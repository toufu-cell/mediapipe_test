import { RECORDING_LIMITS } from '../../types/pose';

interface RecordButtonProps {
    isRecording: boolean;
    duration: number;
    estimatedSize: number;
    isSupported: boolean;
    unsupportedReason: string;
    isWarning: boolean;
    onStart: () => void;
    onStop: () => void;
}

/**
 * 秒数をMM:SS形式に変換
 */
function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * バイト数をMB形式に変換
 */
function formatSize(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

export function RecordButton({
    isRecording,
    duration,
    estimatedSize,
    isSupported,
    unsupportedReason,
    isWarning,
    onStart,
    onStop,
}: RecordButtonProps) {
    const maxDurationSec = RECORDING_LIMITS.maxDurationMs / 1000;
    const maxSizeMB = RECORDING_LIMITS.maxFileSizeBytes / (1024 * 1024);

    if (!isSupported) {
        return (
            <div className="record-control">
                <button
                    className="control-button record-button"
                    disabled
                    title={unsupportedReason}
                >
                    <span className="button-icon">⏺</span>
                    <span className="button-text">録画</span>
                </button>
                <p className="unsupported-warning">{unsupportedReason}</p>
            </div>
        );
    }

    return (
        <div className="record-control">
            <button
                className={`control-button record-button ${isRecording ? 'recording' : ''}`}
                onClick={isRecording ? onStop : onStart}
            >
                <span className="button-icon">{isRecording ? '⏹' : '⏺'}</span>
                <span className="button-text">{isRecording ? '停止' : '録画'}</span>
            </button>

            {isRecording && (
                <div className={`recording-info ${isWarning ? 'warning' : ''}`}>
                    <p>
                        録画時間: {formatTime(duration)} / {formatTime(maxDurationSec)}
                    </p>
                    <p>
                        推定サイズ: {formatSize(estimatedSize)}MB / {maxSizeMB}MB
                    </p>
                </div>
            )}
        </div>
    );
}
