import { useRef, useState, useCallback } from 'react';
import type { DetectionResult } from '../types/pose';

/** seekタイムアウト (ms) */
const SEEK_TIMEOUT = 5000;
/** seek間隔 (秒) - 30fps相当 */
const SEEK_STEP = 1 / 30;

interface UseVideoFileReturn {
    /** 動画ファイルを選択 */
    selectFile: (file: File) => void;
    /** 動画要素のref */
    videoRef: React.RefObject<HTMLVideoElement | null>;
    /** 選択されたファイル名 */
    fileName: string | null;
    /** 動画の長さ (秒) */
    duration: number;
    /** 解析進捗 (0-1) */
    progress: number;
    /** 解析中フラグ */
    isAnalyzing: boolean;
    /** オフライン解析を開始 */
    startAnalysis: (
        detect: (video: HTMLVideoElement, timestamp: number) => DetectionResult[],
        onFrame: (results: DetectionResult[], timestamp: number) => void,
        resetPoseLandmarker: () => Promise<void>,
    ) => Promise<void>;
    /** 解析をキャンセル */
    cancelAnalysis: () => void;
    /** ファイル選択をクリア */
    clearFile: () => void;
}

/**
 * seekedイベント + タイムアウトのPromiseラップ
 */
function waitForSeek(video: HTMLVideoElement, targetTime: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            video.removeEventListener('seeked', onSeeked);
            reject(new Error(`Seek timeout at ${targetTime}s`));
        }, SEEK_TIMEOUT);

        const onSeeked = () => {
            clearTimeout(timeout);
            resolve();
        };

        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = targetTime;
    });
}

export function useVideoFile(): UseVideoFileReturn {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const [duration, setDuration] = useState(0);
    const [progress, setProgress] = useState(0);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    const objectUrlRef = useRef<string | null>(null);

    const clearFile = useCallback(() => {
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.src = '';
        }
        setFileName(null);
        setDuration(0);
        setProgress(0);
        setIsAnalyzing(false);
    }, []);

    const selectFile = useCallback((file: File) => {
        // 前回のURLを解放
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
        }

        const url = URL.createObjectURL(file);
        objectUrlRef.current = url;
        setFileName(file.name);
        setProgress(0);
        setDuration(0);

        const video = videoRef.current;
        if (video) {
            video.src = url;
            video.addEventListener('loadedmetadata', () => {
                if (video.duration !== Infinity && !isNaN(video.duration)) {
                    setDuration(video.duration);
                } else {
                    // WebM等でdurationがInfinityの場合、末尾seekで実際の長さを取得
                    video.currentTime = Number.MAX_SAFE_INTEGER;
                    video.addEventListener('timeupdate', function onTimeUpdate() {
                        video.removeEventListener('timeupdate', onTimeUpdate);
                        const realDuration = video.currentTime;
                        video.currentTime = 0;
                        video.addEventListener('seeked', () => {
                            setDuration(realDuration);
                        }, { once: true });
                    });
                }
            }, { once: true });
        }
    }, []);

    const cancelAnalysis = useCallback(() => {
        abortControllerRef.current?.abort();
        setIsAnalyzing(false);
    }, []);

    const startAnalysis = useCallback(async (
        detect: (video: HTMLVideoElement, timestamp: number) => DetectionResult[],
        onFrame: (results: DetectionResult[], timestamp: number) => void,
        resetPoseLandmarker: () => Promise<void>,
    ) => {
        const video = videoRef.current;
        if (!video || !video.duration || video.duration === Infinity || isNaN(video.duration)) return;

        // 解析開始前にPoseLandmarkerをリセット（tracking stateクリア）
        await resetPoseLandmarker();

        const controller = new AbortController();
        abortControllerRef.current = controller;
        setIsAnalyzing(true);
        setProgress(0);

        const totalDuration = video.duration;
        let currentTime = 0;
        let lastTimestamp = -1;

        try {
            while (currentTime < totalDuration) {
                if (controller.signal.aborted) break;

                await waitForSeek(video, currentTime);

                // 動画時間基準のタイムスタンプ (ms)
                const timestampMs = video.currentTime * 1000;

                // 単調増加時刻の保証
                if (timestampMs <= lastTimestamp) {
                    currentTime += SEEK_STEP;
                    continue;
                }
                lastTimestamp = timestampMs;

                // 検出実行
                const results = detect(video, timestampMs);
                onFrame(results, timestampMs);

                // 進捗更新
                setProgress(currentTime / totalDuration);

                currentTime += SEEK_STEP;
            }

            // 完了
            setProgress(1);
        } catch (err) {
            if (!controller.signal.aborted) {
                console.error('Video analysis error:', err);
            }
        } finally {
            setIsAnalyzing(false);
        }
    }, []);

    return {
        selectFile,
        videoRef,
        fileName,
        duration,
        progress,
        isAnalyzing,
        startAnalysis,
        cancelAnalysis,
        clearFile,
    };
}
