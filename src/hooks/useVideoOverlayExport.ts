import { useRef, useState, useCallback, useEffect } from 'react';

/** サポートされているMIMEタイプを取得 */
function getSupportedMimeType(): string | null {
    if (typeof MediaRecorder === 'undefined') return null;
    const types = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
    ];
    for (const t of types) {
        if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return null;
}

/** タイムスタンプ文字列を生成 */
function getTimestamp(): string {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}${mo}${d}_${h}${mi}${s}`;
}

/** Blobをダウンロード */
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

interface UseVideoOverlayExportReturn {
    /** オーバーレイ録画が利用可能か */
    isSupported: boolean;
    /** 録画中フラグ */
    isRecording: boolean;
    /**
     * 録画を開始。録画用Canvasから captureStream(30) でストリームを取得し、
     * MediaRecorder で録画する。Canvas への描画は呼び出し側が行う。
     */
    startRecording: (recordingCanvas: HTMLCanvasElement) => void;
    /** 録画を終了してWebMをダウンロード */
    stopRecording: () => Promise<void>;
    /** 録画を破棄（キャンセル時） */
    discardRecording: () => void;
}

export function useVideoOverlayExport(): UseVideoOverlayExportReturn {
    const [isRecording, setIsRecording] = useState(false);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const mimeTypeRef = useRef<string | null>(null);
    const discardedRef = useRef(false);

    const isSupported = typeof MediaRecorder !== 'undefined' && getSupportedMimeType() !== null;

    function cleanup() {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        chunksRef.current = [];
        mediaRecorderRef.current = null;
        mimeTypeRef.current = null;
        discardedRef.current = false;
        setIsRecording(false);
    }

    const startRecording = useCallback((recordingCanvas: HTMLCanvasElement) => {
        const mimeType = getSupportedMimeType();
        if (!mimeType) return;

        // 再入防止
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.onstop = null;
            mediaRecorderRef.current.ondataavailable = null;
            mediaRecorderRef.current.stop();
            cleanup();
        }

        mimeTypeRef.current = mimeType;
        discardedRef.current = false;
        chunksRef.current = [];

        // リアルタイムストリーム取得（30fps）
        const stream = recordingCanvas.captureStream(30);
        streamRef.current = stream;

        const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 4000000,
        });

        recorder.ondataavailable = (event) => {
            if (event.data.size > 0 && !discardedRef.current) {
                chunksRef.current.push(event.data);
            }
        };

        mediaRecorderRef.current = recorder;
        recorder.start(1000);
        setIsRecording(true);
    }, []);

    const stopRecording = useCallback((): Promise<void> => {
        return new Promise((resolve) => {
            const recorder = mediaRecorderRef.current;
            if (!recorder || recorder.state === 'inactive' || discardedRef.current) {
                cleanup();
                resolve();
                return;
            }

            recorder.onstop = () => {
                if (chunksRef.current.length > 0 && !discardedRef.current) {
                    const blob = new Blob(chunksRef.current, {
                        type: mimeTypeRef.current ?? 'video/webm',
                    });
                    downloadBlob(blob, `overlay_video_${getTimestamp()}.webm`);
                }
                cleanup();
                resolve();
            };

            recorder.stop();
        });
    }, []);

    const discardRecording = useCallback(() => {
        discardedRef.current = true;
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== 'inactive') {
            recorder.onstop = () => cleanup();
            recorder.stop();
        } else {
            cleanup();
        }
    }, []);

    // unmount時のクリーンアップ
    useEffect(() => {
        return () => {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                mediaRecorderRef.current.onstop = null;
                mediaRecorderRef.current.ondataavailable = null;
                mediaRecorderRef.current.stop();
            }
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
            }
        };
    }, []);

    return {
        isSupported,
        isRecording,
        startRecording,
        stopRecording,
        discardRecording,
    };
}
