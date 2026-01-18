import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { PoseSettings } from '../types/pose';
import { POSE_CONNECTIONS } from './poseConnections';

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
 * キャンバスをクリア
 */
export function clearCanvas(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
