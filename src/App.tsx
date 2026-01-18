import { useState, useRef, useCallback, useEffect } from 'react';
import { PoseDetector } from './components/PoseDetector/PoseDetector';
import { type PoseCanvasHandle } from './components/PoseDetector/PoseCanvas';
import { ScreenshotButton } from './components/Controls/ScreenshotButton';
import { RecordButton } from './components/Controls/RecordButton';
import { SettingsPanel } from './components/Controls/SettingsPanel';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useScreenshot } from './hooks/useScreenshot';
import { useRecorder } from './hooks/useRecorder';
import type { PoseSettings } from './types/pose';
import { DEFAULT_POSE_SETTINGS } from './types/pose';
import './App.css';

/**
 * Safariブラウザかどうかを判定
 */
function isSafari(): boolean {
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
    const canvasHandleRef = useRef<PoseCanvasHandle | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const { takeScreenshot } = useScreenshot();
    const recorder = useRecorder();

    const [browserSupported, setBrowserSupported] = useState(true);

    useEffect(() => {
        setBrowserSupported(isSupportedBrowser());
    }, []);

    const handleCanvasReady = useCallback((handle: PoseCanvasHandle) => {
        canvasHandleRef.current = handle;
    }, []);

    const handleStreamReady = useCallback((stream: MediaStream) => {
        streamRef.current = stream;
    }, []);

    const handleScreenshot = useCallback(() => {
        if (canvasHandleRef.current) {
            takeScreenshot(() => canvasHandleRef.current?.captureFrame() ?? null);
        }
    }, [takeScreenshot]);

    const handleStartRecording = useCallback(() => {
        if (streamRef.current) {
            recorder.startRecording(streamRef.current);
        }
    }, [recorder]);

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
                    <h1>骨格検出アプリ</h1>
                </header>

                <main className="app-main">
                    <PoseDetector
                        settings={settings}
                        onCanvasReady={handleCanvasReady}
                        onStreamReady={handleStreamReady}
                    />

                    <div className="controls-section">
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

                        <SettingsPanel
                            settings={settings}
                            onChange={setSettings}
                        />
                    </div>
                </main>
            </div>
        </ErrorBoundary>
    );
}

export default App;
