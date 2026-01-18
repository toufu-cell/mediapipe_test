import { useCallback } from 'react';

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
 * データURLをダウンロード
 */
function downloadDataUrl(dataUrl: string, filename: string): void {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

interface UseScreenshotReturn {
    takeScreenshot: (captureFrame: () => string | null) => void;
}

export function useScreenshot(): UseScreenshotReturn {
    const takeScreenshot = useCallback((captureFrame: () => string | null) => {
        const dataUrl = captureFrame();
        if (dataUrl) {
            const filename = `pose_screenshot_${getTimestamp()}.png`;
            downloadDataUrl(dataUrl, filename);
        }
    }, []);

    return { takeScreenshot };
}
