import { useMemo, useState } from 'react';

type CaptureStatus = 'idle' | 'recording' | 'rollback' | 'stopped' | 'unknown';
type CommandStatus = 'idle' | 'sending' | 'sent' | 'error';
type WristSide = 'left' | 'right';
type CaptureMode = 'research-right' | 'dual-watch';

interface StartCommandPayload {
    type: 'start';
    sessionId: string;
    startAt: string;
    expectedDurationSec: number;
    syncGesture: 'wrist_shake_3_times';
    video: {
        device: 'iphone';
        filename: string;
        enabled: boolean;
    };
    watch: {
        device: 'apple_watch';
        sampleRateHz: number;
        filename: string;
        wristSide: WristSide;
    };
}

interface StopCommandPayload {
    type: 'stop';
    sessionId: string;
    stopAt: string;
}

interface EndpointConfig {
    host: string;
    token: string;
}

interface EndpointState extends EndpointConfig {
    status: CommandStatus;
    message: string;
}

type CaptureCommandPayload = StartCommandPayload | StopCommandPayload;
type EndpointMap = Record<WristSide, EndpointState>;
interface ActiveTransaction {
    sessionId: string;
    startAt: string;
    endpoints: Record<WristSide, EndpointConfig>;
    mode: CaptureMode;
    sides: WristSide[];
    status: 'recording' | 'rollback';
}

const SIDES: WristSide[] = ['left', 'right'];
const START_DELAY_MS = 10_000;
const ACTIVE_TRANSACTION_KEY = 'capture.activeTransaction';
const IPHONE_COMMAND_REJECTED = 'iphone_command_rejected';

