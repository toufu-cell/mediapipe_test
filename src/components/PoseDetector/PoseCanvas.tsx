import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { PoseSettings } from '../../types/pose';
import { drawPose, clearCanvas } from '../../utils/drawPose';

interface PoseCanvasProps {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    landmarks: NormalizedLandmark[] | null;
    settings: PoseSettings;
    width: number;
    height: number;
}

export interface PoseCanvasHandle {
    getCanvas: () => HTMLCanvasElement | null;
    captureFrame: () => string | null;
}

export const PoseCanvas = forwardRef<PoseCanvasHandle, PoseCanvasProps>(
    function PoseCanvas({ videoRef, landmarks, settings, width, height }, ref) {
        const canvasRef = useRef<HTMLCanvasElement>(null);

        useImperativeHandle(ref, () => ({
            getCanvas: () => canvasRef.current,
            captureFrame: () => {
                const canvas = canvasRef.current;
                const video = videoRef.current;
                if (!canvas || !video) return null;

                const ctx = canvas.getContext('2d');
                if (!ctx) return null;

                // キャプチャ用のオフスクリーンキャンバス
                const captureCanvas = document.createElement('canvas');
                captureCanvas.width = width;
                captureCanvas.height = height;
                const captureCtx = captureCanvas.getContext('2d');
                if (!captureCtx) return null;

                // ビデオフレームを描画
                captureCtx.drawImage(video, 0, 0, width, height);

                // 骨格を描画
                if (landmarks && landmarks.length > 0) {
                    drawPose(captureCtx, landmarks, width, height, settings);
                }

                return captureCanvas.toDataURL('image/png');
            },
        }));

        const draw = useCallback(() => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            if (!ctx || !canvas) return;

            clearCanvas(ctx);

            if (landmarks && landmarks.length > 0) {
                drawPose(ctx, landmarks, width, height, settings);
            }
        }, [landmarks, width, height, settings]);

        useEffect(() => {
            draw();
        }, [draw]);

        return (
            <canvas
                ref={canvasRef}
                width={width}
                height={height}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    pointerEvents: 'none',
                }}
            />
        );
    }
);
