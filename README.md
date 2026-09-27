# 調理工程比較システム

iPhoneの映像、MediaPipe Handsの両手21点、右手首のApple Watch IMUを同じ`sessionId`で記録・同期し、一人の他者との調理工程比較に使う研究用プロジェクトです。現在の研究ではBody Poseによる分類精度を目的にせず、Video-only提示とMultimodal提示が次回方針の形成をどう支えるかを扱います。

このファイルはプロジェクト概要と実行手順をまとめます。成果物の厳密な形式は`schemas/cooking-capture-v1.md`、現行仕様は実装とtestsを正とします。過去の実機確認と評価値は日付付きのsnapshotとして区別しています。

## 現在地

実装済みの範囲は次のとおりです。

- Webアプリで2本の調理動画を比較し、根拠区間と次回方針を記録・出力できる。
- PCから1台のiPhoneへ、予定開始時刻を持つ認証付きStart / Stop commandを送信できる。
- 同じiPhoneで音声なし1080p/30 fps動画を記録し、右手首Apple Watchへ同じsessionのcommandをrelayできる。
- Apple Watchで`userAcceleration`、`rotationRate`、`gravity`、quaternion、CoreMotion timestampを50 HzでCSVへ保存できる。
- 動画からBody Poseを生成せず、MediaPipe Handsの左右21点だけを実PTS付きで抽出できる。
- 開始直後と終了直前の3回振りから、Hand手首速度とWatch加速度を一次式で同期できる。
- 動画、Hand、右手首IMU、同期、校正の品質manifestを生成できる。
- Pose / Hand / IMU の時系列特徴量を用いて、XGBoost または Random Forest で分類・LOSO 評価できる。

旧来の左右Watch収録と分類コードは互換用に残しています。収録ファイルのPCへの自動転送、VLMによる工程対応、比較時の操作ログは未実装です。

## システム構成

```text
PC / Web app
  ├─ Capture Sessionと10秒後のstartAtを作成
  ├─ localhostのcommand proxyから1台へ送信
  └─ 動画からHandsを抽出し、Pythonで右IMUと同期・品質判定
         │
         ▼
iPhone Recorder（Camera + Watch）
  ├─ front cameraを音声なしで録画
  ├─ 右Watchへrelay
  └─ <sessionId>.mov
         │
         ▼
右 Apple Watch Recorder
  └─ <sessionId>_right_wrist_imu.csv
```

デバイスごとの責務は次のとおりです。

| 担当 | 主な責務 | 主な出力 |
| --- | --- | --- |
| PC | session作成、command送信、Hands抽出、同期、品質判定、比較 | Hand CSV、同期済みCSV、manifest |
| iPhone | command受信、予定時刻での動画録画、右Watch relay | `<sessionId>.mov` |
| 右Apple Watch | 手首IMU記録、iPhoneへの転送 | `<sessionId>_right_wrist_imu.csv` |

## Web アプリ

### 研究画面

| モード | 用途 |
| --- | --- |
| 動作比較（最初に開く画面） | 2記録を独立再生し、映像のみ／Hand＋Watchで比較して次回方針を記録 |
| 収録 | iPhoneとApple Watchの収録を制御 |
| Watchライブ | Watchの値を受信し、装着状態と動作を確認 |

カメラ解析、動画ファイル解析、骨格の2D・3D再生は研究画面から外しています。既存のソースと収録データは保持しています。動画・データの設定と表示の読み方は折り畳めます。

比較後フォームでは、気付いた違い、変更・維持・保留、理由、次回の行動・観察、結果の確認方法を記入します。記録Aを自分、記録Bを比較相手とし、選択区間を明示的に取り込みます。取り込み時の動画名、sessionId、時刻、表示条件は、その後に動画や区間を変更しても保持されます。

下書きと記録は同じブラウザの保存領域に残り、JSONへ書き出せます。動画は保存しません。保存できない場合や別タブと競合した場合は警告し、画面内の入力を書き出せるように残します。終了前にJSONを書き出してください。再読込み後は動画とCSVを選び直します。操作ログ、JSONの再読込み、2回目調理後の再評価フォームは未実装です。

