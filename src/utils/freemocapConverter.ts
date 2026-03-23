/**
 * FreeMoCap `by_frame.json` → SkeletonData 変換ユーティリティ
 */
import type { SkeletonData, LandmarkPoint, SkeletonFrame } from '../types/skeletonData';

// ── FreeMoCap 型定義 ──

interface FreeMoCapTrackedPoint {
    x: number;
    y: number;
    z: number;
}

interface FreeMoCapFrame {
    timestamps: {
        mean: number;
        by_camera: Record<string, number>;
    };
    tracked_points: Record<string, FreeMoCapTrackedPoint>;
}

interface FreeMoCapData {
    info: {
        schemas: Record<string, { proximal: string; distal: string }>;
    };
    data_by_frame: Record<string, FreeMoCapFrame>;
}

// ── body ポイント名 → MediaPipe インデックス（33点） ──

const BODY_POINT_NAMES: readonly string[] = [
    'body_nose',              // 0
    'body_left_eye_inner',    // 1
    'body_left_eye',          // 2
    'body_left_eye_outer',    // 3
    'body_right_eye_inner',   // 4
    'body_right_eye',         // 5
    'body_right_eye_outer',   // 6
    'body_left_ear',          // 7
    'body_right_ear',         // 8
    'body_mouth_left',        // 9
    'body_mouth_right',       // 10
    'body_left_shoulder',     // 11
    'body_right_shoulder',    // 12
    'body_left_elbow',        // 13
    'body_right_elbow',       // 14
    'body_left_wrist',        // 15
    'body_right_wrist',       // 16
    'body_left_pinky',        // 17
    'body_right_pinky',       // 18
    'body_left_index',        // 19
    'body_right_index',       // 20
    'body_left_thumb',        // 21
    'body_right_thumb',       // 22
    'body_left_hip',          // 23
    'body_right_hip',         // 24
    'body_left_knee',         // 25
    'body_right_knee',        // 26
    'body_left_ankle',        // 27
    'body_right_ankle',       // 28
    'body_left_heel',         // 29
    'body_right_heel',        // 30
    'body_left_foot_index',   // 31
    'body_right_foot_index',  // 32
] as const;

// ── 判定関数 ──

/**
 * FreeMoCap `by_frame.json` 形式かどうかを判定する。
 * data_by_frame の最小数値キーのフレームに body_nose が存在するかで判定。
 */
export function isFreeMoCapData(data: unknown): data is FreeMoCapData {
    if (!data || typeof data !== 'object') return false;

    const obj = data as Record<string, unknown>;
    if (!obj.data_by_frame || typeof obj.data_by_frame !== 'object') return false;

    const dataByFrame = obj.data_by_frame as Record<string, unknown>;
    const keys = Object.keys(dataByFrame);
    if (keys.length === 0) return false;

    // 最小の数値キーを取得
    const numericKeys = keys
        .map(k => Number(k))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => a - b);
    if (numericKeys.length === 0) return false;

    const firstKey = String(numericKeys[0]);
    const firstFrame = dataByFrame[firstKey] as Record<string, unknown> | undefined;
    if (!firstFrame || typeof firstFrame !== 'object') return false;

    const trackedPoints = firstFrame.tracked_points as Record<string, unknown> | undefined;
    if (!trackedPoints || typeof trackedPoints !== 'object') return false;

    return 'body_nose' in trackedPoints;
}

// ── 変換関数 ──

/**
 * FreeMoCap データを SkeletonData に変換する。
 * @throws 有効な座標データが1点もない場合、または有効ランドマークフレームが0の場合
 */
