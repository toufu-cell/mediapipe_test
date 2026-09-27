import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
    buildWatchRotationSeries,
    sampleWatchRotationAtTime,
    resolveOverlayDetailLevel,
    type SignalSeries,
} from '../src/components/MotionComparison/comparisonData';

const TINY_WEBM_BASE64 = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHLTbuMU6uEElTDZ1OsggEY7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmpSrXsYMPQkBNgIxMYXZmNjEuNy4xMDBXQYxMYXZmNjEuNy4xMDAWVK5ryK4BAAAAAAAAP9eBAXPFiM7H2U6JKuPSnIEAIrWcg3VuZIiBAIaFVl9WUDmDgQEj44OEAmJaAOCQsIEguoESmoECVbCEVbmBARJUw2fbc3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS43LjEwMHNztmPAi2PFiM7H2U6JKuPSZ8ilRaOHRU5DT0RFUkSHmExhdmM2MS4xOS4xMDEgbGlidnB4LXZwOR9DtnVBIueBAKOhgQAAgIJJg0IAAfABFgA4JBwYSgAAMGAAABDf//1ZFYAAo5OBACgAhgBAkpwAUAAAAyAAAENAo5OBAFAAhgBAkpwATuAAAyAAAENAo5OBAHgAhgBAkpwAUAAAAyAAAENAo5OBAKAAhgBAkpwATUAAAyAAAENAo5OBAMgAhgBAkpwAUAAAAyAAAENAo5OBAPAAhgBAkpwATuAAAyAAAENAo5OBARgAhgBAkpwAUAAAAyAAAENAo5OBAUAAhgBAkpwASiAAAyAAAENAo5OBAWgAhgBAkpwAUAAAAyAAAENAo5OBAZAAhgDAkpwASiAAAyAAAENAo5OBAbgAhgBAkpwAUAAAAyAAAENAo5OBAeAAhgBAkpwATUAAAyAAAENA';

const HAND_LANDMARK_NAMES = [
    'wrist',
    'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
    'indexFingerMcp', 'indexFingerPip', 'indexFingerDip', 'indexFingerTip',
    'middleFingerMcp', 'middleFingerPip', 'middleFingerDip', 'middleFingerTip',
    'ringFingerMcp', 'ringFingerPip', 'ringFingerDip', 'ringFingerTip',
    'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip',
] as const;

interface CsvOptions {
    mirroredHand?: boolean;
    accelerationNorm?: number;
    allGyroMissing?: boolean;
    allHandsMissing?: boolean;
    collapsedForearmVector?: boolean;
    emptyFirstTimestamp?: boolean;
    gyroGap?: boolean;
    handOnlyAtStart?: boolean;
    imuStartsAt250?: boolean;
    invalidHandColumn?: boolean;
    missingAccelColumn?: boolean;
    missingGyroXColumn?: boolean;
    invalidGyroX?: string;
    missingImuIdentity?: boolean;
    movingRightHand?: boolean;
    oneGyroMissing?: boolean;
    rightPalmAtLeftEdge?: boolean;
    rightPalmScale?: number;
    singleGyroSample?: boolean;
    unusableRightPalm?: boolean;
    gyroX?: number;
    gyroY?: number;
    gyroZ?: number;
    rotationBurst?: boolean;
    durationMs?: number;
}

function fixtureTimestamps(options: CsvOptions): number[] {
    return options.movingRightHand || options.rotationBurst || options.durationMs !== undefined
        ? Array.from({ length: (options.durationMs ?? 1000) / 100 + 1 }, (_, index) => index * 100)
        : [0, 2000, 2450, 2500, 2550, 3000, 5000];
}

function makeHandCsv(
    options: CsvOptions = {},
): string {
    const handHeaders = HAND_LANDMARK_NAMES.map(name => [
        `${name}_x`,
        `${name}_y`,
        `${name}_z`,
    ]).flat();
    if (options.invalidHandColumn) {
        handHeaders[0] = 'invalid_wrist_x';
    }
    const header = [
        'timestamp_ms',
        'frame_index',
        'hand_index',
        'handedness',
        'raw_handedness',
        'score',
        ...handHeaders,
        'detected',
        'missing_reason',
        'timestamp_source',
    ].join(',');
    const rows = fixtureTimestamps(options).flatMap((timestampMs, frameIndex) => (
        (['Left', 'Right'] as const).map((side, sideIndex) => {
            const detected = !options.allHandsMissing && !(options.handOnlyAtStart && timestampMs > 2000);
            const rightHandShift = options.movingRightHand && side === 'Right' && frameIndex % 2 === 1
                && !options.rightPalmAtLeftEdge
                ? 0.32
                : 0;
            const handValues = detected
                ? HAND_LANDMARK_NAMES.map((_, index) => {
                    const unusableRightPalm = options.unusableRightPalm && side === 'Right';
                    const palmScale = side === 'Right' ? options.rightPalmScale ?? 1 : 1;
                    const coordinateIndex = options.collapsedForearmVector && side === 'Right' && index === 0
                        ? 10.9
                        : index;
                    const baseX = options.rightPalmAtLeftEdge && side === 'Right' ? 0.01 : 0.25;
                    const pointX = unusableRightPalm
                            ? 0.5 + index * 0.0001
                            : baseX + coordinateIndex * 0.01 * palmScale + rightHandShift;
                    return [
                        (options.mirroredHand ? 1 - pointX : pointX).toFixed(4),
                        (unusableRightPalm
                            ? 0.5 + index * 0.00005
                            : 0.4 + coordinateIndex * 0.005 * palmScale).toFixed(4),
                        '0',
                    ];
                }).flat()
                : Array.from({ length: HAND_LANDMARK_NAMES.length * 3 }, () => '');
            return [
                options.emptyFirstTimestamp && frameIndex === 0 && sideIndex === 0 ? '' : timestampMs,
                frameIndex,
                sideIndex,
                side,
                side,
                detected ? '0.95' : '',
                ...handValues,
                detected ? 'true' : 'false',
                detected ? '' : 'not_detected',
                'container_pts',
            ].join(',');
        })
    ));
    return [header, ...rows].join('\n');
}

