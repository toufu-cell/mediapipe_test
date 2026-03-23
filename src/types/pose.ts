import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

// 検出結果の種類
export type DetectionType = 'pose' | 'hand';

// 統合された検出結果
export interface DetectionResult {
    id: string;                          // 一意の識別子（React keyや追跡用）
    type: DetectionType;
    landmarks: NormalizedLandmark[];
    handedness?: string;                 // handの場合: 'Left' | 'Right' | その他（未知の値も許容）
}

// ID生成用ユーティリティ（crypto.randomUUIDでコリジョン回避）
// globalThis.crypto経由で型解決を安定させる
export function generateDetectionId(): string {
    return globalThis.crypto.randomUUID();
}

export interface PoseSettings {
    pointColor: string;
    lineColor: string;
    pointSize: number;
    lineWidth: number;
}

export interface RecordingState {
    isRecording: boolean;
    duration: number;
    estimatedSize: number;
}

export interface RecordingLimits {
    maxDurationMs: number;
    maxFileSizeBytes: number;
    warningThresholdPercent: number;
}

export const RECORDING_LIMITS: RecordingLimits = {
    maxDurationMs: 5 * 60 * 1000,
    maxFileSizeBytes: 150 * 1024 * 1024,
    warningThresholdPercent: 80,
};

export const DEFAULT_POSE_SETTINGS: PoseSettings = {
    pointColor: '#00FF00',
    lineColor: '#00FF00',
    pointSize: 5,
    lineWidth: 2,
};

export type PoseLandmarks = NormalizedLandmark[];

export interface CameraError {
    type: 'permission' | 'notfound' | 'unknown';
    message: string;
}
