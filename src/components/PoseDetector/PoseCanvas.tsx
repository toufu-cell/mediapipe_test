import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { PoseSettings, DetectionResult } from '../../types/pose';
import { drawDetectionResults, clearCanvas } from '../../utils/drawPose';

interface PoseCanvasProps {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    detectionResults: DetectionResult[];
    settings: PoseSettings;
    width: number;
    height: number;
}

export interface PoseCanvasHandle {
    getCanvas: () => HTMLCanvasElement | null;
    captureFrame: () => string | null;
    getRecordingCanvas: () => HTMLCanvasElement | null;
    getRecordingStream: (fps?: number) => MediaStream | null;
}

export const PoseCanvas = forwardRef<PoseCanvasHandle, PoseCanvasProps>(
    function PoseCanvas({ videoRef, detectionResults, settings, width, height }, ref) {
        const canvasRef = useRef<HTMLCanvasElement>(null);
        const recordingCanvasRef = useRef<HTMLCanvasElement>(null);
        const recordingStreamRef = useRef<MediaStream | null>(null);

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

                // 検出結果を描画
                if (detectionResults.length > 0) {
                    drawDetectionResults(captureCtx, detectionResults, width, height, settings);
                }

                return captureCanvas.toDataURL('image/png');
            },
            getRecordingCanvas: () => recordingCanvasRef.current,
            getRecordingStream: (fps = 30) => {
                const canvas = recordingCanvasRef.current;
                if (!canvas) return null;

                // 既存のストリームがあれば再利用
                if (recordingStreamRef.current) {
                    return recordingStreamRef.current;
                }

                // Canvasからストリームを生成
                const stream = canvas.captureStream(fps);
                recordingStreamRef.current = stream;
                return stream;
            },
        }));

        const draw = useCallback(() => {
            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d');
            if (!ctx || !canvas) return;

            clearCanvas(ctx);

            if (detectionResults.length > 0) {
                drawDetectionResults(ctx, detectionResults, width, height, settings);
            }
        }, [detectionResults, width, height, settings]);

        useEffect(() => {
            draw();
        }, [draw]);

        return (
            <>
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
                {/* 録画用Canvas（非表示） */}
                <canvas
                    ref={recordingCanvasRef}
                    width={width}
                    height={height}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        pointerEvents: 'none',
                        visibility: 'hidden',
                    }}
                />
            </>
        );
    }
);
