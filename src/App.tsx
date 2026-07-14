import { lazy, Suspense, useState, useRef, useCallback } from 'react';
import { PoseDetector } from './components/PoseDetector/PoseDetector';
import { type PoseCanvasHandle } from './components/PoseDetector/PoseCanvas';
import { ScreenshotButton } from './components/Controls/ScreenshotButton';
import { RecordButton } from './components/Controls/RecordButton';
import { SettingsPanel } from './components/Controls/SettingsPanel';
import { VideoFileAnalyzer } from './components/VideoFileAnalyzer';
import { SkeletonPlayer } from './components/SkeletonPlayer/SkeletonPlayer';
import { CaptureSession } from './components/CaptureSession/CaptureSession';
import { MotionGraph } from './components/MotionGraph/MotionGraph';
import { MotionGraphControls } from './components/MotionGraph/MotionGraphControls';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useScreenshot } from './hooks/useScreenshot';
import { useRecorder } from './hooks/useRecorder';
import { useMotionData } from './hooks/useMotionData';
import { useMotionExport } from './hooks/useMotionExport';
import type { PoseSettings, DetectionResult } from './types/pose';
import { DEFAULT_POSE_SETTINGS } from './types/pose';
import type { InputSource, MotionGraphSettings } from './types/motion';
import { DEFAULT_MOTION_GRAPH_SETTINGS, MAX_BUFFER_FRAMES } from './types/motion';
import type { SkeletonFrame, SkeletonSource } from './types/skeletonData';
import './App.css';

const SkeletonPlayer3D = lazy(async () => {
    const module = await import('./components/SkeletonPlayer3D/SkeletonPlayer3D');
    return { default: module.SkeletonPlayer3D };
});

/**
 * Safariブラウザかどうかを判定
 */
function isSafari(): boolean {
    if (typeof navigator === 'undefined') {
        return false;
    }

    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium');
}

/**
 * 対応ブラウザかどうかを判定
 */
function isSupportedBrowser(): boolean {
    return !isSafari();
}