export function convertFreeMoCapToSkeletonData(data: FreeMoCapData): SkeletonData {
    // 1. フレームキーを数値ソート
    const frameKeys = Object.keys(data.data_by_frame)
        .map(k => Number(k))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => a - b);

    if (frameKeys.length === 0) {
        throw new Error('FreeMoCapデータにフレームがありません');
    }

    // 2. バウンディングボックス計算（isFinite な body 座標のみ）
    let xMin = Infinity;
    let xMax = -Infinity;
    let zMin = Infinity;
    let zMax = -Infinity;

    for (const key of frameKeys) {
        const frame = data.data_by_frame[String(key)];
        for (const name of BODY_POINT_NAMES) {
            const pt = frame.tracked_points[name];
            if (!pt) continue;
            if (Number.isFinite(pt.x)) {
                xMin = Math.min(xMin, pt.x);
                xMax = Math.max(xMax, pt.x);
            }
            if (Number.isFinite(pt.z)) {
                zMin = Math.min(zMin, pt.z);
                zMax = Math.max(zMax, pt.z);
            }
        }
    }

    if (!Number.isFinite(xMin) || !Number.isFinite(xMax) ||
        !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
        throw new Error('FreeMoCapデータに有効な座標が見つかりません');
    }

    // アスペクト比維持: 統一スケール + 中央寄せ + 5% マージン
    const xRange = xMax - xMin;
    const zRange = zMax - zMin;
    const range = Math.max(xRange, zRange);

    if (range === 0) {
        throw new Error('FreeMoCapデータの座標範囲が0です');
    }

    const margin = 0.05;
    const totalRange = range / (1 - 2 * margin);
    const xOffset = (range - xRange) / 2 + margin * totalRange;
    const zOffset = (range - zRange) / 2 + margin * totalRange;

    // 3. fps 推定（タイムスタンプ差分の中央値）
    const firstFrameMean = data.data_by_frame[String(frameKeys[0])].timestamps.mean;
    const deltas: number[] = [];
    for (let i = 1; i < frameKeys.length; i++) {
        const prev = data.data_by_frame[String(frameKeys[i - 1])].timestamps.mean;
        const curr = data.data_by_frame[String(frameKeys[i])].timestamps.mean;
        const delta = (curr - prev) / 1_000_000; // ナノ秒 → ms
        if (Number.isFinite(delta) && delta > 0) {
            deltas.push(delta);
        }
    }

    deltas.sort((a, b) => a - b);
    const medianDeltaMs = deltas.length > 0
        ? deltas[Math.floor(deltas.length / 2)]
        : 33.33; // フォールバック: ~30fps
    const estimatedFps = Math.round(1000 / medianDeltaMs);

    // 4. フレーム変換
    let validFrameCount = 0;
    let prevTimestampMs = -1;
    const frames: SkeletonFrame[] = [];

    for (let i = 0; i < frameKeys.length; i++) {
        const key = String(frameKeys[i]);
        const srcFrame = data.data_by_frame[key];

        // タイムスタンプ正規化（ナノ秒 → ms、先頭フレーム基準）
        let timestampMs = (srcFrame.timestamps.mean - firstFrameMean) / 1_000_000;

        // 非単調増加の場合は前フレーム + 1ms に補正
        if (timestampMs <= prevTimestampMs) {
            timestampMs = prevTimestampMs + 1;
        }
        prevTimestampMs = timestampMs;

        // body ポイント変換
        let allValid = true;
        const landmarks: LandmarkPoint[] = [];

        for (const name of BODY_POINT_NAMES) {
            const pt = srcFrame.tracked_points[name];
            if (!pt ||
                !Number.isFinite(pt.x) ||
                !Number.isFinite(pt.z)) {
                allValid = false;
                break;
            }

            landmarks.push({
                x: (pt.x - xMin + xOffset) / totalRange,
                y: 1 - (pt.z - zMin + zOffset) / totalRange, // z → 画面縦軸（反転）
                z: 0,
                visibility: 1.0,
            });
        }

        if (allValid && landmarks.length === 33) {
            validFrameCount++;
            frames.push({
                frameIndex: i,
                timestampMs,
                landmarks,
            });
        } else {
            frames.push({
                frameIndex: i,
                timestampMs,
                landmarks: null,
            });
        }
    }

    if (validFrameCount === 0) {
        throw new Error('FreeMoCapデータに有効なランドマークフレームがありません');
    }

    // 5. metadata 構築
    const lastTimestampMs = frames[frames.length - 1].timestampMs;

    const skeletonData: SkeletonData = {
        metadata: {
            schemaVersion: 1,
            source: 'imported',
            coordinateSpace: 'normalized',
            landmarkModel: 'mediapipe-pose-33',
            sourceWidth: 640,
            sourceHeight: 640,
            mirrored: false,
            estimatedFps,
            frameCount: frames.length,
            durationMs: lastTimestampMs,
            exportedAt: new Date().toISOString(),
        },
        frames,
    };

    return skeletonData;
}
