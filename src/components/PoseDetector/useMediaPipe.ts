import { useEffect, useRef, useState, useCallback } from 'react';
import { FilesetResolver, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { DetectionResult } from '../../types/pose';
import { generateDetectionId } from '../../types/pose';
import { POSE_LANDMARKS, SHOULDER_VISIBILITY_THRESHOLD, ARM_VISIBILITY_THRESHOLD } from '../../constants/poseLandmarks';

interface UseMediaPipeReturn {
    isLoading: boolean;
    error: string | null;
    detect: (video: HTMLVideoElement, timestamp: number) => DetectionResult[];
    resetPoseLandmarker: () => Promise<void>;
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const HAND_MODEL_PATH = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// delegate設定を共通化
const DELEGATE = 'GPU';

/**
 * 上半身が有効に検出されているかを判定
 * 条件: 肩（左右どちらか）がvisibility 0.6以上 + 肘か手首が1点以上見える
 */
function hasValidUpperBody(landmarks: NormalizedLandmark[]): boolean {
    const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];

    // 肩が少なくとも片方見えているか
    const hasVisibleShoulder =
        (leftShoulder && (leftShoulder.visibility ?? 0) >= SHOULDER_VISIBILITY_THRESHOLD) ||
        (rightShoulder && (rightShoulder.visibility ?? 0) >= SHOULDER_VISIBILITY_THRESHOLD);

    if (!hasVisibleShoulder) {
        return false;
    }

    // 肘か手首が少なくとも1点見えているか
    const armLandmarkIndices = [
        POSE_LANDMARKS.LEFT_ELBOW,
        POSE_LANDMARKS.RIGHT_ELBOW,
        POSE_LANDMARKS.LEFT_WRIST,
        POSE_LANDMARKS.RIGHT_WRIST,
    ];

    const hasVisibleArm = armLandmarkIndices.some(idx => {
        const lm = landmarks[idx];
        return lm && (lm.visibility ?? 0) >= ARM_VISIBILITY_THRESHOLD;
    });

    return hasVisibleArm;
}

export function useMediaPipe(): UseMediaPipeReturn {
    const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
    const handLandmarkerRef = useRef<HandLandmarker | null>(null);
    const visionRef = useRef<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null>(null);
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
                visionRef.current = vision;

                // 両方を並列で初期化（同じdelegateを使用）
                const [poseLandmarker, handLandmarker] = await Promise.all([
                    PoseLandmarker.createFromOptions(vision, {
                        baseOptions: {
                            modelAssetPath: MODEL_PATH,
                            delegate: DELEGATE,
                        },
                        runningMode: 'VIDEO',
                        numPoses: 1,
                        minPoseDetectionConfidence: 0.5,
                        minPosePresenceConfidence: 0.5,
                        minTrackingConfidence: 0.5,
                    }),
                    HandLandmarker.createFromOptions(vision, {
                        baseOptions: {
                            modelAssetPath: HAND_MODEL_PATH,
                            delegate: DELEGATE,
                        },
                        runningMode: 'VIDEO',
                        numHands: 2,
                        minHandDetectionConfidence: 0.5,
                        minHandPresenceConfidence: 0.5,
                        minTrackingConfidence: 0.5,
                    }),
                ]);

                if (isMounted) {
                    poseLandmarkerRef.current = poseLandmarker;
                    handLandmarkerRef.current = handLandmarker;
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
            // 両方をクリーンアップ（WASMリソースリーク防止）
            poseLandmarkerRef.current?.close();
            handLandmarkerRef.current?.close();
            poseLandmarkerRef.current = null;
            handLandmarkerRef.current = null;
        };
    }, []);

    const detect = useCallback(
        (video: HTMLVideoElement, timestamp: number): DetectionResult[] => {
            if (!poseLandmarkerRef.current || !handLandmarkerRef.current || !isReady) {
                return [];
            }

            const results: DetectionResult[] = [];

            try {
                // Step 1: Pose検出
                const poseResult = poseLandmarkerRef.current.detectForVideo(video, timestamp);
                if (poseResult?.landmarks?.[0]) {
                    const landmarks = poseResult.landmarks[0];

                    // 上半身が十分に見えている場合はPoseを使用
                    if (hasValidUpperBody(landmarks)) {
                        results.push({
                            id: generateDetectionId(),
                            type: 'pose',
                            landmarks,
                        });
                        return results;
                    }
                }

                // Step 2: Poseが不十分な場合、Hand検出にフォールバック
                const handResult = handLandmarkerRef.current.detectForVideo(video, timestamp);
                // undefinedチェックと空配列チェック
                if (handResult?.landmarks && handResult.landmarks.length > 0) {
                    for (let index = 0; index < handResult.landmarks.length; index++) {
                        const landmarks = handResult.landmarks[index];
                        // handednessは文字列として取得（未知の値も許容）
                        const handedness = handResult.handednesses?.[index]?.[0]?.categoryName;
                        results.push({
                            id: generateDetectionId(),
                            type: 'hand',
                            landmarks,
                            handedness,  // string | undefined
                        });
                    }
                }
            } catch (err) {
                console.error('Detection error:', err);
            }

            return results;
        },
        [isReady]
    );

    /**
     * PoseLandmarkerをclose→再作成してtracking stateをリセット
     * 動画ファイルのseekオフライン解析前に呼び出す
     */
    const resetPoseLandmarker = useCallback(async () => {
        if (!visionRef.current) return;

        poseLandmarkerRef.current?.close();
        poseLandmarkerRef.current = await PoseLandmarker.createFromOptions(visionRef.current, {
            baseOptions: {
                modelAssetPath: MODEL_PATH,
                delegate: DELEGATE,
            },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
        });
    }, []);

    return {
        isLoading,
        error,
        detect,
        resetPoseLandmarker,
    };
}
