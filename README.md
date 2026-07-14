# MediaPipe 調理行動認識

iPhone の映像、Apple Watch の手首 IMU、MediaPipe の Pose / Hand 推定を組み合わせ、調理行動を記録・同期・分類する研究用プロジェクトです。PC の Web アプリを収録の司令塔とし、同じ `sessionId` で動画と IMU CSV を管理します。

このファイルは、プロジェクト概要、開発手順、収録仕様、進捗、実験結果をまとめた唯一の tracked ドキュメントです。現行仕様とコマンドは 2026-07-14 時点の working tree、`package.json`、実装、tests を正とします。過去の実機確認と評価値は、日付付きの snapshot として区別しています。

## 現在地

実装済みの範囲は次のとおりです。

- React / Vite / TypeScript の Web アプリで、カメラ・動画・骨格データを表示、解析、export できる。
- PC から iPhone へ認証付きの Start / Stop command を送り、動画を収録できる。
- iPhone から Apple Watch へ同じ session の command を relay し、CoreMotion の IMU データを CSV に保存できる。
- 動画から Pose 33点と Hand 21点を抽出できる。
- 開始直後の手首3回振りを使い、動画由来の手首速度と Watch の `gyro_norm` を同期できる。
- Pose / Hand / IMU の時系列特徴量を用いて、XGBoost または Random Forest で分類・LOSO 評価できる。

現在は、収録、同期、特徴量化、分類評価までがつながっています。一方、収録ファイルの PC への自動転送、Web UI 上の同期再生、同期済み Pose + IMU を使う分類処理の完全自動化は未実装です。

## システム構成

```text
PC / Web app
  ├─ Capture Session を作成
  ├─ localhost の command proxy から TCP :8765 へ送信
  └─ 動画を MediaPipe で解析し、Python で同期・分類
             │
             ▼
iPhone Recorder
  ├─ pairing token と command を検証
  ├─ front camera の動画を <sessionId>.mov として保存
  ├─ Photos に動画を追加
  └─ command を WatchConnectivity で relay
             │
             ▼
Apple Watch Recorder
  ├─ Extended Runtime 中に CoreMotion を記録
  ├─ <sessionId>_wrist_imu.csv を生成
  └─ CSV を iPhone へ転送
```

デバイスごとの責務は次のとおりです。

| 担当 | 主な責務 | 主な出力 |
| --- | --- | --- |
| PC | session 作成、command 送信、MediaPipe 抽出、同期、分類 | Pose / Hand CSV、同期済み CSV、評価結果 |
| iPhone | command 受信、予定時刻での動画録画、Watch relay | `<sessionId>.mov` |
| Apple Watch | 手首の加速度・角速度記録、iPhone への転送 | `<sessionId>_wrist_imu.csv` |

## Web アプリ

### 入力モード

| モード | 用途 |
| --- | --- |
| `camera` | カメラ映像のリアルタイム Pose / Hand 検出 |
| `videoFile` | ローカル動画の解析 |
| `skeletonPlayer` | Skeleton JSON の 2D 再生 |
| `skeleton3D` | Skeleton / FreeMoCap データの 3D 再生 |
| `captureSession` | iPhone / Apple Watch 収録 session の制御 |

Pose は 33 landmarks、Hand は片手 21 landmarks を扱います。検出結果は Canvas に描画し、モーショングラフ表示、スクリーンショット、WebM 録画、CSV / JSON / Skeleton JSON / 33-landmark CSV export に対応しています。

Safari は非対応です。Chrome、Edge、Firefox を使用してください。

初回の Pose / Hand 検出時に、WASM を jsDelivr、MediaPipe model を Google Cloud Storage から取得するため、インターネット接続が必要です。offline 環境や Content Security Policy でこれらの host を遮断している環境では初期化できません。

### セットアップと実行

```bash
npm install
npm run dev
```

利用できる npm scripts:

```bash
npm run build
npm run preview
npm run test:api
npm run test:e2e
```

`npm run test:api` は `tests/capture-command-api.spec.mjs` を実行します。Capture Session の UI test は iPhone への実送信を mock します。

主要依存は React 19、Vite 7、TypeScript 5、MediaPipe Tasks Vision、Three.js / React Three Fiber、uPlot、Playwright です。

## Capture Session プロトコル

### Transport と保護

