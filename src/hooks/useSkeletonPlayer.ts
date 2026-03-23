import { useState, useRef, useCallback, useEffect } from 'react';
import type { SkeletonData, LandmarkPoint } from '../types/skeletonData';
import { validateSkeletonData, MAX_FILE_SIZE_BYTES } from '../types/skeletonData';
import { isFreeMoCapData, convertFreeMoCapToSkeletonData } from '../utils/freemocapConverter';

/** 再生速度の選択肢 */
export const SPEED_OPTIONS = [0.25, 0.5, 1, 2] as const;
export type PlaybackSpeed = typeof SPEED_OPTIONS[number];

export interface UseSkeletonPlayerReturn {
    /** データ読み込み */
    loadFile: (file: File) => Promise<void>;
    loadedData: SkeletonData | null;
    /** 再生状態 */
    isPlaying: boolean;
    currentFrame: number;
    totalFrames: number;
    /** 現在フレームのランドマーク */
    currentLandmarks: LandmarkPoint[] | null;
    /** 現在の時刻 (ms) */
    currentTimeMs: number;
    /** 総再生時間 (ms) */
    totalDurationMs: number;
    /** コントロール */
    play: () => void;
    pause: () => void;
    togglePlayPause: () => void;
    stepForward: () => void;
    stepBackward: () => void;
    seek: (frame: number) => void;
    setSpeed: (speed: PlaybackSpeed) => void;
    speed: PlaybackSpeed;
    /** ミラー */
    isMirrored: boolean;
    toggleMirror: () => void;
    /** 状態 */
    isLoading: boolean;
    error: string | null;
}

