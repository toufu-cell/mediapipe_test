import { useRef, useState, useCallback } from 'react';
import type { DetectionResult } from '../types/pose';

/** seekタイムアウト (ms) */
const SEEK_TIMEOUT = 5000;
/** 完全性優先の固定サンプリング間隔 (30fps 相当) */
const SEEK_STEP = 1 / 30;
/** 中間サマリの出力間隔 */
const PERF_LOG_INTERVAL_FRAMES = 30;

interface PerfMetric {
    totalMs: number;
    maxMs: number;
}

interface AnalysisPerfStats {
    attemptedFrames: number;
    processedFrames: number;
    skippedFrames: number;
    poseResultFrames: number;
    handResultFrames: number;
    seek: PerfMetric;
    detect: PerfMetric;
    onFrame: PerfMetric;
    render: PerfMetric;
    loop: PerfMetric;
}

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
    /** 解析を開始 */
    startAnalysis: (
        detect: (video: HTMLVideoElement, timestamp: number) => DetectionResult[],
        onFrame: (results: DetectionResult[], timestamp: number) => void,
        resetPoseLandmarker: () => Promise<void>,
        onRenderFrame?: (video: HTMLVideoElement, results: DetectionResult[], timestamp: number) => void,
    ) => Promise<void>;
    /** 解析をキャンセル */
    cancelAnalysis: () => void;
    /** ファイル選択をクリア */
    clearFile: () => void;
}

function createPerfMetric(): PerfMetric {
    return {
        totalMs: 0,
        maxMs: 0,
    };
}

function createAnalysisPerfStats(): AnalysisPerfStats {
    return {
        attemptedFrames: 0,
        processedFrames: 0,
        skippedFrames: 0,
        poseResultFrames: 0,
        handResultFrames: 0,
        seek: createPerfMetric(),
        detect: createPerfMetric(),
        onFrame: createPerfMetric(),
        render: createPerfMetric(),
        loop: createPerfMetric(),
    };
}

function recordMetric(metric: PerfMetric, elapsedMs: number): void {
    metric.totalMs += elapsedMs;
    metric.maxMs = Math.max(metric.maxMs, elapsedMs);
}

function averageMs(metric: PerfMetric, count: number): number {
    if (count === 0) return 0;
    return metric.totalMs / count;
}

function roundMs(value: number): number {
    return Math.round(value * 100) / 100;
}

function buildPerfSummary(stats: AnalysisPerfStats, totalElapsedMs: number) {
    const processed = stats.processedFrames;
    const effectiveFps = totalElapsedMs > 0 ? (processed / totalElapsedMs) * 1000 : 0;
    return {
        attemptedFrames: stats.attemptedFrames,
        processedFrames: processed,
        skippedFrames: stats.skippedFrames,
        poseResultFrames: stats.poseResultFrames,
        handResultFrames: stats.handResultFrames,
        effectiveFps: roundMs(effectiveFps),
        avgSeekMs: roundMs(averageMs(stats.seek, processed)),
        maxSeekMs: roundMs(stats.seek.maxMs),
        avgDetectMs: roundMs(averageMs(stats.detect, processed)),
        maxDetectMs: roundMs(stats.detect.maxMs),
        avgOnFrameMs: roundMs(averageMs(stats.onFrame, processed)),
        maxOnFrameMs: roundMs(stats.onFrame.maxMs),
        avgRenderMs: roundMs(averageMs(stats.render, processed)),
        maxRenderMs: roundMs(stats.render.maxMs),
        avgLoopMs: roundMs(averageMs(stats.loop, processed)),
        maxLoopMs: roundMs(stats.loop.maxMs),
        totalElapsedMs: roundMs(totalElapsedMs),
    };
}

/**
 * 指定時刻へ seek して、描画可能なフレームが来るまで待つ。
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

/**
 * 先頭フレームがまだ decode されていない場合に備えて待つ。
 */
