import { useRef, useEffect } from 'react';
import type { LandmarkPoint } from '../../types/skeletonData';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { drawPose, clearCanvas } from '../../utils/drawPose';
import type { PoseSettings } from '../../types/pose';

/** 骨格再生プレーヤー用の描画設定（ティール系） */
const PLAYER_POSE_SETTINGS: PoseSettings = {
    pointColor: '#0D9488',
    lineColor: '#0D9488',
    pointSize: 5,
    lineWidth: 2,
};

interface SkeletonPlayerCanvasProps {
    landmarks: LandmarkPoint[] | null;
    width: number;
    height: number;
    isMirrored: boolean;
}

/**
 * LandmarkPoint を NormalizedLandmark に変換
 * mirror適用時は x → 1-x
 */
function toNormalizedLandmarks(
    landmarks: LandmarkPoint[],
    mirrored: boolean,
): NormalizedLandmark[] {
    return landmarks.map(lm => ({
        x: mirrored ? 1 - lm.x : lm.x,
        y: lm.y,
        z: lm.z,
        visibility: lm.visibility,
    }));
}

export function SkeletonPlayerCanvas({
    landmarks,
    width,
    height,
    isMirrored,
}: SkeletonPlayerCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        clearCanvas(ctx);

        // 黒背景
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (landmarks) {
            const normalized = toNormalizedLandmarks(landmarks, isMirrored);
            drawPose(ctx, normalized, canvas.width, canvas.height, PLAYER_POSE_SETTINGS);
        }
    }, [landmarks, width, height, isMirrored]);

    // Canvas表示サイズの制限（元解像度のアスペクト比を維持しつつ最大640px幅）
    const displayWidth = Math.min(width, 640);
    const displayHeight = Math.round(displayWidth * (height / width));

    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={height}
            className="skeleton-player-canvas"
            style={{
                width: displayWidth,
                height: displayHeight,
                borderRadius: '8px',
            }}
        />
    );
}