function makeSyncedCsv(
    sessionId: string,
    defaultRate: number,
    options: CsvOptions = {},
    side: 'left' | 'right' = 'right',
): string {
    const header = [
        'timestamp_ms', 'frame_index', 'imu_session_id', 'imu_wrist_side',
        ...(options.missingAccelColumn ? [] : ['imu_accel_norm']),
        ...(options.missingGyroXColumn ? [] : ['imu_gyro_x']),
        'imu_gyro_y', 'imu_gyro_z',
        // 重力や他軸を回転の代替にしないことを確認するため、無関係な値も含める。
        'imu_gravity_x', 'imu_gravity_y', 'imu_gravity_z',
    ].join(',');
    const rows = fixtureTimestamps(options).map((timestampMs, frameIndex) => {
        const imuMissing = options.imuStartsAt250 && timestampMs < 2500;
        const gyroMissing = options.allGyroMissing || (
            options.gyroGap && timestampMs >= 500 && timestampMs <= 900
        ) || (options.singleGyroSample && frameIndex > 0) || (
            options.oneGyroMissing && timestampMs === 700
        );
        const rate = options.rotationBurst && (timestampMs < 300 || timestampMs >= 1200)
            ? 0 : options.gyroX ?? defaultRate;
        return [
            timestampMs, frameIndex,
            imuMissing || options.missingImuIdentity ? '' : sessionId,
            imuMissing || options.missingImuIdentity ? '' : side,
            ...(options.missingAccelColumn ? [] : [
                imuMissing ? '' : (options.accelerationNorm ?? 0.05).toFixed(3),
            ]),
            ...(options.missingGyroXColumn ? [] : [
                imuMissing || gyroMissing ? '' : options.invalidGyroX ?? rate.toFixed(6),
            ]),
            options.gyroY ?? 0, options.gyroZ ?? 0,
            0, 0, 0,
        ].join(',');
    });
    return [header, ...rows].join('\n');
}

async function openComparison(page: Page): Promise<void> {
    await page.goto('/');
    await page.getByRole('button', { name: '動作比較' }).click();
    await expect(page.getByRole('heading', { name: '動作比較スタジオ' })).toBeVisible();
}

const PLAN_STORAGE_KEY = 'cooking.nextPlans.v1';

async function completePlan(page: Page, choice = '維持') {
    await page.getByLabel('気付いた違い', { exact: true }).fill('自分は途中で混ぜるのを止めていた');
    await page.getByRole('radio', { name: choice, exact: true }).check();
    await page.getByLabel('選んだ理由', { exact: true }).fill('生地の状態を確認できたため');
    await page.getByLabel('次の調理で行うこと・観察すること', { exact: true }).fill('途中で止めて生地を確認する');
    await page.getByLabel('結果を確認する方法', { exact: true }).fill('混ぜ終わりの状態と動画を見返す');
}

async function exportedPlans(page: Page) {
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
    const file = await downloaded;
    const path = await file.path();
    expect(path).not.toBeNull();
    return JSON.parse(await readFile(path!, 'utf8'));
}

test('方針の下書きと根拠を復元し、別動画でも元の根拠を保持して記録・出力する', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: '研究メニュー' }).getByRole('button')).toHaveText(['動作比較', '収録', 'Watchライブ']);
    await expect(page.getByRole('heading', { name: '動作比較スタジオ' })).toBeVisible();
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await uploadRecording(page, 'a', sessionA);
    await uploadRecording(page, 'b', sessionB);
    const capture = page.getByRole('button', { name: '選択中の区間を取り込む' });
    await page.locator('#recording-a-start').fill('');
    await expect(capture).toBeDisabled();
    await page.locator('#recording-a-start').fill('0.2');
    await page.locator('#recording-a-end').fill('1.2');
    await capture.click();
    await completePlan(page);
    await expect(page.getByText('下書きと記録をブラウザ内に保存済み')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('気付いた違い', { exact: true })).toHaveValue('自分は途中で混ぜるのを止めていた');
    await expect(page.locator('.plan-evidence-input')).toContainText('0.20–1.20秒');
    await expect(capture).toBeDisabled();
    await uploadRecording(page, 'a', 'capture_20260803_030303_003_03');
    await uploadRecording(page, 'b', 'capture_20260803_040404_004_04');
    await expect(page.locator('.plan-evidence-input')).toContainText(sessionA);
    await page.getByRole('button', { name: '方針を記録する' }).click();
    await expect(page.getByText('記録した方針（1件）')).toBeVisible();
    for (const choice of ['変更', '保留']) {
        await capture.click();
        await completePlan(page, choice);
        await page.getByRole('button', { name: '方針を記録する' }).click();
    }
    await expect(page.getByText('下書きと記録をブラウザ内に保存済み')).toBeVisible();
    const exported = await exportedPlans(page);
    expect(exported.plans.map((plan: { choice: string }) => plan.choice)).toEqual(['maintain', 'change', 'defer']);
    expect(exported.plans[0].evidence.self).toEqual({ sessionId: sessionA, videoName: `${sessionA}_labelstudio.webm`, startSec: 0.2, endSec: 1.2 });
    expect(exported.plans[0].evidence.other.sessionId).toBe(sessionB);
    expect(exported.plans[1].evidence.self.sessionId).toBe('capture_20260803_030303_003_03');
    await page.reload();
    await expect(page.getByText('記録した方針（3件）')).toBeVisible();
});

test('保存失敗でも入力を保持し、離脱を確認してJSONへ退避できる', async ({ page }) => {
    await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (key === 'cooking.nextPlans.v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
            original.call(this, key, value);
        };
    });
    await page.goto('/');
    await page.getByLabel('気付いた違い', { exact: true }).fill('消してはいけない観察');
    await expect(page.getByRole('alert')).toContainText('ブラウザ内に保存できません');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '収録', exact: true }).click();
    await expect(page.getByLabel('気付いた違い', { exact: true })).toHaveValue('消してはいけない観察');
    expect((await exportedPlans(page)).draft.observation).toBe('消してはいけない観察');
    await page.getByRole('button', { name: '収録', exact: true }).click();
    await expect(page.getByLabel('Capture mode')).toBeVisible();
});

test('壊れた保存値を上書きせず、新しい入力を別に書き出せる', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(key => localStorage.setItem(key, '{broken'), PLAN_STORAGE_KEY);
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('既存データは上書きしません');
    await page.getByLabel('気付いた違い', { exact: true }).fill('別に残す観察');
    expect((await exportedPlans(page)).draft.observation).toBe('別に残す観察');
    expect(await page.evaluate(key => localStorage.getItem(key), PLAN_STORAGE_KEY)).toBe('{broken');
});

test('2タブの競合保存は一方を保護し、もう一方の入力も書き出せる', async ({ page, context }) => {
    await page.goto('/');
    const other = await context.newPage();
    await other.goto('/');
    await Promise.all([
        page.getByLabel('気付いた違い', { exact: true }).fill('タブAの観察'),
        other.getByLabel('気付いた違い', { exact: true }).fill('タブBの観察'),
    ]);
    await expect.poll(async () => Number(await page.getByRole('alert').count()) + Number(await other.getByRole('alert').count())).toBe(1);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), PLAN_STORAGE_KEY);
    expect(['タブAの観察', 'タブBの観察']).toContain(stored.draft.observation);
    const loser = await page.getByRole('alert').count() ? page : other;
    await expect(loser.getByRole('alert')).toContainText('別のタブ');
    const recovered = await exportedPlans(loser);
    expect(recovered.draft.observation).not.toBe(stored.draft.observation);
    expect(['タブAの観察', 'タブBの観察']).toContain(recovered.draft.observation);
    await page.reload();
    await other.reload();
    await other.getByLabel('気付いた違い', { exact: true }).fill('別タブで更新した観察');
    await expect(other.getByText('下書きと記録をブラウザ内に保存済み')).toBeVisible();
    await page.getByLabel('気付いた違い', { exact: true }).fill('一時的な変更');
    await page.getByLabel('気付いた違い', { exact: true }).fill(stored.draft.observation);
    await expect(page.getByRole('alert')).toContainText('別のタブ');
    let confirmed = false;
    page.once('dialog', async dialog => { confirmed = true; await dialog.dismiss(); });
    await page.getByRole('button', { name: '収録', exact: true }).click();
    expect(confirmed).toBe(true);
    await expect(page.getByLabel('気付いた違い', { exact: true })).toHaveValue(stored.draft.observation);
});

