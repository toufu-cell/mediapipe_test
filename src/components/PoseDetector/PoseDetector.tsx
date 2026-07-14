import { useEffect, useRef, useState, useCallback } from 'react';
import { useCameraStream } from './useCameraStream';
import { useMediaPipe } from './useMediaPipe';
import { PoseCanvas, type PoseCanvasHandle } from './PoseCanvas';
import { FpsDisplay } from '../common/FpsDisplay';
import { useFps } from '../../hooks/useFps';
import type { PoseSettings, DetectionResult } from '../../types/pose';
import { DEFAULT_POSE_SETTINGS } from '../../types/pose';
import { drawDetectionResults } from '../../utils/drawPose';

interface PoseDetectorProps {
    settings?: PoseSettings;
    onCanvasReady?: (handle: PoseCanvasHandle) => void;
    onStreamReady?: (stream: MediaStream) => void;
    onDetection?: (results: DetectionResult[], timestamp: number) => void;
    isRecording?: boolean;
}

const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;

export function PoseDetector({
    settings = DEFAULT_POSE_SETTINGS,
    onCanvasReady,
    onStreamReady,
    onDetection,
    isRecording = false,
}: PoseDetectorProps) {
    const { videoRef, stream, error: cameraError, isLoading: cameraLoading, startCamera } = useCameraStream();
    const { isLoading: mediapipeLoading, error: mediapipeError, detect } = useMediaPipe();
    const { fps, tick: fpsTick } = useFps();
    const [detectionResults, setDetectionResults] = useState<DetectionResult[]>([]);
    const animationFrameRef = useRef<number | undefined>(undefined);
    const lastTimestampRef = useRef<number>(0);
    const canvasHandleRef = useRef<PoseCanvasHandle>(null);
    const isRecordingRef = useRef<boolean>(false);
    const detectionResultsRef = useRef<DetectionResult[]>([]);
    const onDetectionRef = useRef(onDetection);
    onDetectionRef.current = onDetection;

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

    // 録画状態をrefに同期
    useEffect(() => {
        isRecordingRef.current = isRecording;
    }, [isRecording]);

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
            const results = detect(video, timestamp);
            setDetectionResults(results);
            detectionResultsRef.current = results;
            lastTimestampRef.current = timestamp;
            fpsTick();

            // モーション解析用コールバック
            onDetectionRef.current?.(results, timestamp);
        }

        // 録画中は録画用Canvasにビデオ+骨格を描画
        if (isRecordingRef.current && canvasHandleRef.current) {
            const recordingCanvas = canvasHandleRef.current.getRecordingCanvas();
            if (recordingCanvas) {
                const ctx = recordingCanvas.getContext('2d');
                if (ctx) {
                    // ビデオフレームを描画
                    ctx.drawImage(video, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
                    // 検出結果を描画
                    if (detectionResultsRef.current.length > 0) {
                        drawDetectionResults(ctx, detectionResultsRef.current, VIDEO_WIDTH, VIDEO_HEIGHT, settings);
                    }
                }
            }
        }

        animationFrameRef.current = requestAnimationFrame(runDetection);
    }, [detect, videoRef, settings, fpsTick]);

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

            <div className="video-container" style={{ position: 'relative' }}>
                <div className="pose-detector-fps">
                    <FpsDisplay fps={fps} label="検出 FPS" />
                </div>
                <video
                    ref={videoRef}
                    width={VIDEO_WIDTH}
                    height={VIDEO_HEIGHT}
                    autoPlay
                    playsInline
                    webkit-playsinline="true"
                    muted
                    style={{ display: error ? 'none' : 'block' }}
                />
                <PoseCanvas
                    ref={canvasHandleRef}
                    videoRef={videoRef}
                    detectionResults={detectionResults}
                    settings={settings}
                    width={VIDEO_WIDTH}
                    height={VIDEO_HEIGHT}
                />
            </div>
        </div>
    );
}
