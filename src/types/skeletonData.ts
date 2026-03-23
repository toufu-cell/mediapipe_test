/**
 * 骨格データ（全33点ランドマーク）の型定義
 * 骨格再生プレーヤーおよびJSONエクスポート用
 */

/** 1点のランドマーク座標 */
export interface LandmarkPoint {
    x: number;
    y: number;
    z: number;
    visibility: number;
}

/** 1フレーム分の骨格データ（全33点ランドマーク） */
export interface SkeletonFrame {
    frameIndex: number;
    /** 実測タイムスタンプ (ms) — timestamp基準再生のため必須 */
    timestampMs: number;
    /** 33点のランドマーク (MediaPipe Pose形式)。検出失敗時はnull */
    landmarks: LandmarkPoint[] | null;
}

/** エクスポート時のデータソース */
export type SkeletonSource = 'camera' | 'videoFile' | 'imported';

/** 骨格データファイルの全体構造 */
export interface SkeletonData {
    metadata: {
        /** スキーマバージョン（将来互換性のため） */
        schemaVersion: 1;
        exportedAt: string;
        frameCount: number;
        durationMs: number;
        /** 推定fps（参考値。再生はtimestamp基準。durationMs / frameCount で算出） */
        estimatedFps: number;
        source: SkeletonSource;
        /** ランドマークモデル識別 */
        landmarkModel: 'mediapipe-pose-33';
        /** 座標系 */
        coordinateSpace: 'normalized';
        /** キャプチャ時の解像度（aspect ratio復元用） */
        sourceWidth: number;
        sourceHeight: number;
        /** selfieモードで撮影されたか */
        mirrored: boolean;
    };
    frames: SkeletonFrame[];
}

/** バリデーション結果 */
export interface SkeletonValidationResult {
    valid: boolean;
    error?: string;
}

/** 期待するランドマーク数 */
export const EXPECTED_LANDMARK_COUNT = 33;

/** ファイルサイズ上限 (100MB) */
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * SkeletonDataのバリデーション
 * schemaVersion, landmarks数=33, x/y/z/visibility型をチェック
 */
export function validateSkeletonData(data: unknown): SkeletonValidationResult {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: '無効なJSONデータです' };
    }

    const obj = data as Record<string, unknown>;

    // metadata チェック
    if (!obj.metadata || typeof obj.metadata !== 'object') {
        return { valid: false, error: 'metadataフィールドがありません' };
    }

    const metadata = obj.metadata as Record<string, unknown>;

    if (metadata.schemaVersion !== 1) {
        return { valid: false, error: `未対応のスキーマバージョンです: ${metadata.schemaVersion}` };
    }

    if (metadata.landmarkModel !== 'mediapipe-pose-33') {
        return { valid: false, error: `未対応のランドマークモデルです: ${metadata.landmarkModel}` };
    }

    // frames チェック
    if (!Array.isArray(obj.frames)) {
        return { valid: false, error: 'framesフィールドが配列ではありません' };
    }

    const frames = obj.frames as unknown[];
    if (frames.length === 0) {
        return { valid: false, error: 'フレームデータが空です' };
    }

    // 先頭・中間・末尾のフレームをサンプルチェック
    const sampleIndices = [
        0,
        Math.floor(frames.length / 2),
        frames.length - 1,
    ];

    for (const idx of sampleIndices) {
        const frame = frames[idx] as Record<string, unknown>;

        if (typeof frame.frameIndex !== 'number') {
            return { valid: false, error: `フレーム${idx}: frameIndexが数値ではありません` };
        }
        if (typeof frame.timestampMs !== 'number') {
            return { valid: false, error: `フレーム${idx}: timestampMsが数値ではありません` };
        }

        // landmarks: null（検出失敗）は許容
        if (frame.landmarks === null) continue;

        if (!Array.isArray(frame.landmarks)) {
            return { valid: false, error: `フレーム${idx}: landmarksが配列またはnullではありません` };
        }

        const landmarks = frame.landmarks as unknown[];
        if (landmarks.length !== EXPECTED_LANDMARK_COUNT) {
            return { valid: false, error: `フレーム${idx}: ランドマーク数が${landmarks.length}です（${EXPECTED_LANDMARK_COUNT}を期待）` };
        }

        // 最初のランドマークの型チェック
        const lm = landmarks[0] as Record<string, unknown>;
        if (
            typeof lm.x !== 'number' ||
            typeof lm.y !== 'number' ||
            typeof lm.z !== 'number' ||
            typeof lm.visibility !== 'number'
        ) {
            return { valid: false, error: `フレーム${idx}: ランドマークのx/y/z/visibilityが数値ではありません` };
        }
    }

    return { valid: true };
}
