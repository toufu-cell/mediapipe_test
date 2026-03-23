import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_FILE_SIZE_BYTES } from '../types/skeletonData';
import type { FreeMoCap3DData, Point3D } from '../types/skeleton3D';
import { parseFreeMoCapCsvFiles } from '../utils/freemocapCsvParser';

export const SPEED_OPTIONS = [0.25, 0.5, 1, 2] as const;
export type PlaybackSpeed = typeof SPEED_OPTIONS[number];

export interface UseSkeletonPlayer3DReturn {
    loadFiles: (bodyFile: File, leftHandFile?: File, rightHandFile?: File, paramsFile?: File) => Promise<void>;
    loadedData: FreeMoCap3DData | null;
    isPlaying: boolean;
    currentFrame: number;
    totalFrames: number;
    currentBodyLandmarks: Point3D[] | null;
    currentLeftHandLandmarks: Point3D[] | null;
    currentRightHandLandmarks: Point3D[] | null;
    currentTimeMs: number;
    totalDurationMs: number;
    play: () => void;
    pause: () => void;
    togglePlayPause: () => void;
    stepForward: () => void;
    stepBackward: () => void;
    seek: (frame: number) => void;
    setSpeed: (speed: PlaybackSpeed) => void;
    speed: PlaybackSpeed;
    isLoading: boolean;
    error: string | null;
}

function validateFileSize(file: File | undefined): string | null {
    if (!file) {
        return null;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
        return `${file.name} のサイズが上限（${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB）を超えています`;
    }

    return null;
}