研究用の比較画面は、各記録の比較用動画、MediaPipe Handsの両手21点CSV、右手首IMUを結合した同期CSVをローカルで読み込みます。右手速度は手のひら上の黄色1〜3本で表示します。Watchは強い回転のときだけ、右手首より前腕側のマゼンタのリングと、映像上部の固定表示で回転方向を示します。弧の長さは一定で、回転が強いほど速く動きます。姿勢や回転角度の数値は表示しません。リングと白い手のひら強調は手の表示サイズに合わせて縮小します。

同期CSVの必須列は `timestamp_ms`、`imu_session_id`、`imu_wrist_side`、`imu_gyro_x` です。右手首のジャイロX軸を直近100msで後方平均し、絶対値が1 rad/s以上の間だけリングを回します。弱い回転では「強い回転なし」としてリングを隠します。符号反転時には平均窓をリセットして逆回転を直ちに反映します。表示上の回転速度は角速度の2倍、上限は毎秒2回転です。これは見やすさのための演出速度であり、ジャイロを積分して実際の角度を推定するものではありません。閾値・倍率・上限は試用条件です。

今回の装着状態での試用として、`+gyroX` を左回転（反時計回り）、`−gyroX` を右回転（時計回り）へ対応づけます。保存した実機ライブ観測では回転時にX軸が主に変化しましたが、観測点は少なく、静止姿勢の手動ラベルを回転方向の正解として評価していません。この対応は装着者の解剖学的な左右や別の装着向きへの一般化を保証しません。カメラの鏡像・Hand座標・検出状態では反転せず、Hand未検出でも有効なWatchデータがあれば固定表示で方向を確認できます。Y/Z軸・重力・quaternionへの代替計算、自動軸選択、基準姿勢の校正は行いません。力や技能の良否は判定しません。

CSV内の空欄は欠測として保持し、欠測点から再開するまで、または直前の値が100msを超えて古い間は「データ不足」とします。未来の値は使いません。欠測や100ms超の間隔では平均窓と演出位相をリセットします。リングの位相は動画時刻に対応するため、一時停止で止まり、同じ位置へのシークで同じ描画に戻ります。OSの「動きを減らす」設定では静止矢印と方向文字で示します。詳細グラフは符号付きX角速度（rad/s、正が左・負が右）で、弱い回転も隠さず示します。各選択区間を0–100%へ正規化した概要であり、現在の再生位置同士の対応や技能の良否を示すものではありません。既存カメラ画面にはPose機能も残っていますが、研究データには使用しません。

比較画面自体は同期CSVの生成方式を判定しません。正式実験へ使う前に、同期metadataと品質manifestで開始・終了3振りによるaffine同期を確認してください。現在のパンケーキ2記録は[captures/PANCAKE-COMPARISON-PILOT.md](captures/PANCAKE-COMPARISON-PILOT.md)の制約に従い、探索用UI確認だけに使用します。

Safari は非対応です。Chrome、Edge、Firefox を使用してください。