async function uploadRecording(
    page: Page,
    id: 'a' | 'b',
    sessionId: string,
    options: CsvOptions & {
        handSessionId?: string;
        rightSessionId?: string;
        rightSide?: 'left' | 'right';
        videoSessionId?: string;
    } = {},
): Promise<void> {
    const handSessionId = options.handSessionId ?? sessionId;
    const rightSessionId = options.rightSessionId ?? sessionId;
    const videoSessionId = options.videoSessionId ?? sessionId;
    await page.locator(`#recording-${id}-video`).setInputFiles({
        name: `${videoSessionId}_labelstudio.webm`,
        mimeType: 'video/webm',
        buffer: Buffer.from(TINY_WEBM_BASE64, 'base64'),
    });
    // Chromiumのheadless環境にコーデックがない場合も、metadata後の比較動作を検証する。
    await page.locator(`.comparison-video-panel.recording-${id} video`).evaluate(video => {
        let mockCurrentTime = 0;
        Object.defineProperty(video, 'duration', { configurable: true, value: 5 });
        Object.defineProperty(video, 'videoWidth', { configurable: true, value: 720 });
        Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1280 });
        Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
        Object.defineProperty(video, 'seeking', { configurable: true, value: false });
        Object.defineProperty(video, 'currentTime', {
            configurable: true,
            get: () => mockCurrentTime,
            set: value => { mockCurrentTime = value; },
        });
        video.dispatchEvent(new Event('loadedmetadata'));
    });
    await page.locator(`#recording-${id}-hand`).setInputFiles({
        name: `${handSessionId}_hand_landmarks.csv`,
        mimeType: 'text/csv',
        buffer: Buffer.from(makeHandCsv(options)),
    });
    await page.locator(`#recording-${id}-right`).setInputFiles({
        name: `${rightSessionId}_right_wrist_synced.csv`,
        mimeType: 'text/csv',
        buffer: Buffer.from(makeSyncedCsv(
            rightSessionId,
            id === 'a' ? -2 : -4,
            options,
            options.rightSide,
        )),
    });
    await page.getByRole('button', { name: `記録${id.toUpperCase()}を読み込む` }).click();
}

interface MarkerStats {
    contentHeight: number;
    contentLeft: number;
    contentTop: number;
    contentWidth: number;
    yellow: number;
    magenta: number;
    magentaCenterX: number;
    magentaCenterY: number;
    magentaHeight: number;
    magentaWidth: number;
    maximumRadius: number;
    palmWhite: number;
    watchCenterX: number;
}

async function readMarkerStats(page: Page): Promise<MarkerStats[]> {
    return page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
        canvases.map(canvas => {
            const context = canvas.getContext('2d');
            const data = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
            let yellow = 0;
            let palmWhite = 0;
            const magentaPoints: Array<{ x: number; y: number }> = [];
            for (let index = 0; index < data.length; index += 4) {
                if (data[index] === 255 && data[index + 1] === 214 && data[index + 2] === 10) {
                    yellow += 1;
                }
                if (data[index] === 240 && data[index + 1] === 240 && data[index + 2] === 240) {
                    palmWhite += 1;
                }
                if (data[index] === 255 && data[index + 1] === 45 && data[index + 2] === 149) {
                    const pixelIndex = index / 4;
                    magentaPoints.push({
                        x: pixelIndex % canvas.width,
                        y: Math.floor(pixelIndex / canvas.width),
                    });
                }
            }
            const video = canvas.parentElement?.querySelector('video');
            if (!video) {
                throw new Error('比較動画が見つかりません');
            }
            const pixelScaleX = canvas.width / video.clientWidth;
            const pixelScaleY = canvas.height / video.clientHeight;
            const containScale = Math.min(
                video.clientWidth / video.videoWidth,
                video.clientHeight / video.videoHeight,
            );
            const contentWidth = video.videoWidth * containScale;
            const contentHeight = video.videoHeight * containScale;
            const contentLeft = (video.clientWidth - contentWidth) / 2;
            const contentTop = (video.clientHeight - contentHeight) / 2;
            const wristCssX = contentLeft + 0.57 * contentWidth;
            const wristCssY = contentTop + 0.4 * contentHeight;
            const palmCenterCssX = contentLeft + 0.658 * contentWidth;
            const palmCenterCssY = contentTop + 0.444 * contentHeight;
            const palmWidthCss = Math.hypot(0.12 * contentWidth, 0.06 * contentHeight);
            const forearmX = wristCssX - palmCenterCssX;
            const forearmY = wristCssY - palmCenterCssY;
            const forearmLength = Math.hypot(forearmX, forearmY);
            const watchCssX = wristCssX + forearmX / forearmLength * palmWidthCss * 0.25;
            const watchCssY = wristCssY + forearmY / forearmLength * palmWidthCss * 0.25;
            const watchX = watchCssX * pixelScaleX;
            const watchY = watchCssY * pixelScaleY;
            const magentaXs = magentaPoints.map(point => point.x / pixelScaleX);
            const magentaYs = magentaPoints.map(point => point.y / pixelScaleY);
            const magentaMinimumX = Math.min(...magentaXs);
            const magentaMaximumX = Math.max(...magentaXs);
            const magentaMinimumY = Math.min(...magentaYs);
            const magentaMaximumY = Math.max(...magentaYs);
            return {
                contentHeight,
                contentLeft,
                contentTop,
                contentWidth,
                yellow,
                magenta: magentaPoints.length,
                magentaCenterX: (magentaMinimumX + magentaMaximumX) / 2,
                magentaCenterY: (magentaMinimumY + magentaMaximumY) / 2,
                magentaHeight: magentaMaximumY - magentaMinimumY,
                magentaWidth: magentaMaximumX - magentaMinimumX,
                maximumRadius: Math.max(...magentaPoints.map(point => (
                    Math.hypot(point.x - watchX, point.y - watchY)
                ))),
                palmWhite,
                watchCenterX: watchCssX,
            };
        })
    ));
}