export function useSkeletonPlayer3D(): UseSkeletonPlayer3DReturn {
    const [loadedData, setLoadedData] = useState<FreeMoCap3DData | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentFrame, setCurrentFrame] = useState(0);
    const [speed, setSpeedState] = useState<PlaybackSpeed>(1);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [currentBodyLandmarks, setCurrentBodyLandmarks] = useState<Point3D[] | null>(null);
    const [currentLeftHandLandmarks, setCurrentLeftHandLandmarks] = useState<Point3D[] | null>(null);
    const [currentRightHandLandmarks, setCurrentRightHandLandmarks] = useState<Point3D[] | null>(null);

    const dataRef = useRef<FreeMoCap3DData | null>(null);
    const frameRef = useRef(0);
    const speedRef = useRef<PlaybackSpeed>(1);
    const rafIdRef = useRef<number | null>(null);
    const lastTimeRef = useRef<number | null>(null);
    const accumulatorRef = useRef(0);
    const lastValidBodyRef = useRef<Point3D[] | null>(null);

    useEffect(() => {
        dataRef.current = loadedData;
    }, [loadedData]);

    useEffect(() => {
        speedRef.current = speed;
    }, [speed]);

    const stopLoop = useCallback(() => {
        if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = null;
        }
        lastTimeRef.current = null;
        accumulatorRef.current = 0;
        setIsPlaying(false);
    }, []);

    const updateFrameLandmarks = useCallback((frameIndex: number) => {
        const data = dataRef.current;
        if (!data) {
            return;
        }

        const frame = data.frames[frameIndex];
        if (!frame) {
            return;
        }

        if (frame.bodyLandmarks) {
            lastValidBodyRef.current = frame.bodyLandmarks;
            setCurrentBodyLandmarks(frame.bodyLandmarks);
        } else {
            setCurrentBodyLandmarks(lastValidBodyRef.current);
        }

        setCurrentLeftHandLandmarks(frame.leftHandLandmarks);
        setCurrentRightHandLandmarks(frame.rightHandLandmarks);
    }, []);

    const loadFiles = useCallback(async (
        bodyFile: File,
        leftHandFile?: File,
        rightHandFile?: File,
        paramsFile?: File,
    ) => {
        setIsLoading(true);
        setError(null);
        stopLoop();

        const sizeError = [
            validateFileSize(bodyFile),
            validateFileSize(leftHandFile),
            validateFileSize(rightHandFile),
            validateFileSize(paramsFile),
        ].find(message => message !== null);

        if (sizeError) {
            setError(sizeError);
            setIsLoading(false);
            return;
        }

        try {
            const data = await parseFreeMoCapCsvFiles(bodyFile, leftHandFile, rightHandFile, paramsFile);
            setLoadedData(data);
            dataRef.current = data;
            frameRef.current = 0;
            setCurrentFrame(0);
            lastValidBodyRef.current = null;

            const firstFrame = data.frames[0] ?? null;
            if (firstFrame?.bodyLandmarks) {
                lastValidBodyRef.current = firstFrame.bodyLandmarks;
                setCurrentBodyLandmarks(firstFrame.bodyLandmarks);
            } else {
                setCurrentBodyLandmarks(null);
            }
            setCurrentLeftHandLandmarks(firstFrame?.leftHandLandmarks ?? null);
            setCurrentRightHandLandmarks(firstFrame?.rightHandLandmarks ?? null);
        } catch (caughtError) {
            const message = caughtError instanceof Error
                ? caughtError.message
                : 'FreeMoCap CSV の読み込みに失敗しました。';
            setLoadedData(null);
            dataRef.current = null;
            setCurrentBodyLandmarks(null);
            setCurrentLeftHandLandmarks(null);
            setCurrentRightHandLandmarks(null);
            setError(message);
        } finally {
            setIsLoading(false);
        }
    }, [stopLoop]);

    const tick = useCallback((now: number) => {
        const data = dataRef.current;
        if (!data || data.frames.length === 0) {
            return;
        }

        if (lastTimeRef.current === null) {
            lastTimeRef.current = now;
            rafIdRef.current = requestAnimationFrame(tick);
            return;
        }

        const deltaMs = now - lastTimeRef.current;
        lastTimeRef.current = now;

        if (deltaMs > 500) {
            accumulatorRef.current = 0;
            rafIdRef.current = requestAnimationFrame(tick);
            return;
        }

        accumulatorRef.current += deltaMs * speedRef.current;

        let nextIndex = frameRef.current;

        while (nextIndex < data.frames.length - 1) {
            const currentTimestamp = data.frames[nextIndex].timestampMs;
            const nextTimestamp = data.frames[nextIndex + 1].timestampMs;
            const frameDuration = nextTimestamp - currentTimestamp;

            if (frameDuration <= 0 || accumulatorRef.current < frameDuration) {
                break;
            }

            accumulatorRef.current -= frameDuration;
            nextIndex++;
        }

        if (nextIndex >= data.frames.length - 1) {
            nextIndex = 0;
            accumulatorRef.current = 0;
            lastValidBodyRef.current = null;
        }

        if (nextIndex !== frameRef.current) {
            frameRef.current = nextIndex;
            setCurrentFrame(nextIndex);
            updateFrameLandmarks(nextIndex);
        }

        rafIdRef.current = requestAnimationFrame(tick);
    }, [updateFrameLandmarks]);

    const play = useCallback(() => {
        const data = dataRef.current;
        if (!data || data.frames.length === 0) {
            return;
        }

        setIsPlaying(true);
        lastTimeRef.current = null;
        accumulatorRef.current = 0;
        rafIdRef.current = requestAnimationFrame(tick);
    }, [tick]);

    const pause = useCallback(() => {
        stopLoop();
    }, [stopLoop]);

    const togglePlayPause = useCallback(() => {
        if (isPlaying) {
            pause();
            return;
        }

        play();
    }, [isPlaying, pause, play]);

    const stepForward = useCallback(() => {
        const data = dataRef.current;
        if (!data) {
            return;
        }

        pause();
        const nextFrame = Math.min(frameRef.current + 1, data.frames.length - 1);
        frameRef.current = nextFrame;
        setCurrentFrame(nextFrame);
        updateFrameLandmarks(nextFrame);
    }, [pause, updateFrameLandmarks]);

    const stepBackward = useCallback(() => {
        const data = dataRef.current;
        if (!data) {
            return;
        }

        pause();
        const previousFrame = Math.max(frameRef.current - 1, 0);
        frameRef.current = previousFrame;
        setCurrentFrame(previousFrame);
        updateFrameLandmarks(previousFrame);
    }, [pause, updateFrameLandmarks]);

    const seek = useCallback((frame: number) => {
        const data = dataRef.current;
        if (!data) {
            return;
        }

        const clampedFrame = Math.max(0, Math.min(frame, data.frames.length - 1));
        frameRef.current = clampedFrame;
        setCurrentFrame(clampedFrame);
        accumulatorRef.current = 0;
        lastValidBodyRef.current = null;

        for (let index = clampedFrame; index >= 0; index--) {
            const bodyLandmarks = data.frames[index].bodyLandmarks;
            if (bodyLandmarks) {
                lastValidBodyRef.current = bodyLandmarks;
                break;
            }
        }

        updateFrameLandmarks(clampedFrame);
    }, [updateFrameLandmarks]);

    const setSpeed = useCallback((newSpeed: PlaybackSpeed) => {
        setSpeedState(newSpeed);
        speedRef.current = newSpeed;
        accumulatorRef.current = 0;
    }, []);

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                lastTimeRef.current = null;
                accumulatorRef.current = 0;
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    useEffect(() => {
        return () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
            }
        };
    }, []);

    const totalFrames = loadedData?.frames.length ?? 0;
    const totalDurationMs = loadedData?.metadata.durationMs ?? 0;
    const currentTimeMs = loadedData?.frames[currentFrame]?.timestampMs ?? 0;

    return {
        loadFiles,
        loadedData,
        isPlaying,
        currentFrame,
        totalFrames,
        currentBodyLandmarks,
        currentLeftHandLandmarks,
        currentRightHandLandmarks,
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
        isLoading,
        error,
    };
}