function waitForCurrentFrame(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            video.removeEventListener('loadeddata', onLoadedData);
            reject(new Error('Timed out waiting for current video frame data'));
        }, SEEK_TIMEOUT);

        const onLoadedData = () => {
            clearTimeout(timeout);
            resolve();
        };

        video.addEventListener('loadeddata', onLoadedData, { once: true });
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
        abortControllerRef.current?.abort();
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.src = '';
        }
        setFileName(null);
        setDuration(0);
        setProgress(0);
        setIsAnalyzing(false);
    }, []);

    const selectFile = useCallback((file: File) => {
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
                if (video.duration !== Infinity && !Number.isNaN(video.duration)) {
                    setDuration(video.duration);
                } else {
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
        if (videoRef.current) {
            videoRef.current.pause();
        }
        setIsAnalyzing(false);
    }, []);

    const startAnalysis = useCallback(async (
        detect: (video: HTMLVideoElement, timestamp: number) => DetectionResult[],
        onFrame: (results: DetectionResult[], timestamp: number) => void,
        resetPoseLandmarker: () => Promise<void>,
        onRenderFrame?: (video: HTMLVideoElement, results: DetectionResult[], timestamp: number) => void,
    ) => {
        const video = videoRef.current;
        if (!video || !video.duration || video.duration === Infinity || Number.isNaN(video.duration)) return;

        const controller = new AbortController();
        abortControllerRef.current = controller;
        setIsAnalyzing(true);
        setProgress(0);

        const analysisStartedAt = performance.now();
        const stats = createAnalysisPerfStats();
        const totalDuration = video.duration;
        let sampleIndex = 0;
        let lastTimestampMs = -1;

        console.info('[VideoAnalysis] start', {
            durationSec: roundMs(totalDuration),
            mode: 'deterministic-seek',
            seekStepSec: SEEK_STEP,
            hasRenderCallback: Boolean(onRenderFrame),
        });

        try {
            const resetStartedAt = performance.now();
            await resetPoseLandmarker();
            console.info('[VideoAnalysis] resetPoseLandmarker', {
                elapsedMs: roundMs(performance.now() - resetStartedAt),
            });

            video.pause();
            if (video.currentTime !== 0) {
                await waitForSeek(video, 0);
            } else {
                video.currentTime = 0;
                await waitForCurrentFrame(video);
            }

            while (!controller.signal.aborted) {
                const targetTimeSec = sampleIndex * SEEK_STEP;
                if (targetTimeSec > totalDuration) break;

                stats.attemptedFrames++;
                const loopStartedAt = performance.now();

                const seekStartedAt = performance.now();
                if (sampleIndex === 0) {
                    await waitForCurrentFrame(video);
                } else {
                    await waitForSeek(video, targetTimeSec);
                }
                const seekElapsedMs = performance.now() - seekStartedAt;
                recordMetric(stats.seek, seekElapsedMs);

                const timestampMs = video.currentTime * 1000;
                if (timestampMs <= lastTimestampMs) {
                    stats.skippedFrames++;
                    sampleIndex++;
                    continue;
                }
                lastTimestampMs = timestampMs;

                const detectStartedAt = performance.now();
                const results = detect(video, timestampMs);
                const detectElapsedMs = performance.now() - detectStartedAt;
                recordMetric(stats.detect, detectElapsedMs);

                if (results.some(result => result.type === 'pose')) {
                    stats.poseResultFrames++;
                }
                if (results.some(result => result.type === 'hand')) {
                    stats.handResultFrames++;
                }

                const onFrameStartedAt = performance.now();
                onFrame(results, timestampMs);
                const onFrameElapsedMs = performance.now() - onFrameStartedAt;
                recordMetric(stats.onFrame, onFrameElapsedMs);

                const renderStartedAt = performance.now();
                onRenderFrame?.(video, results, timestampMs);
                const renderElapsedMs = performance.now() - renderStartedAt;
                recordMetric(stats.render, renderElapsedMs);

                const loopElapsedMs = performance.now() - loopStartedAt;
                recordMetric(stats.loop, loopElapsedMs);
                stats.processedFrames++;

                console.debug('[VideoAnalysis] frame', {
                    frame: stats.processedFrames,
                    sampleIndex,
                    targetTimeSec: roundMs(targetTimeSec),
                    timestampMs: roundMs(timestampMs),
                    results: results.map(result => result.type),
                    seekMs: roundMs(seekElapsedMs),
                    detectMs: roundMs(detectElapsedMs),
                    onFrameMs: roundMs(onFrameElapsedMs),
                    renderMs: roundMs(renderElapsedMs),
                    loopMs: roundMs(loopElapsedMs),
                });

                if (stats.processedFrames % PERF_LOG_INTERVAL_FRAMES === 0) {
                    console.info(
                        '[VideoAnalysis] progress-summary',
                        buildPerfSummary(stats, performance.now() - analysisStartedAt),
                    );
                }

                setProgress(Math.min(1, targetTimeSec / totalDuration));
                sampleIndex++;
            }

            const summary = buildPerfSummary(stats, performance.now() - analysisStartedAt);
            if (controller.signal.aborted) {
                console.info('[VideoAnalysis] aborted', summary);
            } else {
                setProgress(1);
                console.info('[VideoAnalysis] completed', summary);
                console.table(summary);
            }
        } catch (error) {
            console.error('[VideoAnalysis] error', error);
        } finally {
            abortControllerRef.current = null;
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
