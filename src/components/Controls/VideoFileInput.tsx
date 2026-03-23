import { useRef } from 'react';

interface VideoFileInputProps {
    fileName: string | null;
    isAnalyzing: boolean;
    progress: number;
    duration: number;
    onSelectFile: (file: File) => void;
    onStartAnalysis: () => void;
    onCancelAnalysis: () => void;
    onClearFile: () => void;
}

export function VideoFileInput({
    fileName,
    isAnalyzing,
    progress,
    duration,
    onSelectFile,
    onStartAnalysis,
    onCancelAnalysis,
    onClearFile,
}: VideoFileInputProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            onSelectFile(file);
        }
    };

    const handleSelectClick = () => {
        fileInputRef.current?.click();
    };

    const progressPercent = Math.round(progress * 100);

    return (
        <div className="video-file-input">
            <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                onChange={handleFileChange}
                style={{ display: 'none' }}
            />

            <div className="video-file-actions">
                <button
                    className="control-button"
                    onClick={handleSelectClick}
                    disabled={isAnalyzing}
                >
                    <span className="button-icon">&#128193;</span>
                    動画ファイル選択
                </button>

                {fileName && (
                    <>
                        <span className="file-name">{fileName}</span>
                        <span className="file-duration">
                            ({duration > 0 ? `${duration.toFixed(1)}秒` : '読込中...'})
                        </span>

                        {!isAnalyzing ? (
                            <>
                                <button
                                    className="control-button"
                                    onClick={onStartAnalysis}
                                    disabled={duration <= 0}
                                >
                                    <span className="button-icon">&#9654;</span>
                                    解析開始
                                </button>
                                <button
                                    className="control-button clear-button"
                                    onClick={onClearFile}
                                >
                                    &times;
                                </button>
                            </>
                        ) : (
                            <button
                                className="control-button cancel-button"
                                onClick={onCancelAnalysis}
                            >
                                <span className="button-icon">&#9632;</span>
                                キャンセル
                            </button>
                        )}
                    </>
                )}
            </div>

            {isAnalyzing && (
                <div className="analysis-progress">
                    <div className="progress-bar">
                        <div
                            className="progress-fill"
                            style={{ width: `${progressPercent}%` }}
                        />
                    </div>
                    <span className="progress-text">{progressPercent}%</span>
                </div>
            )}
        </div>
    );
}
