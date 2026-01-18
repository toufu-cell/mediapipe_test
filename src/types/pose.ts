import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

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