test('ジャイロを後方100ms平均し、符号反転・明示欠測・100ms超の間隔で窓を切る', () => {
    const input: SignalSeries = {
        timestampsMs: Float64Array.from([0, 50, 100, 200, 300, 400, 501, 601, 701]),
        values: Float32Array.from([2, 4, 6, -4, NaN, 2, 6, 0, 0.99]),
    };
    const rotation = buildWatchRotationSeries(input);
    expect(Array.from(rotation.values)).toEqual([2, 3, 4, -4, NaN, 2, 6, 0, expect.closeTo(0.99, 5)]);
    expect(sampleWatchRotationAtTime(rotation, 199).side).toBe('left');
    expect(sampleWatchRotationAtTime(rotation, 200).side).toBe('right');
    expect(sampleWatchRotationAtTime(rotation, 300).state).toBe('unavailable');
    expect(sampleWatchRotationAtTime(rotation, 400).phase).toBe(0);
    expect(sampleWatchRotationAtTime(rotation, 501).phase).toBe(0);
    expect(sampleWatchRotationAtTime(rotation, 601).state).toBe('quiet');
    expect(sampleWatchRotationAtTime(rotation, 701).state).toBe('quiet');
});

test('リング位相は向きと強さに追従し、シークが決定的で、表示速度には上限がある', () => {
    const series = (rate: number) => buildWatchRotationSeries({
        timestampsMs: Float64Array.from([0, 100, 200]),
        values: Float32Array.from([rate, rate, rate]),
    });
    const slow = series(1);
    const fast = series(2);
    const right = series(-2);
    expect(sampleWatchRotationAtTime(slow, 100).phase).toBeCloseTo(-0.2);
    expect(sampleWatchRotationAtTime(fast, 100).phase).toBeCloseTo(-0.4);
    expect(sampleWatchRotationAtTime(right, 100).phase).toBeCloseTo(0.4);
    expect(sampleWatchRotationAtTime(fast, 150).phase).toBeCloseTo(-0.6);
    expect(sampleWatchRotationAtTime(series(100), 100).phase).toBeCloseTo(-0.4 * Math.PI);
    expect(sampleWatchRotationAtTime(series(0.999), 100).state).toBe('quiet');
    const before = sampleWatchRotationAtTime(fast, 150);
    sampleWatchRotationAtTime(fast, 290);
    expect(sampleWatchRotationAtTime(fast, 150)).toEqual(before);
});

test('リングは未来・明示欠測・100ms超の古いデータを表示しない', () => {
    const rotation = buildWatchRotationSeries({
        timestampsMs: Float64Array.from([0, 100, 150, 200, 500]),
        values: Float32Array.from([0, 2, NaN, -2, 4]),
    });
    expect(sampleWatchRotationAtTime(rotation, -1).state).toBe('unavailable');
    expect(sampleWatchRotationAtTime(rotation, NaN).state).toBe('unavailable');
    expect(sampleWatchRotationAtTime(rotation, 99).state).toBe('quiet');
    expect(sampleWatchRotationAtTime(rotation, 100).state).toBe('active');
    expect(sampleWatchRotationAtTime(rotation, 150).state).toBe('unavailable');
    expect(sampleWatchRotationAtTime(rotation, 199).state).toBe('unavailable');
    expect(sampleWatchRotationAtTime(rotation, 300).state).toBe('active');
    expect(sampleWatchRotationAtTime(rotation, 301).state).toBe('unavailable');
    expect(sampleWatchRotationAtTime(rotation, 500).phase).toBe(0);
});

test('手の表示サイズをヒステリシス付きでfull・compact・tinyへ分ける', () => {
    expect(resolveOverlayDetailLevel(48, null)).toBe('full');
    expect(resolveOverlayDetailLevel(47, null)).toBe('compact');
    expect(resolveOverlayDetailLevel(27, null)).toBe('tiny');

    expect(resolveOverlayDetailLevel(44, 'full')).toBe('full');
    expect(resolveOverlayDetailLevel(43, 'full')).toBe('compact');
    expect(resolveOverlayDetailLevel(51, 'compact')).toBe('compact');
    expect(resolveOverlayDetailLevel(52, 'compact')).toBe('full');
    expect(resolveOverlayDetailLevel(24, 'compact')).toBe('compact');
    expect(resolveOverlayDetailLevel(23, 'compact')).toBe('tiny');
    expect(resolveOverlayDetailLevel(31, 'tiny')).toBe('tiny');
    expect(resolveOverlayDetailLevel(32, 'tiny')).toBe('compact');
});