function App() {
    const [settings, setSettings] = useState<PoseSettings>(DEFAULT_POSE_SETTINGS);
    const [motionSettings, setMotionSettings] = useState<MotionGraphSettings>(DEFAULT_MOTION_GRAPH_SETTINGS);
    const [inputSource, setInputSource] = useState<InputSource>('camera');
    const [showMotionControls, setShowMotionControls] = useState(false);
    const canvasHandleRef = useRef<PoseCanvasHandle | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const recordingStreamRef = useRef<MediaStream | null>(null);

    const { takeScreenshot } = useScreenshot();
    const recorder = useRecorder();
    const motionData = useMotionData(motionSettings.timeWindow);
    const { exportCSV, exportJSON, exportSkeletonJSON, exportSkeletonCSV } = useMotionExport();

    // 骨格フレーム蓄積（全33点ランドマーク）
    const skeletonFramesRef = useRef<SkeletonFrame[]>([]);
    // 単調増加のフレームインデックスカウンタ（shift()後もユニーク性を維持）
    const nextFrameIndexRef = useRef(0);
    // キャプチャ時の解像度（動的取得用）
    const captureResolutionRef = useRef({ width: 640, height: 480 });

    const [browserSupported] = useState(isSupportedBrowser);
    const isAnalysisMode = inputSource === 'camera' || inputSource === 'videoFile';

    const handleCanvasReady = useCallback((handle: PoseCanvasHandle) => {
        canvasHandleRef.current = handle;
        const recordingStream = handle.getRecordingStream(30);
        if (recordingStream) {
            recordingStreamRef.current = recordingStream;
        }
    }, []);

    const handleStreamReady = useCallback((stream: MediaStream) => {
        streamRef.current = stream;
        // キャプチャ解像度を動的に取得
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            const trackSettings = videoTrack.getSettings();
            if (trackSettings.width && trackSettings.height) {
                captureResolutionRef.current = {
                    width: trackSettings.width,
                    height: trackSettings.height,
                };
            }
        }
    }, []);

    const handleDetection = useCallback((results: DetectionResult[], timestamp: number) => {
        if (inputSource === 'camera') {
            motionData.processDetection(results, timestamp);
        }

        // 骨格フレーム蓄積（全33点）— カメラ・動画ファイル両対応
        const poseResult = results.find(r => r.type === 'pose');
        const frame: SkeletonFrame = {
            frameIndex: nextFrameIndexRef.current++,
            timestampMs: timestamp,
            landmarks: poseResult
                ? poseResult.landmarks.map(lm => ({
                    x: lm.x,
                    y: lm.y,
                    z: lm.z,
                    visibility: lm.visibility ?? 0,
                }))
                : null,
        };
        skeletonFramesRef.current.push(frame);
        if (skeletonFramesRef.current.length > MAX_BUFFER_FRAMES) {
            skeletonFramesRef.current.shift();
        }
    }, [inputSource, motionData]);

    const handleScreenshot = useCallback(() => {
        if (canvasHandleRef.current) {
            takeScreenshot(() => canvasHandleRef.current?.captureFrame() ?? null);
        }
    }, [takeScreenshot]);

    const handleStartRecording = useCallback(() => {
        if (recordingStreamRef.current) {
            recorder.startRecording(recordingStreamRef.current, streamRef.current ?? undefined);
        }
    }, [recorder]);

    // 入力モード切替
    const handleInputSourceChange = useCallback((source: InputSource) => {
        setInputSource(source);
        motionData.clearBuffers();
        skeletonFramesRef.current = [];
        nextFrameIndexRef.current = 0;
    }, [motionData]);

    // 動画解像度コールバック
    const handleVideoResolution = useCallback((width: number, height: number) => {
        captureResolutionRef.current = { width, height };
    }, []);

    // エクスポート
    const handleExportCSV = useCallback(() => {
        exportCSV(motionData.fullHistory);
    }, [exportCSV, motionData.fullHistory]);

    const handleExportJSON = useCallback(() => {
        exportJSON(motionData.fullHistory, inputSource);
    }, [exportJSON, motionData.fullHistory, inputSource]);

    const handleExportSkeletonJSON = useCallback(() => {
        const source: SkeletonSource = inputSource === 'camera' ? 'camera' : 'videoFile';
        exportSkeletonJSON({
            frames: skeletonFramesRef.current,
            source,
            sourceWidth: captureResolutionRef.current.width,
            sourceHeight: captureResolutionRef.current.height,
            mirrored: inputSource === 'camera',
        });
    }, [exportSkeletonJSON, inputSource]);

    const handleExportSkeletonCSV = useCallback(() => {
        const source: SkeletonSource = inputSource === 'camera' ? 'camera' : 'videoFile';
        exportSkeletonCSV({
            frames: skeletonFramesRef.current,
            source,
            sourceWidth: captureResolutionRef.current.width,
            sourceHeight: captureResolutionRef.current.height,
            mirrored: inputSource === 'camera',
        });
    }, [exportSkeletonCSV, inputSource]);

    if (!browserSupported) {
        return (
            <div className="app unsupported-browser">
                <header className="app-header">
                    <h1>骨格検出アプリ</h1>
                </header>
                <main className="app-main">
                    <div className="browser-warning">
                        <h2>非対応ブラウザ</h2>
                        <p>
                            このアプリケーションはSafariブラウザをサポートしていません。
                        </p>
                        <p>
                            Chrome、Edge、または Firefox での使用を推奨します。
                        </p>
                    </div>
                </main>
            </div>
        );
    }

    return (
        <ErrorBoundary>
            <div className="app">
                <header className="app-header">
                    <h1>骨格検出 + モーション解析</h1>
                </header>

                <main className="app-main">
                    {/* 入力モード切替 */}
                    <div className="input-mode-toggle">
                        <button
                            className={`mode-button ${inputSource === 'camera' ? 'active' : ''}`}
                            onClick={() => handleInputSourceChange('camera')}
                        >
                            カメラ
                        </button>
                        <button
                            className={`mode-button ${inputSource === 'videoFile' ? 'active' : ''}`}
                            onClick={() => handleInputSourceChange('videoFile')}
                        >
                            動画ファイル
                        </button>
                        <button
                            className={`mode-button ${inputSource === 'skeletonPlayer' ? 'active' : ''}`}
                            onClick={() => handleInputSourceChange('skeletonPlayer')}
                        >
                            再生
                        </button>
                        <button
                            className={`mode-button ${inputSource === 'skeleton3D' ? 'active' : ''}`}
                            onClick={() => handleInputSourceChange('skeleton3D')}
                        >
                            3D再生
                        </button>
                        <button
                            className={`mode-button ${inputSource === 'captureSession' ? 'active' : ''}`}
                            onClick={() => handleInputSourceChange('captureSession')}
                        >
                            Capture Session
                        </button>
                    </div>

                    {/* カメラモード */}
                    {inputSource === 'camera' && (
                        <PoseDetector
                            settings={settings}
                            onCanvasReady={handleCanvasReady}
                            onStreamReady={handleStreamReady}
                            onDetection={handleDetection}
                            isRecording={recorder.isRecording}
                        />
                    )}

                    {/* 動画ファイルモード */}
                    {inputSource === 'videoFile' && (
                        <VideoFileAnalyzer
                            onClearBuffers={() => {
                                motionData.clearBuffers();
                                skeletonFramesRef.current = [];
                                nextFrameIndexRef.current = 0;
                            }}
                            processDetection={motionData.processDetection}
                            onDetection={handleDetection}
                            onVideoResolution={handleVideoResolution}
                            settings={settings}
                        />
                    )}

                    {/* 骨格再生モード */}
                    {inputSource === 'skeletonPlayer' && (
                        <SkeletonPlayer />
                    )}

                    {inputSource === 'skeleton3D' && (
                        <Suspense fallback={<div className="skeleton-player-loading">3Dプレーヤーを読み込み中...</div>}>
                            <SkeletonPlayer3D />
                        </Suspense>
                    )}

                    {inputSource === 'captureSession' && (
                        <CaptureSession />
                    )}

                    {/* コントロールセクション（解析モードのみ） */}
                    {isAnalysisMode && (
                    <div className="controls-section">
                        {inputSource === 'camera' && (
                            <div className="button-group">
                                <ScreenshotButton
                                    onClick={handleScreenshot}
                                    disabled={recorder.isRecording}
                                />
                                <RecordButton
                                    isRecording={recorder.isRecording}
                                    duration={recorder.duration}
                                    estimatedSize={recorder.estimatedSize}
                                    isSupported={recorder.isSupported}
                                    unsupportedReason={recorder.unsupportedReason}
                                    isWarning={recorder.isWarning}
                                    onStart={handleStartRecording}
                                    onStop={recorder.stopRecording}
                                />
                            </div>
                        )}

                        {/* エクスポートボタン */}
                        <div className="button-group export-group">
                            <button
                                className="control-button export-button"
                                onClick={handleExportCSV}
                                disabled={motionData.fullHistory.length === 0}
                            >
                                <span className="button-icon">&#128190;</span>
                                CSV エクスポート
                            </button>
                            <button
                                className="control-button export-button"
                                onClick={handleExportJSON}
                                disabled={motionData.fullHistory.length === 0}
                            >
                                <span className="button-icon">&#128190;</span>
                                JSON エクスポート
                            </button>
                            <button
                                className="control-button export-button"
                                onClick={handleExportSkeletonJSON}
                                disabled={skeletonFramesRef.current.length === 0}
                            >
                                <span className="button-icon">&#128190;</span>
                                骨格JSON エクスポート
                            </button>
                            <button
                                className="control-button export-button"
                                onClick={handleExportSkeletonCSV}
                                disabled={skeletonFramesRef.current.length === 0}
                            >
                                <span className="button-icon">&#128190;</span>
                                33ランドマークCSV
                            </button>
                        </div>

                        <SettingsPanel
                            settings={settings}
                            onChange={setSettings}
                        />
                    </div>
                    )}

                    {/* モーショングラフ（解析モードのみ） */}
                    {isAnalysisMode && (
                    <div className="motion-section">
                        <div className="motion-section-header">
                            <h2>モーション解析</h2>
                            <button
                                className="settings-toggle"
                                onClick={() => setShowMotionControls(!showMotionControls)}
                            >
                                <span className="toggle-icon">
                                    {showMotionControls ? '▼' : '▶'}
                                </span>
                                グラフ設定
                            </button>
                        </div>

                        {showMotionControls && (
                            <MotionGraphControls
                                settings={motionSettings}
                                onChange={setMotionSettings}
                            />
                        )}

                        <MotionGraph
                            data={motionData.displayData}
                            settings={motionSettings}
                            updateCount={motionData.updateCount}
                        />
                    </div>
                    )}
                </main>
            </div>
        </ErrorBoundary>
    );
}

export default App;
