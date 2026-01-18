import { useEffect, useRef, useState, useCallback } from 'react';
import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from '@mediapipe/tasks-vision';

interface UseMediaPipeReturn {
    poseLandmarker: PoseLandmarker | null;
    isLoading: boolean;
    error: string | null;
    detectPose: (video: HTMLVideoElement, timestamp: number) => PoseLandmarkerResult | null;
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export function useMediaPipe(): UseMediaPipeReturn {
    const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isReady, setIsReady] = useState(false);

    useEffect(() => {
        let isMounted = true;

        async function initializeMediaPipe() {
            try {
                setIsLoading(true);
                setError(null);

                const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

                const landmarker = await PoseLandmarker.createFromOptions(vision, {
                    baseOptions: {
                        modelAssetPath: MODEL_PATH,
                        delegate: 'GPU',
                    },
                    runningMode: 'VIDEO',
                    numPoses: 1,
                    minPoseDetectionConfidence: 0.5,
                    minPosePresenceConfidence: 0.5,
                    minTrackingConfidence: 0.5,
                });

                if (isMounted) {
                    poseLandmarkerRef.current = landmarker;
                    setIsReady(true);
                }
            } catch (err) {
                if (isMounted) {
                    const errorMessage = err instanceof Error ? err.message : 'MediaPipeの初期化に失敗しました';
                    setError(errorMessage);
                    console.error('MediaPipe initialization error:', err);
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        initializeMediaPipe();

        return () => {
            isMounted = false;
            if (poseLandmarkerRef.current) {
                poseLandmarkerRef.current.close();
                poseLandmarkerRef.current = null;
            }
        };
    }, []);

    const detectPose = useCallback(
        (video: HTMLVideoElement, timestamp: number): PoseLandmarkerResult | null => {
            if (!poseLandmarkerRef.current || !isReady) {
                return null;
            }

            try {
                return poseLandmarkerRef.current.detectForVideo(video, timestamp);
            } catch (err) {
                console.error('Pose detection error:', err);
                return null;
            }
        },
        [isReady]
    );

    return {
        poseLandmarker: poseLandmarkerRef.current,
        isLoading,
        error,
        detectPose,
    };
}