test('2記録を独立操作し、必要なときだけ2本を一括操作する', async ({ page }) => {
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionA);
    await uploadRecording(page, 'b', sessionB);

    await expect(page.getByText('記録Aは比較準備完了です')).toBeVisible();
    await expect(page.getByText('記録Bは比較準備完了です')).toBeVisible();
    const groupControlsBox = await page.locator('.comparison-group-controls').boundingBox();
    const videoGridBox = await page.locator('.comparison-video-grid').boundingBox();
    expect(groupControlsBox).not.toBeNull();
    expect(videoGridBox).not.toBeNull();
    expect(groupControlsBox?.y).toBeLessThan(videoGridBox?.y ?? 0);
    for (const id of ['a', 'b'] as const) {
        const controlsBox = await page.locator(
            `.comparison-video-panel.recording-${id} .comparison-video-controls`,
        ).boundingBox();
        const stageBox = await page.locator(
            `.comparison-video-panel.recording-${id} .comparison-video-stage`,
        ).boundingBox();
        expect(controlsBox).not.toBeNull();
        expect(stageBox).not.toBeNull();
        expect(controlsBox?.y).toBeLessThan(stageBox?.y ?? 0);
    }
    await page.getByText('手首回転グラフ（詳細）').click();
    await expect(page.getByRole('heading', { name: 'Watchの回転' })).toBeVisible();
    await expect(page.getByText('記録A・右手')).toBeVisible();
    await expect(page.getByText('記録B・右手')).toBeVisible();
    await expect(page.locator('.comparison-video-stage canvas')).toHaveCount(2);

    const endAInput = page.locator('#recording-a-end');
    const endBInput = page.locator('#recording-b-end');
    const endA = Number(await endAInput.inputValue());
    const endB = Number(await endBInput.inputValue()) * 0.8;
    await endBInput.fill(String(endB));
    await page.getByLabel('記録Aの再生位置').fill('500');
    await page.getByLabel('記録Bの再生位置').fill('625');

    await expect(page.getByTestId('recording-a-phase')).toHaveText('50%');
    await expect(page.getByTestId('recording-b-phase')).toHaveText('63%');
    await expect.poll(async () => page.locator('.comparison-video-stage video').evaluateAll(videos => (
        videos.map(video => Number(video.currentTime.toFixed(3)))
    ))).toEqual([Number((endA / 2).toFixed(3)), Number((endB * 0.625).toFixed(3))]);
    await expect.poll(async () => page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
        canvases.map(canvas => {
            const context = canvas.getContext('2d');
            const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let index = 3; pixels && index < pixels.length; index += 4) {
                if (pixels[index] > 0) return true;
            }
            return false;
        })
    ))).toEqual([true, true]);
    const drawnBounds = await page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
        canvases.map(canvas => {
            const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
            const video = canvas.parentElement?.querySelector('video');
            if (!video) throw new Error('比較動画が見つかりません');
            let minimumX = canvas.width;
            let minimumY = canvas.height;
            let maximumX = -1;
            let maximumY = -1;
            for (let index = 3; pixels && index < pixels.length; index += 4) {
                if (pixels[index] > 0) {
                    const pixelIndex = Math.floor(index / 4);
                    const x = pixelIndex % canvas.width;
                    const y = Math.floor(pixelIndex / canvas.width);
                    minimumX = Math.min(minimumX, x);
                    minimumY = Math.min(minimumY, y);
                    maximumX = Math.max(maximumX, x);
                    maximumY = Math.max(maximumY, y);
                }
            }
            const pixelScaleX = canvas.width / video.clientWidth;
            const pixelScaleY = canvas.height / video.clientHeight;
            const containScale = Math.min(
                video.clientWidth / video.videoWidth,
                video.clientHeight / video.videoHeight,
            );
            const contentWidth = video.videoWidth * containScale;
            const contentHeight = video.videoHeight * containScale;
            const contentLeft = (video.clientWidth - contentWidth) / 2 * pixelScaleX;
            const contentTop = (video.clientHeight - contentHeight) / 2 * pixelScaleY;
            return {
                minimumX,
                minimumY,
                maximumX,
                maximumY,
                contentLeft,
                contentTop,
                contentRight: contentLeft + contentWidth * pixelScaleX,
                contentBottom: contentTop + contentHeight * pixelScaleY,
            };
        })
    ));
    for (const bounds of drawnBounds) {
        expect(bounds.minimumX).toBeGreaterThanOrEqual(Math.floor(bounds.contentLeft) - 1);
        expect(bounds.minimumY).toBeGreaterThanOrEqual(Math.floor(bounds.contentTop) - 1);
        expect(bounds.maximumX).toBeLessThanOrEqual(Math.ceil(bounds.contentRight) + 1);
        expect(bounds.maximumY).toBeLessThanOrEqual(Math.ceil(bounds.contentBottom) + 1);
    }

    await page.locator('.comparison-video-stage video').evaluateAll(videos => {
        for (const video of videos) {
            video.play = () => Promise.resolve();
            video.pause = () => undefined;
        }
    });
    await page.getByRole('button', { name: '記録Aを再生' }).click();
    await expect(page.getByRole('button', { name: '記録Aを一時停止' })).toBeVisible();
    await expect(page.getByRole('button', { name: '記録Bを再生' })).toBeVisible();
    await page.locator('.comparison-video-panel.recording-a video').evaluate(video => {
        video.currentTime += 0.5;
    });
    await expect(page.getByTestId('recording-a-phase')).toHaveText('60%');
    await expect(page.getByTestId('recording-b-phase')).toHaveText('63%');
    await page.getByRole('button', { name: '記録Aを一時停止' }).click();

    await page.getByRole('button', { name: '2本を再生' }).click();
    await expect(page.getByRole('button', { name: '記録Aを一時停止' })).toBeVisible();
    await expect(page.getByRole('button', { name: '記録Bを一時停止' })).toBeVisible();
    await expect.poll(async () => page.locator('.comparison-video-stage video').evaluateAll(videos => (
        videos.map(video => video.playbackRate)
    ))).toEqual([1, 1]);

    await page.locator('.comparison-video-panel.recording-b video').evaluate((video, endSec) => {
        video.currentTime = Number(endSec);
    }, endB);
    await expect(page.getByTestId('recording-b-phase')).toHaveText('100%');
    await expect(page.getByRole('button', { name: '記録Bを再生' })).toBeVisible();
    await expect(page.getByRole('button', { name: '記録Aを一時停止' })).toBeVisible();

    await page.getByRole('button', { name: '2本を一時停止' }).click();
    await page.getByRole('button', { name: '2本を再生' }).click();
    await expect.poll(async () => page.locator('.comparison-video-stage video').evaluateAll(videos => (
        videos.map(video => Number(video.currentTime.toFixed(3)))
    ))).toEqual([Number((endA * 0.6).toFixed(3)), 0]);

    await page.getByRole('button', { name: '2本を一時停止' }).click();
    await page.locator('.comparison-video-panel.recording-b video').evaluate(video => {
        video.play = () => Promise.reject(new DOMException('拒否', 'NotAllowedError'));
    });
    await page.getByRole('button', { name: '2本を再生' }).click();
    await expect(page.getByRole('button', { name: '記録Aを一時停止' })).toBeVisible();
    await expect(page.getByRole('button', { name: '記録Bを再生' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(
        '記録Bを再生できませんでした。ファイルを確認してください',
    );
});

test('Hand＋Watch表示を決定的に描画し、映像のみでは派生情報を隠す', async ({ page }) => {
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        accelerationNorm: 0.05,
        gyroX: -2,
    });
    await uploadRecording(page, 'b', sessionB, {
        movingRightHand: true, rotationBurst: true,
        accelerationNorm: 0.60,
        gyroX: -4,
    });
    await expect(page.getByTestId('recording-a-motion-status')).toContainText('手速度：低');
    await page.getByLabel('記録Aの再生位置').fill('700');
    await page.getByLabel('記録Bの再生位置').fill('700');

    await expect(page.getByTestId('recording-a-motion-status')).toContainText('手速度：高');
    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'Watchの回転：右回転',
    );
    await expect(page.getByTestId('recording-b-motion-status')).toContainText(
        'Watchの回転：右回転',
    );
    await expect(page.getByLabel('可視化の凡例')).toContainText(
        '弧の長さは一定',
    );
    await expect(page.getByLabel('可視化の凡例')).toContainText(
        '+Xは左回転、−Xは右回転',
    );
    const markerStats = await readMarkerStats(page);
    expect(markerStats.every(stats => stats.yellow > 0 && stats.magenta > 0)).toBe(true);
    // 矢印が異なる位相にあり、ピクセル化による最大距離の差を2pxまで許容する。
    expect(Math.abs(markerStats[0].maximumRadius - markerStats[1].maximumRadius)).toBeLessThanOrEqual(2);
    for (const ring of await page.locator('.comparison-watch-rotation-value').all()) {
        await expect(ring).toHaveAttribute('stroke-dasharray', '0.75 0.25');
    }
    expect(markerStats[1].magenta / markerStats[0].magenta).toBeGreaterThan(0.8);
    expect(markerStats[1].magenta / markerStats[0].magenta).toBeLessThan(1.2);

    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -2,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');
    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'Watchの回転：右回転',
    );
    expect((await readMarkerStats(page))[0].magenta).toBeGreaterThan(0);

    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -2,
        oneGyroMissing: true,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');
    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'データ不足',
    );

    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        gyroGap: true,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');
    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'データ不足',
    );
    expect((await readMarkerStats(page))[0].magenta).toBe(0);
    await expect(page.getByTestId('recording-a-motion-status').locator('.comparison-watch-rotation-ring')).toHaveCount(0);

    const phaseABeforeToggle = await page.getByTestId('recording-a-phase').textContent();
    const phaseBBeforeToggle = await page.getByTestId('recording-b-phase').textContent();
    await page.getByRole('button', { name: '映像のみ' }).click();
    await expect(page.getByTestId('recording-a-phase')).toHaveText(phaseABeforeToggle ?? '');
    await expect(page.getByTestId('recording-b-phase')).toHaveText(phaseBBeforeToggle ?? '');
    await expect(page.getByLabel('可視化の凡例')).toHaveCount(0);
    await expect(page.getByText('手首回転グラフ（詳細）')).toHaveCount(0);
    await expect(page.locator('[data-testid$="-motion-status"]')).toHaveCount(0);
    await expect.poll(async () => page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
        canvases.every(canvas => {
            const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
            return !Array.from(data).some((value, index) => index % 4 === 3 && value !== 0);
        })
    ))).toBe(true);
});