- iPhone は TCP port `8765` で待ち受ける。
- PC は connection ごとに newline-delimited JSON を1行送り、iPhone の1行 response を受け取る。
- envelope は pairing token と inner command を含む。
- pairing token は iPhone が生成・保持し、PC の Capture Session 画面へ入力する。
- token は 16〜256文字。request は最大 16 KiB、response は最大 8 KiB。
- Vite dev server の `/api/capture-command` は `POST` と same-origin request のみを受け付け、送信先 port を `8765` に固定する。
- timeout は既定で8秒。
- iPhone は成功時に `{"ok":true}`、失敗時に `{"ok":false,"error":"..."}` を返す。

### Start command

```json
{
    "token": "<PAIRING_TOKEN>",
    "command": {
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
}
```

### Stop command

```json
{
    "token": "<PAIRING_TOKEN>",
    "command": {
        "type": "stop",
        "sessionId": "capture_20260524_203000",
        "stopAt": "2026-05-24T20:33:03.000+09:00"
    }
}
```

### Timing と同期

1. PC が `startAt` を含む Start command を送る。
2. iPhone は camera を準備し、`startAt` まで待って録画を始める。過去時刻なら待ち時間を0にする。
3. iPhone は同じ command を Apple Watch へ即時送信し、application context / user info にも queue する。
4. Apple Watch は Extended Runtime が開始できた時点の local time を IMU の基準時刻として記録を始める。
5. 被験者は収録開始直後に手首を3回振る。
6. 後処理で Pose の手首速度と Watch の `gyro_norm` の3ピークを対応させ、残る `offset_ms` を推定する。

したがって、`elapsed_ms` は Watch 側の実記録開始からの経過時間であり、iPhone の実録画開始時刻と同一とは限りません。最終的な alignment は同期ジェスチャで補正します。

### 収録前後の checklist

1. PC と iPhone を同じ LAN に接続し、iPhone と Apple Watch の WatchConnectivity が利用できる状態にする。
2. iPhone Recorder と Watch Recorder を起動し、両方を前面・active のまま待機させる。
3. Capture Session 画面で iPhone の IP address と、iPhone に表示された pairing token を確認する。
4. Start を押し、iPhone が録画中、Watch が `Recording` になったことを確認する。
5. 収録開始直後に、Watch を装着した手首を3回振る。
6. 測定後に Stop を押し、動画と Watch CSV が同じ `sessionId` で保存されたことを確認する。
7. iPhone の動画と IMU CSV を PC へ回収し、`sync_session.py` で同期する。

Watch app が前面にない場合、Extended Runtime の開始は active 復帰まで保留されます。同期ジェスチャと冒頭の IMU を取り逃さないよう、Start 前に必ず Watch Recorder を開いてください。

### Watch IMU CSV

```csv
session_id,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm
capture_20260524_203000,1779622203000,0,0.010000,0.980000,0.030000,0.100000,0.020000,0.010000,0.980510,0.102470
```

- `timestamp_ms`: Unix time milliseconds
- `elapsed_ms`: Watch の記録開始からの経過 milliseconds
- `accel_*`: CoreMotion `userAcceleration`
- `gyro_*`: CoreMotion `rotationRate`
- `accel_norm`, `gyro_norm`: 各3軸の Euclidean norm

## iPhone / Apple Watch アプリ

既存の Xcode project は `ios/IPhoneRecorderApp.xcodeproj` です。iPhone app は SwiftUI、AVFoundation、Network、WatchConnectivity を使用し、Watch app は CoreMotion と `WKExtendedRuntimeSession` を使用します。

### ローカル self-test

```bash
cd ios
swift run CaptureCoreSelfTest
```

### Simulator build 例

```bash
xcodebuild -project ios/IPhoneRecorderApp.xcodeproj \
  -scheme IPhoneRecorderApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build
```

### Apple Watch 実機への install 手順例

次の command は実機 destination ID、device ID、code signing の設定が必要です。

```bash
xcodebuild -project ios/IPhoneRecorderApp.xcodeproj \
  -target WatchRecorderApp \
  -destination 'id=<WATCH_DESTINATION_ID>' \
  -quiet build

xcrun devicectl device install app \
  --device <WATCH_DEVICE_ID> \
  ios/build/Release-watchos/WatchRecorderApp.app
```

