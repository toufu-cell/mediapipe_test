# Capture System Plan

## Goal

PC を司令塔にして、iPhone の動画録画と Apple Watch の手首センサ記録を同じ session として開始・停止できるようにする。MediaPipe 解析は PC 側で行い、iPhone は録画、Apple Watch は IMU 記録に集中させる。

## MVP Scope

最初の MVP は PC 側の Capture Session 画面とデータ仕様を固定するところまでにする。iPhone / Apple Watch との実通信は次フェーズで実装する。

MVP に含めるもの:

- PC 側で sessionId を発行する。
- Start / Stop command の payload を画面で確認できる。
- iPhone と Apple Watch の接続状態を表示する枠を用意する。
- `startAt` を現在時刻 + 数秒として扱い、同時開始の前提を明示する。
- 同期用ジェスチャとして、開始直後に手首を 3 回振る運用を入れる。
- iPhone 側 MVP の transport は newline-delimited JSON over TCP に固定する。

MVP に含めないもの:

- iPhone への実 WebSocket / HTTP 通信。
- Apple Watch への実 WatchConnectivity command。
- 動画ファイルや IMU CSV の自動転送。
- 自動ピーク検出による同期補正。

## System Responsibilities

### PC App

- Capture Session を作成する。
- `sessionId`, `startAt`, `expectedDurationSec` を含む command payload を作る。
- Start / Stop の状態を管理する。
- 後続フェーズで iPhone app へ command を送る。
- 収録後に動画、Watch IMU CSV、MediaPipe 抽出 CSV を読み込んで比較する。

### iPhone App

- PC app から newline-delimited JSON over TCP で command を受ける。
- start command 受信後、`startAt` まで待ってから `AVFoundation` で動画録画を開始する。
- stop command 受信時に録画を停止する。
- 同じ `sessionId` を Apple Watch app へ渡す。
- 録画ファイル名に `sessionId` を含める。

### Apple Watch App

- iPhone app からの command を受ける。
- `Core Motion` で加速度・角速度を記録する。
- `sessionId` つきの IMU CSV / JSON を作る。
- 記録後に iPhone へ転送する。

## Command Schema

```json
{
    "type": "start",
    "sessionId": "capture_20260524_203000",
    "startAt": "2026-05-24T20:30:03.000+09:00",
    "expectedDurationSec": 180,
    "syncGesture": "wrist_shake_3_times",
    "video": {
        "device": "iphone",
        "filename": "capture_20260524_203000.mov"
    },
    "watch": {
        "device": "apple_watch",
        "sampleRateHz": 50,
        "filename": "capture_20260524_203000_wrist_imu.csv"
    }
}
```

```json
{
    "type": "stop",
    "sessionId": "capture_20260524_203000",
    "stopAt": "2026-05-24T20:33:03.000+09:00"
}
```

## Watch IMU CSV Schema

```csv
session_id,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm
capture_20260524_203000,0,0,0.01,0.98,0.03,0.10,0.02,0.01,0.981,0.102
```

## Sync Strategy

1. PC app creates a session.
2. PC app sends a `start` command with `startAt = now + 3 sec`.
3. iPhone and Watch prepare recording before `startAt`.
4. At `startAt`, iPhone starts video recording and Watch starts IMU recording.
5. Subject performs `wrist_shake_3_times` immediately after start.
6. PC post-processing uses the sync gesture to estimate any remaining offset.

## Implementation Phases

1. PC Capture Session UI.
2. iPhone recording app command receiver.
3. Apple Watch IMU recorder.
4. Transfer and import workflow.
5. Video + IMU synchronized playback.
6. MediaPipe skeleton + IMU feature fusion.
