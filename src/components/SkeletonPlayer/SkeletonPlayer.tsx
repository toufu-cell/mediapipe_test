import { useRef, useCallback } from 'react';
import { useSkeletonPlayer, SPEED_OPTIONS } from '../../hooks/useSkeletonPlayer';
import type { PlaybackSpeed } from '../../hooks/useSkeletonPlayer';
import { SkeletonPlayerCanvas } from './SkeletonPlayerCanvas';

/** 時間をフォーマット (ms → "M:SS.s") */
function formatTime(ms: number): string {
    const totalSec = ms / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

export function SkeletonPlayer() {
    const player = useSkeletonPlayer();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            player.loadFile(file);
        }
    }, [player]);

    const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        player.seek(Number(e.target.value));
    }, [player]);

    const handleSpeedChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
        player.setSpeed(Number(e.target.value) as PlaybackSpeed);
    }, [player]);

    // Canvas解像度（読み込みデータのメタデータから取得、デフォルト640x480）
    const canvasWidth = player.loadedData?.metadata.sourceWidth ?? 640;
    const canvasHeight = player.loadedData?.metadata.sourceHeight ?? 480;

    return (
        <div className="skeleton-player">
            {/* ファイル選択 */}
            <div className="skeleton-player-file">
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                />
                <button
                    className="control-button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={player.isLoading}
                >
                    {player.isLoading ? '読み込み中...' : 'JSONファイルを選択'}
                </button>
                {player.loadedData && (
                    <span className="skeleton-player-info">
                        {player.totalFrames} フレーム / {formatTime(player.totalDurationMs)}
                        {' '}(データ FPS: {player.loadedData.metadata.estimatedFps.toFixed(1)})
                    </span>
                )}
            </div>

            {/* エラー表示 */}
            {player.error && (
                <div className="skeleton-player-error">
                    {player.error}
                </div>
            )}

            {/* Canvas */}
            {player.loadedData && (
                <>
                    <div className="skeleton-player-canvas-container">
                        <SkeletonPlayerCanvas
                            landmarks={player.currentLandmarks}
                            width={canvasWidth}
                            height={canvasHeight}
                            isMirrored={player.isMirrored}
                        />
                    </div>

                    {/* コントロール */}
                    <div className="skeleton-player-controls">
                        {/* 再生ボタン群 */}
                        <div className="skeleton-player-buttons">
                            <button
                                className="player-button"
                                onClick={player.stepBackward}
                                title="前フレーム"
                            >
                                &#9664;
                            </button>
                            <button
                                className="player-button player-button-main"
                                onClick={player.togglePlayPause}
                                title={player.isPlaying ? '一時停止' : '再生'}
                            >
                                {player.isPlaying ? '\u275A\u275A' : '\u25B6'}
                            </button>
                            <button
                                className="player-button"
                                onClick={player.stepForward}
                                title="次フレーム"
                            >
                                &#9654;
                            </button>

                            {/* 速度選択 */}
                            <select
                                className="speed-select"
                                value={player.speed}
                                onChange={handleSpeedChange}
                            >
                                {SPEED_OPTIONS.map(s => (
                                    <option key={s} value={s}>{s}x</option>
                                ))}
                            </select>

                            {/* ミラートグル */}
                            <button
                                className={`player-button mirror-button ${player.isMirrored ? 'active' : ''}`}
                                onClick={player.toggleMirror}
                                title="ミラー反転"
                            >
                                &#8596;
                            </button>
                        </div>

                        {/* シークバー */}
                        <div className="skeleton-player-seek">
                            <input
                                type="range"
                                min={0}
                                max={player.totalFrames - 1}
                                value={player.currentFrame}
                                onChange={handleSeek}
                                className="seek-slider"
                            />
                        </div>

                        {/* フレーム情報 */}
                        <div className="skeleton-player-status">
                            <span>
                                Frame: {player.currentFrame + 1} / {player.totalFrames}
                            </span>
                            <span>
                                {formatTime(player.currentTimeMs)} / {formatTime(player.totalDurationMs)}
                            </span>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
