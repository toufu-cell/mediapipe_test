import { useState, useRef, useCallback, useEffect } from 'react';
import { RECORDING_LIMITS } from '../types/pose';

interface UseRecorderReturn {
    isRecording: boolean;
    duration: number;
    estimatedSize: number;
    isSupported: boolean;
    unsupportedReason: string;
    startRecording: (stream: MediaStream) => void;
    stopRecording: () => void;
    isWarning: boolean;
}

/**
 * サポートされているMIMEタイプを取得
 */
function getSupportedMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') {
        return null;
    }

    const mimeTypes = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
    ];

    for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
            return mimeType;
        }
    }
    return null;
}

/**
 * 録画機能がサポートされているかを判定
 */
function isRecordingSupported(): boolean {
    if (typeof MediaRecorder === 'undefined') {
        return false;
    }
    return getSupportedMimeType() !== null;
}

/**
 * 録画非対応の理由を取得
 */
function getRecordingUnsupportedReason(): string {
    if (typeof MediaRecorder === 'undefined') {
        return 'このブラウザはMediaRecorder APIをサポートしていません。';
    }
    if (getSupportedMimeType() === null) {
        return 'このブラウザはWebM録画をサポートしていないため、録画機能を利用できません。';
    }
    return '';
}

/**
 * 現在の日時をファイル名用フォーマットで取得
 */
function getTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Blobをダウンロード
 */
function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

export function useRecorder(): UseRecorderReturn {
    const [isRecording, setIsRecording] = useState(false);
    const [duration, setDuration] = useState(0);
    const [estimatedSize, setEstimatedSize] = useState(0);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const startTimeRef = useRef<number>(0);
    const intervalRef = useRef<number | undefined>(undefined);

    const isSupported = isRecordingSupported();
    const unsupportedReason = getRecordingUnsupportedReason();

    const isWarning =
        duration >= (RECORDING_LIMITS.maxDurationMs * RECORDING_LIMITS.warningThresholdPercent) / 100000 ||
        estimatedSize >= (RECORDING_LIMITS.maxFileSizeBytes * RECORDING_LIMITS.warningThresholdPercent) / 100;

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }

        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = undefined;
        }

        setIsRecording(false);
    }, []);

    const startRecording = useCallback((stream: MediaStream) => {
        if (!isSupported) {
            console.warn('Recording not supported:', unsupportedReason);
            return;
        }

        const mimeType = getSupportedMimeType();
        if (!mimeType) return;

        chunksRef.current = [];
        setDuration(0);
        setEstimatedSize(0);

        const mediaRecorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 2500000, // 2.5 Mbps
        });

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunksRef.current.push(event.data);

                // 累積サイズを計算
                const totalSize = chunksRef.current.reduce((acc, chunk) => acc + chunk.size, 0);
                setEstimatedSize(totalSize);

                // サイズ制限チェック
                if (totalSize >= RECORDING_LIMITS.maxFileSizeBytes) {
                    stopRecording();
                }
            }
        };

        mediaRecorder.onstop = () => {
            if (chunksRef.current.length > 0) {
                const blob = new Blob(chunksRef.current, { type: mimeType });
                const filename = `pose_recording_${getTimestamp()}.webm`;
                downloadBlob(blob, filename);
            }

            chunksRef.current = [];
            setDuration(0);
            setEstimatedSize(0);
        };

        mediaRecorderRef.current = mediaRecorder;
        startTimeRef.current = Date.now();

        // 1秒ごとにデータを取得
        mediaRecorder.start(1000);
        setIsRecording(true);

        // 経過時間を更新
        intervalRef.current = window.setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
            setDuration(elapsed);

            // 時間制限チェック
            if (elapsed >= RECORDING_LIMITS.maxDurationMs / 1000) {
                stopRecording();
            }
        }, 1000);
    }, [isSupported, unsupportedReason, stopRecording]);

    // クリーンアップ
    useEffect(() => {
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                mediaRecorderRef.current.stop();
            }
        };
    }, []);

    return {
        isRecording,
        duration,
        estimatedSize,
        isSupported,
        unsupportedReason,
        startRecording,
        stopRecording,
        isWarning,
    };
}
