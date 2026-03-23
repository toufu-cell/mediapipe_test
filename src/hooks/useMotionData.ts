import { useRef, useCallback, useState, useMemo } from 'react';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { DetectionResult } from '../types/pose';
import type {
    JointName,
    AngleName,
    Position3D,
    MotionDataPoint,
} from '../types/motion';
import {
    JOINT_LANDMARK_MAP,
    JOINT_ANGLE_DEFINITIONS,
    ALL_JOINT_NAMES,
    ALL_ANGLE_NAMES,
    MAX_BUFFER_FRAMES,
} from '../types/motion';
import {
    calculateAngle,
    smoothPosition,
    calculateAcceleration,
    calculateAngularVelocity,
} from '../utils/motionMath';

/** visibility閾値 */
const VISIBILITY_THRESHOLD = 0.5;

/** グラフ再描画のthrottle間隔 (ms) - 10fps */
const GRAPH_UPDATE_INTERVAL = 100;

interface UseMotionDataReturn {
    /** 表示用データ（直近N秒分） */
    displayData: MotionDataPoint[];
    /** エクスポート用フルヒストリー */
    fullHistory: MotionDataPoint[];
    /** 検出結果を処理 */
    processDetection: (results: DetectionResult[], timestamp: number) => void;
    /** バッファをクリア（入力モード切替時に使用） */
    clearBuffers: () => void;
    /** グラフ再描画用のupdateカウンター */
    updateCount: number;
    /** フレーム番号 */
    frameCount: number;
}

/** ランドマークからPosition3Dを抽出（visibility < 閾値ならnull） */
function extractPosition(
    landmarks: NormalizedLandmark[],
    index: number,
): Position3D | null {
    const lm = landmarks[index];
    if (!lm || (lm.visibility ?? 0) < VISIBILITY_THRESHOLD) {
        return null;
    }
    return { x: lm.x, y: lm.y, z: lm.z };
}

