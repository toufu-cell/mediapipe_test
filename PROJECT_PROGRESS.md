# MediaPipe 調理行動認識プロジェクト進捗

最終更新: 2026-05-31

## 研究の狙い

調理過程を低負担に記録し、振り返りや調理支援に使える形へつなげる。現在の中心は、固定カメラ映像から MediaPipe で骨格・手元情報を取得し、時系列特徴量から行動分類を行うこと。

発表資料上では、将来的に手首センサの加速度・角速度を補助入力として統合し、映像だけでは弱い細かな手元動作や静止動作を補う方針になっている。2026-05-25 時点で、iPhone 動画録画と Apple Watch IMU 記録を同じ session ID で開始・停止し、PC に回収して長さ・欠損を確認するところまで進めた。

## 実装済み

### Web アプリ

- React / Vite / TypeScript の MediaPipe 骨格検出アプリがある。
- 入力モードは `camera`、`videoFile`、`skeletonPlayer`、`skeleton3D`、`captureSession` に対応している。
- MediaPipe Pose / Hand を使い、Pose が不十分な場合に Hand 検出を補助的に使う構成になっている。
- カメラ映像・動画ファイルから骨格を検出し、Canvas 上に描画できる。
- スクリーンショット、WebM 録画、モーショングラフ表示、CSV / JSON エクスポートが実装済み。
- 33 ランドマーク CSV / Skeleton JSON のエクスポートに対応している。

主な参照先:

- `src/App.tsx`
- `src/components/PoseDetector/`
- `src/components/VideoFileAnalyzer.tsx`
- `src/components/SkeletonPlayer/`
- `src/components/SkeletonPlayer3D/`
- `src/hooks/useMotionExport.ts`

### Capture Session / iPhone 録画連携

- Web アプリに `captureSession` 入力モードを追加し、PC 側で session ID、予定開始時刻、同期用ジェスチャ情報を作れる。
- Capture Session 画面から iPhone IP を指定し、Start / Stop ボタンで録画 command を送る UI がある。
- 再測定用に `New session` ボタンを追加し、milliseconds + revision 付きの session ID を発行できる。これにより、測定のたびに app を再インストールしなくても新しい session で記録できる。
- Vite dev server に `/api/capture-command` を追加し、Web UI から iPhone app の TCP `8765` へ newline-delimited JSON command を転送できる。
- API 側は dev 用のローカル連携として、host / port / command type の validation、port `8765` 固定、same-origin Origin check、body / response size limit、TCP timeout を持つ。
- Playwright test では `/api/capture-command` を mock し、実機へ誤って command を送らないようにしている。
- iPhone SwiftUI app を追加し、TCP `8765` で `start` / `stop` command を受けられる。
- `startAt` 指定がある場合は予定時刻まで待って録画を開始し、`stop` command で録画を停止する。
- 録画ファイルは iPhone app の Documents に保存し、録画完了後に Photos app へ追加する処理を入れている。
- カメラは実験時の撮影条件に合わせて内カメラを使う設定にしている。
- Apple Watch へ start / stop payload を relay する `WatchSessionBridge` を実装済み。
- Apple Watch 側に `WatchRecorderApp` を追加し、WatchConnectivity 経由で iPhone app から start / stop command を受けられる。
- Apple Watch 側では `CoreMotion` で手首の加速度・角速度を記録し、`session_id,timestamp_ms,elapsed_ms,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z,accel_norm,gyro_norm` 形式の CSV として保存できる。
- 記録後、Apple Watch 側 CSV を iPhone app へ転送する処理を入れている。
- Watch app 側には `WKExtendedRuntimeSession` と `WKBackgroundModes = self-care` を追加し、測定中に app が止まりにくいようにした。
- Watch app が active/frontmost になる前に runtime start が失敗した場合は pending start を保持し、active 復帰時に retry する。
- start / stop command は即時送信と queue 送信の両方を使い、Watch が一時的に reachable でない場合でも後から届くようにしている。

主な参照先:

- `src/components/CaptureSession/CaptureSession.tsx`
- `server/capture-command.mjs`
- `vite.config.ts`
- `tests/capture-session.spec.ts`
- `tests/capture-command-api.test.mjs`
- `ios/IPhoneRecorderApp.xcodeproj/`
- `ios/IPhoneRecorderApp/`
- `ios/WatchRecorderApp/`
- `ios/Sources/CaptureCore/`

