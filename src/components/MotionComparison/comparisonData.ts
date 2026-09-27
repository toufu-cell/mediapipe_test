export type WristSide = 'left' | 'right';

export const HAND_LANDMARK_COUNT = 21;
export const HAND_POINT_STRIDE = 2;
export const HAND_COORDINATES_PER_SIDE = HAND_LANDMARK_COUNT * HAND_POINT_STRIDE;

const COMPARISON_GRID_SIZE = 201;
const MAX_SIGNAL_GAP_MS = 100;
export const MIN_HAND_SCORE = 0.5;
export const MIN_PALM_WIDTH_PX = 8;
export const OVERLAY_FULL_PALM_WIDTH_PX = 48;
const OVERLAY_INITIAL_TINY_PALM_WIDTH_PX = 28;
const OVERLAY_FULL_ENTER_PALM_WIDTH_PX = 52;
const OVERLAY_FULL_EXIT_PALM_WIDTH_PX = 44;
const OVERLAY_TINY_ENTER_PALM_WIDTH_PX = 24;
const OVERLAY_TINY_EXIT_PALM_WIDTH_PX = 32;
const SPEED_SMOOTHING_WINDOW_MS = 400;
const MIN_SPEED_BAND_HOLD_MS = 500;
const LOW_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC = 8;
const HIGH_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC = 16;
const SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC = 1;
const WATCH_ROTATION_SMOOTHING_WINDOW_MS = 100;
// ponytail: この装着状態でのX軸試用。別収録で方向・検出を確認してから軸と閾値を調整する。
export const WATCH_ROTATION_THRESHOLD_RAD_PER_SEC = 1;
const WATCH_ROTATION_DISPLAY_GAIN = 2;
const WATCH_ROTATION_MAX_DISPLAY_RATE = 4 * Math.PI;
const HAND_LANDMARK_NAMES = [
    'wrist',
    'thumbCmc', 'thumbMcp', 'thumbIp', 'thumbTip',
    'indexFingerMcp', 'indexFingerPip', 'indexFingerDip', 'indexFingerTip',
    'middleFingerMcp', 'middleFingerPip', 'middleFingerDip', 'middleFingerTip',
    'ringFingerMcp', 'ringFingerPip', 'ringFingerDip', 'ringFingerTip',
    'pinkyMcp', 'pinkyPip', 'pinkyDip', 'pinkyTip',
] as const;

export interface ComparisonHandFrame {
    frameIndex: number;
    timestampMs: number;
    /** 左21点のxy、右21点のxyを格納する。未検出側はNaN。 */
    points: Float32Array;
    /** 左、右の順。未検出側はNaN。 */
    scores: Float32Array;
}

export interface SignalSeries {
    timestampsMs: Float64Array;
    values: Float32Array;
}

export interface WatchRotationSeries extends SignalSeries {
    /** 動画時刻に固定した演出用の位相。姿勢や実際の回転角度ではない。 */
    phases: Float64Array;
}

export interface ParsedHandMotion {
    frames: ComparisonHandFrame[];
}

export interface ParsedSyncedImu {
    sessionId: string;
    side: WristSide;
    watchRotationSignal: SignalSeries;
}

export interface ComparisonSessionData {
    sessionId: string;
    handFrames: ComparisonHandFrame[];
    rightWatchRotationSignal: SignalSeries;
    timelineStartSec: number;
    timelineEndSec: number;
}

export interface ComparisonInterval {
    startSec: number;
    endSec: number;
}

export type HandSpeedLevel = 1 | 2 | 3;
export type OverlayDetailLevel = 'full' | 'compact' | 'tiny';
export type WatchRotationSide = 'left' | 'right' | 'neutral' | 'missing';

/** この装着状態では+gyroXを左回転として試用。カメラの鏡像では反転しない。 */
export function resolveWatchRotationSide(value: number | null): WatchRotationSide {
    if (value === null || !Number.isFinite(value)) return 'missing';
    if (Math.abs(value) < WATCH_ROTATION_THRESHOLD_RAD_PER_SEC) return 'neutral';
    return value > 0 ? 'left' : 'right';
}