iPhone app container のファイル確認例:

```bash
xcrun devicectl device info files \
  --device <IPHONE_DEVICE_ID> \
  --domain-type appDataContainer \
  --domain-identifier app.mediapipe.IPhoneRecorderApp \
  --subdirectory Documents
```

## Python パイプライン

### 環境構築

分類・評価を含む環境:

```bash
cd python
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

動画抽出だけの最小環境:

```bash
cd python
python3 -m venv .venv-extract
.venv-extract/bin/pip install -r requirements-extract.txt
```

### データ形式

分類用 data directory は次の構造を想定します。

```text
data/
  labels.csv
  subjects/
    <subject-or-capture>/
      motion.csv
      labeling.json
```

`labeling.json` は Label Studio の TimelineLabels を内部形式へ正規化します。`other` は学習・評価から除外し、残る label ID を0始まりへ振り直します。train は label 境界をまたがない window、eval は full-sequence window を使い、数値列ごとに mean / variance / standard deviation / max / min / median を特徴量化します。

### 動画から Pose / Hand を抽出

```bash
cd python
.venv-extract/bin/python extract_pose_video.py ../path/to/video.mp4 \
  -o output/extract \
  --write-overlay-video \
  --landmark-profile upper-body \
  --visibility-threshold 0.5 \
  --arm-selection both \
  --detect-hands \
  --max-hands 2 \
  --max-interpolation-ms 250 \
  --min-pose-bbox-area 0.006 \
  --min-shoulder-width 0.05 \
  --max-center-jump 0.35 \
  --min-valid-upper-body-landmarks 4
```

主な出力は Pose Skeleton JSON、33-landmark CSV、frame metadata、overlay video です。`--detect-hands` を付けると Hand JSON / CSV も生成します。

### Pose と IMU を同期

```bash
cd python
.venv/bin/python sync_session.py \
  --pose-csv output/extract/capture_xxx_33landmarks.csv \
  --imu-csv ../path/to/capture_xxx_wrist_imu.csv \
  --output-dir output/extract/sync \
  --watch-side left
```

同期処理は次を出力します。

- `<sessionId>_sync_metadata.json`: 推定 offset と診断情報
- `<sessionId>_synced_pose_imu.csv`: Pose timestamp に最も近い IMU sample を結合した CSV
- `<sessionId>_sync_diagnostic.png`: 両 signal と peak の確認図

3ピークの対応が不安定なら自動同期を失敗させます。必要な場合は `--manual-offset-ms` で手動補正できます。

### 分類と modality 比較

```bash
cd python
.venv/bin/python main.py \
  --data-dir data/<dataset> \
  --loso \
  --window-sec 1.0 \
  --step-sec 0.5 \
  --output-dir output/loso