### Python パイプライン

- `python/main.py` に 2D 骨格 CSV から行動分類する CLI がある。
- Label Studio の TimelineLabels 形式を内部形式へ正規化し、`motion.csv` と `labeling.json` を subject 単位で読み込める。
- train はラベル境界を跨がない windowing、eval は full sequence windowing で処理する設計。
- `other` ラベルは学習・評価から除外し、残りのラベル ID を振り直す。
- CSV の数値カラムを自動検出し、各 window で mean / var / std / max / min / median を特徴量化する。
- XGBoost / Random Forest 系の評価出力、混同行列、時系列比較プロットを生成できる。
- `python/extract_pose_video.py` に動画から Pose Skeleton JSON / 33 ランドマーク CSV / frame metadata / overlay mp4 を抽出する処理がある。
- `--detect-hands` 指定時は Hand 21 点の JSON / CSV も出力できる。
- `python/plot_extracted_pose.py` に抽出品質確認用の plot 生成処理がある。
- `python/sync_session.py` に、抽出済み Pose CSV と Apple Watch IMU CSV を同期する CLI を追加した。
- 同期 CLI は、左手 Watch 前提で開始直後の 3 回振り同期ジェスチャを使い、動画側の `leftWrist` 速度と Watch 側の `gyro_norm` のピークから `offset_ms` を推定する。
- 同期 CLI は `sync_metadata.json`、`synced_pose_imu.csv`、`sync_diagnostic.png` を出力し、ピーク対応が不安定な場合は自動同期を失敗させる。必要に応じて `--manual-offset-ms` で手動補正できる。
- 同期 CLI の単体テストとして `python/tests/test_sync_session.py` を追加し、合成データで offset 推定、誤ピーク reject、IMU schema、manual offset、出力生成を確認している。
- Python 側は単体テストが整備されている。

主な参照先:

- `python/main.py`
- `python/extract_pose_video.py`
- `python/render_pose_overlay_video.py`
- `python/plot_extracted_pose.py`
- `python/sync_session.py`
- `python/modules/`
- `python/tests/`

### 発表・説明資料

- 研究アプローチ、カメラ配置、システム概要のスライド HTML / PPTX がルートにある。
- 読み込んだ発表資料では、固定カメラによる空間文脈と手首センサによる手元動作特徴量を統合する構想が整理されている。

主な参照先:

- `research-approach-slide.html`
- `camera-placement-slide.html`
- `system-overview-slide.html`
- `system-overview-slide.pptx`
- `/path/to/reference-presentation.pptx`

## 実験済みの内容

### 基礎分類実験

- 現在のラベル定義は `other`, `walk`, `sit`, `stop`。
- 発表資料では、30 秒程度の動画 7 本から 3 種類の行動を分類し、平均正解率 70.7%、最良 73.7% と整理されている。
- `python/output/` にはローカル実験出力として特徴量 CSV、混同行列、時系列 plot、LOSO/LOVO 相当の summary が残っている。

### 出力に残っている評価例

`subject-1` から `subject-5` を fold とした LOSO / Leave-One-Video-Out 相当の評価として、次の summary が確認できる。ここでの `subject` は必ずしも独立した被験者を意味しないため、被験者汎化の結果とは言い切らない。

| 出力                                                   | 平均 accuracy | 平均 macro F1 | メモ                     |
| ------------------------------------------------------ | ------------: | ------------: | ------------------------ |
| `python/output/loso_w1s/loso_summary.csv`              |        0.7016 |        0.6393 | 1 秒 window の基礎評価   |
| `python/output/loso_33lm_w1s/loso_summary.csv`         |        0.7177 |        0.6417 | 33 ランドマーク CSV 入力 |
| `python/output/loso_33lm_no_other_v3/loso_summary.csv` |        0.7074 |        0.5869 | `other` 除外系の評価     |
| `python/output/rf/loso_summary.csv`                    |        0.7457 |        0.6377 | Random Forest 系の評価   |

### 動画抽出・品質確認

