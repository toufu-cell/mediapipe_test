import { useState } from 'react';
import { CaptureSession } from './components/CaptureSession/CaptureSession';
import { MotionComparison } from './components/MotionComparison/MotionComparison';
import { WatchLive } from './components/WatchLive/WatchLive';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import './App.css';

type ResearchPage = 'motionComparison' | 'captureSession' | 'watchLive';

const PAGES: { id: ResearchPage; label: string }[] = [
    { id: 'motionComparison', label: '動作比較' },
    { id: 'captureSession', label: '収録' },
    { id: 'watchLive', label: 'Watchライブ' },
];

function App() {
    const [page, setPage] = useState<ResearchPage>(() => {
        const mode = new URLSearchParams(window.location.search).get('mode');
        return mode === 'watchLive' || mode === 'captureSession' ? mode : 'motionComparison';
    });
    const [watchHasUnsavedNotes, setWatchHasUnsavedNotes] = useState(false);
    const [planHasUnsavedNotes, setPlanHasUnsavedNotes] = useState(false);
    const ua = navigator.userAgent.toLowerCase();
    const browserSupported = !(ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium'));

    function navigate(next: ResearchPage) {
        if (next === page) return;
        if (page === 'watchLive' && watchHasUnsavedNotes
            && !window.confirm('保存していないWatchの確認メモがあります。破棄して画面を切り替えますか？')) return;
        if (page === 'motionComparison' && planHasUnsavedNotes
            && !window.confirm('保存できていない次回方針があります。書き出さずに画面を切り替えますか？')) return;
        setPage(next);
    }

    return (
        <ErrorBoundary>
            <div className={`app research-app ${page === 'motionComparison' ? 'comparison-app' : ''}`}>
                <header className="app-header research-header">
                    <h1>調理の比較と振り返り</h1>
                    {browserSupported && (
                        <nav className="research-nav" aria-label="研究メニュー">
                            {PAGES.map(item => (
                                <button
                                    key={item.id}
                                    type="button"
                                    aria-current={page === item.id ? 'page' : undefined}
                                    onClick={() => navigate(item.id)}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </nav>
                    )}
                </header>
                <main className="app-main">
                    {!browserSupported ? (
                        <div className="browser-warning">
                            <h2>非対応ブラウザ</h2>
                            <p>Chrome、Edge、Firefoxで開いてください。</p>
                        </div>
                    ) : (
                        <>
                            {page === 'motionComparison' && <MotionComparison onUnsavedChange={setPlanHasUnsavedNotes} />}
                            {page === 'captureSession' && <CaptureSession />}
                            {page === 'watchLive' && <WatchLive onUnsavedChange={setWatchHasUnsavedNotes} />}
                        </>
                    )}
                </main>
            </div>
        </ErrorBoundary>
    );
}

export default App;