export function useSkeletonPlayer(): UseSkeletonPlayerReturn {
    const [loadedData, setLoadedData] = useState<SkeletonData | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentFrame, setCurrentFrame] = useState(0);
    const [speed, setSpeedState] = useState<PlaybackSpeed>(1);
    const [isMirrored, setIsMirrored] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // refs for rAF loop
    const dataRef = useRef<SkeletonData | null>(null);
    const frameRef = useRef(0);
    const speedRef = useRef<PlaybackSpeed>(1);
    const rafIdRef = useRef<number | null>(null);
    const lastTimeRef = useRef<number | null>(null);
    const accumulatorRef = useRef(0);

    // 直前の有効ランドマーク（検出失敗フレーム用）
    const lastValidLandmarksRef = useRef<LandmarkPoint[] | null>(null);

    // 現在のランドマーク（描画用）
    const [currentLandmarks, setCurrentLandmarks] = useState<LandmarkPoint[] | null>(null);

    // データ同期
    useEffect(() => {
        dataRef.current = loadedData;
    }, [loadedData]);

    useEffect(() => {
        speedRef.current = speed;
    }, [speed]);

    /** ファイル読み込み */
    const loadFile = useCallback(async (file: File) => {
        setIsLoading(true);
        setError(null);

        // 既存のrAFループを確実に停止
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        setIsPlaying(false);
        lastTimeRef.current = null;
        accumulatorRef.current = 0;

        // ファイルサイズチェック
        if (file.size > MAX_FILE_SIZE_BYTES) {
            setError(`ファイルサイズが上限（${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB）を超えています`);
            setIsLoading(false);
            return;
        }

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);

            let data: SkeletonData;
            if (isFreeMoCapData(parsed)) {
                data = convertFreeMoCapToSkeletonData(parsed);
            } else {
                const validation = validateSkeletonData(parsed);
                if (!validation.valid) {
                    setError(validation.error ?? '不明なバリデーションエラー');
                    setIsLoading(false);
                    return;
                }
                data = parsed as SkeletonData;
            }
            setLoadedData(data);
            dataRef.current = data;
            setCurrentFrame(0);
            frameRef.current = 0;
            lastValidLandmarksRef.current = null;

            // 初回フレームのランドマークを設定
            const firstFrame = data.frames[0];
            if (firstFrame?.landmarks) {
                setCurrentLandmarks(firstFrame.landmarks);
                lastValidLandmarksRef.current = firstFrame.landmarks;
            } else {
                setCurrentLandmarks(null);
            }

            // metadata.mirrored に基づきミラー初期値を設定
            setIsMirrored(data.metadata.mirrored);
        } catch {
            setError('JSONファイルの解析に失敗しました。有効な骨格データファイルを選択してください。');
        } finally {
            setIsLoading(false);
        }
    }, []);

    /** フレーム更新（描画用ランドマークの計算） */
    const updateFrameLandmarks = useCallback((frameIndex: number) => {
        const data = dataRef.current;
        if (!data) return;

        const frame = data.frames[frameIndex];
        if (!frame) return;

        if (frame.landmarks) {
            lastValidLandmarksRef.current = frame.landmarks;
            setCurrentLandmarks(frame.landmarks);
        } else {
            // 検出失敗フレーム: 直前の有効フレームを維持表示
            setCurrentLandmarks(lastValidLandmarksRef.current);
        }
    }, []);

    /** rAFループ: timestamp基準再生 */
    const tick = useCallback((now: number) => {
        const data = dataRef.current;
        if (!data || data.frames.length === 0) return;

        if (lastTimeRef.current === null) {
            lastTimeRef.current = now;
            rafIdRef.current = requestAnimationFrame(tick);
            return;
        }

        const deltaMs = now - lastTimeRef.current;
        lastTimeRef.current = now;

        // tab非アクティブで大きなdeltaが来た場合、accumulator リセット
        if (deltaMs > 500) {
            accumulatorRef.current = 0;
            rafIdRef.current = requestAnimationFrame(tick);
            return;
        }

        accumulatorRef.current += deltaMs * speedRef.current;

        const frames = data.frames;
        let idx = frameRef.current;

        // 次フレームとの時間差を超えたらフレームを進める
        while (idx < frames.length - 1) {
            const currentTimestamp = frames[idx].timestampMs;
            const nextTimestamp = frames[idx + 1].timestampMs;
            const frameDuration = nextTimestamp - currentTimestamp;

            if (frameDuration <= 0 || accumulatorRef.current < frameDuration) {
                break;
            }

            accumulatorRef.current -= frameDuration;
            idx++;
        }

        // ループ再生: 最後のフレームに達したら先頭に戻る
        if (idx >= frames.length - 1) {
            idx = 0;
            accumulatorRef.current = 0;
            lastValidLandmarksRef.current = null;
        }

        if (idx !== frameRef.current) {
            frameRef.current = idx;
            setCurrentFrame(idx);
            updateFrameLandmarks(idx);
        }

        rafIdRef.current = requestAnimationFrame(tick);
    }, [updateFrameLandmarks]);

    /** 再生開始 */
    const play = useCallback(() => {
        if (!dataRef.current || dataRef.current.frames.length === 0) return;
        setIsPlaying(true);
        lastTimeRef.current = null;
        accumulatorRef.current = 0;
        rafIdRef.current = requestAnimationFrame(tick);
    }, [tick]);

    /** 一時停止 */
    const pause = useCallback(() => {
        setIsPlaying(false);
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        lastTimeRef.current = null;
    }, []);

    /** 再生/一時停止トグル */
    const togglePlayPause = useCallback(() => {
        if (isPlaying) {
            pause();
        } else {
            play();
        }
    }, [isPlaying, play, pause]);

    /** 1フレーム進む */
    const stepForward = useCallback(() => {
        const data = dataRef.current;
        if (!data) return;
        pause();
        const nextFrame = Math.min(frameRef.current + 1, data.frames.length - 1);
        frameRef.current = nextFrame;
        setCurrentFrame(nextFrame);
        updateFrameLandmarks(nextFrame);
    }, [pause, updateFrameLandmarks]);

    /** 1フレーム戻る */
    const stepBackward = useCallback(() => {
        const data = dataRef.current;
        if (!data) return;
        pause();
        const prevFrame = Math.max(frameRef.current - 1, 0);
        frameRef.current = prevFrame;
        setCurrentFrame(prevFrame);
        updateFrameLandmarks(prevFrame);
    }, [pause, updateFrameLandmarks]);

    /** シーク */
    const seek = useCallback((frame: number) => {
        const data = dataRef.current;
        if (!data) return;

        const clamped = Math.max(0, Math.min(frame, data.frames.length - 1));
        frameRef.current = clamped;
        setCurrentFrame(clamped);
        accumulatorRef.current = 0;

        // シーク時は lastValidLandmarks をリセットし、シーク先から再構築
        lastValidLandmarksRef.current = null;
        // シーク先以前の直近の有効フレームを探す
        for (let i = clamped; i >= 0; i--) {
            if (data.frames[i].landmarks) {
                lastValidLandmarksRef.current = data.frames[i].landmarks;
                break;
            }
        }
        updateFrameLandmarks(clamped);
    }, [updateFrameLandmarks]);

    /** 速度変更 */
    const setSpeed = useCallback((newSpeed: PlaybackSpeed) => {
        setSpeedState(newSpeed);
        speedRef.current = newSpeed;
        accumulatorRef.current = 0;
    }, []);

    /** ミラートグル */
    const toggleMirror = useCallback(() => {
        setIsMirrored(prev => !prev);
    }, []);

    // visibilitychange対応: tab非アクティブ時に再同期
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                // tab非アクティブ: rAFは自動停止するが、accumulator をリセット
                lastTimeRef.current = null;
                accumulatorRef.current = 0;
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    // cleanup: コンポーネントアンマウント時にrAFを確実に停止
    useEffect(() => {
        return () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
        };
    }, []);

    // 時間の計算
    const totalFrames = loadedData?.frames.length ?? 0;
    const totalDurationMs = loadedData?.metadata.durationMs ?? 0;
    const currentTimeMs = loadedData && totalFrames > 0
        ? loadedData.frames[currentFrame]?.timestampMs - loadedData.frames[0].timestampMs
        : 0;

    return {
        loadFile,
        loadedData,
        isPlaying,
        currentFrame,
        totalFrames,
        currentLandmarks,
        currentTimeMs,
        totalDurationMs,
        play,
        pause,
        togglePlayPause,
        stepForward,
        stepBackward,
        seek,
        setSpeed,
        speed,
        isMirrored,
        toggleMirror,
        isLoading,
        error,
    };
}