class CaptureCommandRequestError extends Error {
    constructor(message: string, readonly isDefinitiveRejection: boolean) {
        super(message);
        this.name = 'CaptureCommandRequestError';
    }
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

function buildStartPayload(
    sessionId: string,
    startAt: Date,
    side: WristSide,
    videoEnabled: boolean,
): StartCommandPayload {
    return {
        type: 'start',
        sessionId,
        startAt: toLocalIso(startAt),
        expectedDurationSec: 180,
        syncGesture: 'wrist_shake_3_times',
        video: {
            device: 'iphone',
            filename: videoEnabled ? `${sessionId}.mov` : `${sessionId}_relay.mov`,
            enabled: videoEnabled,
        },
        watch: {
            device: 'apple_watch',
            sampleRateHz: 50,
            filename: `${sessionId}_${side}_wrist_imu.csv`,
            wristSide: side,
        },
    };
}

function captureSides(mode: CaptureMode): WristSide[] {
    return mode === 'research-right' ? ['right'] : SIDES;
}

function normalizeCaptureSides(value: unknown, mode: CaptureMode): WristSide[] {
    if (mode === 'research-right') {
        return ['right'];
    }
    if (!Array.isArray(value)) {
        return captureSides(mode);
    }
    const sides = SIDES.filter(side => value.includes(side));
    return sides.length > 0 ? sides : captureSides(mode);
}

function targetLabelForSides(sides: WristSide[], capitalize = false): string {
    const label = sides.length > 1 ? 'both iPhones' : `${sides[0]} iPhone`;
    return capitalize ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function stopButtonLabel(
    status: CaptureStatus,
    mode: CaptureMode,
    sides: WristSide[]
): string {
    if (status === 'rollback') {
        return `Retry Stop ${targetLabelForSides(sides)}`;
    }
    if (mode === 'research-right') {
        return 'Stop research capture';
    }
    return sides.length > 1 ? 'Stop both' : `Stop ${targetLabelForSides(sides)}`;
}

function failureReason(reason: unknown): string {
    return reason instanceof Error ? reason.message : 'Command failed';
}

function buildStopPayload(sessionId: string, stopAt: Date): StopCommandPayload {
    return {
        type: 'stop',
        sessionId,
        stopAt: toLocalIso(stopAt),
    };
}

function getStoredValue(key: string, fallbackKey?: string): string {
    if (typeof window === 'undefined') {
        return '';
    }
    return window.localStorage.getItem(key)
        ?? (fallbackKey ? window.localStorage.getItem(fallbackKey) : null)
        ?? '';
}

function readActiveTransaction(): ActiveTransaction | null {
    if (typeof window === 'undefined') {
        return null;
    }
    try {
        const value = JSON.parse(window.localStorage.getItem(ACTIVE_TRANSACTION_KEY) ?? 'null');
        if (
            value
            && typeof value.sessionId === 'string'
            && typeof value.startAt === 'string'
            && ['recording', 'rollback'].includes(value.status)
            && SIDES.every(side => (
                typeof value.endpoints?.[side]?.host === 'string'
                && typeof value.endpoints?.[side]?.token === 'string'
            ))
        ) {
            const mode: CaptureMode = value.mode === 'research-right' ? 'research-right' : 'dual-watch';
            return {
                sessionId: value.sessionId,
                startAt: value.startAt,
                endpoints: {
                    left: { host: value.endpoints.left.host, token: value.endpoints.left.token },
                    right: { host: value.endpoints.right.host, token: value.endpoints.right.token },
                },
                mode,
                sides: normalizeCaptureSides(value.sides, mode),
                status: value.status,
            };
        }
    } catch {
        return null;
    }
    return null;
}

function storedTransactionSessionId(): string | null {
    try {
        const value = JSON.parse(window.localStorage.getItem(ACTIVE_TRANSACTION_KEY) ?? 'null');
        return typeof value?.sessionId === 'string' ? value.sessionId : null;
    } catch {
        return null;
    }
}

function makeInitialEndpoints(
    activeEndpoints?: Record<WristSide, EndpointConfig>
): EndpointMap {
    return {
        left: {
            host: activeEndpoints?.left.host ?? getStoredValue('capture.left.iphoneHost', 'capture.iphoneHost'),
            token: activeEndpoints?.left.token ?? getStoredValue('capture.left.pairingToken', 'capture.pairingToken'),
            status: 'idle',
            message: activeEndpoints ? 'Restored active endpoint' : 'No command sent',
        },
        right: {
            host: activeEndpoints?.right.host ?? getStoredValue('capture.right.iphoneHost'),
            token: activeEndpoints?.right.token ?? getStoredValue('capture.right.pairingToken'),
            status: 'idle',
            message: activeEndpoints ? 'Restored active endpoint' : 'No command sent',
        },
    };
}

export function CaptureSession() {
    const [restoredTransaction] = useState(readActiveTransaction);
    const [hasUnreadableTransaction, setHasUnreadableTransaction] = useState(() => (
        !restoredTransaction
        && typeof window !== 'undefined'
        && window.localStorage.getItem(ACTIVE_TRANSACTION_KEY) !== null
    ));
    const [activeTransaction, setActiveTransaction] = useState<ActiveTransaction | null>(restoredTransaction);
    const [sessionId, setSessionId] = useState(
        () => restoredTransaction?.sessionId ?? buildSessionId(new Date(), 0)
    );
    const [scheduledStartAt, setScheduledStartAt] = useState(
        () => restoredTransaction ? new Date(restoredTransaction.startAt) : new Date(Date.now() + START_DELAY_MS)
    );
    const [status, setStatus] = useState<CaptureStatus>(
        restoredTransaction?.status ?? (hasUnreadableTransaction ? 'unknown' : 'idle')
    );
    const [mode, setMode] = useState<CaptureMode>(restoredTransaction?.mode ?? 'research-right');
    const [commandStatus, setCommandStatus] = useState<CommandStatus>(
        restoredTransaction || hasUnreadableTransaction ? 'error' : 'idle'
    );
    const [commandMessage, setCommandMessage] = useState(() => {
        if (hasUnreadableTransaction) {
            return 'Saved capture state is unreadable. Confirm all recording devices are stopped, then clear local session state.';
        }
        if (!restoredTransaction) {
            return 'No command sent';
        }
        const restoredStopLabel = stopButtonLabel(
            restoredTransaction.status,
            restoredTransaction.mode,
            restoredTransaction.sides
        );
        return `Restored active session; use ${restoredStopLabel} before starting another session`;
    });
    const [endpoints, setEndpoints] = useState<EndpointMap>(
        () => makeInitialEndpoints(restoredTransaction?.endpoints)
    );
    const startPayloads = useMemo(
        () => ({
            left: buildStartPayload(sessionId, scheduledStartAt, 'left', true),
            right: buildStartPayload(sessionId, scheduledStartAt, 'right', mode === 'research-right'),
        }),
        [mode, sessionId, scheduledStartAt]
    );
    const selectedSides = activeTransaction?.sides ?? captureSides(mode);
    const startTargetLabel = mode === 'research-right' ? 'right iPhone' : 'both iPhones';
    const stopLabel = stopButtonLabel(status, activeTransaction?.mode ?? mode, selectedSides);
    const isSending = commandStatus === 'sending';
    const canClearLocalSession = hasUnreadableTransaction
        || (activeTransaction !== null && status === 'rollback');

    const updateEndpoint = (side: WristSide, change: Partial<EndpointState>) => {
        setEndpoints(previous => ({
            ...previous,
            [side]: { ...previous[side], ...change },
        }));
    };

    const storeActiveTransaction = (
        transaction: ActiveTransaction | null,
        expectedSessionId?: string
    ): boolean => {
        if (
            expectedSessionId !== undefined
            && storedTransactionSessionId() !== expectedSessionId
        ) {
            return false;
        }
        setActiveTransaction(transaction);
        if (transaction) {
            window.localStorage.setItem(ACTIVE_TRANSACTION_KEY, JSON.stringify(transaction));
        } else {
            window.localStorage.removeItem(ACTIVE_TRANSACTION_KEY);
        }
        return true;
    };

    const storeCurrentTransaction = (
        transaction: ActiveTransaction | null,
        expectedSessionId: string
    ): boolean => {
        if (storeActiveTransaction(transaction, expectedSessionId)) {
            return true;
        }
        setStatus('unknown');
        setCommandStatus('error');
        setCommandMessage('Session state changed in another view. Reopen Capture Session before continuing.');
        return false;
    };

    const snapshotEndpoints = (): Record<WristSide, EndpointConfig> => ({
        left: { host: endpoints.left.host.trim(), token: endpoints.left.token.trim() },
        right: { host: endpoints.right.host.trim(), token: endpoints.right.token.trim() },
    });

    const postCommand = async (
        side: WristSide,
        command: CaptureCommandPayload,
        endpoint: EndpointConfig
    ) => {
        const host = endpoint.host.trim();
        const token = endpoint.token.trim();
        if (!host) {
            throw new Error(`${side === 'left' ? 'Left' : 'Right'} iPhone IP is required`);
        }
        if (token.length < 8) {
            throw new Error(`${side === 'left' ? 'Left' : 'Right'} pairing code must contain at least 8 characters`);
        }

        window.localStorage.setItem(`capture.${side}.iphoneHost`, host);
        window.localStorage.setItem(`capture.${side}.pairingToken`, token);
        updateEndpoint(side, { status: 'sending', message: `Sending ${command.type}` });

        try {
            const response = await fetch('/api/capture-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port: 8765, token, command }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.ok) {
                throw new CaptureCommandRequestError(
                    result.error || `Command failed with HTTP ${response.status}`,
                    result.errorCode === IPHONE_COMMAND_REJECTED
                );
            }
            updateEndpoint(side, { status: 'sent', message: 'Command accepted' });
        } catch (error) {
            updateEndpoint(side, {
                status: 'error',
                message: error instanceof Error ? error.message : 'Command failed',
            });
            throw error;
        }
    };

    const handleStart = async () => {
        const leftHost = endpoints.left.host.trim();
        const rightHost = endpoints.right.host.trim();
        const sides = captureSides(mode);
        for (const side of sides) {
            const label = side === 'left' ? 'Left' : 'Right';
            const endpoint = endpoints[side];
            const message = !endpoint.host.trim()
                ? `${label} iPhone IP is required`
                : endpoint.token.trim().length < 8
                    ? `${label} pairing code must contain at least 8 characters`
                    : null;
            if (message) {
                setCommandStatus('error');
                setCommandMessage(message);
                updateEndpoint(side, { status: 'error', message });
                return;
            }
        }
        if (mode === 'dual-watch' && leftHost && leftHost === rightHost) {
            const message = 'Left and Right iPhone IPs must be different';
            setCommandStatus('error');
            setCommandMessage(message);
            updateEndpoint('left', { status: 'error', message });
            updateEndpoint('right', { status: 'error', message });
            return;
        }

        const nextStartAt = new Date(Date.now() + START_DELAY_MS);
        const commands = {
            left: buildStartPayload(sessionId, nextStartAt, 'left', true),
            right: buildStartPayload(sessionId, nextStartAt, 'right', mode === 'research-right'),
        };
        const endpointSnapshot = snapshotEndpoints();
        const pendingTransaction: ActiveTransaction = {
            sessionId,
            startAt: toLocalIso(nextStartAt),
            endpoints: endpointSnapshot,
            mode,
            sides,
            status: 'rollback',
        };
        setScheduledStartAt(nextStartAt);
        setCommandStatus('sending');
        setCommandMessage(`Sending Start to ${startTargetLabel}`);
        storeActiveTransaction(pendingTransaction);
        setStatus('rollback');

        const results = await Promise.allSettled(
            sides.map(side => postCommand(side, commands[side], endpointSnapshot[side]))
        );
        if (results.every(result => result.status === 'fulfilled')) {
            if (!storeCurrentTransaction({ ...pendingTransaction, status: 'recording' }, sessionId)) {
                return;
            }
            setCommandStatus('sent');
            setCommandMessage(`${mode === 'research-right' ? 'Right iPhone' : 'Both iPhones'} accepted the scheduled Start`);
            setStatus('recording');
            return;
        }

        const cancelCommand = buildStopPayload(sessionId, new Date());
        const rollbackResults = await Promise.allSettled(
            sides.map(side => postCommand(side, cancelCommand, endpointSnapshot[side]))
        );
        const failedRollbackSides = sides.filter(
            (_, index) => {
                if (rollbackResults[index].status !== 'rejected') {
                    return false;
                }
                const startResult = results[index];
                return !(
                    startResult.status === 'rejected'
                    && startResult.reason instanceof CaptureCommandRequestError
                    && startResult.reason.isDefinitiveRejection
                );
            }
        );
        setCommandStatus('error');
        if (failedRollbackSides.length === 0) {
            if (!storeCurrentTransaction(null, sessionId)) {
                return;
            }
            setCommandMessage('Start failed; no active session remains. Create a new session');
            setStatus('stopped');
        } else {
            if (!storeCurrentTransaction({
                ...pendingTransaction,
                sides: failedRollbackSides,
                status: 'rollback',
            }, sessionId)) {
                return;
            }
            setCommandMessage(`Start failed; retry Stop for ${failedRollbackSides.join(' and ')} iPhone`);
            setStatus('rollback');
        }
    };

    const handleStop = async () => {
        const stopSessionId = activeTransaction?.sessionId ?? sessionId;
        const endpointSnapshot = activeTransaction?.endpoints ?? snapshotEndpoints();
        const sides = activeTransaction?.sides ?? captureSides(mode);
        const nextStopAt = new Date();
        const command = buildStopPayload(stopSessionId, nextStopAt);
        setCommandStatus('sending');
        setCommandMessage(`Sending Stop to ${targetLabelForSides(sides)}`);

        const results = await Promise.allSettled(
            sides.map(side => postCommand(side, command, endpointSnapshot[side]))
        );
        if (results.every(result => result.status === 'fulfilled')) {
            if (!storeCurrentTransaction(null, stopSessionId)) {
                return;
            }
            setStatus('stopped');
            setCommandStatus('sent');
            setCommandMessage(`${targetLabelForSides(sides, true)} accepted Stop`);
        } else {
            const failures = sides.flatMap((side, index) => {
                const result = results[index];
                return result.status === 'rejected' ? [{ side, reason: result.reason }] : [];
            });
            const failedSides = failures.map(failure => failure.side);
            const failureDetails = failures.map(failure => (
                `${targetLabelForSides([failure.side])}: ${failureReason(failure.reason)}`
            )).join('; ');
            const rollbackTransaction: ActiveTransaction = {
                sessionId: stopSessionId,
                startAt: activeTransaction?.startAt ?? toLocalIso(scheduledStartAt),
                endpoints: endpointSnapshot,
                mode: activeTransaction?.mode ?? mode,
                sides: failedSides,
                status: 'rollback',
            };
            if (!storeCurrentTransaction(rollbackTransaction, stopSessionId)) {
                return;
            }
            setStatus('rollback');
            setCommandStatus('error');
            setCommandMessage(`Stop failed for ${failureDetails}`);
        }
    };

    const handleClearLocalSession = () => {
        const confirmed = window.confirm(
            'This clears browser state only and sends no Stop command. Recording devices may still be active. Continue only after confirming all devices are stopped.'
        );
        if (!confirmed) {
            return;
        }
        if (
            activeTransaction
            && !storeCurrentTransaction(null, activeTransaction.sessionId)
        ) {
            return;
        }
        if (!activeTransaction) {
            storeActiveTransaction(null);
        }
        setHasUnreadableTransaction(false);
        setStatus('unknown');
        setCommandStatus('error');
        setCommandMessage(
            'Local session state cleared. Device recording state is unknown; confirm all recording devices are stopped before creating a new session.'
        );
    };

    const handleNewSession = () => {
        const nextCreatedAt = new Date();
        setSessionId(buildSessionId(nextCreatedAt, nextCreatedAt.getMilliseconds()));
        setScheduledStartAt(new Date(nextCreatedAt.getTime() + START_DELAY_MS));
        setStatus('idle');
        setCommandStatus('idle');
        setCommandMessage('No command sent');
        setEndpoints(previous => ({
            left: { ...previous.left, status: 'idle', message: 'No command sent' },
            right: { ...previous.right, status: 'idle', message: 'No command sent' },
        }));
    };

    return (
        <section className="capture-session" aria-label="Capture Session workspace">
            <div className="capture-session-header">
                <div>
                    <h2>Cooking Capture</h2>
                    <p>{mode === 'research-right'
                        ? '研究用として、1台のiPhoneで動画と右手首IMUを同じsessionに記録します。'
                        : '互換用として、左iPhoneの動画と左右Watchを同じsessionに記録します。'}</p>
                </div>
                <div className={`capture-status capture-status-${status}`}>
                    {status === 'idle' && 'Ready'}
                    {status === 'recording' && 'Scheduled'}
                    {status === 'rollback' && 'Stop required'}
                    {status === 'stopped' && 'Stopped'}
                    {status === 'unknown' && 'Device state unknown'}
                </div>
            </div>

            <div className="capture-session-grid">
                <div className="capture-panel capture-session-summary">
                    <h3>Session</h3>
                    <dl>
                        <div><dt>Session ID</dt><dd>{sessionId}</dd></div>
                        <div><dt>Scheduled start</dt><dd>{toLocalIso(scheduledStartAt)}</dd></div>
                        <div><dt>Sync gesture</dt><dd>wrist_shake_3_times</dd></div>
                    </dl>
                    <label className="capture-host-field capture-mode-field">
                        <span>Capture mode</span>
                        <select
                            aria-label="Capture mode"
                            value={mode}
                            onChange={event => setMode(event.target.value as CaptureMode)}
                            disabled={activeTransaction !== null || isSending}
                        >
                            <option value="research-right">Research · video + right wrist</option>
                            <option value="dual-watch">Legacy · video + both wrists</option>
                        </select>
                    </label>
                    <div className="capture-command-row">
                        <button className="control-button capture-primary-button" onClick={handleStart} disabled={status !== 'idle' || isSending}>
                            {mode === 'research-right' ? 'Start research capture' : 'Start both'}
                        </button>
                        <button className="control-button" onClick={handleStop} disabled={!['recording', 'rollback'].includes(status) || isSending}>
                            {stopLabel}
                        </button>
                        <button className="control-button" onClick={handleNewSession} disabled={hasUnreadableTransaction || ['recording', 'rollback'].includes(status) || isSending}>
                            New session
                        </button>
                    </div>
                    <p className={`capture-command-message capture-command-message-${commandStatus}`} role="status">
                        {commandMessage}
                    </p>
                    {canClearLocalSession && (
                        <div className="capture-stop-recovery">
                            <p>This clears browser state only. It does not stop recording devices.</p>
                            <button
                                className="control-button capture-local-reset-button"
                                onClick={handleClearLocalSession}
                                disabled={isSending}
                            >
                                Clear local session state
                            </button>
                        </div>
                    )}
                </div>

                <div className="capture-panel">
                    <h3>Endpoint readiness</h3>
                    <div className="capture-endpoint-list">
                        {selectedSides.map(side => {
                            const label = side === 'left' ? 'Left' : 'Right';
                            return (
                                <fieldset className={`capture-endpoint capture-endpoint-${side}`} key={side}>
                                    <legend>{label} iPhone · {mode === 'research-right' ? 'Camera + right Watch' : side === 'left' ? 'Camera + Watch' : 'Watch relay'}</legend>
                                    <label className="capture-host-field">
                                        <span>{label} iPhone IP</span>
                                        <input
                                            value={endpoints[side].host}
                                            onChange={event => updateEndpoint(side, { host: event.target.value })}
                                            placeholder={side === 'left' ? '192.168.1.10' : '192.168.1.11'}
                                            inputMode="decimal"
                                            disabled={activeTransaction !== null || isSending}
                                        />
                                    </label>
                                    <label className="capture-host-field">
                                        <span>{label} pairing code</span>
                                        <input
                                            type="password"
                                            value={endpoints[side].token}
                                            onChange={event => updateEndpoint(side, { token: event.target.value })}
                                            placeholder="8-character code shown on this iPhone"
                                            autoComplete="off"
                                            disabled={activeTransaction !== null || isSending}
                                        />
                                    </label>
                                    <div className="capture-device-row">
                                        <span className={`capture-device-dot capture-device-dot-${endpoints[side].status}`} />
                                        <div>
                                            <strong>{label} endpoint</strong>
                                            <span>{endpoints[side].message}</span>
                                        </div>
                                    </div>
                                </fieldset>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="capture-session-grid">
                {selectedSides.map(side => (
                    <div className="capture-panel" key={side}>
                        <h3>{side === 'left' ? 'Left' : 'Right'} Start command payload</h3>
                        <pre className="capture-payload">{JSON.stringify(startPayloads[side], null, 2)}</pre>
                    </div>
                ))}
            </div>

            <div className="capture-panel capture-sync-panel">
                <h3>Capture checklist</h3>
                {mode === 'research-right' ? (
                    <ol>
                        <li>Camera + Watch roleのiPhone Recorderと、右手首のWatch Recorderを前面にする。</li>
                        <li>Apple Watchが右手首に固定されていることを確認する。</li>
                        <li>Start research captureを押し、Command acceptedを確認する。</li>
                        <li>開始直後と終了直前に右手首を3回振る。</li>
                        <li>Stop research capture後に、音声なし動画とright IMUの2成果物を確認する。</li>
                    </ol>
                ) : (
                    <ol>
                        <li>左iPhoneと右iPhoneでRecorderを起動し、各Watch Recorderを前面にする。</li>
                        <li>物理ラベルと画面のLeft / Rightが一致していることを確認する。</li>
                        <li>Start bothを押し、両endpointがCommand acceptedになることを確認する。</li>
                        <li>開始直後と終了直前に両手首を3回振る。</li>
                        <li>Stop both後に動画、left IMU、right IMUの3成果物を確認する。</li>
                    </ol>
                )}
            </div>
        </section>
    );
}