export function resolveOverlayDetailLevel(
    palmWidthPx: number,
    previous: OverlayDetailLevel | null,
): OverlayDetailLevel {
    if (previous === null) {
        if (palmWidthPx >= OVERLAY_FULL_PALM_WIDTH_PX) return 'full';
        if (palmWidthPx < OVERLAY_INITIAL_TINY_PALM_WIDTH_PX) return 'tiny';
        return 'compact';
    }
    if (previous === 'full') {
        if (palmWidthPx < OVERLAY_TINY_ENTER_PALM_WIDTH_PX) return 'tiny';
        return palmWidthPx < OVERLAY_FULL_EXIT_PALM_WIDTH_PX ? 'compact' : 'full';
    }
    if (previous === 'tiny') {
        if (palmWidthPx >= OVERLAY_FULL_ENTER_PALM_WIDTH_PX) return 'full';
        return palmWidthPx >= OVERLAY_TINY_EXIT_PALM_WIDTH_PX ? 'compact' : 'tiny';
    }
    if (palmWidthPx >= OVERLAY_FULL_ENTER_PALM_WIDTH_PX) return 'full';
    if (palmWidthPx < OVERLAY_TINY_ENTER_PALM_WIDTH_PX) return 'tiny';
    return 'compact';
}

export type ComparisonPlotData = [
    Float64Array,
    (number | null)[],
    (number | null)[],
];

interface SyncedImuCsvSchema {
    timestampIndex: number;
    sessionIdIndex: number;
    wristSideIndex: number;
    gyroXIndex: number;
    columnCount: number;
}

interface HandCsvSchema {
    timestampIndex: number;
    frameIndex: number;
    handednessIndex: number;
    scoreIndex: number;
    detectedIndex: number | null;
    pointColumns: Array<{ x: number; y: number }>;
    columnCount: number;
}

function abortError(): DOMException {
    return new DOMException('ファイルの読み込みを中止しました', 'AbortError');
}