test('強い回転だけ方向を表示し、カメラ鏡像・Hand検出・重力・他軸に依存しない', async ({ page }) => {
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionA, { movingRightHand: true, rotationBurst: true, gyroX: -2, durationMs: 2000 });
    await uploadRecording(page, 'b', sessionB, { movingRightHand: true, rotationBurst: true, gyroX: 2, durationMs: 2000 });
    await page.getByLabel('記録Aの再生位置').fill('350');
    await page.getByLabel('記録Bの再生位置').fill('350');
    const statusA = page.getByTestId('recording-a-motion-status');
    const statusB = page.getByTestId('recording-b-motion-status');
    await expect(statusA).toContainText('右回転');
    await expect(statusB).toContainText('左回転');
    await expect(statusA.locator('svg')).toHaveAttribute('data-rotation-side', 'right');
    await expect(statusB.locator('svg')).toHaveAttribute('data-rotation-side', 'left');
    await expect(statusA).not.toContainText('°');
    await expect(statusA).not.toContainText('姿勢');
    await expect(page.getByText('基準姿勢を設定', { exact: true })).toHaveCount(0);
    await page.locator('.comparison-video-grid').screenshot({ path: 'test-results/watch-gyro-rings.png' });

    await page.getByLabel('記録Aの再生位置').fill('800');
    await expect(statusA).toHaveAttribute('data-watch-state', 'quiet');
    await expect(statusA).toContainText('強い回転なし');
    await expect(statusA.locator('svg')).toHaveCount(0);
    expect((await readMarkerStats(page))[0].magenta).toBe(0);
    await expect(statusB).toContainText('左回転');
    await page.getByText('手首回転グラフ（詳細）').click();
    await expect(page.getByLabel('現在位置のWatchの回転')).toContainText('A右 0.00 rad/s');
    await page.getByLabel('記録Aの再生位置').fill('350');
    await expect(statusA).toHaveAttribute('data-watch-state', 'active');

    await page.setViewportSize({ width: 375, height: 850 });
    await page.locator('.comparison-video-grid').screenshot({ path: 'test-results/watch-gyro-mobile.png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const stage = page.locator('.recording-a .comparison-video-stage');
    const activeStageY = (await stage.boundingBox())!.y;
    await page.getByLabel('記録Aの再生位置').fill('800');
    await expect(statusA).toHaveAttribute('data-watch-state', 'quiet');
    expect(Math.abs((await stage.boundingBox())!.y - activeStageY)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 720 });

    for (const options of [{ mirroredHand: true }, { allHandsMissing: true }]) {
        await uploadRecording(page, 'b', sessionB, { rotationBurst: true, gyroX: -2, ...options });
        await page.getByLabel('記録Bの再生位置').fill('700');
        await expect(statusB).toContainText('右回転');
    }
    await expect(statusB).toContainText('手速度：取得不可');
    for (const gyroX of [0, 0.99, -0.99]) {
        await uploadRecording(page, 'a', sessionA, { movingRightHand: true, gyroX, gyroY: 12, gyroZ: -20 });
        await page.getByLabel('記録Aの再生位置').fill('700');
        await expect(statusA).toHaveAttribute('data-watch-state', 'quiet');
        expect((await readMarkerStats(page))[0].magenta).toBe(0);
    }
});

test('リングは動画時刻に同期し、停止・再開・シーク・動きを減らす設定を反映する', async ({ page }) => {
    await openComparison(page);
    await uploadRecording(page, 'a', 'capture_20260803_010101_001_01', { gyroX: -2, durationMs: 2000 });
    const ring = page.getByTestId('recording-a-motion-status').locator('svg');
    const phase = () => ring.getAttribute('data-animation-phase');
    const canvas = page.locator('.recording-a canvas');
    await page.getByLabel('記録Aの再生位置').fill('200');
    const initial = await phase();
    const initialPixels = await canvas.evaluate(canvas => canvas.toDataURL());
    await page.getByLabel('記録Aの再生位置').fill('250');
    expect(await phase()).not.toBe(initial);
    expect(await canvas.evaluate(canvas => canvas.toDataURL())).not.toBe(initialPixels);
    await page.getByLabel('記録Aの再生位置').fill('200');
    expect(await phase()).toBe(initial);
    expect(await canvas.evaluate(canvas => canvas.toDataURL())).toBe(initialPixels);
    await page.locator('.recording-a video').evaluate(video => {
        video.play = () => Promise.resolve();
        video.pause = () => undefined;
    });
    await page.getByRole('button', { name: '記録Aを再生' }).click();
    await page.locator('.recording-a video').evaluate(video => { video.currentTime = 0.5; });
    await expect.poll(phase).not.toBe(initial);
    await page.getByRole('button', { name: '記録Aを一時停止' }).click();
    const paused = await phase();
    const pausedPixels = await canvas.evaluate(canvas => canvas.toDataURL());
    await page.waitForTimeout(180);
    expect(await phase()).toBe(paused);
    expect(await canvas.evaluate(canvas => canvas.toDataURL())).toBe(pausedPixels);
    await page.getByRole('button', { name: '記録Aを再生' }).click();
    await page.locator('.recording-a video').evaluate(video => { video.currentTime = 0.6; });
    await expect.poll(phase).not.toBe(paused);
    await page.getByRole('button', { name: '記録Aを一時停止' }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(ring).toHaveAttribute('data-animation-phase', '0');
    const reducedPixels = await canvas.evaluate(canvas => canvas.toDataURL());
    await page.getByLabel('記録Aの再生位置').fill('400');
    await expect(ring).toHaveAttribute('data-animation-phase', '0');
    expect(await canvas.evaluate(canvas => canvas.toDataURL())).toBe(reducedPixels);
    await expect(page.getByTestId('recording-a-motion-status')).toContainText('右回転');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(ring).not.toHaveAttribute('data-animation-phase', '0');
});

test('片方の記録だけでもWatch表示の代替情報を提供する', async ({ page }) => {
    const sessionId = 'capture_20260803_010101_001_01';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionId, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -5,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');

    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'Watchの回転：右回転',
    );
    await expect(page.getByTestId('recording-b-motion-status')).toHaveCount(0);
});

