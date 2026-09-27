import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import { parseWatchLiveResponse, watchLiveFreshness } from '../src/components/WatchLive/watchLiveData';

const STREAM_A = '00000000-0000-4000-8000-000000000001';
const STREAM_B = '00000000-0000-4000-8000-000000000002';
const TEST_TOKEN = 'ABCD2345';

function response(sequence = 1, streamId = STREAM_A) {
    const now = Date.now();
    return { ok: true, response: { ok: true, live: {
        sample: {
            streamId, sequence, timestampMs: now, motionTimestampSec: sequence / 10,
            wristSide: 'right', crownOrientation: 'left',
            gravity: [0.2, 0.3, -Math.sqrt(0.87)], gyro: [-0.5, 0.7, 0.2],
            acceleration: [0, 0, 0], quaternion: [0, 0, 0, 1],
            sampleRateHz: 10, referenceFrame: 'xArbitraryZVertical',
        }, receivedAtMs: now, ageMs: 0,
    } } };
}

test('live freshness distinguishes stopped samples, transport delay and clock mismatch', () => {
    const fresh = parseWatchLiveResponse(response());
    expect(watchLiveFreshness(fresh, 100)).toBe('fresh');
    expect(watchLiveFreshness(fresh, 1501)).toBe('stale');
    expect(watchLiveFreshness({ ...fresh, ageMs: 5000 }, 0)).toBe('stale');
    expect(watchLiveFreshness({ ...fresh, receivedAtMs: fresh.receivedAtMs! + 5000 }, 0)).toBe('stale');
    expect(watchLiveFreshness({ ...fresh, receivedAtMs: fresh.receivedAtMs! - 5000 }, 0)).toBe('clock');
    expect(watchLiveFreshness(parseWatchLiveResponse({ ok: true, response: { ok: true, live: {} } }), 0)).toBe('waiting');
    for (const gravity of [[0, 0], [0, 0, 0], [NaN, 0, -1]]) {
        const invalid = response();
        invalid.response.live.sample.gravity = gravity;
        expect(() => parseWatchLiveResponse(invalid)).toThrow();
    }
});

test('live page shows sensor values, preserves labeled snapshots and exports no pairing code', async ({ page }) => {
    let sequence = 0;
    let streamId = STREAM_A;
    let stale = false;
    const requests: unknown[] = [];
    await page.addInitScript(() => {
        (window as typeof window & { cameraCalls: number }).cameraCalls = 0;
        navigator.mediaDevices.getUserMedia = async () => {
            (window as typeof window & { cameraCalls: number }).cameraCalls++;
            throw new Error('Camera must not start in live monitor mode');
        };
    });
    await page.route('**/api/capture-command', async route => {
        requests.push(route.request().postDataJSON());
        const body = response(++sequence, streamId);
        if (stale) body.response.live.ageMs = 5000;
        await route.fulfill({ json: body });
    });
    await page.goto('/?mode=watchLive');
    await expect(page.getByRole('heading', { name: 'Watch ライブ確認' })).toBeVisible();
    await expect(page.getByRole('button', { name: '中立を記録', exact: true })).toBeDisabled();
    await page.getByLabel('iPhoneのIP').fill('192.168.1.10');
    await page.getByLabel('ペアリングコード').fill(TEST_TOKEN);
    await page.getByRole('button', { name: '接続する', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('受信中');
    await expect(page.getByRole('region', { name: '重力', exact: true })).toContainText('0.200');
    await expect(page.getByRole('region', { name: 'ジャイロ（角速度）' })).toContainText('-0.500');
    await page.getByLabel('操作メモ').fill('肘を置いて静止');
    await page.getByRole('button', { name: '中立を記録', exact: true }).click();
    await expect(page.getByText('#1 中立', { exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '動作比較', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Watch ライブ確認' })).toBeVisible();

    streamId = STREAM_B;
    sequence = 0;
    await expect.poll(() => sequence).toBeGreaterThan(1);
    await page.screenshot({ path: 'test-results/watch-live-desktop.png', fullPage: true });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '確認データを保存', exact: true }).click();
    const download = await downloadPromise;
    const exported = JSON.parse(await fs.readFile((await download.path())!, 'utf8'));
    expect(exported.markers).toHaveLength(1);
    expect(exported.markers[0]).toMatchObject({ label: '中立', note: '肘を置いて静止', sample: { streamId: STREAM_A, gyro: [-0.5, 0.7, 0.2] } });
    expect(exported.history.every((sample: { streamId: string }) => sample.streamId === STREAM_B)).toBe(true);
    expect(JSON.stringify(exported)).not.toContain(TEST_TOKEN);
    expect(requests[0]).toEqual({ host: '192.168.1.10', token: TEST_TOKEN, command: { type: 'watch-live' } });
    expect(await page.evaluate(() => (window as typeof window & { cameraCalls: number }).cameraCalls)).toBe(0);

    stale = true;
    await expect(page.getByRole('status')).toHaveText('更新停止');
    await expect(page.getByRole('button', { name: '中立を記録', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: 'test-results/watch-live-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'PCの受信を停止', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('未接続');
    const expectFormRetained = async () => {
        await expect(page.getByLabel('iPhoneのIP')).toHaveValue('192.168.1.10');
        await expect(page.getByLabel('ペアリングコード')).toHaveValue(TEST_TOKEN);
        await expect(page.getByLabel('操作メモ')).toHaveValue('肘を置いて静止');
    };
    await expectFormRetained();
    await page.clock.install();
    const requestCount = requests.length;
    await page.clock.runFor(1000);
    expect(requests.length).toBe(requestCount);
    await page.getByRole('button', { name: '動作比較', exact: true }).click();
    await page.getByRole('button', { name: 'Watchライブ', exact: true }).click();
    await expectFormRetained();
    await page.reload();
    await expectFormRetained();
    await expect(page.getByRole('status')).toHaveText('未接続');
    await page.clock.runFor(1000);
    expect(requests.length).toBe(requestCount);
    stale = false;
    await page.getByRole('button', { name: '接続する', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('受信中');
    await page.getByRole('button', { name: 'PCの受信を停止', exact: true }).click();
    for (const label of ['iPhoneのIP', 'ペアリングコード', '操作メモ']) {
        await page.getByLabel(label).fill('');
    }
    await page.reload();
    for (const label of ['iPhoneのIP', 'ペアリングコード', '操作メモ']) {
        await expect(page.getByLabel(label)).toBeEmpty();
    }
});

test('invalid sensor replies disable labeling instead of looking live', async ({ page }) => {
    const invalid = response();
    invalid.response.live.sample.quaternion = [0, 0, 0, 0];
    await page.route('**/api/capture-command', route => route.fulfill({ json: invalid }));
    await page.goto('/?mode=watchLive');
    await page.getByLabel('iPhoneのIP').fill('192.168.1.10');
    await page.getByLabel('ペアリングコード').fill(TEST_TOKEN);
    await page.getByRole('button', { name: '接続する', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('通信エラー');
    await expect(page.getByRole('alert')).toContainText('quaternion');
    await expect(page.getByRole('button', { name: '右傾きを記録', exact: true })).toBeDisabled();
});
