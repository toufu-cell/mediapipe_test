import { useCallback, useRef, useState, useEffect } from 'react';
import { useMediaPipe } from './PoseDetector/useMediaPipe';
import { useVideoFile } from '../hooks/useVideoFile';
import { useFps } from '../hooks/useFps';
import { VideoFileInput } from './Controls/VideoFileInput';
import { FpsDisplay } from './common/FpsDisplay';
import type { DetectionResult, PoseSettings } from '../types/pose';
import { DEFAULT_POSE_SETTINGS } from '../types/pose';
import { drawDetectionResults, clearCanvas } from '../utils/drawPose';

interface VideoFileAnalyzerProps {
    onClearBuffers: () => void;
    processDetection: (results: DetectionResult[], timestamp: number) => void;
    onDetection?: (results: DetectionResult[], timestamp: number) => void;
    onVideoResolution?: (width: number, height: number) => void;
    settings?: PoseSettings;
}

/**
 * 動画ファイル解析用コンポーネント
 * 解析中に映像+骨格をリアルタイムプレビューする
 */
export function VideoFileAnalyzer({
    onClearBuffers,
    processDetection,
    onDetection,
    onVideoResolution,
    settings = DEFAULT_POSE_SETTINGS,
}: VideoFileAnalyzerProps) {
    const mediaPipe = useMediaPipe();
    const videoFile = useVideoFile();
    const { fps, tick: fpsTick, reset: fpsReset } = useFps();

    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

    const [videoSize, setVideoSize] = useState({ width: 640, height: 480 });

    // 動画ファイル選択時に解像度を取得
    useEffect(() => {
        const video = videoFile.videoRef.current;
        if (!video) return;
        const handleLoaded = () => {
            if (video.videoWidth && video.videoHeight) {
                setVideoSize({ width: video.videoWidth, height: video.videoHeight });
            }
        };
        video.addEventListener('loadedmetadata', handleLoaded);
        return () => video.removeEventListener('loadedmetadata', handleLoaded);
    }, [videoFile.videoRef, videoFile.fileName]);

    // processDetection + onDetection の両方を呼ぶ統合コールバック
    const handleFrame = useCallback((results: DetectionResult[], timestamp: number) => {
        processDetection(results, timestamp);
        onDetection?.(results, timestamp);
        fpsTick();
    }, [processDetection, onDetection, fpsTick]);

    // 各フレームで表示用Canvasに描画
    const handleRenderFrame = useCallback((
        video: HTMLVideoElement,
        results: DetectionResult[],
    ) => {
        const w = video.videoWidth || videoSize.width;
        const h = video.videoHeight || videoSize.height;

        // 表示用Canvas: 骨格のみ（video要素の上に重ねるため）
        const overlayCanvas = overlayCanvasRef.current;
        if (overlayCanvas) {
            const ctx = overlayCanvas.getContext('2d');
            if (ctx) {
                clearCanvas(ctx);
                if (results.length > 0) {
                    drawDetectionResults(ctx, results, w, h, settings);
                }
            }
        }
    }, [videoSize, settings]);

    const handleStartAnalysis = useCallback(async () => {
        onClearBuffers();
        fpsReset();
        const video = videoFile.videoRef.current;
        const w = video?.videoWidth || 640;
        const h = video?.videoHeight || 480;
        setVideoSize({ width: w, height: h });
        onVideoResolution?.(w, h);

        await videoFile.startAnalysis(
            mediaPipe.detect,
            handleFrame,
            mediaPipe.resetPoseLandmarker,
            handleRenderFrame,
        );

        // 表示用Canvasをクリア
        const overlayCanvas = overlayCanvasRef.current;
        if (overlayCanvas) {
            const ctx = overlayCanvas.getContext('2d');
            if (ctx) clearCanvas(ctx);
        }
    }, [videoFile, mediaPipe, handleFrame, handleRenderFrame, onClearBuffers, onVideoResolution, fpsReset]);

    const handleCancelAnalysis = useCallback(() => {
        videoFile.cancelAnalysis();
        // 表示用Canvasをクリア
        const overlayCanvas = overlayCanvasRef.current;
        if (overlayCanvas) {
            const ctx = overlayCanvas.getContext('2d');
            if (ctx) clearCanvas(ctx);
        }
    }, [videoFile]);

    return (
        <div className="video-file-section">
            <VideoFileInput
                fileName={videoFile.fileName}
                isAnalyzing={videoFile.isAnalyzing}
                progress={videoFile.progress}
                duration={videoFile.duration}
                onSelectFile={videoFile.selectFile}
                onStartAnalysis={handleStartAnalysis}
                onCancelAnalysis={handleCancelAnalysis}
                onClearFile={videoFile.clearFile}
            />

            {/* 動画プレビュー + 骨格オーバーレイ */}
            <div
                className="video-container"
                style={{
                    position: 'relative',
                    display: videoFile.isAnalyzing ? 'block' : 'none',
                    width: '100%',
                    maxWidth: `${videoSize.width}px`,
                    aspectRatio: `${videoSize.width} / ${videoSize.height}`,
                }}
            >
                <video
                    ref={videoFile.videoRef}
                    preload="auto"
                    muted
                    style={{
                        display: 'block',
                        width: '100%',
                        height: '100%',
                        objectFit: 'fill',
                    }}
                />
                <canvas
                    ref={overlayCanvasRef}
                    width={videoSize.width}
                    height={videoSize.height}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        pointerEvents: 'none',
                    }}
                />
            </div>

            {videoFile.isAnalyzing && fps !== null && (
                <div className="video-analysis-status">
                    <FpsDisplay fps={fps} label="解析 FPS" />
                </div>
            )}
            {mediaPipe.isLoading && (
                <div className="video-analysis-status">
                    <p>MediaPipeを読み込み中...</p>
                </div>
            )}
            {mediaPipe.error && (
                <div className="video-analysis-error">
                    <p>{mediaPipe.error}</p>
                </div>
            )}
        </div>
    );
}
