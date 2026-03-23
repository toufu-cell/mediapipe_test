/**
 * 上半身ランドマークのインデックス定数
 * useMediaPipe.ts と motion 解析で共通使用
 */
export const POSE_LANDMARKS = {
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_INDEX: 19,
    RIGHT_INDEX: 20,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
} as const;

// 上半身検出の信頼度閾値
export const SHOULDER_VISIBILITY_THRESHOLD = 0.6;
export const ARM_VISIBILITY_THRESHOLD = 0.5;
