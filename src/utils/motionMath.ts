/**
 * モーション解析の数学ユーティリティ
 */

import type { Position3D } from '../types/motion';

/**
 * 3点から頂点Bの角度を算出（度数法）
 * ベクトルBA・BCの内積を使用
 * @returns 角度（0-180度）、計算不可時はnull
 */
export function calculateAngle(
    a: Position3D,
    b: Position3D,
    c: Position3D,
): number | null {
    const ba = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };

    const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
    const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y + ba.z * ba.z);
    const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);

    if (magBA === 0 || magBC === 0) {
        return null;
    }

    // clampして浮動小数点誤差を吸収
    const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
    return Math.acos(cosAngle) * (180 / Math.PI);
}

/**
 * dt依存のEMA平滑化
 * α = 1 - exp(-dt / τ) で dt に応じて平滑化係数を調整
 * τ（時定数）が小さいほど追従が速い
 */
export function smoothPosition(
    prev: Position3D,
    curr: Position3D,
    dt: number,
    tau: number = 50, // 時定数（ms）。50ms ≈ 20fpsで約63%追従
): Position3D {
    if (dt <= 0) return curr;

    const alpha = 1 - Math.exp(-dt / tau);
    return {
        x: prev.x + alpha * (curr.x - prev.x),
        y: prev.y + alpha * (curr.y - prev.y),
        z: prev.z + alpha * (curr.z - prev.z),
    };
}

/**
 * 2階中心差分で擬似加速度を計算
 * accel = (pos[t+1] - 2*pos[t] + pos[t-1]) / dt^2
 * @param dtPrev t-1→t の時間間隔 (秒)
 * @param dtNext t→t+1 の時間間隔 (秒)
 */
export function calculateAcceleration(
    prev: Position3D,
    curr: Position3D,
    next: Position3D,
    dtPrev: number,
    dtNext: number,
): Position3D | null {
    if (dtPrev <= 0 || dtNext <= 0) return null;

    const dtAvg = (dtPrev + dtNext) / 2;
    const dtSq = dtAvg * dtAvg;

    return {
        x: (next.x - 2 * curr.x + prev.x) / dtSq,
        y: (next.y - 2 * curr.y + prev.y) / dtSq,
        z: (next.z - 2 * curr.z + prev.z) / dtSq,
    };
}

/**
 * 角度の1階差分で擬似角速度を計算
 * @param dt 時間間隔 (秒)
 * @returns 角速度（度/秒）
 */
export function calculateAngularVelocity(
    prevAngle: number,
    currAngle: number,
    dt: number,
): number | null {
    if (dt <= 0) return null;
    return (currAngle - prevAngle) / dt;
}
