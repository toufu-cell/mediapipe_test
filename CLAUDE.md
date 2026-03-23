# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

MediaPipe Tasks Visionを使用したリアルタイム骨格検出Webアプリケーション。カメラ映像から人体のポーズランドマーク（33点）と手のランドマーク（21点×2）を検出し、Canvas上に描画する。

## コマンド

```bash
npm run dev      # 開発サーバー起動 (Vite)
npm run build    # TypeScriptコンパイル + 本番ビルド
npm run preview  # ビルド成果物のプレビュー
```

## アーキテクチャ

### コンポーネント構成

```
App.tsx
├── PoseDetector          # メイン検出コンポーネント
│   ├── useCameraStream   # カメラストリーム管理
│   ├── useMediaPipe      # MediaPipe初期化・検出
│   └── PoseCanvas        # 骨格描画（表示用+録画用Canvas）
└── Controls
    ├── ScreenshotButton  # スクリーンショット
    ├── RecordButton      # 録画（WebM）
    └── SettingsPanel     # 表示設定
```

### 検出フロー

1. `useCameraStream`: getUserMediaでカメラストリーム取得
2. `useMediaPipe`: PoseLandmarkerとHandLandmarkerを並列初期化
3. `PoseDetector`: requestAnimationFrameループで検出実行
4. 検出ロジック:
   - まずPose検出を試行
   - 上半身が有効（肩+肘/手首が見える）ならPose結果を使用
   - 不十分な場合はHand検出にフォールバック

### 主要な型定義 (src/types/pose.ts)

- `DetectionResult`: 検出結果（type: 'pose' | 'hand'、landmarks配列）
- `PoseSettings`: 描画設定（色、線の太さ、ポイントサイズ）

### 描画 (src/utils/drawPose.ts)

- `drawDetectionResults`: 検出結果に基づいて骨格を描画
- Pose用とHand用で異なる接続定義を使用

## ブラウザ対応

- Chrome/Edge/Firefox: フル対応
- Safari: 非対応（MediaRecorder WebMサポートなし）

## 外部依存

MediaPipeのモデル/WASMはCDNから取得:
- WASMファイル: `cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm`
- Poseモデル: `storage.googleapis.com/.../pose_landmarker_lite.task`
- Handモデル: `storage.googleapis.com/.../hand_landmarker.task`