```

`--classifier` は `xgboost` または `randomforest`、`--modality` は `watch`、`video`、`combined` を選べます。3条件を同時比較する場合は `--compare-modalities` を使います。`subjects/` 直下が独立被験者でない dataset では、`--loso` は実質 Leave-One-Video-Out になる点に注意してください。

### Python tests

```bash
cd python
.venv/bin/python -m pytest --capture=no -p no:cacheprovider tests -v
```

## 評価 snapshot

以下は過去の実験結果であり、dataset と条件が異なる値を直接比較しません。

### 基礎動作分類（2026-05-31 まで）

基礎 label `walk` / `sit` / `stop` を使った約30秒の動画7本の集計では、平均 accuracy 70.7%、最良 73.7% でした。ローカル出力として記録されていた例は次のとおりです。ここでの `subject` は独立被験者とは限りません。

| 条件 | 平均 accuracy | 平均 macro F1 |
| --- | ---: | ---: |
| 1秒 window の基礎評価 | 0.7016 | 0.6393 |
| Pose 33-landmark CSV | 0.7177 | 0.6417 |
| `other` 除外系 | 0.7074 | 0.5869 |
| Random Forest 系 | 0.7457 | 0.6377 |

### iPhone / Apple Watch 実機確認（2026-05-25）

iPhone への Start / Stop、front camera 録画、Photos 保存、Watch command relay、Watch CSV の iPhone 転送を確認しました。Extended Runtime と queued delivery の導入後に確認した5 session は次のとおりです。

| session | 動画 | Watch CSV span | 差分 | 欠損 |
| --- | ---: | ---: | ---: | --- |
| `capture_20260525_051743_555_07` | 42.702 s | 43.557 s | +0.855 s | なし |
| `capture_20260525_051252_302_06` | 48.902 s | 49.473 s | +0.571 s | なし |
| `capture_20260525_050641_618_05` | 42.102 s | 42.730 s | +0.628 s | なし |
| `capture_20260525_050005_471_04` | 58.268 s | 59.011 s | +0.743 s | なし |
| `capture_20260525_045607_232_03` | 63.235 s | 63.704 s | +0.469 s | なし |

全 session の平均 interval は約 20.127 ms で、40 ms 超 gap、100 ms 超 gap、時刻の逆行はいずれも0でした。動画と CSV の duration 差は、予定時刻と実際の録画開始・停止 timing の差として扱います。

### 調理動作分類（2026-07-07）

野菜カット `cooking_20260602` は5 captures、target labels は `peak` / `ranngiri` / `wagiri` です。

| modality | accuracy | macro F1 |
| --- | ---: | ---: |
| Pose only | 0.582 | 0.627 |
| Pose + IMU | 0.630 | 0.656 |

IMU の追加による差は accuracy `+0.048`、macro F1 `+0.029` でした。

魚処理 `fish_project5_7subjects` は7 subjects、target labels は `uroko` / `atama` / `naziou` / `haraarau` / `sannmai` です。

| modality | accuracy |
| --- | ---: |
| Watch | 0.508 |
| Video | 0.669 |
| Combined | 0.674 |

Combined 条件の action 別 accuracy:

| action | 内容 | accuracy |
| --- | --- | ---: |
| `uroko` | 鱗をかく | 0.814 |
| `atama` | 頭を取る | 0.531 |
| `naziou` | 内臓を取る | 0.115 |
| `haraarau` | 腹を洗う | 0.833 |
| `sannmai` | 三枚おろし | 0.787 |

Video が主な分類性能を支え、Combined の改善幅は小さい結果でした。特に `naziou` は手元が隠れやすく、姿勢差も小さいため、誤分類先と失敗 frame の分析が必要です。

## 既知の課題と次の作業

1. 同期精度を実データで検証し、peak threshold、許容 interval、offset のばらつき条件を調整する。
2. iPhone の実録画開始時刻を metadata として保存する。
3. 同じ `sessionId` の動画と IMU CSV を PC へ取り込み、同じ timeline で再生・確認できるようにする。
4. 同期済み Pose / Hand / IMU を分類 pipeline の標準入力へ統合する。
5. 利き手基準、肩幅・体幹・作業台基準の正規化を入れる。
6. Hand 21点を指先代表点、手首相対座標、速度、開閉度などへ圧縮する。
7. `naziou` を中心に confusion matrix と失敗 frame を確認し、手・道具・食材の相対特徴を追加する。
8. 同一人物の動画分割評価と、被験者を分けた汎化評価を明確に分ける。

## Repository layout

| path | 内容 |
| --- | --- |
| `src/` | Web アプリ本体 |
| `server/` | Vite dev server の capture command proxy |
| `tests/` | Playwright の API / UI tests |
| `ios/IPhoneRecorderApp/` | iPhone recorder source |
| `ios/WatchRecorderApp/` | Apple Watch recorder source |
| `ios/Sources/CaptureCore/` | command schema、timing、CSV 共通処理 |
| `python/` | 抽出、同期、前処理、分類、評価 pipeline |
| `python/tests/` | Python tests と fixtures |
| `python/data/` | tracked の label 定義と dataset 配置先 |
| `python/output/` | 実験出力の配置先（生成物は通常 commit しない） |

## 主要な実装参照先

- Web entry: `src/App.tsx`
- MediaPipe detection: `src/components/PoseDetector/`
- Capture UI: `src/components/CaptureSession/CaptureSession.tsx`
- command proxy: `server/capture-command.mjs`
- iPhone coordinator: `ios/IPhoneRecorderApp/RecordingCoordinator.swift`
- Watch relay: `ios/IPhoneRecorderApp/WatchSessionBridge.swift`
- Watch recorder: `ios/WatchRecorderApp/WatchConnectivityController.swift`
- Pose / Hand extraction: `python/extract_pose_video.py`
- synchronization: `python/sync_session.py`
- classification: `python/main.py`
