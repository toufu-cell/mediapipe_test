import { useMemo, useState } from 'react';

type CaptureStatus = 'idle' | 'recording' | 'stopped';
type CommandStatus = 'idle' | 'sending' | 'sent' | 'error';

interface StartCommandPayload {
    type: 'start';
    sessionId: string;
    startAt: string;
    expectedDurationSec: number;
    syncGesture: 'wrist_shake_3_times';
    video: {
        device: 'iphone';
        filename: string;
    };
    watch: {
        device: 'apple_watch';
        sampleRateHz: number;
        filename: string;
    };
}

interface StopCommandPayload {
    type: 'stop';
    sessionId: string;
    stopAt: string;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function padMilliseconds(value: number): string {
    return String(value).padStart(3, '0');
}

function buildSessionId(date: Date, revision: number): string {
    return [
        'capture',
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
        padMilliseconds(date.getMilliseconds()),
        String(revision).padStart(2, '0'),
    ].join('_');
}

function toLocalIso(date: Date): string {
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absMinutes = Math.abs(offsetMinutes);
    const offset = `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${offset}`;
}

function buildStartPayload(sessionId: string, startAt: Date): StartCommandPayload {
    return {
        type: 'start',
        sessionId,
        startAt: toLocalIso(startAt),
        expectedDurationSec: 180,
        syncGesture: 'wrist_shake_3_times',
        video: {
            device: 'iphone',
            filename: `${sessionId}.mov`,
        },
        watch: {
            device: 'apple_watch',
            sampleRateHz: 50,
            filename: `${sessionId}_wrist_imu.csv`,
        },
    };
}

function buildStopPayload(sessionId: string, stopAt: Date): StopCommandPayload {
    return {
        type: 'stop',
        sessionId,
        stopAt: toLocalIso(stopAt),
    };
}

function getInitialIphoneHost(): string {
    if (typeof window === 'undefined') {
        return '';
    }
    return window.localStorage.getItem('capture.iphoneHost') ?? '';
}

function getInitialPairingToken(): string {
    if (typeof window === 'undefined') {
        return '';
    }
    return window.localStorage.getItem('capture.pairingToken') ?? '';
}

export function CaptureSession() {
    const [sessionSeed, setSessionSeed] = useState(() => ({
        createdAt: new Date(),
        revision: 0,
    }));
    const [scheduledStartAt, setScheduledStartAt] = useState(() => new Date(Date.now() + 3000));
    const [status, setStatus] = useState<CaptureStatus>('idle');
    const [commandStatus, setCommandStatus] = useState<CommandStatus>('idle');
    const [commandMessage, setCommandMessage] = useState('No command sent');
    const [iphoneHost, setIphoneHost] = useState(getInitialIphoneHost);
    const [pairingToken, setPairingToken] = useState(getInitialPairingToken);
    const [stopAt, setStopAt] = useState<Date | null>(null);

    const sessionId = useMemo(
        () => buildSessionId(sessionSeed.createdAt, sessionSeed.revision),
        [sessionSeed]
    );

    const startPayload = useMemo(
        () => buildStartPayload(sessionId, scheduledStartAt),
        [sessionId, scheduledStartAt]
    );

    const stopPayload = useMemo(
        () => buildStopPayload(sessionId, stopAt ?? new Date()),
        [sessionId, stopAt]
    );

    const isSending = commandStatus === 'sending';

    const sendCommand = async (command: StartCommandPayload | StopCommandPayload) => {
        const host = iphoneHost.trim();
        if (!host) {
            setCommandStatus('error');
            setCommandMessage('iPhone IP is required');
            return false;
        }

        const token = pairingToken.trim();
        if (token.length < 16) {
            setCommandStatus('error');
            setCommandMessage('Pairing token must contain at least 16 characters');
            return false;
        }

        window.localStorage.setItem('capture.iphoneHost', host);
        window.localStorage.setItem('capture.pairingToken', token);
        setCommandStatus('sending');
        setCommandMessage(`Sending ${command.type} command`);

        try {
            const response = await fetch('/api/capture-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port: 8765, token, command }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.ok) {
                throw new Error(result.error || `Command failed with HTTP ${response.status}`);
            }

            setCommandStatus('sent');
            setCommandMessage('Command accepted');
            return true;
        } catch (error) {
            setCommandStatus('error');
            setCommandMessage(error instanceof Error ? error.message : 'Command failed');
            return false;
        }
    };

    const handleStart = async () => {
        const nextStartAt = new Date(Date.now() + 3000);
        const command = buildStartPayload(sessionId, nextStartAt);
        setScheduledStartAt(nextStartAt);
        setStopAt(null);

        if (await sendCommand(command)) {
            setStatus('recording');
        }
    };

    const handleStop = async () => {
        const nextStopAt = new Date();
        const command = buildStopPayload(sessionId, nextStopAt);
        setStopAt(nextStopAt);

        if (await sendCommand(command)) {
            setStatus('stopped');
        }
    };

    const handleNewSession = () => {
        const nextCreatedAt = new Date();
        setSessionSeed(previous => ({
            createdAt: nextCreatedAt,
            revision: previous.revision + 1,
        }));
        setScheduledStartAt(new Date(nextCreatedAt.getTime() + 3000));
        setStatus('idle');
        setCommandStatus('idle');
        setCommandMessage('No command sent');
        setStopAt(null);
    };

    return (
        <section className="capture-session" aria-label="Capture Session workspace">
            <div className="capture-session-header">
                <div>
                    <h2>Capture Session</h2>
                    <p>PCからiPhone録画とApple Watch IMU記録を同じsessionで起動するための司令塔です。</p>
                </div>
                <div className={`capture-status capture-status-${status}`}>
                    {status === 'idle' && 'Ready'}
                    {status === 'recording' && 'Command sent'}
                    {status === 'stopped' && 'Stopped'}
                </div>
            </div>

            <div className="capture-session-grid">
                <div className="capture-panel capture-session-summary">
                    <h3>Session</h3>
                    <dl>
                        <div>
                            <dt>Session ID</dt>
                            <dd>{sessionId}</dd>
                        </div>
                        <div>
                            <dt>Scheduled start</dt>
                            <dd>{toLocalIso(scheduledStartAt)}</dd>
                        </div>
                        <div>
                            <dt>Sync gesture</dt>
                            <dd>wrist_shake_3_times</dd>
                        </div>
                    </dl>
                    <div className="capture-command-row">
                        <button
                            className="control-button capture-primary-button"
                            onClick={handleStart}
                            disabled={isSending}
                        >
                            Start command
                        </button>
                        <button
                            className="control-button"
                            onClick={handleStop}
                            disabled={status !== 'recording' || isSending}
                        >
                            Stop command
                        </button>
                        <button
                            className="control-button"
                            onClick={handleNewSession}
                            disabled={status === 'recording' || isSending}
                        >
                            New session
                        </button>
                    </div>
                </div>

                <div className="capture-panel">
                    <h3>Device Readiness</h3>
                    <label className="capture-host-field">
                        <span>iPhone IP</span>
                        <input
                            value={iphoneHost}
                            onChange={(event) => setIphoneHost(event.target.value)}
                            placeholder="192.168.1.10"
                            inputMode="decimal"
                        />
                    </label>
                    <label className="capture-host-field">
                        <span>Pairing token</span>
                        <input
                            type="password"
                            value={pairingToken}
                            onChange={(event) => setPairingToken(event.target.value)}
                            placeholder="Enter the token shown on iPhone"
                            autoComplete="off"
                        />
                    </label>
                    <div className="capture-device-list">
                        <div className="capture-device-row">
                            <span className="capture-device-dot capture-device-dot-ready" />
                            <div>
                                <strong>PC command server</strong>
                                <span>Local API forwards commands to TCP :8765</span>
                            </div>
                        </div>
                        <div className="capture-device-row">
                            <span className={`capture-device-dot capture-device-dot-${commandStatus}`} />
                            <div>
                                <strong>iPhone recorder</strong>
                                <span>{commandMessage}</span>
                            </div>
                        </div>
                        <div className="capture-device-row">
                            <span className="capture-device-dot capture-device-dot-waiting" />
                            <div>
                                <strong>Apple Watch IMU</strong>
                                <span>Starts through iPhone app</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="capture-session-grid">
                <div className="capture-panel">
                    <h3>Start command payload</h3>
                    <pre className="capture-payload">{JSON.stringify(startPayload, null, 2)}</pre>
                </div>

                <div className="capture-panel">
                    <h3>Stop command payload</h3>
                    <pre className="capture-payload">{JSON.stringify(stopPayload, null, 2)}</pre>
                </div>
            </div>

            <div className="capture-panel capture-sync-panel">
                <h3>Capture checklist</h3>
                <ol>
                    <li>iPhone recording appを前面で待機させる。</li>
                    <li>Apple Watch recorderを開いて待機させる。</li>
                    <li>PCからStart commandを送る。</li>
                    <li>開始直後に手首を3回振って同期ピークを作る。</li>
                    <li>収録後、動画とWatch CSVをPCへ読み込む。</li>
                </ol>
            </div>
        </section>
    );
}
