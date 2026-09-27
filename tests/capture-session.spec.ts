import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const TEST_PAIRING_TOKEN = 'ABCD2345';

async function openCaptureSession(page: Page, mode: 'research-right' | 'dual-watch' = 'dual-watch') {
    await page.goto('/');
    await page.getByRole('button', { name: '収録' }).click();
    const modeSelect = page.getByLabel('Capture mode');
    if (await modeSelect.isEnabled()) {
        await modeSelect.selectOption(mode);
    }
}

async function fillDualEndpoints(page: Page) {
    await page.getByLabel('Left iPhone IP').fill('192.168.1.10');
    await page.getByLabel('Left pairing code').fill(TEST_PAIRING_TOKEN);
    await page.getByLabel('Right iPhone IP').fill('192.168.1.11');
    await page.getByLabel('Right pairing code').fill(TEST_PAIRING_TOKEN);
}

test.describe('unsupported Safari browser', () => {
    test.use({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    });

    test('does not initialize the camera before showing the unsupported browser warning', async ({ page }) => {
        await page.addInitScript(() => {
            const testWindow = window as typeof window & { __getUserMediaCalls?: number };
            testWindow.__getUserMediaCalls = 0;
            Object.defineProperty(navigator, 'mediaDevices', {
                configurable: true,
                value: {
                    getUserMedia: () => {
                        testWindow.__getUserMediaCalls = (testWindow.__getUserMediaCalls ?? 0) + 1;
                        return Promise.reject(new Error('Unexpected camera access'));
                    },
                },
            });
        });
        await page.goto('/');
        await expect(page.getByRole('heading', { name: '非対応ブラウザ' })).toBeVisible();
        await expect(page.locator('.pose-detector')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => {
            const testWindow = window as typeof window & { __getUserMediaCalls?: number };
            return testWindow.__getUserMediaCalls ?? 0;
        })).toBe(0);
    });
});

test('Capture Session shows fixed Left and Right roles', async ({ page }) => {
    await openCaptureSession(page);
    await expect(page.getByRole('heading', { name: 'Cooking Capture' })).toBeVisible();
    await expect(page.getByText('Left iPhone · Camera + Watch')).toBeVisible();
    await expect(page.getByText('Right iPhone · Watch relay')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start both' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop both' })).toBeDisabled();
    await expect(page.getByText('CSV エクスポート')).toHaveCount(0);
});

test('research capture records video and right wrist through one iPhone', async ({ page }) => {
    const requests: any[] = [];
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page, 'research-right');
    await expect(page.getByLabel('Left iPhone IP')).toHaveCount(0);
    await expect(page.getByText('Right iPhone · Camera + right Watch')).toBeVisible();
    await page.getByLabel('Right iPhone IP').fill('192.168.1.11');
    await page.getByLabel('Right pairing code').fill(TEST_PAIRING_TOKEN);
    await page.getByRole('button', { name: 'Start research capture' }).click();

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].command.video).toEqual({
        device: 'iphone',
        filename: expect.stringMatching(/\.mov$/),
        enabled: true,
    });
    expect(requests[0].command.watch.wristSide).toBe('right');
    expect(requests[0].command.watch.sampleRateHz).toBe(50);
    await page.getByRole('button', { name: 'Stop research capture' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].command.type).toBe('stop');
});

test('Start and Stop fan out side-specific commands to both iPhones', async ({ page }) => {
    const requests: any[] = [];
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await fillDualEndpoints(page);
    const clickedAt = Date.now();
    await page.getByRole('button', { name: 'Start both' }).click();

    await expect.poll(() => requests.length).toBe(2);
    const starts = requests.sort((a, b) => a.host.localeCompare(b.host));
    expect(starts[0].host).toBe('192.168.1.10');
    expect(starts[1].host).toBe('192.168.1.11');
    expect(starts[0].command.sessionId).toBe(starts[1].command.sessionId);
    expect(starts[0].command.startAt).toBe(starts[1].command.startAt);
    expect(Date.parse(starts[0].command.startAt)).toBeGreaterThan(clickedAt + 8_000);
    expect(starts[0].command.video.enabled).toBe(true);
    expect(starts[1].command.video.enabled).toBe(false);
    expect(starts[0].command.watch.wristSide).toBe('left');
    expect(starts[1].command.watch.wristSide).toBe('right');
    expect(starts[0].command.watch.filename).toContain('_left_wrist_imu.csv');
    expect(starts[1].command.watch.filename).toContain('_right_wrist_imu.csv');

    await expect(page.getByText('Both iPhones accepted the scheduled Start')).toBeVisible();
    await page.getByRole('button', { name: 'Stop both' }).click();
    await expect.poll(() => requests.length).toBe(4);
    expect(requests.slice(2).every(request => request.command.type === 'stop')).toBe(true);
    expect(requests[2].command.sessionId).toBe(starts[0].command.sessionId);
});