- `python/output/img_1752_test/`、`python/output/img_1954_extract/` など、実動画から抽出した出力がある。
- frame metadata に `pose_status`、`interpolated`、`invalid_reason`、`arm_selection` などを残す設計になっている。
- 横向き撮影では手先データの欠損が比較的少ない、という観察が発表資料にある。

### iPhone 録画連携の確認

- Xcode を導入し、`xcode-select -p` が `/Applications/Xcode.app/Contents/Developer` を指す状態になっている。
- iPhone 実機に `IPhoneRecorderApp` をインストールし、信頼されていないデベロッパ表示への対応後、iPhone 側で app を起動できた。
- PC から iPhone `:8765` へ start / stop command を送り、iPhone 側が `Recording` 表示になることを手元確認した。
- Web UI の Start / Stop は Playwright 上で `/api/capture-command` を mock した payload 送信確認に加えて、実機への Web ボタン経由 end-to-end 確認も完了した。
- 最新 build を iPhone に入れ直し、録画後に Photos app へ保存されることを実機確認した。

### Apple Watch IMU 記録の確認

- Watch app を実機へインストールし、iPhone app から start / stop command を送れることを確認した。
- 当初は Watch app が未インストール、reachable でない、start を取り逃がして stop だけ届く、runtime start が active 前に失敗する、などの問題があった。
- start command を queue にも乗せ、Extended Runtime の開始後に recording を schedule し、active 復帰時に retry する実装へ修正した。
- Extended Runtime 追加前は Watch CSV に大きな欠損が出るケースがあったが、修正後は複数回の測定で 50Hz 近辺の連続記録を確認した。

確認済みの 5 セッション:

| session | 動画 | Watch CSV span | 差分 | 欠損 |
| --- | ---: | ---: | ---: | --- |
| `capture_20260525_051743_555_07` | 42.702s | 43.557s | +0.855s | なし |
| `capture_20260525_051252_302_06` | 48.902s | 49.473s | +0.571s | なし |
| `capture_20260525_050641_618_05` | 42.102s | 42.730s | +0.628s | なし |
| `capture_20260525_050005_471_04` | 58.268s | 59.011s | +0.743s | なし |
| `capture_20260525_045607_232_03` | 63.235s | 63.704s | +0.469s | なし |

全セッションで平均 interval は約 20.127ms、`40ms` 超 gap、`100ms` 超 gap、時刻の逆行はいずれも 0。動画と CSV の差分は欠損ではなく、予定開始時刻と実録画開始・停止タイミングの差として扱う。

## 現在の課題

- 調理行動認識の研究目的に対して、現在の学習ラベルは `walk` / `sit` / `stop` 中心で、調理動作ラベルへの拡張が必要。
- `stop` のような骨格変化が小さい区間は誤判定されやすい。
- Hand 骨格は 21 点 x 両手で情報量が多く、そのまま特徴量へ入れると扱いが重い。合成特徴量化または分類対象の整理が必要。
- 左利き・右利きの違いがノイズになりうるため、利き手基準の特徴量へ変換する必要がある。
- 撮影方向が変わっても比較できるように、身体または作業空間に対する基準点を定義する必要がある。
- Watch CSV の `elapsed_ms` は共通の予定開始時刻 `startAt` 基準であり、厳密には iPhone の実録画開始時刻そのものではない。同期動作ピークによる補正 CLI は追加済みだが、実データでの閾値検証と iPhone 側の実録画開始 metadata 保存はまだ必要。
- iPhone 動画と Apple Watch IMU データは手動で PC へ回収できるが、PC 側 UI に読み込み、同じ timeline 上で確認する処理は未実装。
- Python の分類入力は現状 CSV 中心。同期済み Pose + Watch IMU CSV の生成 CLI は追加済みだが、分類パイプラインの特徴量化・学習入力への統合は未実装。
- `ios/README.md` は Watch install 手順を一部追記済みだが、現在の全体運用手順としてはまだ整理が必要。

## 次にやること

1. iPhone 動画と Apple Watch IMU データを PC に取り込み、同期ジェスチャ補正を実データで検証する。
   - 開始直後の 3 回振り同期動作を使い、動画時刻と IMU 時刻が合うか `sync_diagnostic.png` で確認する。
   - 実データでピーク検出閾値、許容 interval 差、offset ばらつき閾値を調整する。
   - 可能なら iPhone 側の実録画開始時刻を metadata として保存する。

