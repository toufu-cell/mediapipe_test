import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { PoseSettings, DetectionResult } from '../types/pose';
import { POSE_CONNECTIONS } from './poseConnections';
import { HAND_CONNECTIONS } from './handConnections';

// 手の色定義（未知のhandednessにも対応）
const HAND_COLORS: Record<string, string> = {
    Left: '#FF6B6B',    // 左手: 赤系
    Right: '#4ECDC4',   // 右手: ティール系
};
const DEFAULT_HAND_COLOR = '#FFFF00';  // 不明時: 黄色

/**
 * ランドマークポイントを描画
 */
function drawLandmarkPoints(
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmark[],
    width: number,
    height: number,
    settings: PoseSettings
): void {
    ctx.fillStyle = settings.pointColor;

    for (const landmark of landmarks) {
        const x = landmark.x * width;
        const y = landmark.y * height;

        ctx.beginPath();
        ctx.arc(x, y, settings.pointSize, 0, 2 * Math.PI);
        ctx.fill();
    }
}

/**
 * ランドマーク間の接続線を描画
 */
function drawConnections(
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmark[],
    width: number,
    height: number,
    settings: PoseSettings
): void {
    ctx.strokeStyle = settings.lineColor;
    ctx.lineWidth = settings.lineWidth;
    ctx.lineCap = 'round';

    for (const [startIdx, endIdx] of POSE_CONNECTIONS) {
        const start = landmarks[startIdx];
        const end = landmarks[endIdx];

        if (start && end) {
            const startX = start.x * width;
            const startY = start.y * height;
            const endX = end.x * width;
            const endY = end.y * height;

            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.stroke();
        }
    }
}

/**
 * 骨格全体を描画
 */
export function drawPose(
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmark[],
    width: number,
    height: number,
    settings: PoseSettings
): void {
    // 接続線を先に描画（ポイントの下に表示）
    drawConnections(ctx, landmarks, width, height, settings);
    // ランドマークポイントを描画
    drawLandmarkPoints(ctx, landmarks, width, height, settings);
}

/**
 * 手のランドマークを描画
 */
export function drawHand(
    ctx: CanvasRenderingContext2D,
    landmarks: NormalizedLandmark[],
    width: number,
    height: number,
    handedness?: string,
    pointSize: number = 4,
    lineWidth: number = 2
): void {
    const color = (handedness && HAND_COLORS[handedness]) || DEFAULT_HAND_COLOR;

    // 接続線を描画
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    for (const [startIdx, endIdx] of HAND_CONNECTIONS) {
        const start = landmarks[startIdx];
        const end = landmarks[endIdx];
        if (start && end) {
            ctx.beginPath();
            ctx.moveTo(start.x * width, start.y * height);
            ctx.lineTo(end.x * width, end.y * height);
            ctx.stroke();
        }
    }

    // ポイントを描画
    ctx.fillStyle = color;
    for (const landmark of landmarks) {
        ctx.beginPath();
        ctx.arc(landmark.x * width, landmark.y * height, pointSize, 0, 2 * Math.PI);
        ctx.fill();
    }
}

/**
 * 検出結果を描画（Pose/Hand統合）
 */
export function drawDetectionResults(
    ctx: CanvasRenderingContext2D,
    results: DetectionResult[],
    width: number,
    height: number,
    poseSettings: PoseSettings
): void {
    for (const result of results) {
        if (result.type === 'pose') {
            // 既存のdrawPoseをそのまま使用（リグレッション防止）
            drawPose(ctx, result.landmarks, width, height, poseSettings);
        } else if (result.type === 'hand') {
            drawHand(ctx, result.landmarks, width, height, result.handedness);
        }
    }
}

/**
 * キャンバスをクリア
 */
export function clearCanvas(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
