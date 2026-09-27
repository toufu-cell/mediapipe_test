import { useEffect, useRef, useState } from 'react';
import { parseWatchLiveResponse, watchLiveFreshness } from './watchLiveData';
import type { WatchLiveSample, WatchLiveSnapshot } from './watchLiveData';
import './WatchLive.css';

const AXES = ['X', 'Y', 'Z'];
const AXIS_COLORS = ['#ff9c8f', '#73dce0', '#f0cf75'];
const MAX_MARKERS = 100;
const FORM_STORAGE_KEY = 'watchLive.form';

function readSavedForm(): { host: string; token: string; note: string } {
    try {
        const saved: unknown = JSON.parse(window.sessionStorage.getItem(FORM_STORAGE_KEY) ?? 'null');
        if (saved && typeof saved === 'object') {
            return {
                host: 'host' in saved && typeof saved.host === 'string' ? saved.host : '',
                token: 'token' in saved && typeof saved.token === 'string' ? saved.token : '',
                note: 'note' in saved && typeof saved.note === 'string' ? saved.note : '',
            };
        }
    } catch {
        // Storage may be unavailable or contain an invalid draft; the form still works in memory.
    }
    return { host: '', token: '', note: '' };
}

interface Marker {
    id: number;
    label: string;
    note: string;
    markedAtMs: number;
    sample: WatchLiveSample;
    context: WatchLiveSample[];
}

