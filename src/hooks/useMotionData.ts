import { useRef, useCallback, useState, useMemo } from 'react';
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
    /** 検出結果を処理（カメラ/動画ファイル用） */
    processDetection: (results: DetectionResult[], timestamp: number) => void;
    /** 33点ランドマーク配列を直接処理（3D再生用） */
    processLandmarks: (landmarks: (Position3D | null)[] | null, timestamp: number) => void;
    /** バッファをクリア（入力モード切替時に使用） */
    clearBuffers: () => void;
    /** グラフ再描画用のupdateカウンター */
    updateCount: number;
    /** フレーム番号 */
    frameCount: number;
}

/** Position3D配列からPosition3Dを取得 */
function extractPositionFromArray(
    landmarks: (Position3D | null)[],
    index: number,
): Position3D | null {
    return landmarks[index] ?? null;
}

/**
 * 33点ランドマーク配列から MotionDataPoint を計算するコアロジック。
 * ステートフルな計算（EMA平滑化、差分計算）のためのミュータブル状態を引数で受け取る。
 */
export interface MotionComputeState {
    recentFrames: {
        timestamp: number;
        smoothed: Record<JointName, Position3D | null>;
        angles: Record<AngleName, number | null>;
    }[];
    smoothed: Record<JointName, Position3D | null> | null;
    frameCount: number;
}

export function createMotionComputeState(): MotionComputeState {
    return {
        recentFrames: [],
        smoothed: null,
        frameCount: 0,
    };
}

/**
 * 33点ランドマーク配列から1フレーム分の MotionDataPoint を計算する。
 * state は副作用として更新される。
 */
export function computeMotionFrame(
    landmarks: (Position3D | null)[] | null,
    timestamp: number,
    state: MotionComputeState,
): MotionDataPoint {
    const frameIndex = state.frameCount++;

    // 1. ランドマーク座標取得（6関節）
    const rawPositions: Record<JointName, Position3D | null> = {} as Record<JointName, Position3D | null>;
    for (const joint of ALL_JOINT_NAMES) {
        rawPositions[joint] = landmarks
            ? extractPositionFromArray(landmarks, JOINT_LANDMARK_MAP[joint])
            : null;
    }

    // 2. EMA平滑化
    const prevSmoothed = state.smoothed;
    const smoothed: Record<JointName, Position3D | null> = {} as Record<JointName, Position3D | null>;

    if (prevSmoothed && state.recentFrames.length > 0) {
        const dt = timestamp - state.recentFrames[state.recentFrames.length - 1].timestamp;
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
    state.smoothed = smoothed;

    // 3. 関節角度算出（角度定義のランドマークindexを直接参照）
    const angles: Record<AngleName, number | null> = {} as Record<AngleName, number | null>;
    for (const angleName of ALL_ANGLE_NAMES) {
        const def = JOINT_ANGLE_DEFINITIONS[angleName];
        const a = landmarks ? extractPositionFromArray(landmarks, def.pointA) : null;
        const b = landmarks ? extractPositionFromArray(landmarks, def.vertex) : null;
        const c = landmarks ? extractPositionFromArray(landmarks, def.pointC) : null;

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
    state.recentFrames.push({ timestamp, smoothed, angles });
    if (state.recentFrames.length > 3) {
        state.recentFrames.shift();
    }

    // 4. 擬似加速度（2階中心差分、3フレーム必要）
    const accelerations: Record<JointName, Position3D | null> = {} as Record<JointName, Position3D | null>;
    if (state.recentFrames.length >= 3) {
        const prev = state.recentFrames[state.recentFrames.length - 3];
        const curr = state.recentFrames[state.recentFrames.length - 2];
        const next = state.recentFrames[state.recentFrames.length - 1];
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
    if (state.recentFrames.length >= 2) {
        const prev = state.recentFrames[state.recentFrames.length - 2];
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

    return {
        timestamp,
        frameIndex,
        positions: smoothed,
        angles,
        accelerations,
        angularVelocities,
    };
}

export function useMotionData(
    displayWindowSeconds: number = 10,
): UseMotionDataReturn {
    const [updateCount, setUpdateCount] = useState(0);

    // バッファ
    const displayBufferRef = useRef<MotionDataPoint[]>([]);
    const fullHistoryRef = useRef<MotionDataPoint[]>([]);

    // 計算状態
    const computeStateRef = useRef<MotionComputeState>(createMotionComputeState());

    // throttle用タイマー
    const lastGraphUpdateRef = useRef(0);

    const clearBuffers = useCallback(() => {
        displayBufferRef.current = [];
        fullHistoryRef.current = [];
        computeStateRef.current = createMotionComputeState();
        lastGraphUpdateRef.current = 0;
        setUpdateCount(0);
    }, []);

    /** 33点ランドマーク配列を直接処理するコアメソッド */
    const processLandmarks = useCallback((
        landmarks: (Position3D | null)[] | null,
        timestamp: number,
    ) => {
        const dataPoint = computeMotionFrame(landmarks, timestamp, computeStateRef.current);

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

    /** カメラ/動画ファイル用アダプタ（DetectionResult[] → Position3D[] 変換） */
    const processDetection = useCallback((
        results: DetectionResult[],
        timestamp: number,
    ) => {
        const poseResult = results.find(r => r.type === 'pose');
        const rawLandmarks = poseResult?.landmarks ?? null;

        // NormalizedLandmark[] → (Position3D | null)[] に変換
        let landmarks: (Position3D | null)[] | null = null;
        if (rawLandmarks) {
            landmarks = rawLandmarks.map((lm, _i) => {
                if ((lm.visibility ?? 0) < VISIBILITY_THRESHOLD) {
                    return null;
                }
                return { x: lm.x, y: lm.y, z: lm.z };
            });
        }

        processLandmarks(landmarks, timestamp);
    }, [processLandmarks]);

    // updateCountが変わるたびにバッファのスナップショットを返す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const displayData = useMemo(() => [...displayBufferRef.current], [updateCount]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const fullHistory = useMemo(() => fullHistoryRef.current, [updateCount]);

    return {
        displayData,
        fullHistory,
        processDetection,
        processLandmarks,
        clearBuffers,
        updateCount,
        frameCount: computeStateRef.current.frameCount,
    };
}