test('遠距離では描画を縮小し、tiny表示でも固定回転ステータスを残す', async ({ page }) => {
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -6,
        rightPalmScale: 1.25,
    });
    await uploadRecording(page, 'b', sessionB, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -6,
        rightPalmScale: 0.75,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');
    await page.getByLabel('記録Bの再生位置').fill('700');

    const [full, compact] = await readMarkerStats(page);
    expect(full.yellow).toBeGreaterThan(0);
    expect(compact.yellow).toBeGreaterThan(0);
    expect(full.palmWhite).toBeGreaterThan(0);
    expect(compact.palmWhite).toBeGreaterThan(0);
    expect(compact.palmWhite).toBeLessThan(full.palmWhite);
    expect(compact.magentaWidth).toBeLessThan(full.magentaWidth * 0.85);
    await expect(page.locator('.recording-a canvas')).toHaveAttribute('data-overlay-detail', 'full');
    await expect(page.locator('.recording-b canvas')).toHaveAttribute('data-overlay-detail', 'compact');
    const compactScale = 0.75;
    const compactWristX = compact.contentLeft + 0.57 * compact.contentWidth;
    const compactWristY = compact.contentTop + 0.4 * compact.contentHeight;
    const compactPalmCenterX = compact.contentLeft + (
        0.57 + 0.088 * compactScale
    ) * compact.contentWidth;
    const compactPalmCenterY = compact.contentTop + (
        0.4 + 0.044 * compactScale
    ) * compact.contentHeight;
    const palmDirectionX = compactPalmCenterX - compactWristX;
    const palmDirectionY = compactPalmCenterY - compactWristY;
    const markerDirectionX = compact.magentaCenterX - compactWristX;
    const markerDirectionY = compact.magentaCenterY - compactWristY;
    expect(markerDirectionX * palmDirectionX + markerDirectionY * palmDirectionY).toBeLessThan(0);
    const compactPalmWidth = Math.hypot(
        0.12 * compactScale * compact.contentWidth,
        0.06 * compactScale * compact.contentHeight,
    );
    const markerOffset = Math.hypot(markerDirectionX, markerDirectionY);
    expect(markerOffset / compactPalmWidth).toBeGreaterThan(0.15);
    expect(markerOffset / compactPalmWidth).toBeLessThan(0.35);

    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -3,
        rightPalmScale: 1,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');
    await expect(page.locator('.recording-a canvas')).toHaveAttribute('data-overlay-detail', 'compact');

    await uploadRecording(page, 'a', sessionA, {
        movingRightHand: true, rotationBurst: true,
        gyroX: -6,
        rightPalmScale: 0.2,
    });
    await page.getByLabel('記録Aの再生位置').fill('700');
    const [tiny] = await readMarkerStats(page);
    await expect(page.locator('.recording-a canvas')).toHaveAttribute('data-overlay-detail', 'tiny');
    expect(tiny.yellow).toBe(0);
    expect(tiny.palmWhite).toBeGreaterThan(0);
    expect(tiny.palmWhite).toBeLessThan(compact.palmWhite);
    expect(tiny.magenta).toBeGreaterThan(0);
    expect(tiny.magentaWidth).toBeGreaterThanOrEqual(12);
    await expect(page.getByTestId('recording-a-motion-status')).toBeVisible();
    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'Watchの回転：右回転',
    );
    await expect(
        page.getByTestId('recording-a-motion-status').locator('.comparison-watch-rotation-ring'),
    ).toHaveAttribute('data-rotation-side', 'right');
});

test.describe('高DPI表示', () => {
    test.use({ deviceScaleFactor: 2 });

    test('CSS px基準のtiny表示を維持する', async ({ page }) => {
        const sessionA = 'capture_20260803_010101_001_01';
        const sessionB = 'capture_20260803_020202_002_02';
        await openComparison(page);
        for (const [id, sessionId, gyroX] of [
            ['a', sessionA, -2],
            ['b', sessionB, -5],
        ] as const) {
            await uploadRecording(page, id, sessionId, {
                movingRightHand: true, rotationBurst: true,
                rightPalmScale: 0.2,
                gyroX,
            });
            await page.getByLabel(`記録${id.toUpperCase()}の再生位置`).fill('700');
        }

        const stats = await readMarkerStats(page);
        const backingStores = await page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
            canvases.map(canvas => ({
                clientHeight: canvas.clientHeight,
                clientWidth: canvas.clientWidth,
                height: canvas.height,
                width: canvas.width,
            }))
        ));
        for (const canvas of backingStores) {
            expect(canvas.width).toBe(Math.round(canvas.clientWidth * 2));
            expect(canvas.height).toBe(Math.round(canvas.clientHeight * 2));
        }
        await expect(page.locator('.recording-a canvas')).toHaveAttribute('data-overlay-detail', 'tiny');
        await expect(page.locator('.recording-b canvas')).toHaveAttribute('data-overlay-detail', 'tiny');
        expect(stats.every(item => (
            item.yellow === 0 && item.magenta > 0 && item.palmWhite > 0
        ))).toBe(true);
        expect(stats[1].magenta / stats[0].magenta).toBeGreaterThan(0.75);
        expect(stats[1].magenta / stats[0].magenta).toBeLessThan(1.25);
        await page.setViewportSize({ width: 1000, height: 800 });
        await expect(page.locator('.recording-a canvas')).toHaveAttribute('data-overlay-detail', 'tiny');
        await expect.poll(async () => (
            page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
                canvases.every(canvas => (
                    canvas.width === Math.round(canvas.clientWidth * 2) &&
                    canvas.height === Math.round(canvas.clientHeight * 2)
                ))
            ))
        )).toBe(true);
        await expect(page.getByTestId('recording-a-motion-status')).toBeVisible();
        await expect(page.getByTestId('recording-b-motion-status')).toBeVisible();
    });
});