2. 回収した `.mov` / `_wrist_imu.csv` を PC 側 UI で読み込めるようにする。
   - 同じ session ID の動画と IMU CSV を紐づける。
   - timeline 上で動画と IMU 波形を同時確認できるようにする。

3. MediaPipe 姿勢推定結果と Watch IMU を同じ timeline 上で比較する。
   - 動画から抽出した Pose / Hand 特徴量と IMU 特徴量を時刻で結合する。
   - IMU の `accel_norm` / `gyro_norm` や短時間統計量を特徴量候補にする。

4. 調理動作データを増やす。
   - まずは包丁操作を含む下ごしらえ動作を対象にする。
   - 将来的にフライパン操作などへ拡張する。

5. 調理動作用のラベル体系を作る。
   - 現在の `walk` / `sit` / `stop` から、調理器具を使った動作ラベルへ移行する。
   - `other` の扱いと、静止区間を独立クラスにするか補助状態にするかを決める。

6. カメラ単体で分類しやすい動作と難しい動作を整理する。
   - Pose だけで十分な動作。
   - Hand を足すと改善しそうな動作。
   - ウェアラブルが必要になりそうな動作。

7. Hand 特徴量を圧縮する。
   - 指先代表点、手首からの相対座標、速度、開閉度などに集約する。
   - 全 21 点をそのまま入れる案と、合成特徴量案を比較する。

8. 利き手基準・身体基準の正規化を入れる。
   - 左利きデータを右利き相当に反転するか、利き手側 / 非利き手側として特徴量名を揃える。
   - 撮影方向差を減らすため、肩幅、体幹、作業台位置などを基準に正規化する。

9. 評価設計を整理する。
   - 同一人物の動画分割評価と、被験者を分けた汎化評価を明確に分ける。
   - accuracy だけでなく macro F1、クラス別 recall、混同行列、時系列の誤判定箇所を見る。

## 主要コマンド

```bash
npm run dev
npm run build
./node_modules/.bin/playwright test tests/capture-session.spec.ts
./node_modules/.bin/tsc
./node_modules/.bin/vite build
```

```bash
xcodebuild -project ios/IPhoneRecorderApp.xcodeproj \
  -scheme IPhoneRecorderApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build

xcodebuild -project ios/IPhoneRecorderApp.xcodeproj \
  -target WatchRecorderApp \
  -destination 'id=<WATCH_DESTINATION_ID>' \
  -quiet build

xcrun devicectl device install app \
  --device <WATCH_DEVICE_ID> \
  ios/build/Release-watchos/WatchRecorderApp.app

cd ios
swift run CaptureCoreSelfTest
```

```bash
xcrun devicectl device info files \
  --device <IPHONE_DEVICE_ID> \
  --domain-type appDataContainer \
  --domain-identifier app.mediapipe.IPhoneRecorderApp \
  --subdirectory Documents
```

```bash
cd python
.venv/bin/python -m pytest --capture=no -p no:cacheprovider tests -v
.venv/bin/python3.11 -m pytest tests/test_sync_session.py -v
.venv/bin/python main.py --loso -w 1.0 -s 0.5 -o output/loso
```

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

```bash
cd python
.venv/bin/python3.11 sync_session.py \
  --pose-csv output/extract/capture_xxx_33landmarks.csv \
  --imu-csv ../path/to/capture_xxx_wrist_imu.csv \
  --output-dir output/extract/sync \
  --watch-side left
```

## 参照した主なディレクトリ

- `src/`: Web アプリ本体
- `server/`: dev server 側 capture command API
- `ios/`: iPhone / Apple Watch recorder app と CaptureCore
- `python/`: 抽出・前処理・分類・評価パイプライン
- `python/data/`: ラベル定義と subject データ置き場
- `python/output/`: ローカル実験出力
- `python/tests/`: Python パイプラインのテスト
- `docs/`: 仕様書とフローチャート
- `docs/labeling-workflow.md`: Label Studio ラベリング手順、動画変換、seek 不具合対策
- `pptx-system-overview/`: 生成済み PPTX 展開物