function parseFinite(value: string, label: string, lineNumber: number): number {
    if (value.trim() === '') {
        throw new Error(`${lineNumber}行目の${label}が空です`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${lineNumber}行目の${label}が数値ではありません`);
    }
    return parsed;
}

function parseOptionalFinite(value: string, label: string, lineNumber: number): number | null {
    if (value.trim() === '') {
        return null;
    }
    return parseFinite(value, label, lineNumber);
}

function parseHeaders(headerLine: string): string[] {
    return headerLine
        .replace(/^\uFEFF/, '')
        .split(',')
        .map(header => header.trim());
}

function requiredColumn(headers: string[], name: string): number {
    const index = headers.indexOf(name);
    if (index < 0) {
        throw new Error(`CSVに必須列 ${name} がありません`);
    }
    return index;
}

function createSyncedImuSchema(headerLine: string): SyncedImuCsvSchema {
    const headers = parseHeaders(headerLine);
    return {
        timestampIndex: requiredColumn(headers, 'timestamp_ms'),
        sessionIdIndex: requiredColumn(headers, 'imu_session_id'),
        wristSideIndex: requiredColumn(headers, 'imu_wrist_side'),
        gyroXIndex: requiredColumn(headers, 'imu_gyro_x'),
        columnCount: headers.length,
    };
}

function createHandSchema(headerLine: string): HandCsvSchema {
    const headers = parseHeaders(headerLine);
    const pointColumns = HAND_LANDMARK_NAMES.map(name => {
        const x = requiredColumn(headers, `${name}_x`);
        const y = requiredColumn(headers, `${name}_y`);
        requiredColumn(headers, `${name}_z`);
        return { x, y };
    });
    return {
        timestampIndex: requiredColumn(headers, 'timestamp_ms'),
        frameIndex: requiredColumn(headers, 'frame_index'),
        handednessIndex: requiredColumn(headers, 'handedness'),
        scoreIndex: requiredColumn(headers, 'score'),
        detectedIndex: headers.includes('detected') ? headers.indexOf('detected') : null,
        pointColumns,
        columnCount: headers.length,
    };
}

function parseFrameIndex(value: string, lineNumber: number): number {
    const frameIndex = parseFinite(value, 'frame_index', lineNumber);
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
        throw new Error(`${lineNumber}行目のframe_indexが0以上の整数ではありません`);
    }
    return frameIndex;
}

async function readFileLines(
    file: File,
    onLine: (line: string, lineNumber: number) => void,
    signal?: AbortSignal,
): Promise<void> {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineNumber = 0;

    try {
        while (true) {
            if (signal?.aborted) {
                throw abortError();
            }
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });

            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex >= 0) {
                if (signal?.aborted) {
                    throw abortError();
                }
                lineNumber += 1;
                const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
                buffer = buffer.slice(newlineIndex + 1);
                if (line.trim() !== '') {
                    onLine(line, lineNumber);
                }
                newlineIndex = buffer.indexOf('\n');
            }

            if (done) {
                break;
            }
        }

        if (buffer.trim() !== '') {
            lineNumber += 1;
            onLine(buffer.replace(/\r$/, ''), lineNumber);
        }
    } finally {
        reader.releaseLock();
    }
}

function createEmptyHandPoints(): Float32Array {
    const points = new Float32Array(HAND_COORDINATES_PER_SIDE * 2);
    points.fill(Number.NaN);
    return points;
}

export async function parseHandMotionFile(
    file: File,
    signal?: AbortSignal,
): Promise<ParsedHandMotion> {
    let schema: HandCsvSchema | null = null;
    const frames: ComparisonHandFrame[] = [];
    let currentFrameIndex: number | null = null;
    let currentTimestampMs = 0;
    let currentPoints = createEmptyHandPoints();
    let currentFrameScores = new Float32Array([Number.NaN, Number.NaN]);
    let currentScores: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let currentSides: [boolean, boolean] = [false, false];

    const flushFrame = () => {
        if (currentFrameIndex !== null) {
            frames.push({
                frameIndex: currentFrameIndex,
                timestampMs: currentTimestampMs,
                points: currentPoints,
                scores: currentFrameScores,
            });
        }
    };

    await readFileLines(file, (line, lineNumber) => {
        if (!schema) {
            schema = createHandSchema(line);
            return;
        }
        const values = line.split(',');
        if (values.length !== schema.columnCount) {
            throw new Error(`${lineNumber}行目の列数がヘッダーと一致しません`);
        }

        const timestampMs = parseFinite(values[schema.timestampIndex], 'timestamp_ms', lineNumber);
        const frameIndex = parseFrameIndex(values[schema.frameIndex], lineNumber);
        if (timestampMs < 0) {
            throw new Error(`${lineNumber}行目のtimestamp_msが0未満です`);
        }

        if (currentFrameIndex === null) {
            currentFrameIndex = frameIndex;
            currentTimestampMs = timestampMs;
        } else if (frameIndex !== currentFrameIndex || timestampMs !== currentTimestampMs) {
            if (frameIndex <= currentFrameIndex || timestampMs <= currentTimestampMs) {
                throw new Error(`${lineNumber}行目のHandフレームが昇順ではありません`);
            }
            flushFrame();
            currentFrameIndex = frameIndex;
            currentTimestampMs = timestampMs;
            currentPoints = createEmptyHandPoints();
            currentFrameScores = new Float32Array([Number.NaN, Number.NaN]);
            currentScores = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
            currentSides = [false, false];
        }

        const handedness = values[schema.handednessIndex].trim();
        const sideIndex = handedness === 'Left' ? 0 : handedness === 'Right' ? 1 : null;
        if (sideIndex === null) {
            return;
        }
        if (schema.detectedIndex !== null && values[schema.detectedIndex].trim().toLowerCase() !== 'true') {
            return;
        }
        const parsedScore = parseOptionalFinite(values[schema.scoreIndex], 'score', lineNumber);
        const score = parsedScore ?? Number.NEGATIVE_INFINITY;
        if (currentSides[sideIndex] && score <= currentScores[sideIndex]) {
            return;
        }

        const sideOffset = sideIndex * HAND_COORDINATES_PER_SIDE;
        for (let pointIndex = 0; pointIndex < schema.pointColumns.length; pointIndex += 1) {
            const columns = schema.pointColumns[pointIndex];
            const pointOffset = sideOffset + pointIndex * HAND_POINT_STRIDE;
            currentPoints[pointOffset] = parseFinite(values[columns.x], 'Hand x座標', lineNumber);
            currentPoints[pointOffset + 1] = parseFinite(values[columns.y], 'Hand y座標', lineNumber);
        }
        currentSides[sideIndex] = true;
        currentScores[sideIndex] = score;
        currentFrameScores[sideIndex] = score;
    }, signal);

    flushFrame();
    if (!schema) {
        throw new Error('Hand CSVにヘッダーがありません');
    }
    if (frames.length < 2) {
        throw new Error('Hand CSVに比較可能なMediaPipe Hands 21点がありません');
    }
    return { frames };
}

export async function parseSyncedImuFile(
    file: File,
    expectedSide: WristSide,
    signal?: AbortSignal,
): Promise<ParsedSyncedImu> {
    let schema: SyncedImuCsvSchema | null = null;
    let sessionId = '';
    let observedSide = '';
    let previousTimestamp = -Infinity;
    const timestamps: number[] = [];
    const rotationValues: number[] = [];
    let validCount = 0;
    let firstValidIndex = -1;
    let lastValidIndex = -1;

    await readFileLines(file, (line, lineNumber) => {
        if (!schema) {
            schema = createSyncedImuSchema(line);
            return;
        }
        const values = line.split(',');
        if (values.length !== schema.columnCount) {
            throw new Error(`${lineNumber}行目の列数がヘッダーと一致しません`);
        }
        const timestampMs = parseFinite(values[schema.timestampIndex], 'timestamp_ms', lineNumber);
        if (timestampMs < 0 || timestampMs <= previousTimestamp) {
            throw new Error(`${lineNumber}行目のtimestamp_msが昇順ではありません`);
        }
        previousTimestamp = timestampMs;

        const rowSessionId = values[schema.sessionIdIndex].trim();
        const rowSide = values[schema.wristSideIndex].trim();
        if (rowSessionId !== '') {
            if (sessionId !== '' && sessionId !== rowSessionId) {
                throw new Error('同期CSVに複数のimu_session_idが含まれています');
            }
            sessionId = rowSessionId;
        }
        if (rowSide !== '') {
            if (rowSide !== 'left' && rowSide !== 'right') {
                throw new Error(`imu_wrist_side ${rowSide} は未対応です`);
            }
            if (observedSide !== '' && observedSide !== rowSide) {
                throw new Error('同期CSVに複数のimu_wrist_sideが含まれています');
            }
            observedSide = rowSide;
        }

        const gyroX = parseOptionalFinite(values[schema.gyroXIndex], 'imu_gyro_x', lineNumber);
        if (gyroX !== null) {
            if (!Number.isFinite(Math.fround(gyroX))) {
                throw new Error(`${lineNumber}行目のimu_gyro_xが表示可能な数値範囲を超えています`);
            }
            if (rowSessionId === '' || rowSide === '') {
                throw new Error(`${lineNumber}行目のIMU値にsessionまたはwrist sideがありません`);
            }
            if (firstValidIndex < 0) firstValidIndex = timestamps.length;
            lastValidIndex = timestamps.length;
            validCount++;
        }
        timestamps.push(timestampMs);
        rotationValues.push(gyroX ?? NaN);
    }, signal);

    if (!schema || previousTimestamp === -Infinity) {
        throw new Error('同期CSVにデータ行がありません');
    }
    if (sessionId === '') {
        throw new Error('同期CSVに有効なimu_session_idがありません');
    }
    if (observedSide !== expectedSide) {
        throw new Error(`選択したCSVは${expectedSide === 'left' ? '左' : '右'}手首用ではありません`);
    }
    if (validCount < 2) {
        throw new Error('同期CSVに比較可能なimu_gyro_xがありません');
    }
    return {
        sessionId,
        side: expectedSide,
        watchRotationSignal: {
            timestampsMs: Float64Array.from(timestamps.slice(firstValidIndex, lastValidIndex + 1)),
            values: Float32Array.from(rotationValues.slice(firstValidIndex, lastValidIndex + 1)),
        },
    };
}

export function createComparisonSessionData(
    hands: ParsedHandMotion,
    right: ParsedSyncedImu,
): ComparisonSessionData {
    if (right.side !== 'right') {
        throw new Error('選択した同期CSVは右手首用ではありません');
    }

    const firstHandFrame = hands.frames[0];
    const lastHandFrame = hands.frames[hands.frames.length - 1];
    const timelineStartMs = Math.max(
        firstHandFrame.timestampMs,
        right.watchRotationSignal.timestampsMs[0],
    );
    const timelineEndMs = Math.min(
        lastHandFrame.timestampMs,
        right.watchRotationSignal.timestampsMs[right.watchRotationSignal.timestampsMs.length - 1],
    );
    if (timelineEndMs <= timelineStartMs) {
        throw new Error('両手骨格と右IMUに共通する時間範囲がありません');
    }
    const hasHandInComparisonRange = hands.frames.some(frame => (
        frame.timestampMs >= timelineStartMs - MAX_SIGNAL_GAP_MS &&
        frame.timestampMs <= timelineEndMs + MAX_SIGNAL_GAP_MS
    ));
    if (!hasHandInComparisonRange) {
        throw new Error('両手骨格と右IMUの共通時間範囲に有効なHandがありません');
    }

    return {
        sessionId: right.sessionId,
        handFrames: hands.frames,
        rightWatchRotationSignal: right.watchRotationSignal,
        timelineStartSec: timelineStartMs / 1000,
        timelineEndSec: timelineEndMs / 1000,
    };
}

export function sessionTimeAtPhase(interval: ComparisonInterval, phase: number): number {
    const clampedPhase = Math.min(1, Math.max(0, phase));
    return interval.startSec + (interval.endSec - interval.startSec) * clampedPhase;
}

export function findHandFrame(
    frames: ComparisonHandFrame[],
    targetMs: number,
): ComparisonHandFrame | null {
    if (frames.length === 0) {
        return null;
    }
    let low = 0;
    let high = frames.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (frames[middle].timestampMs < targetMs) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    const previousIndex = Math.max(0, low - 1);
    const currentDistance = Math.abs(frames[low].timestampMs - targetMs);
    const previousDistance = Math.abs(frames[previousIndex].timestampMs - targetMs);
    const bestIndex = previousDistance <= currentDistance ? previousIndex : low;
    return Math.abs(frames[bestIndex].timestampMs - targetMs) <= MAX_SIGNAL_GAP_MS
        ? frames[bestIndex]
        : null;
}

interface PalmGeometry {
    centerX: number;
    centerY: number;
    width: number;
}

function rightPalmGeometry(
    frame: ComparisonHandFrame,
    videoWidth: number,
    videoHeight: number,
): PalmGeometry | null {
    const rightOffset = HAND_COORDINATES_PER_SIDE;
    if (frame.scores[1] < MIN_HAND_SCORE) {
        return null;
    }
    const palmIndices = [0, 5, 9, 13, 17];
    const points = palmIndices.map(index => {
        const offset = rightOffset + index * HAND_POINT_STRIDE;
        return {
            x: frame.points[offset] * videoWidth,
            y: frame.points[offset + 1] * videoHeight,
        };
    });
    if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        return null;
    }
    const width = Math.hypot(points[1].x - points[4].x, points[1].y - points[4].y);
    if (!Number.isFinite(width) || width < MIN_PALM_WIDTH_PX) {
        return null;
    }
    return {
        centerX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
        width,
    };
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

/**
 * 生成済みHand CSVの各side最良候補に対して、Python rendererと同じ速度段階を前計算する。
 * ponytail: accepted thresholds are duplicated across TS/Python for interactive interval changes;
 * move them to one generated schema if the visualization scale is revised.
 */
export function buildHandSpeedLevels(
    frames: ComparisonHandFrame[],
    interval: ComparisonInterval,
    videoWidth: number,
    videoHeight: number,
): Map<number, HandSpeedLevel> {
    const startMs = interval.startSec * 1000;
    const endMs = interval.endSec * 1000;
    const selectedFrames = frames.filter(frame => frame.timestampMs >= startMs && frame.timestampMs <= endMs);
    const geometries = selectedFrames.map(frame => rightPalmGeometry(frame, videoWidth, videoHeight));
    const usableWidths = geometries
        .filter((geometry): geometry is PalmGeometry => geometry !== null)
        .map(geometry => geometry.width);
    if (usableWidths.length === 0) {
        return new Map();
    }
    const representativePalmWidth = median(usableWidths);
    const consecutiveIntervals = selectedFrames.slice(1).flatMap((frame, index) => (
        frame.frameIndex === selectedFrames[index].frameIndex + 1
            ? [frame.timestampMs - selectedFrames[index].timestampMs]
            : []
    )).filter(intervalMs => intervalMs > 0);
    if (consecutiveIntervals.length === 0) {
        return new Map();
    }
    const expectedIntervalMs = median(consecutiveIntervals);
    const minimumIntervalMs = expectedIntervalMs * 0.5;
    const maximumIntervalMs = expectedIntervalMs * 1.5;
    const levels = new Map<number, HandSpeedLevel>();
    const speedSamples: Array<{ timestampMs: number; speed: number }> = [];
    let speedSampleStart = 0;
    let speedBand = 0;
    let lastBandChangeMs = selectedFrames[0].timestampMs;

    for (let index = 0; index < selectedFrames.length; index += 1) {
        const frame = selectedFrames[index];
        const geometry = geometries[index];
        const previousFrame = index > 0 ? selectedFrames[index - 1] : null;
        const previousGeometry = index > 0 ? geometries[index - 1] : null;
        if (geometry && previousFrame && previousGeometry && frame.frameIndex === previousFrame.frameIndex + 1) {
            const elapsedMs = frame.timestampMs - previousFrame.timestampMs;
            if (elapsedMs >= minimumIntervalMs && elapsedMs <= maximumIntervalMs) {
                const distance = Math.hypot(
                    geometry.centerX - previousGeometry.centerX,
                    geometry.centerY - previousGeometry.centerY,
                );
                speedSamples.push({
                    timestampMs: frame.timestampMs,
                    speed: distance / (elapsedMs / 1000) / representativePalmWidth,
                });
            }
        }

        const windowStartMs = frame.timestampMs - SPEED_SMOOTHING_WINDOW_MS;
        while (
            speedSampleStart < speedSamples.length &&
            speedSamples[speedSampleStart].timestampMs < windowStartMs
        ) {
            speedSampleStart += 1;
        }
        let speedSum = 0;
        for (let sampleIndex = speedSampleStart; sampleIndex < speedSamples.length; sampleIndex += 1) {
            speedSum += speedSamples[sampleIndex].speed;
        }
        const sampleCount = speedSamples.length - speedSampleStart;
        const smoothedSpeed = sampleCount > 0 ? speedSum / sampleCount : 0;
        const lowEnter = LOW_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC + SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC;
        const lowExit = LOW_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC - SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC;
        const highEnter = HIGH_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC + SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC;
        const highExit = HIGH_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC - SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC;
        let candidateBand = speedBand;
        if (speedBand === 0) {
            candidateBand = smoothedSpeed >= highEnter ? 2 : smoothedSpeed >= lowEnter ? 1 : 0;
        } else if (speedBand === 1) {
            candidateBand = smoothedSpeed >= highEnter ? 2 : smoothedSpeed < lowExit ? 0 : 1;
        } else {
            candidateBand = smoothedSpeed < lowExit ? 0 : smoothedSpeed < highExit ? 1 : 2;
        }
        if (candidateBand !== speedBand && frame.timestampMs - lastBandChangeMs >= MIN_SPEED_BAND_HOLD_MS) {
            speedBand = candidateBand;
            lastBandChangeMs = frame.timestampMs;
        }
        if (geometry) {
            levels.set(frame.timestampMs, (speedBand + 1) as HandSpeedLevel);
        }
    }
    return levels;
}

function displayRotationRate(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value) < WATCH_ROTATION_THRESHOLD_RAD_PER_SEC) return 0;
    return -Math.sign(value) * Math.min(Math.abs(value) * WATCH_ROTATION_DISPLAY_GAIN, WATCH_ROTATION_MAX_DISPLAY_RATE);
}

export function buildWatchRotationSeries(series: SignalSeries): WatchRotationSeries {
    const { timestampsMs } = series;
    const values = new Float32Array(series.values.length).fill(NaN);
    const phases = new Float64Array(series.values.length);
    let windowStart = 0;
    let windowSum = 0;
    for (let index = 0; index < series.values.length; index++) {
        const value = series.values[index];
        const previous = series.values[index - 1];
        const elapsed = index > 0 ? timestampsMs[index] - timestampsMs[index - 1] : Infinity;
        const continuous = Number.isFinite(value) && Number.isFinite(previous) && elapsed <= MAX_SIGNAL_GAP_MS;
        if (!continuous || Math.sign(value) !== Math.sign(previous)) {
            windowStart = index;
            windowSum = 0;
        }
        if (!Number.isFinite(value)) continue;
        windowSum += value;
        while (windowStart < index && timestampsMs[windowStart] < timestampsMs[index] - WATCH_ROTATION_SMOOTHING_WINDOW_MS) {
            windowSum -= series.values[windowStart++];
        }
        values[index] = windowSum / (index - windowStart + 1);
        phases[index] = continuous
            ? (phases[index - 1] + displayRotationRate(values[index - 1]) * elapsed / 1000) % (2 * Math.PI)
            : 0;
    }
    return { timestampsMs, values, phases };
}

export interface WatchRotationSample {
    rate: number | null;
    phase: number;
    side: WatchRotationSide;
    state: 'active' | 'quiet' | 'unavailable';
}

/** 未来を使わず、欠測・100ms超の古い値でリングを動かさない。 */
export function sampleWatchRotationAtTime(series: WatchRotationSeries, targetMs: number): WatchRotationSample {
    const unavailable: WatchRotationSample = { rate: null, phase: 0, side: 'missing', state: 'unavailable' };
    if (!Number.isFinite(targetMs)) return unavailable;
    let low = 0;
    let high = series.timestampsMs.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (series.timestampsMs[middle] <= targetMs) low = middle + 1;
        else high = middle;
    }
    const index = low - 1;
    const age = targetMs - series.timestampsMs[index];
    if (index < 0 || age > MAX_SIGNAL_GAP_MS) return unavailable;
    const rate = series.values[index];
    if (!Number.isFinite(rate)) return unavailable;
    const side = resolveWatchRotationSide(rate);
    return {
        rate,
        phase: (series.phases[index] + displayRotationRate(rate) * age / 1000) % (2 * Math.PI),
        side,
        state: side === 'neutral' ? 'quiet' : 'active',
    };
}

function resampleRotation(
    series: WatchRotationSeries,
    interval: ComparisonInterval,
    phases: Float64Array,
): (number | null)[] {
    return Array.from(phases, phase => (
        sampleWatchRotationAtTime(series, sessionTimeAtPhase(interval, phase) * 1000).rate
    ));
}

export function buildComparisonPlotData(
    sessionA: ComparisonSessionData,
    intervalA: ComparisonInterval,
    sessionB: ComparisonSessionData,
    intervalB: ComparisonInterval,
): ComparisonPlotData {
    const phases = new Float64Array(COMPARISON_GRID_SIZE);
    for (let index = 0; index < COMPARISON_GRID_SIZE; index += 1) {
        phases[index] = index / (COMPARISON_GRID_SIZE - 1);
    }
    return [
        phases,
        resampleRotation(buildWatchRotationSeries(sessionA.rightWatchRotationSignal), intervalA, phases),
        resampleRotation(buildWatchRotationSeries(sessionB.rightWatchRotationSignal), intervalB, phases),
    ];
}