test('前腕方向が退化しても描画し、画面端ではWatch記号を内側へ収める', async ({ page }) => {
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionA, {
        collapsedForearmVector: true,
        movingRightHand: true, rotationBurst: true,
        gyroX: -6,
    });
    await uploadRecording(page, 'b', sessionB, {
        movingRightHand: true, rotationBurst: true,
        rightPalmAtLeftEdge: true,
        rightPalmScale: 6,
        gyroX: -6,
    });
    await page.getByLabel('記録Aの再生位置').fill('600');
    await page.getByLabel('記録Bの再生位置').fill('700');

    const [collapsed, edge] = await readMarkerStats(page);
    expect(collapsed.magenta).toBeGreaterThan(0);
    expect(Number.isFinite(collapsed.magentaCenterX)).toBe(true);
    const collapsedWristX = collapsed.contentLeft + 0.359 * collapsed.contentWidth;
    const collapsedWristY = collapsed.contentTop + 0.4545 * collapsed.contentHeight;
    expect(Math.hypot(
        collapsed.magentaCenterX - collapsedWristX,
        collapsed.magentaCenterY - collapsedWristY,
    )).toBeLessThan(3);
    expect(edge.magentaCenterX - edge.magentaWidth / 2).toBeGreaterThanOrEqual(edge.contentLeft);
    expect(edge.magentaCenterX + edge.magentaWidth / 2).toBeLessThanOrEqual(
        edge.contentLeft + edge.contentWidth,
    );
});

test('右Watch同期CSVが別sessionなら比較を開始しない', async ({ page }) => {
    const sessionId = 'capture_20260803_010101_001_01';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionId, {
        rightSessionId: 'capture_20260803_030303_003_03',
    });

    await expect(page.getByRole('alert')).toHaveText('動画・Hand CSVと同期CSVが別のsessionです');
    await expect(page.getByText('記録Aは比較準備完了です')).toHaveCount(0);
});

test('微小な右手誤検出には速度バーとWatchリングを表示しない', async ({ page }) => {
    const sessionA = 'capture_20260803_010101_001_01';
    const sessionB = 'capture_20260803_020202_002_02';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionA, { unusableRightPalm: true, rotationBurst: true });
    await uploadRecording(page, 'b', sessionB, { unusableRightPalm: true, rotationBurst: true });
    await page.getByLabel('記録Aの再生位置').fill('700');
    await page.getByLabel('記録Bの再生位置').fill('700');

    await expect(page.getByTestId('recording-a-motion-status')).toContainText('手速度：取得不可');
    await expect(page.getByTestId('recording-a-motion-status')).toContainText(
        'Watchの回転：右回転',
    );
    await expect(
        page.getByTestId('recording-a-motion-status').locator('.comparison-watch-rotation-ring'),
    ).toHaveAttribute('data-rotation-side', 'right');
    const rotationArcs = page
        .getByTestId('recording-a-motion-status')
        .locator('.comparison-watch-rotation-value');
    await expect(rotationArcs).toHaveCount(1);
    await expect(rotationArcs.first()).toBeVisible();
    const magentaCounts = await page.locator('.comparison-video-stage canvas').evaluateAll(canvases => (
        canvases.map(canvas => {
            const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
            let magenta = 0;
            for (let index = 0; index < data.length; index += 4) {
                if (data[index] === 255 && data[index + 1] === 45 && data[index + 2] === 149) {
                    magenta += 1;
                }
            }
            return magenta;
        })
    ));
    expect(magentaCounts).toEqual([0, 0]);
});

test('動画とCSVのsession不一致を拒否し、動画変更後に再検証する', async ({ page }) => {
    const sessionId = 'capture_20260803_010101_001_01';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionId);
    await expect(page.getByText('記録Aは比較準備完了です')).toBeVisible();

    await uploadRecording(page, 'a', sessionId, {
        videoSessionId: 'capture_20260803_040404_004_04',
    });
    await expect(page.getByRole('alert')).toHaveText('動画とHand CSVが別のsessionです');
    await expect(page.getByText('記録Aは比較準備完了です')).toHaveCount(0);

    await uploadRecording(page, 'a', sessionId, {
        videoSessionId: `prefix_${sessionId}`,
    });
    await expect(page.getByRole('alert')).toContainText('動画ファイル名からsessionを確認できません');
});

test('Hand未検出フレームを保持し、不正列を拒否する', async ({ page }) => {
    const sessionId = 'capture_20260803_010101_001_01';
    await openComparison(page);
    await uploadRecording(page, 'a', sessionId, { allHandsMissing: true });
    await expect(page.getByText('記録Aは比較準備完了です')).toBeVisible();
    await expect(page.getByTestId('recording-a-motion-status')).toContainText('手速度：取得不可');
    await expect(page.getByTestId('recording-a-motion-status')).toContainText('右回転');

    await uploadRecording(page, 'a', sessionId, { invalidHandColumn: true });
    await expect(page.getByRole('alert')).toContainText('CSVに必須列 wrist_x がありません');

    await uploadRecording(page, 'a', sessionId, { missingAccelColumn: true });
    await expect(page.getByText('記録Aは比較準備完了です')).toBeVisible();

    await uploadRecording(page, 'a', sessionId, { missingGyroXColumn: true });
    await expect(page.getByRole('alert')).toContainText('CSVに必須列 imu_gyro_x がありません');
    for (const options of [{ allGyroMissing: true }, { singleGyroSample: true }]) {
        await uploadRecording(page, 'a', sessionId, options);
        await expect(page.getByRole('alert')).toContainText('同期CSVに比較可能なimu_gyro_xがありません');
    }
    for (const invalidGyroX of ['NaN', 'Infinity', 'invalid', '1e99']) {
        await uploadRecording(page, 'a', sessionId, { invalidGyroX });
        await expect(page.getByRole('alert')).toContainText('imu_gyro_x');
    }
    await uploadRecording(page, 'a', sessionId, { missingImuIdentity: true });
    await expect(page.getByRole('alert')).toContainText('IMU値にsessionまたはwrist sideがありません');
    await uploadRecording(page, 'a', sessionId, { rightSide: 'left' });
    await expect(page.getByRole('alert')).toContainText('右手首用ではありません');

    await uploadRecording(page, 'a', sessionId, { emptyFirstTimestamp: true });
    await expect(page.getByRole('alert')).toHaveText('2行目のtimestamp_msが空です');

    await uploadRecording(page, 'a', sessionId, {
        imuStartsAt250: true,
        handOnlyAtStart: true,
    });
    await expect(page.getByText('記録Aは比較準備完了です')).toBeVisible();
});

test('動画読込エラーを利用者に表示する', async ({ page }) => {
    await openComparison(page);
    await page.locator('#recording-a-video').setInputFiles({
        name: 'capture_20260803_010101_001_01_labelstudio.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('not-a-video'),
    });
    await page.locator('.comparison-video-panel.recording-a video').dispatchEvent('error');

    await expect(page.getByRole('alert')).toHaveText(
        '記録Aの動画を読み込めません。形式またはcodecを確認してください',
    );

    await page.locator('#recording-a-video').setInputFiles({
        name: 'capture_20260803_010101_001_01_labelstudio.webm',
        mimeType: 'video/webm',
        buffer: Buffer.from(TINY_WEBM_BASE64, 'base64'),
    });
    await page.locator('.comparison-video-panel.recording-a video').evaluate(video => {
        Object.defineProperty(video, 'duration', { configurable: true, value: Number.NaN });
        video.dispatchEvent(new Event('loadedmetadata'));
    });
    await expect(page.getByRole('alert')).toHaveText('動画の長さを取得できません');
});
