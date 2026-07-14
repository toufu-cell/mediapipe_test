import { useRef, useCallback, useState, useMemo } from 'react';
import type { FreeMoCap3DData } from '../types/skeleton3D';
import type { Position3D, MotionDataPoint, MotionGraphSettings } from '../types/motion';
import { DEFAULT_MOTION_GRAPH_SETTINGS } from '../types/motion';
import { computeMotionFrame, createMotionComputeState } from './useMotionData';

interface UseMotionData3DReturn {
    /** 表示用データ（再生位置周辺の時間窓分） */
    displayData: MotionDataPoint[];
    /** エクスポート用フルヒストリー（全フレーム） */
    fullHistory: MotionDataPoint[];
    /** FreeMoCap3DData を受け取って全フレーム一括計算 */
    computeAll: (data: FreeMoCap3DData) => void;
    /** 再生位置を更新して表示窓をスライス */
    updatePlaybackPosition: (currentTimeMs: number) => void;
    /** バッファをクリア */
    clearBuffers: () => void;
    /** グラフ設定 */
    settings: MotionGraphSettings;
    /** グラフ設定更新 */
    setSettings: (settings: MotionGraphSettings) => void;
    /** グラフ再描画用のupdateカウンター */
    updateCount: number;
    /** 計算済みかどうか */
    isComputed: boolean;
}

/**
 * FreeMoCap 3Dデータ用のモーション解析フック。
 * ロード時に全フレーム分の MotionDataPoint[] を一括計算し、
 * 再生位置に応じて表示窓をスライスして返す。
 */
export function useMotionData3D(): UseMotionData3DReturn {
    const [updateCount, setUpdateCount] = useState(0);
    const [settings, setSettings] = useState<MotionGraphSettings>(DEFAULT_MOTION_GRAPH_SETTINGS);
    const [isComputed, setIsComputed] = useState(false);

    const allDataRef = useRef<MotionDataPoint[]>([]);
    const displayDataRef = useRef<MotionDataPoint[]>([]);

    const clearBuffers = useCallback(() => {
        allDataRef.current = [];
        displayDataRef.current = [];
        setIsComputed(false);
        setUpdateCount(0);
    }, []);

    /** FreeMoCap3DData の全フレームからモーション解析データを一括計算 */
    const computeAll = useCallback((data: FreeMoCap3DData) => {
        const state = createMotionComputeState();
        const results: MotionDataPoint[] = [];

        for (const frame of data.frames) {
            // Point3D[] → (Position3D | null)[] に変換
            // FreeMoCap は33点のボディランドマーク（MediaPipeと同じ順序）
            let landmarks: (Position3D | null)[] | null = null;
            if (frame.bodyLandmarks) {
                landmarks = frame.bodyLandmarks.map(pt => ({
                    x: pt.x,
                    y: pt.y,
                    z: pt.z,
                }));
            }

            const dataPoint = computeMotionFrame(landmarks, frame.timestampMs, state);
            results.push(dataPoint);
        }

        allDataRef.current = results;
        displayDataRef.current = results;
        setIsComputed(true);
        setUpdateCount(c => c + 1);
    }, []);

    /** 再生位置に応じて表示窓をスライス */
    const updatePlaybackPosition = useCallback((currentTimeMs: number) => {
        const allData = allDataRef.current;
        if (allData.length === 0) {
            return;
        }

        const windowMs = settings.timeWindow * 1000;
        const startTime = Math.max(0, currentTimeMs - windowMs);

        // 二分探索で開始位置を見つける
        let lo = 0;
        let hi = allData.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (allData[mid].timestamp < startTime) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        // 終了位置: currentTimeMs 以下の最後のフレーム
        let end = allData.length;
        {
            let lo2 = 0;
            let hi2 = allData.length;
            while (lo2 < hi2) {
                const mid = (lo2 + hi2) >>> 1;
                if (allData[mid].timestamp <= currentTimeMs) {
                    lo2 = mid + 1;
                } else {
                    hi2 = mid;
                }
            }
            end = lo2;
        }

        displayDataRef.current = allData.slice(lo, end);
        setUpdateCount(c => c + 1);
    }, [settings.timeWindow]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const displayData = useMemo(() => [...displayDataRef.current], [updateCount]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const fullHistory = useMemo(() => allDataRef.current, [updateCount]);

    return {
        displayData,
        fullHistory,
        computeAll,
        updatePlaybackPosition,
        clearBuffers,
        settings,
        setSettings,
        updateCount,
        isComputed,
    };
}