保持している旧解析機能を再接続する場合は、初回のPose / Hand検出時に外部からWASMとモデルを取得します。現在の比較画面は抽出済みのCSVを読み込みます。

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
- pairing code は iPhone が生成・保持し、PC の Capture Session 画面へ入力する。新規生成されるcodeは、紛らわしい文字を除いた8文字。
- codeは8〜256文字（既存の長いtokenも利用可能）。request は最大 16 KiB、response は最大 8 KiB。
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
            "filename": "capture_20260524_203000.mov",
            "enabled": true
        },
        "watch": {
            "device": "apple_watch",
            "sampleRateHz": 50,
            "filename": "capture_20260524_203000_right_wrist_imu.csv",
            "wristSide": "right"
        }
    }
}
```

研究用の既定モードでは、右手首Watchとpairingした1台のiPhoneへ上記を送ります。互換用の`Legacy · video + both wrists`を選んだ場合だけ、旧来の左右2台へ送ります。旧commandとの互換性のため、`video.enabled`がない場合は`true`として扱います。

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

1. PCが10秒後の`startAt`を生成し、iPhoneへStart commandを送る。
2. iPhoneはcameraを準備し、右Apple Watchへcommandをrelayする。
3. iPhoneとWatchは`startAt`まで待って動画とIMUの記録を始める。
4. 参加者は開始直後と終了直前に右手首を3回振る。
5. 後処理でHand手首速度と`userAcceleration`ノルムの開始3点・終了3点を対応させ、`videoTime = scale * coreMotionElapsedTime + intercept`をfitする。

`startAt`は予定開始用のwall clockです。最終同期には単調増加する`core_motion_elapsed_ms`を使い、`timestamp_ms`と`elapsed_ms`は互換情報として残します。

研究用モードでは1台がStartを受理した場合だけ成功扱いにします。失敗時は同じsessionへStopを試行し、成否が不明ならUIを`Stop required`に保ちます。収録後は動画1本と右CSV 1本が同じ`sessionId`で揃っていることを確認してください。

### 収録前後の checklist

1. PCとiPhoneを同じLANに接続し、iPhoneと右Apple Watchをpairingする。
2. Apple Watchを右手首へ固定し、Watchの「設定 > 一般 > 向き」も右手首にして、iPhone Recorderの`Recorder role`を`Camera + Watch`にする。
3. iPhone RecorderとWatch Recorderを前面・activeのまま待機させる。
4. Capture Sessionで`Research · video + right wrist`を選び、iPhoneのIP addressとpairing codeを入力する。
5. `Start research capture`を押し、iPhoneが録画中、Watchが`Recording`になったことを確認する。
6. 開始直後に右手首を3回振り、調理前の校正姿勢で2〜3秒静止する。
7. 調理終了後、もう一度右手首を3回振ってから`Stop research capture`を押す。
8. 音声なし動画と右Watch CSVをPCへ回収し、同じ`sessionId`であることを確認する。

Watch app が前面にない場合、Extended Runtime の開始は active 復帰まで保留されます。同期ジェスチャと冒頭の IMU を取り逃さないよう、Start 前に必ず Watch Recorder を開いてください。

### Watch ライブ確認

Web画面の「Watchライブ」、または `/?mode=watchLive` から、Watchの重力・ジャイロ（角速度）のXYZ波形、姿勢quaternion、加速度を確認できます。このモードではPCカメラを起動せず、左右の自動判定も行いません。

1. 更新版のiPhone RecorderとWatch Recorderを起動する。PCとiPhoneは同じネットワークに接続する。
2. Watchの `Start live` を押す。通常収録・未完了の書き出しがある間は開始できない。
3. Web画面にiPhoneのIPとペアリングコードを入力して「接続する」を押す。
4. 手首を動かし、「中立・左傾き・右傾き・その他を記録」で、その瞬間の値と直前2秒の受信値に手動ラベルを付ける。操作メモには肘の置き方や動かし方も残す。
5. 「確認データを保存」でJSONを保存し、共有して比較する。直近30秒と最大100件の確認メモが含まれ、IP・ペアリングコードは含まれない。
6. Webの「PCの受信を停止」とWatchの `Stop live` をそれぞれ押す。PC側の停止だけではWatchの取得は止まらない。

IP・ペアリングコード・入力中の操作メモは、そのタブの `sessionStorage` に保持します。受信停止・画面切り替え・再読み込み後も再入力せずに使えますが、自動再接続はしません。消したい項目は入力欄を空にしてください。ブラウザが保存を拒否する場合は、画面を開いている間だけ保持します。波形や記録済みの確認メモは復元対象ではないため、画面を離れる前にJSONで保存してください。

Watchは10 Hzで取得し、WatchConnectivityで最新値をiPhoneへ送ります。即時通信が利用できないときや返信が遅延したときは、最大2 Hzで `updateApplicationContext` に最新値を渡します。この経路は送信待ちを最新1件へ置き換え、配送時刻はOSが決めます。Watchの `background queued` は配送済みを意味しません。即時・バックグラウンドの両経路で同じ連番と取得時刻を使い、古い値や重複受信で鮮度を更新しません。

PCは既存の認証付きローカル経路を最大5 Hzで照会します。これは最新値の間引き表示であり、全サンプルを保存する収録機能ではありません。更新が1.5秒を超えて止まった場合や不正な値・時刻差を検出した場合は、確認メモの追加を無効にします。表示値は最後の受信値として残ります。バックグラウンド配送の遅延も検出対象であり、常に1.5秒以内で届く保証はありません。

WatchのExtended Runtimeには有効期間があり、実行期限やセンサーエラーなどで停止することがあります。通信不可の間は取得とバックグラウンド更新を続けますが、常時稼働・連続配送は保証しません。取得自体が停止したときはWatchで `Start live` を押してください。通常収録のCSVと今回の確認JSONは別物です。

### Watch IMU CSV

```csv
session_id,wrist_side,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm,core_motion_timestamp_s,core_motion_elapsed_ms,gravity_x,gravity_y,gravity_z,quaternion_x,quaternion_y,quaternion_z,quaternion_w
capture_20260524_203000,right,1779622203000,0,0.010000,0.980000,0.030000,0.100000,0.020000,0.010000,0.980510,0.102470,1234.500000,0,0.000000,-1.000000,0.000000,0.000000,0.000000,0.000000,1.000000
```

- `wrist_side`: 研究用収録では`right`
- `timestamp_ms`: Unix time milliseconds
- `elapsed_ms`: 未来Startでは予定時刻 `startAt`、過去Startでは実際の記録開始からの経過 milliseconds
- `accel_*`: CoreMotion `userAcceleration`
- `gyro_*`: CoreMotion `rotationRate`
- `accel_norm`, `gyro_norm`: 各3軸の Euclidean norm
- `core_motion_timestamp_s`, `core_motion_elapsed_ms`: 同期に使う単調増加時刻
- `gravity_*`: CoreMotion `gravity`
- `quaternion_*`: `xArbitraryZVertical`基準の`x,y,z,w`

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

### 動画からHandsだけを抽出

```bash
cd python
.venv-extract/bin/python extract_pose_video.py ../path/to/video.mp4 \
  -o output/extract \
  --hands-only \
  --max-hands 2
