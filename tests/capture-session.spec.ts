import { expect, test } from '@playwright/test';

const TEST_PAIRING_TOKEN = 'capture-test-token-1234';

test.describe('unsupported Safari browser', () => {
    test.use({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    });

    test('does not initialize the camera before showing the unsupported browser warning', async ({ page }) => {
        await page.addInitScript(() => {
            const testWindow = window as typeof window & {
                __getUserMediaCalls?: number;
            };
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
        await expect.poll(
            () => page.evaluate(() => {
                const testWindow = window as typeof window & {
                    __getUserMediaCalls?: number;
                };
                return testWindow.__getUserMediaCalls ?? 0;
            })
        ).toBe(0);
    });
});

test('Capture Session mode shows session command payload and hides analysis controls', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Capture Session' }).click();

    await expect(page.getByRole('heading', { name: 'Capture Session' })).toBeVisible();
    await expect(page.getByText('Session ID')).toBeVisible();
    await expect(page.getByText('Start command payload')).toBeVisible();
    await expect(page.getByText('wrist_shake_3_times', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start command' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop command' })).toBeDisabled();
    await expect(page.getByText('CSV エクスポート')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'モーション解析', exact: true })).toHaveCount(0);
});

test('Start command schedules startAt from the click time', async ({ page }) => {
    await page.route('**/api/capture-command', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await page.goto('/');

    await page.getByRole('button', { name: 'Capture Session' }).click();
    await page.waitForTimeout(3500);

    const clickedAt = Date.now();
    await page.getByRole('button', { name: 'Start command' }).click();

    const payloadText = await page
        .locator('.capture-panel', { hasText: 'Start command payload' })
        .locator('.capture-payload')
        .textContent();
    const payload = JSON.parse(payloadText ?? '{}') as { startAt: string };
    const startAtMs = Date.parse(payload.startAt);

    expect(startAtMs).toBeGreaterThan(clickedAt + 1000);
    expect(startAtMs).toBeLessThan(clickedAt + 5000);
});

test('Start and Stop command buttons post capture commands to the local API', async ({ page }) => {
    const requests: unknown[] = [];

    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Capture Session' }).click();

    await page.getByLabel('iPhone IP').fill('192.168.1.10');
    await page.getByLabel('Pairing token').fill(TEST_PAIRING_TOKEN);

    const clickedAt = Date.now();
    await page.getByRole('button', { name: 'Start command' }).click();

    expect(requests).toHaveLength(1);
    const startRequest = requests[0] as {
        host: string;
        port: number;
        token: string;
        command: { type: string; startAt: string; sessionId: string };
    };
    expect(startRequest.host).toBe('192.168.1.10');
    expect(startRequest.port).toBe(8765);
    expect(startRequest.token).toBe(TEST_PAIRING_TOKEN);
    expect(startRequest.command.type).toBe('start');
    expect(Date.parse(startRequest.command.startAt)).toBeGreaterThan(clickedAt + 1000);
    expect(Date.parse(startRequest.command.startAt)).toBeLessThan(clickedAt + 5000);

    await expect(page.getByText('Command accepted')).toBeVisible();

    await page.getByRole('button', { name: 'Stop command' }).click();

    expect(requests).toHaveLength(2);
    const stopRequest = requests[1] as {
        host: string;
        port: number;
        token: string;
        command: { type: string; sessionId: string; stopAt: string };
    };
    expect(stopRequest.host).toBe('192.168.1.10');
    expect(stopRequest.port).toBe(8765);
    expect(stopRequest.token).toBe(TEST_PAIRING_TOKEN);
    expect(stopRequest.command.type).toBe('stop');
    expect(stopRequest.command.sessionId).toBe(startRequest.command.sessionId);
    expect(Date.parse(stopRequest.command.stopAt)).toBeGreaterThan(clickedAt);
});

test('New session refreshes the session ID for the next capture', async ({ page }) => {
    const requests: unknown[] = [];

    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, response: { ok: true } }),
        });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Capture Session' }).click();
    await page.getByLabel('iPhone IP').fill('192.168.1.10');
    await page.getByLabel('Pairing token').fill(TEST_PAIRING_TOKEN);

    const sessionIdValue = page.locator('.capture-session-summary dd').first();
    const initialSessionId = await sessionIdValue.textContent();

    await page.getByRole('button', { name: 'Start command' }).click();
    await page.getByRole('button', { name: 'Stop command' }).click();
    await page.getByRole('button', { name: 'New session' }).click();

    const refreshedSessionId = await sessionIdValue.textContent();
    expect(refreshedSessionId).toBeTruthy();
    expect(refreshedSessionId).not.toBe(initialSessionId);

    await page.getByRole('button', { name: 'Start command' }).click();

    expect(requests).toHaveLength(3);
    const firstStartRequest = requests[0] as {
        command: { type: string; sessionId: string };
    };
    const secondStartRequest = requests[2] as {
        command: { type: string; sessionId: string };
    };
    expect(firstStartRequest.command.type).toBe('start');
    expect(secondStartRequest.command.type).toBe('start');
    expect(secondStartRequest.command.sessionId).toBe(refreshedSessionId);
    expect(secondStartRequest.command.sessionId).not.toBe(firstStartRequest.command.sessionId);
});