export function useMotionData(
    displayWindowSeconds: number = 10,
): UseMotionDataReturn {
    const [updateCount, setUpdateCount] = useState(0);

    // バッファ
    const displayBufferRef = useRef<MotionDataPoint[]>([]);
    const fullHistoryRef = useRef<MotionDataPoint[]>([]);

    // 直近3フレームの平滑化済み座標（差分計算用）
    const recentFramesRef = useRef<{
        timestamp: number;
        smoothed: Record<JointName, Position3D | null>;
        angles: Record<AngleName, number | null>;
    }[]>([]);

    // EMA平滑化の前回値
    const smoothedRef = useRef<Record<JointName, Position3D | null> | null>(null);

    // フレームカウンター
    const frameCountRef = useRef(0);

    // throttle用タイマー
    const lastGraphUpdateRef = useRef(0);

    const clearBuffers = useCallback(() => {
        displayBufferRef.current = [];
        fullHistoryRef.current = [];
        recentFramesRef.current = [];
        smoothedRef.current = null;
        frameCountRef.current = 0;
        lastGraphUpdateRef.current = 0;
        setUpdateCount(0);
    }, []);

    const processDetection = useCallback((
        results: DetectionResult[],
        timestamp: number,
    ) => {
        // Poseタイプのみ処理（Handは無視）
        const poseResult = results.find(r => r.type === 'pose');
        const landmarks = poseResult?.landmarks ?? null;

        const frameIndex = frameCountRef.current++;

        // 1. ランドマーク座標取得
        const rawPositions: Record<JointName, Position3D | null> = {} as Record<JointName, Position3D | null>;
        for (const joint of ALL_JOINT_NAMES) {
            rawPositions[joint] = landmarks
                ? extractPosition(landmarks, JOINT_LANDMARK_MAP[joint])
                : null;
        }

        // 2. EMA平滑化
        const prevSmoothed = smoothedRef.current;
        const smoothed: Record<JointName, Position3D | null> = {} as Record<JointName, Position3D | null>;

        if (prevSmoothed && recentFramesRef.current.length > 0) {
            const dt = timestamp - recentFramesRef.current[recentFramesRef.current.length - 1].timestamp;
            for (const joint of ALL_JOINT_NAMES) {
                const curr = rawPositions[joint];
                const prev = prevSmoothed[joint];
                if (curr && prev) {
                    smoothed[joint] = smoothPosition(prev, curr, dt);
                } else {
                    smoothed[joint] = curr; // 前回欠損ならそのまま
                }
            }
        } else {
            // 初回フレーム
            for (const joint of ALL_JOINT_NAMES) {
                smoothed[joint] = rawPositions[joint];
            }
        }
        smoothedRef.current = smoothed;

        // 3. 関節角度算出
        const angles: Record<AngleName, number | null> = {} as Record<AngleName, number | null>;
        for (const angleName of ALL_ANGLE_NAMES) {
            const def = JOINT_ANGLE_DEFINITIONS[angleName];
            const a = landmarks ? extractPosition(landmarks, def.pointA) : null;
            const b = landmarks ? extractPosition(landmarks, def.vertex) : null;
            const c = landmarks ? extractPosition(landmarks, def.pointC) : null;

            if (a && b && c) {
                // 平滑化済み座標を使用（利用可能な場合）
                const smoothA = smoothed[Object.keys(JOINT_LANDMARK_MAP).find(
                    k => JOINT_LANDMARK_MAP[k as JointName] === def.pointA
                ) as JointName] ?? a;
                const smoothB = smoothed[Object.keys(JOINT_LANDMARK_MAP).find(
                    k => JOINT_LANDMARK_MAP[k as JointName] === def.vertex
                ) as JointName] ?? b;
                const smoothC = smoothed[Object.keys(JOINT_LANDMARK_MAP).find(
                    k => JOINT_LANDMARK_MAP[k as JointName] === def.pointC
                ) as JointName] ?? c;
                angles[angleName] = calculateAngle(smoothA, smoothB, smoothC);
            } else {
                angles[angleName] = null;
            }
        }

        // 直近フレーム履歴に追加
        const recentFrames = recentFramesRef.current;
        recentFrames.push({ timestamp, smoothed, angles });
        if (recentFrames.length > 3) {
            recentFrames.shift();
        }

        // 4. 擬似加速度（2階中心差分、3フレーム必要）
        const accelerations: Record<JointName, Position3D | null> = {} as Record<JointName, Position3D | null>;
        if (recentFrames.length >= 3) {
            const prev = recentFrames[recentFrames.length - 3];
            const curr = recentFrames[recentFrames.length - 2];
            const next = recentFrames[recentFrames.length - 1];
            const dtPrev = (curr.timestamp - prev.timestamp) / 1000;
            const dtNext = (next.timestamp - curr.timestamp) / 1000;

            for (const joint of ALL_JOINT_NAMES) {
                const pPos = prev.smoothed[joint];
                const cPos = curr.smoothed[joint];
                const nPos = next.smoothed[joint];

                if (pPos && cPos && nPos) {
                    accelerations[joint] = calculateAcceleration(pPos, cPos, nPos, dtPrev, dtNext);
                } else {
                    accelerations[joint] = null;
                }
            }
        } else {
            for (const joint of ALL_JOINT_NAMES) {
                accelerations[joint] = null;
            }
        }

        // 5. 擬似角速度（1階差分、2フレーム必要）
        const angularVelocities: Record<AngleName, number | null> = {} as Record<AngleName, number | null>;
        if (recentFrames.length >= 2) {
            const prev = recentFrames[recentFrames.length - 2];
            const dt = (timestamp - prev.timestamp) / 1000;
            for (const angleName of ALL_ANGLE_NAMES) {
                const prevAngle = prev.angles[angleName];
                const currAngle = angles[angleName];
                if (prevAngle !== null && currAngle !== null) {
                    angularVelocities[angleName] = calculateAngularVelocity(prevAngle, currAngle, dt);
                } else {
                    angularVelocities[angleName] = null;
                }
            }
        } else {
            for (const angleName of ALL_ANGLE_NAMES) {
                angularVelocities[angleName] = null;
            }
        }

        const dataPoint: MotionDataPoint = {
            timestamp,
            frameIndex,
            positions: smoothed,
            angles,
            accelerations,
            angularVelocities,
        };

        // 表示用バッファに追加
        const displayBuffer = displayBufferRef.current;
        displayBuffer.push(dataPoint);

        // 時間窓を超えたデータを削除
        const cutoffTime = timestamp - displayWindowSeconds * 1000;
        while (displayBuffer.length > 0 && displayBuffer[0].timestamp < cutoffTime) {
            displayBuffer.shift();
        }

        // エクスポート用フルヒストリーに追加（MAX_BUFFER_FRAMES上限）
        const fullHistory = fullHistoryRef.current;
        fullHistory.push(dataPoint);
        while (fullHistory.length > MAX_BUFFER_FRAMES) {
            fullHistory.shift();
        }

        // グラフ再描画をthrottle（10fps）
        const now = performance.now();
        if (now - lastGraphUpdateRef.current >= GRAPH_UPDATE_INTERVAL) {
            lastGraphUpdateRef.current = now;
            setUpdateCount(c => c + 1);
        }
    }, [displayWindowSeconds]);

    // updateCountが変わるたびにバッファのスナップショットを返す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const displayData = useMemo(() => [...displayBufferRef.current], [updateCount]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const fullHistory = useMemo(() => fullHistoryRef.current, [updateCount]);

    return {
        displayData,
        fullHistory,
        processDetection,
        clearBuffers,
        updateCount,
        frameCount: frameCountRef.current,
    };
}
