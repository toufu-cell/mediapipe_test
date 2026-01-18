import { useEffect, useRef, useState, useCallback } from 'react';
import type { CameraError } from '../../types/pose';

interface UseCameraStreamReturn {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    stream: MediaStream | null;
    error: CameraError | null;
    isLoading: boolean;
    startCamera: () => Promise<void>;
    stopCamera: () => void;
}

const DEFAULT_CONSTRAINTS: MediaStreamConstraints = {
    video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
    },
    audio: false,
};

export function useCameraStream(): UseCameraStreamReturn {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [error, setError] = useState<CameraError | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const stopCamera = useCallback(() => {
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
            setStream(null);
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
    }, [stream]);

    const startCamera = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia(
                DEFAULT_CONSTRAINTS
            );

            setStream(mediaStream);

            if (videoRef.current) {
                videoRef.current.srcObject = mediaStream;
                await videoRef.current.play();
            }
        } catch (err) {
            const error = err as Error;
            let cameraError: CameraError;

            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                cameraError = {
                    type: 'permission',
                    message: 'カメラへのアクセスが拒否されました。ブラウザの設定でカメラへのアクセスを許可してください。',
                };
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                cameraError = {
                    type: 'notfound',
                    message: 'カメラが見つかりません。カメラが接続されているか確認してください。',
                };
            } else {
                cameraError = {
                    type: 'unknown',
                    message: `カメラの初期化に失敗しました: ${error.message}`,
                };
            }

            setError(cameraError);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        return () => {
            if (stream) {
                stream.getTracks().forEach((track) => track.stop());
            }
        };
    }, [stream]);

    return {
        videoRef,
        stream,
        error,
        isLoading,
        startCamera,
        stopCamera,
    };
}
