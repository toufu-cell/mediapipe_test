export interface WatchLiveSample {
    streamId: string;
    sequence: number;
    timestampMs: number;
    motionTimestampSec: number;
    wristSide: 'left' | 'right';
    crownOrientation: 'left' | 'right';
    gravity: number[];
    gyro: number[];
    acceleration: number[];
    quaternion: number[];
    sampleRateHz: number;
    referenceFrame: string;
}

export interface WatchLiveSnapshot {
    sample: WatchLiveSample | null;
    receivedAtMs: number | null;
    ageMs: number | null;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('iPhoneからの応答形式が不正です。アプリを更新してください。');
    }
    return value as Record<string, unknown>;
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function vector(value: unknown, count: number): number[] {
    if (!Array.isArray(value) || value.length !== count || !value.every(v => finite(v) && Math.abs(v) < 10_000)) {
        throw new Error('センサー値が欠けているか、不正な値を含んでいます。');
    }
    return [...value];
}

export function parseWatchLiveResponse(value: unknown): WatchLiveSnapshot {
    const envelope = object(value);
    if (envelope.ok !== true) {
        throw new Error(typeof envelope.error === 'string' ? envelope.error : 'iPhoneとの通信に失敗しました。');
    }
    const response = object(envelope.response);
    if (response.ok !== true) throw new Error('iPhoneが要求を受け付けませんでした。');
    const live = object(response.live);
    if (live.sample === undefined || live.sample === null) {
        return { sample: null, receivedAtMs: null, ageMs: null };
    }
    const sample = object(live.sample);
    if (
        typeof sample.streamId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sample.streamId)
        || !Number.isSafeInteger(sample.sequence) || (sample.sequence as number) < 0 || (sample.sequence as number) > 2_147_483_647
        || !finite(sample.timestampMs) || sample.timestampMs <= 0
        || !finite(sample.motionTimestampSec) || sample.motionTimestampSec < 0
        || !['left', 'right'].includes(sample.wristSide as string)
        || !['left', 'right'].includes(sample.crownOrientation as string)
        || sample.referenceFrame !== 'xArbitraryZVertical' || sample.sampleRateHz !== 10
        || !finite(live.receivedAtMs) || live.receivedAtMs <= 0
        || !finite(live.ageMs) || live.ageMs < 0
    ) throw new Error('センサー時刻・装着情報・連番の形式が不正です。');
    const gravity = vector(sample.gravity, 3);
    const quaternion = vector(sample.quaternion, 4);
    if ([Math.hypot(...gravity), Math.hypot(...quaternion)].some(norm => norm < 0.9 || norm > 1.1)) {
        throw new Error('重力またはquaternionの大きさが不正です。');
    }
    return {
        sample: {
            streamId: sample.streamId,
            sequence: sample.sequence as number,
            timestampMs: sample.timestampMs,
            motionTimestampSec: sample.motionTimestampSec,
            wristSide: sample.wristSide as WatchLiveSample['wristSide'],
            crownOrientation: sample.crownOrientation as WatchLiveSample['crownOrientation'],
            gravity,
            gyro: vector(sample.gyro, 3),
            acceleration: vector(sample.acceleration, 3),
            quaternion,
            sampleRateHz: sample.sampleRateHz,
            referenceFrame: sample.referenceFrame,
        },
        receivedAtMs: live.receivedAtMs,
        ageMs: live.ageMs,
    };
}

export function watchLiveFreshness(snapshot: WatchLiveSnapshot | null, elapsedMs: number): 'waiting' | 'fresh' | 'stale' | 'clock' {
    if (!snapshot?.sample || snapshot.ageMs === null || snapshot.receivedAtMs === null) return 'waiting';
    const sourceDelay = snapshot.receivedAtMs - snapshot.sample.timestampMs;
    if (sourceDelay < -1500) return 'clock';
    return Math.max(snapshot.ageMs, sourceDelay) + elapsedMs <= 1500 ? 'fresh' : 'stale';
}