test('a partial Start failure sends Stop to both endpoints', async ({ page }) => {
    const requests: any[] = [];
    await page.route('**/api/capture-command', async route => {
        const body = route.request().postDataJSON();
        requests.push(body);
        const shouldFail = body.host === '192.168.1.11' && body.command.type === 'start';
        await route.fulfill({
            status: shouldFail ? 502 : 200,
            contentType: 'application/json',
            body: JSON.stringify(shouldFail
                ? { ok: false, error: 'Right iPhone unavailable' }
                : { ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await fillDualEndpoints(page);
    await page.getByRole('button', { name: 'Start both' }).click();

    await expect.poll(() => requests.length).toBe(4);
    const rollback = requests.filter(request => request.command.type === 'stop');
    expect(rollback).toHaveLength(2);
    expect(new Set(rollback.map(request => request.host))).toEqual(
        new Set(['192.168.1.10', '192.168.1.11'])
    );
    await expect(page.getByText('Start failed; no active session remains. Create a new session')).toBeVisible();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start both' })).toBeDisabled();
});

test('a definitive Start rejection does not leave a restored active session when its rollback Stop is rejected', async ({ page }) => {
    await page.route('**/api/capture-command', async route => {
        const body = route.request().postDataJSON();
        const rejectedByRightIPhone = body.host === '192.168.1.11';
        await route.fulfill({
            status: rejectedByRightIPhone ? 502 : 200,
            contentType: 'application/json',
            body: JSON.stringify(rejectedByRightIPhone
                ? {
                    ok: false,
                    error: 'iPhone recorder rejected command: Watch app is not installed',
                    errorCode: 'iphone_command_rejected',
                }
                : { ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await fillDualEndpoints(page);
    await page.getByRole('button', { name: 'Start both' }).click();

    await expect(page.getByText('Start failed; no active session remains. Create a new session')).toBeVisible();
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('capture.activeTransaction'))).toBeNull();

    await page.reload();
    await openCaptureSession(page);
    await expect(page.getByText('Restored active session; use Stop both before starting another session')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start both' })).toBeEnabled();
});

test('a failed rollback stays in Stop required state and can retry', async ({ page }) => {
    const requests: any[] = [];
    let rightStopAttempts = 0;
    await page.route('**/api/capture-command', async route => {
        const body = route.request().postDataJSON();
        requests.push(body);
        const rightStart = body.host === '192.168.1.11' && body.command.type === 'start';
        const rightStop = body.host === '192.168.1.11' && body.command.type === 'stop';
        if (rightStop) {
            rightStopAttempts += 1;
        }
        const shouldFail = rightStart || (rightStop && rightStopAttempts === 1);
        await route.fulfill({
            status: shouldFail ? 502 : 200,
            contentType: 'application/json',
            body: JSON.stringify(shouldFail
                ? { ok: false, error: 'Right iPhone unavailable' }
                : { ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await fillDualEndpoints(page);
    await page.getByRole('button', { name: 'Start both' }).click();

    await expect(page.getByText('Stop required', { exact: true })).toBeVisible();
    await expect(page.getByText('Start failed; retry Stop for right iPhone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start both' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry Stop right iPhone' })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(
        localStorage.getItem('capture.activeTransaction') ?? 'null'
    )?.sides)).toEqual(['right']);

    const requestCountBeforeRetry = requests.length;
    await page.getByRole('button', { name: 'Retry Stop right iPhone' }).click();
    await expect(page.getByText('Right iPhone accepted Stop')).toBeVisible();
    expect(requests.slice(requestCountBeforeRetry).map(request => request.host)).toEqual(['192.168.1.11']);
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
});

test('the same iPhone IP cannot be assigned to both wrist roles', async ({ page }) => {
    let requestCount = 0;
    await page.route('**/api/capture-command', async route => {
        requestCount += 1;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });

    await openCaptureSession(page);
    await page.getByLabel('Left iPhone IP').fill('192.168.1.10');
    await page.getByLabel('Left pairing code').fill(TEST_PAIRING_TOKEN);
    await page.getByLabel('Right iPhone IP').fill('192.168.1.10');
    await page.getByLabel('Right pairing code').fill(TEST_PAIRING_TOKEN);
    await page.getByRole('button', { name: 'Start both' }).click();

    await expect(page.getByText('Left and Right iPhone IPs must be different').first()).toBeVisible();
    expect(requestCount).toBe(0);
});

test('reload restores the active transaction and Stop uses the original endpoints', async ({ page }) => {
    const requests: any[] = [];
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await fillDualEndpoints(page);
    await page.getByRole('button', { name: 'Start both' }).click();
    await expect(page.getByText('Both iPhones accepted the scheduled Start')).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: '収録' }).click();
    await expect(page.getByText('Restored active session; use Stop both before starting another session')).toBeVisible();
    await expect(page.getByLabel('Left iPhone IP')).toBeDisabled();
    await expect(page.getByLabel('Right iPhone IP')).toBeDisabled();
    await page.getByRole('button', { name: 'Stop both' }).click();

    const stops = requests.filter(request => request.command.type === 'stop');
    expect(new Set(stops.map(request => request.host))).toEqual(
        new Set(['192.168.1.10', '192.168.1.11'])
    );
});

test('reload restores a research capture and stops only the right iPhone', async ({ page }) => {
    const requests: any[] = [];
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page, 'research-right');
    await page.getByLabel('Right iPhone IP').fill('192.168.1.11');
    await page.getByLabel('Right pairing code').fill(TEST_PAIRING_TOKEN);
    await page.getByRole('button', { name: 'Start research capture' }).click();
    await expect(page.getByText('Right iPhone accepted the scheduled Start')).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: '収録' }).click();
    await expect(page.getByText(
        'Restored active session; use Stop research capture before starting another session'
    )).toBeVisible();
    await expect(page.getByLabel('Left iPhone IP')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop research capture' }).click();

    const stops = requests.filter(request => request.command.type === 'stop');
    expect(stops).toHaveLength(1);
    expect(stops[0].host).toBe('192.168.1.11');
});

test('partial Stop failure survives reload and retries only the unresolved iPhone', async ({ page }) => {
    const requests: any[] = [];
    let rightStopAttempts = 0;
    await page.addInitScript(token => {
        const activeTransaction = localStorage.getItem('capture.activeTransaction');
        if (activeTransaction) {
            return;
        }
        localStorage.setItem('capture.activeTransaction', JSON.stringify({
            sessionId: 'capture_partial_stop',
            startAt: '2026-08-16T19:00:00.000+09:00',
            endpoints: {
                left: { host: '192.168.1.10', token },
                right: { host: '192.168.1.11', token },
            },
            mode: 'dual-watch',
            sides: ['left', 'right'],
            status: 'recording',
        }));
    }, TEST_PAIRING_TOKEN);
    await page.route('**/api/capture-command', async route => {
        const body = route.request().postDataJSON();
        requests.push(body);
        if (body.host === '192.168.1.11') {
            rightStopAttempts += 1;
        }
        const shouldFail = body.host === '192.168.1.11' && rightStopAttempts === 1;
        await route.fulfill({
            status: shouldFail ? 504 : 200,
            contentType: 'application/json',
            body: JSON.stringify(shouldFail
                ? { ok: false, error: 'Timed out waiting for right iPhone' }
                : { ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await page.getByRole('button', { name: 'Stop both' }).click();

    await expect(page.getByText('Stop failed for right iPhone: Timed out waiting for right iPhone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry Stop right iPhone' })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(
        localStorage.getItem('capture.activeTransaction') ?? 'null'
    )?.sides)).toEqual(['right']);

    await page.reload();
    await page.getByRole('button', { name: '収録' }).click();
    await expect(page.getByRole('button', { name: 'Retry Stop right iPhone' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear local session state' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry Stop right iPhone' }).click();

    expect(requests.map(request => request.host)).toEqual([
        '192.168.1.10',
        '192.168.1.11',
        '192.168.1.11',
    ]);
    await expect(page.getByText('Right iPhone accepted Stop')).toBeVisible();
});

test('failed restored Stop can clear only browser state with an explicit warning', async ({ page }) => {
    let requestCount = 0;
    await page.addInitScript(token => {
        localStorage.setItem('capture.activeTransaction', JSON.stringify({
            sessionId: 'capture_unreachable_right',
            startAt: '2026-08-16T19:00:00.000+09:00',
            endpoints: {
                left: { host: '', token: '' },
                right: { host: '192.168.1.11', token },
            },
            mode: 'research-right',
            sides: ['right'],
            status: 'recording',
        }));
    }, TEST_PAIRING_TOKEN);
    await page.route('**/api/capture-command', async route => {
        requestCount += 1;
        await route.fulfill({
            status: 504,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'Timed out waiting for iPhone recorder' }),
        });
    });

    await openCaptureSession(page);
    await page.getByRole('button', { name: 'Stop research capture' }).click();
    await expect(page.getByText(
        'Stop failed for right iPhone: Timed out waiting for iPhone recorder'
    )).toBeVisible();
    await expect(page.getByText(
        'This clears browser state only. It does not stop recording devices.'
    )).toBeVisible();

    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Clear local session state' }).click();
    await expect.poll(() => page.evaluate(
        () => localStorage.getItem('capture.activeTransaction')
    )).not.toBeNull();

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear local session state' }).click();
    await expect.poll(() => page.evaluate(
        () => localStorage.getItem('capture.activeTransaction')
    )).toBeNull();
    expect(requestCount).toBe(1);
    await expect(page.getByText('Device state unknown', { exact: true })).toBeVisible();
    await expect(page.getByText('Stopped', { exact: true })).toHaveCount(0);
    await expect(page.getByText(
        'Local session state cleared. Device recording state is unknown; confirm all recording devices are stopped before creating a new session.'
    )).toBeVisible();
    await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
});

test('legacy restored state preserves and normalizes its unresolved sides', async ({ page }) => {
    const requests: any[] = [];
    await page.addInitScript(token => {
        localStorage.setItem('capture.activeTransaction', JSON.stringify({
            sessionId: 'capture_legacy_right',
            startAt: '2026-08-16T19:00:00.000+09:00',
            endpoints: {
                left: { host: '192.168.1.10', token },
                right: { host: '192.168.1.11', token },
            },
            sides: ['right', 'right', 'unknown'],
            status: 'rollback',
        }));
    }, TEST_PAIRING_TOKEN);
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await expect(page.getByRole('button', { name: 'Retry Stop right iPhone' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry Stop right iPhone' }).click();

    expect(requests).toHaveLength(1);
    expect(requests[0].host).toBe('192.168.1.11');
});

test('research restore always targets the right iPhone when stored sides are inconsistent', async ({ page }) => {
    const requests: any[] = [];
    await page.addInitScript(token => {
        localStorage.setItem('capture.activeTransaction', JSON.stringify({
            sessionId: 'capture_research_inconsistent',
            startAt: '2026-08-16T19:00:00.000+09:00',
            endpoints: {
                left: { host: '192.168.1.10', token },
                right: { host: '192.168.1.11', token },
            },
            mode: 'research-right',
            sides: ['left'],
            status: 'recording',
        }));
    }, TEST_PAIRING_TOKEN);
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await openCaptureSession(page);
    await page.getByRole('button', { name: 'Stop research capture' }).click();

    expect(requests).toHaveLength(1);
    expect(requests[0].host).toBe('192.168.1.11');
});

test('unreadable stored capture state requires explicit local recovery', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('capture.activeTransaction', '{not-json');
    });

    await openCaptureSession(page, 'research-right');
    await expect(page.getByText('Device state unknown', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start research capture' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Clear local session state' })).toBeVisible();

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Clear local session state' }).click();

    await expect.poll(() => page.evaluate(
        () => localStorage.getItem('capture.activeTransaction')
    )).toBeNull();
    await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
    await expect(page.getByText('Stopped', { exact: true })).toHaveCount(0);
});

test('legacy single-endpoint storage initializes the Left endpoint only', async ({ page }) => {
    await page.addInitScript(token => {
        localStorage.setItem('capture.iphoneHost', '192.168.1.20');
        localStorage.setItem('capture.pairingToken', token);
    }, TEST_PAIRING_TOKEN);
    await openCaptureSession(page);
    await expect(page.getByLabel('Left iPhone IP')).toHaveValue('192.168.1.20');
    await expect(page.getByLabel('Left pairing code')).toHaveValue(TEST_PAIRING_TOKEN);
    await expect(page.getByLabel('Right iPhone IP')).toHaveValue('');
});

test('New session changes the ID used by both endpoints', async ({ page }) => {
    const requests: any[] = [];
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });
    await openCaptureSession(page);
    await fillDualEndpoints(page);
    const sessionIdValue = page.locator('.capture-session-summary dd').first();
    const initialSessionId = await sessionIdValue.textContent();
    await page.getByRole('button', { name: 'Start both' }).click();
    await page.getByRole('button', { name: 'Stop both' }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    const nextSessionId = await sessionIdValue.textContent();
    expect(nextSessionId).not.toBe(initialSessionId);
    await page.getByRole('button', { name: 'Start both' }).click();
    await expect.poll(() => requests.filter(
        request => request.command.type === 'start'
    ).length).toBe(4);
    const latestStarts = requests.filter(
        request => request.command.type === 'start'
    ).slice(-2);
    expect(latestStarts.every(request => request.command.sessionId === nextSessionId)).toBe(true);
});
