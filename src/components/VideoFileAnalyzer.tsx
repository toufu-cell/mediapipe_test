import { useCallback } from 'react';
import { useMediaPipe } from './PoseDetector/useMediaPipe';
import { useVideoFile } from '../hooks/useVideoFile';
import { VideoFileInput } from './Controls/VideoFileInput';
import type { DetectionResult } from '../types/pose';

interface VideoFileAnalyzerProps {
    onClearBuffers: () => void;
    processDetection: (results: DetectionResult[], timestamp: number) => void;
    /** 全33点ランドマーク蓄積用コールバック（骨格JSONエクスポート用） */
    onDetection?: (results: DetectionResult[], timestamp: number) => void;
    /** 動画解像度が確定したときのコールバック */
    onVideoResolution?: (width: number, height: number) => void;
}

/**
 * 動画ファイル解析用コンポーネント
 * ビデオモード時のみマウントされ、専用のMediaPipeインスタンスを管理
 */
export function VideoFileAnalyzer({
    onClearBuffers,
    processDetection,
    onDetection,
    onVideoResolution,
}: VideoFileAnalyzerProps) {
    const mediaPipe = useMediaPipe();
    const videoFile = useVideoFile();

    // processDetection + onDetection の両方を呼ぶ統合コールバック
    const handleFrame = useCallback((results: DetectionResult[], timestamp: number) => {
        processDetection(results, timestamp);
        onDetection?.(results, timestamp);
    }, [processDetection, onDetection]);

    const handleStartAnalysis = useCallback(() => {
        onClearBuffers();
        // 動画解像度を通知
        const video = videoFile.videoRef.current;
        if (video && onVideoResolution) {
            onVideoResolution(video.videoWidth || 640, video.videoHeight || 480);
        }
        videoFile.startAnalysis(
            mediaPipe.detect,
            handleFrame,
            mediaPipe.resetPoseLandmarker,
        );
    }, [videoFile, mediaPipe, handleFrame, onClearBuffers, onVideoResolution]);

    return (
        <div className="video-file-section">
            <VideoFileInput
                fileName={videoFile.fileName}
                isAnalyzing={videoFile.isAnalyzing}
                progress={videoFile.progress}
                duration={videoFile.duration}
                onSelectFile={videoFile.selectFile}
                onStartAnalysis={handleStartAnalysis}
                onCancelAnalysis={videoFile.cancelAnalysis}
                onClearFile={videoFile.clearFile}
            />
            {/* 動画ファイル用の非表示video要素 */}
            <video
                ref={videoFile.videoRef}
                style={{ display: 'none' }}
                preload="auto"
                muted
            />
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
