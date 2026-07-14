import { useCallback, useEffect, useRef, useState } from 'react';

/** FPS計測の更新間隔（ms） */
const UPDATE_INTERVAL_MS = 500;

/** tick() が途絶えてからFPSを null に戻すまでの猶予（ms） */
const STALE_TIMEOUT_MS = 2000;

export interface UseFpsReturn {
    /** 現在のFPS値（小数点1桁） */
    fps: number | null;
    /** 毎フレームの完了時に呼ぶ（wall-clock ベースで計測） */
    tick: () => void;
    /** 計測をリセット */
    reset: () => void;
}

/**
 * tick() の呼び出し頻度から実FPSを計測するフック。
 * wall-clock (performance.now()) ベースで、UPDATE_INTERVAL_MS ごとに値を更新する。
 * tick() が STALE_TIMEOUT_MS 以上途絶えると自動的に null に戻る。
 */
export function useFps(): UseFpsReturn {
    const [fps, setFps] = useState<number | null>(null);
    const tickCountRef = useRef(0);
    const lastUpdateRef = useRef<number | null>(null);
    const lastTickRef = useRef<number | null>(null);
    const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearStaleTimer = useCallback(() => {
        if (staleTimerRef.current !== null) {
            clearTimeout(staleTimerRef.current);
            staleTimerRef.current = null;
        }
    }, []);

    const tick = useCallback(() => {
        const now = performance.now();
        lastTickRef.current = now;

        // stale タイマーをリセット
        clearStaleTimer();
        staleTimerRef.current = setTimeout(() => {
            setFps(null);
            tickCountRef.current = 0;
            lastUpdateRef.current = null;
            lastTickRef.current = null;
        }, STALE_TIMEOUT_MS);

        if (lastUpdateRef.current === null) {
            lastUpdateRef.current = now;
            tickCountRef.current = 1;
            return;
        }

        tickCountRef.current++;
        const elapsed = now - lastUpdateRef.current;

        if (elapsed >= UPDATE_INTERVAL_MS) {
            const measured = (tickCountRef.current / elapsed) * 1000;
            setFps(Math.round(measured * 10) / 10);
            tickCountRef.current = 0;
            lastUpdateRef.current = now;
        }
    }, [clearStaleTimer]);

    const reset = useCallback(() => {
        clearStaleTimer();
        setFps(null);
        tickCountRef.current = 0;
        lastUpdateRef.current = null;
        lastTickRef.current = null;
    }, [clearStaleTimer]);

    // クリーンアップ
    useEffect(() => {
        return () => {
            clearStaleTimer();
        };
    }, [clearStaleTimer]);

    return { fps, tick, reset };
}