```

`<sessionId>_hand_landmarks.json`と`<sessionId>_hand_landmarks.csv`を生成します。各frameへLeft / Rightの2行を必ず出し、未検出側は`detected=false`にします。時刻は動画containerのPTSを優先し、取得不能時だけ`frame_index_fps_fallback`を記録します。`--hands-only`ではBody Pose modelを読み込みません。

### Handsと右手首IMUを同期

```bash
cd python
.venv/bin/python sync_session.py \
  --pose-csv output/extract/capture_xxx_hand_landmarks.csv \
  --imu-csv ../path/to/capture_xxx_right_wrist_imu.csv \
  --output-dir output/extract/sync \
  --watch-side right \
  --sync-method affine \
  --search-window-ms 10000 \
  --end-search-window-ms 10000
```

同期処理は次を出力します。

- `<sessionId>_sync_metadata.json`: `scale`、`intercept_ms`、drift、残差、使用ピーク
- `<sessionId>_synced_pose_imu.csv`: 各video frame timestampに最も近い右IMU sampleを結合した互換名のCSV
- `<sessionId>_sync_diagnostic.png`: 両 signal と peak の確認図

6点の対応、drift、残差が基準外なら自動同期を失敗させます。自動検出だけが失敗した場合は、開始3点・終了3点を次のように手動指定できます。

```bash
.venv/bin/python sync_session.py \
  --pose-csv output/extract/capture_xxx_hand_landmarks.csv \
  --imu-csv ../path/to/capture_xxx_right_wrist_imu.csv \
  --output-dir output/extract/sync \
  --sync-method affine \
  --manual-video-times-ms 1200 1900 2700 172000 172800 173500 \
  --manual-imu-times-ms 1620 2320 3120 172505 173305 174005
```

### 品質manifest

校正JSONを用意した後、映像・Hand・IMU・同期の品質を1ファイルへまとめます。校正JSONの必須fieldは[schemas/cooking-capture-v1.md](schemas/cooking-capture-v1.md)を参照してください。

```bash
.venv/bin/python capture_quality_manifest.py \
  --session-id capture_xxx \
  --participant-id participant_001 \
  --trial-id trial_1 \
  --condition multimodal \
  --video ../path/to/capture_xxx.mov \
  --hand-csv output/extract/capture_xxx_hand_landmarks.csv \
  --imu-csv ../path/to/capture_xxx_right_wrist_imu.csv \
  --sync-metadata output/extract/sync/capture_xxx_sync_metadata.json \
  --calibration-status valid \
  --calibration-metadata ../path/to/capture_xxx_calibration.json \
  --output output/extract/capture_xxx_quality_manifest.json
```

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