function SignalPlot({ samples, field, title, unit }: {
    samples: WatchLiveSample[];
    field: 'gravity' | 'gyro';
    title: string;
    unit: string;
}) {
    const last = samples[samples.length - 1];
    const endTime = last?.motionTimestampSec ?? 30;
    const bound = field === 'gravity' ? 1 : Math.max(1, Math.ceil(Math.max(0, ...samples.flatMap(sample => sample.gyro.map(Math.abs)))));
    const paths = AXES.map((_, axis) => samples.map((sample, index) => {
        const x = 30 + (sample.motionTimestampSec - (endTime - 30)) / 30 * 670;
        const y = 85 - sample[field][axis] / bound * 60;
        const isGap = index === 0 || sample.motionTimestampSec - samples[index - 1].motionTimestampSec > 0.75;
        return `${isGap ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' '));
    return (
        <section className="watch-live-signal" aria-label={title}>
            <div className="watch-live-signal-heading"><h3>{title}</h3><span>{unit} · ±{bound}</span></div>
            <dl className="watch-live-values">
                {AXES.map((axis, index) => <div key={axis} style={{ color: AXIS_COLORS[index] }}>
                    <dt>{axis}</dt><dd>{last ? last[field][index].toFixed(3) : '—'}</dd>
                </div>)}
            </dl>
            <svg viewBox="0 0 720 170" role="img" aria-label={`${title}：直近30秒、X・Y・Z軸の波形。数値は上部に表示。`}>
                {[25, 85, 145].map(y => <line key={y} x1="30" x2="700" y1={y} y2={y} className={y === 85 ? 'zero-line' : 'grid-line'} />)}
                {paths.map((path, index) => <path key={index} d={path} fill="none" stroke={AXIS_COLORS[index]} strokeWidth="2" />)}
                <text x="30" y="165">−30秒</text><text x="680" y="165">現在</text><text x="8" y="89">0</text>
            </svg>
        </section>
    );
}

export function WatchLive({ onUnsavedChange }: { onUnsavedChange: (value: boolean) => void }) {
    const [form, setForm] = useState(readSavedForm);
    const { host, token, note } = form;
    const [endpoint, setEndpoint] = useState<{ host: string; token: string } | null>(null);
    const [snapshot, setSnapshot] = useState<WatchLiveSnapshot | null>(null);
    const [history, setHistory] = useState<WatchLiveSample[]>([]);
    const [markers, setMarkers] = useState<Marker[]>([]);
    const [exportedMarkerCount, setExportedMarkerCount] = useState(0);
    const [error, setError] = useState('');
    const [tick, setTick] = useState(performance.now());
    const lastResponseAt = useRef(performance.now());
    const previousSample = useRef<WatchLiveSample | null>(null);
    const markerId = useRef(0);

    useEffect(() => {
        try {
            if (form.host || form.token || form.note) {
                window.sessionStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(form));
            } else {
                window.sessionStorage.removeItem(FORM_STORAGE_KEY);
            }
        } catch {
            // Keep the current inputs usable even if browser storage is blocked or full.
        }
    }, [form]);

    useEffect(() => {
        const dirty = markers.length > exportedMarkerCount;
        onUnsavedChange(dirty);
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (!dirty) return;
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => { window.removeEventListener('beforeunload', beforeUnload); onUnsavedChange(false); };
    }, [markers.length, exportedMarkerCount, onUnsavedChange]);

    useEffect(() => {
        const timer = window.setInterval(() => setTick(performance.now()), 100);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!endpoint) return;
        let disposed = false;
        let timer: number | undefined;
        let controller: AbortController | undefined;
        const poll = async () => {
            controller = new AbortController();
            const timeout = window.setTimeout(() => controller?.abort(), 2500);
            try {
                const response = await fetch('/api/capture-command', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...endpoint, command: { type: 'watch-live' } }),
                    signal: controller.signal,
                });
                const parsed = parseWatchLiveResponse(await response.json());
                if (!response.ok) throw new Error('iPhoneへの接続に失敗しました。');
                if (disposed) return;
                const sample = parsed.sample;
                const previous = previousSample.current;
                if (sample && previous?.streamId === sample.streamId && sample.sequence < previous.sequence) {
                    throw new Error('古い連番を受信しました。再接続してください。');
                }
                if (sample && previous?.streamId === sample.streamId && sample.sequence > previous.sequence
                    && sample.motionTimestampSec <= previous.motionTimestampSec) {
                    throw new Error('センサー時刻が逆行しました。再接続してください。');
                }
                setSnapshot(parsed);
                lastResponseAt.current = performance.now();
                setTick(performance.now());
                setError('');
                if (!sample) { previousSample.current = null; setHistory([]); }
                if (sample && (previous?.streamId !== sample.streamId || previous.sequence !== sample.sequence)) {
                    previousSample.current = sample;
                    setHistory(current => {
                        const retained = previous?.streamId === sample.streamId
                            ? current.filter(row => sample.motionTimestampSec - row.motionTimestampSec <= 30)
                            : [];
                        return [...retained, sample].slice(-300);
                    });
                }
            } catch (error) {
                if (!disposed) setError(error instanceof Error && error.name !== 'AbortError'
                    ? error.message : 'iPhoneの応答がありません。接続・IP・アプリの起動状態を確認してください。');
            } finally {
                window.clearTimeout(timeout);
                if (!disposed) timer = window.setTimeout(poll, 200);
            }
        };
        void poll();
        return () => { disposed = true; controller?.abort(); window.clearTimeout(timer); };
    }, [endpoint]);

    const freshness = watchLiveFreshness(snapshot, Math.max(0, tick - lastResponseAt.current));
    const canMark = Boolean(endpoint) && !error && freshness === 'fresh' && markers.length < MAX_MARKERS;
    const status = !endpoint ? '未接続' : error ? '通信エラー' : {
        waiting: 'Watchの開始待ち', fresh: '受信中', stale: '更新停止', clock: '端末の時計差を確認',
    }[freshness];
    const sample = snapshot?.sample;
    const age = snapshot?.ageMs === null || snapshot?.ageMs === undefined
        ? null : (snapshot.ageMs + Math.max(0, tick - lastResponseAt.current)) / 1000;

    function mark(label: string) {
        if (!canMark || !sample || watchLiveFreshness(snapshot, performance.now() - lastResponseAt.current) !== 'fresh') return;
        const marker: Marker = {
            id: ++markerId.current, label, note: note.trim(), markedAtMs: Date.now(), sample,
            context: history.filter(row => row.streamId === sample.streamId && sample.motionTimestampSec - row.motionTimestampSec <= 2),
        };
        setMarkers(current => [...current, marker]);
    }

    function download() {
        const data = {
            schemaVersion: 1,
            kind: 'watch-live-inspection',
            exportedAt: new Date().toISOString(),
            units: { gravity: 'g', gyro: 'rad/s', acceleration: 'g', quaternion: 'unitless' },
            note: '最新値の間引き表示。全サンプルの記録ではない。historyは直近30秒、markersは最大100件（各直前2秒を含む）。ラベルは手動。',
            history, markers,
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `watch-live-${new Date().toISOString().replace(/:/g, '-')}.json`;
        anchor.click();
        setExportedMarkerCount(markers.length);
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return (
        <div className="watch-live">
            <header className="watch-live-heading">
                <div><h2>Watch ライブ確認</h2><p>実際に手首を動かして、どの軸がどう変わるか確認します。左右の自動判定は行いません。</p></div>
                <span className={`watch-live-status ${status === '受信中' ? 'fresh' : ''}`} role="status">{status}</span>
            </header>
            <form className="watch-live-connection" onSubmit={event => {
                event.preventDefault();
                setSnapshot(null); setHistory([]); previousSample.current = null; setError('');
                setEndpoint({ host: host.trim(), token: token.trim() });
            }}>
                <label>iPhoneのIP<input required value={host} onChange={e => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.10" disabled={Boolean(endpoint)} autoComplete="off" /></label>
                <label>ペアリングコード<input required minLength={8} maxLength={256} type="password" value={token} onChange={e => setForm({ ...form, token: e.target.value })} disabled={Boolean(endpoint)} autoComplete="off" /></label>
                {endpoint ? <button key="stop" type="button" onClick={event => {
                    event.preventDefault();
                    setEndpoint(null);
                }}>PCの受信を停止</button> : <button key="connect" type="submit">接続する</button>}
            </form>
            <p className="watch-live-help">iPhoneでRecorderを開き、Watchで「Start live」を押してください。終了時はWatchの「Stop live」も押します。通常の収録とは同時に使えません。</p>
            {error && <p className="watch-live-error" role="alert">{error}</p>}
            {endpoint && freshness === 'stale' && <p className="watch-live-warning">新しい値が届いていません。表示は最後の受信値です。Watch・iPhoneのアプリと接続を確認してください。</p>}
            {endpoint && freshness === 'clock' && <p className="watch-live-warning">WatchとiPhoneの時刻に差があります。時計を合わせてから比較してください。</p>}
            <div className="watch-live-meta">
                <span>装着設定：{sample ? `${sample.wristSide === 'right' ? '右' : '左'}手首 / クラウン${sample.crownOrientation === 'right' ? '右' : '左'}` : '—'}</span>
                <span>連番：{sample?.sequence ?? '—'}</span>
                <span>iPhone受信から：{age === null ? '—' : `${age.toFixed(1)}秒`}</span>
                <span>Watch取得 10 Hz / PC表示 最大5 Hz</span>
            </div>
            <SignalPlot samples={history} field="gravity" title="重力" unit="g" />
            <SignalPlot samples={history} field="gyro" title="ジャイロ（角速度）" unit="rad/s" />
            <section className="watch-live-details" aria-label="姿勢と加速度">
                <div><h3>姿勢 quaternion</h3><p className="watch-live-mono">{['x', 'y', 'z', 'w'].map((axis, index) => `${axis} ${sample ? sample.quaternion[index].toFixed(4) : '—'}`).join('　')}</p><p>基準：xArbitraryZVertical。撮影画面の向きや手首の関節角度ではありません。</p></div>
                <div><h3>重力を除いた加速度</h3><p className="watch-live-mono">{AXES.map((axis, index) => `${axis} ${sample ? sample.acceleration[index].toFixed(3) : '—'}`).join('　')} g</p></div>
            </section>
            <section className="watch-live-markers" aria-label="動きの確認メモ">
                <div className="watch-live-signal-heading"><h3>動きの確認メモ</h3><button onClick={download} disabled={history.length === 0 && markers.length === 0}>確認データを保存</button></div>
                <label>操作メモ<input value={note} maxLength={200} onChange={e => setForm({ ...form, note: e.target.value })} placeholder="例：肘を机に置いて、ゆっくり右へ傾ける" /></label>
                <div className="watch-live-marker-buttons">{['中立', '左傾き', '右傾き', 'その他'].map(label => <button key={label} disabled={!canMark} onClick={() => mark(label)}>{label}を記録</button>)}</div>
                <p className="watch-live-help">押したときの最新値と直前2秒を残します。最大100件。保存したJSONを共有して一緒に比較できます。画面を離れる前に保存してください。</p>
                {markers.length === MAX_MARKERS && <p className="watch-live-warning">100件に達しました。確認データを保存してください。</p>}
                <ol>{markers.slice(-8).reverse().map(marker => <li key={marker.id}><span>#{marker.id} {marker.label}</span><span>{marker.note || 'メモなし'}</span><code>g {marker.sample.gravity.map(v => v.toFixed(3)).join(', ')}</code></li>)}</ol>
            </section>
        </div>
    );
}
