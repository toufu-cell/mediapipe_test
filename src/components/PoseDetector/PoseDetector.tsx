import { useEffect, useRef, useState, useCallback } from 'react';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { useCameraStream } from './useCameraStream';
import { useMediaPipe } from './useMediaPipe';
import { PoseCanvas, type PoseCanvasHandle } from './PoseCanvas';
import type { PoseSettings } from '../../types/pose';
import { DEFAULT_POSE_SETTINGS } from '../../types/pose';

interface PoseDetectorProps {
    settings?: PoseSettings;
    onCanvasReady?: (handle: PoseCanvasHandle) => void;
    onStreamReady?: (stream: MediaStream) => void;
}

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;

export function PoseDetector({
    settings = DEFAULT_POSE_SETTINGS,
    onCanvasReady,
    onStreamReady,
}: PoseDetectorProps) {
    const { videoRef, stream, error: cameraError, isLoading: cameraLoading, startCamera } = useCameraStream();
    const { isLoading: mediapipeLoading, error: mediapipeError, detectPose } = useMediaPipe();
    const [landmarks, setLandmarks] = useState<NormalizedLandmark[] | null>(null);
    const animationFrameRef = useRef<number | undefined>(undefined);
    const lastTimestampRef = useRef<number>(0);
    const canvasHandleRef = useRef<PoseCanvasHandle>(null);

    // カメラ開始
    useEffect(() => {
        startCamera();
    }, [startCamera]);

    // ストリーム準備通知
    useEffect(() => {
        if (stream && onStreamReady) {
            onStreamReady(stream);
        }
    }, [stream, onStreamReady]);

    // キャンバスハンドル通知
    useEffect(() => {
        if (canvasHandleRef.current && onCanvasReady) {
            onCanvasReady(canvasHandleRef.current);
        }
    }, [onCanvasReady]);

    // ポーズ検出ループ
    const runDetection = useCallback(() => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) {
            animationFrameRef.current = requestAnimationFrame(runDetection);
            return;
        }

        const timestamp = performance.now();
        // 同じタイムスタンプで連続検出しない
        if (timestamp !== lastTimestampRef.current) {
            const result = detectPose(video, timestamp);
            if (result && result.landmarks && result.landmarks.length > 0) {
                setLandmarks(result.landmarks[0]);
            } else {
                setLandmarks(null);
            }
            lastTimestampRef.current = timestamp;
        }

        animationFrameRef.current = requestAnimationFrame(runDetection);
    }, [detectPose, videoRef]);

    useEffect(() => {
        if (stream && !mediapipeLoading && !mediapipeError) {
            animationFrameRef.current = requestAnimationFrame(runDetection);
        }

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [stream, mediapipeLoading, mediapipeError, runDetection]);

    const isLoading = cameraLoading || mediapipeLoading;
    const error = cameraError?.message || mediapipeError;

    return (
        <div className="pose-detector">
            {isLoading && (
                <div className="loading-overlay">
                    <div className="loading-spinner"></div>
                    <p>
                        {cameraLoading && 'カメラを初期化中...'}
                        {mediapipeLoading && 'MediaPipeを読み込み中...'}
                    </p>
                </div>
            )}

            {error && (
                <div className="error-message">
                    <p>{error}</p>
                    {cameraError?.type === 'permission' && (
                        <button onClick={startCamera}>再試行</button>
                    )}
                </div>
            )}

            <div className="video-container">
                <video
                    ref={videoRef}
                    width={VIDEO_WIDTH}
                    height={VIDEO_HEIGHT}
                    autoPlay
                    playsInline
                    muted
                    style={{ display: error ? 'none' : 'block' }}
                />
                <PoseCanvas
                    ref={canvasHandleRef}
                    videoRef={videoRef}
                    landmarks={landmarks}
                    settings={settings}
                    width={VIDEO_WIDTH}
                    height={VIDEO_HEIGHT}
                />
            </div>
        </div>
    );
}
