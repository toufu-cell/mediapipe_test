import { useCallback, useEffect, useRef, useState } from 'react';
import { SPEED_OPTIONS, useSkeletonPlayer3D } from '../../hooks/useSkeletonPlayer3D';
import type { PlaybackSpeed } from '../../hooks/useSkeletonPlayer3D';
import { SkeletonPlayer3DCanvas } from './SkeletonPlayer3DCanvas';

const BODY_FILE_NAME = 'mediapipe_body_3d_xyz.csv';
const LEFT_HAND_FILE_NAME = 'mediapipe_left_hand_3d_xyz.csv';
const RIGHT_HAND_FILE_NAME = 'mediapipe_right_hand_3d_xyz.csv';
const PARAMS_FILE_NAME = 'recording_parameters.json';

function formatTime(ms: number): string {
    const totalSec = ms / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function getFilePath(file: File): string {
    const maybeRelativePath = 'webkitRelativePath' in file ? file.webkitRelativePath : '';
    return (maybeRelativePath || file.name).replace(/\\/g, '/').toLowerCase();
}

function findMatchingFile(files: File[], targetFileName: string): File | undefined {
    return files.find(file => getFilePath(file).endsWith(targetFileName.toLowerCase()));
}

function useDirectoryInputRef() {
    const inputRef = useRef<HTMLInputElement | null>(null);

    const setInputRef = useCallback((node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (!node) {
            return;
        }

        node.setAttribute('webkitdirectory', '');
        node.setAttribute('directory', '');
    }, []);

    return { inputRef, setInputRef };
}

export function SkeletonPlayer3D() {
    const player = useSkeletonPlayer3D();
    const [selectionError, setSelectionError] = useState<string | null>(null);
    const [showLeftHand, setShowLeftHand] = useState(true);
    const [showRightHand, setShowRightHand] = useState(true);
    const { inputRef: directoryInputRef, setInputRef: setDirectoryInputRef } = useDirectoryInputRef();
    const filesInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!player.loadedData) {
            return;
        }

        setShowLeftHand(player.loadedData.metadata.hasLeftHand);
        setShowRightHand(player.loadedData.metadata.hasRightHand);
    }, [player.loadedData]);

    const loadSelectedFiles = useCallback(async (files: File[]) => {
        const bodyFile = findMatchingFile(files, BODY_FILE_NAME);
        const leftHandFile = findMatchingFile(files, LEFT_HAND_FILE_NAME);
        const rightHandFile = findMatchingFile(files, RIGHT_HAND_FILE_NAME);
        const paramsFile = findMatchingFile(files, PARAMS_FILE_NAME);

        if (!bodyFile) {
            setSelectionError(`body CSV (${BODY_FILE_NAME}) が見つかりません。`);
            return;
        }

        setSelectionError(null);
        await player.loadFiles(bodyFile, leftHandFile, rightHandFile, paramsFile);
    }, [player]);

    const handleDirectoryChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files ? Array.from(event.target.files) : [];
        event.target.value = '';

        if (files.length === 0) {
            return;
        }

        await loadSelectedFiles(files);
    }, [loadSelectedFiles]);

    const handleFilesChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files ? Array.from(event.target.files) : [];
        event.target.value = '';

        if (files.length === 0) {
            return;
        }

        await loadSelectedFiles(files);
    }, [loadSelectedFiles]);

    const handleSeek = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        player.seek(Number(event.target.value));
    }, [player]);

    const handleSpeedChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        player.setSpeed(Number(event.target.value) as PlaybackSpeed);
    }, [player]);

    return (
        <div className="skeleton-player skeleton-player-3d">
            <div className="skeleton-player-file skeleton-player-3d-file">
                <input
                    ref={setDirectoryInputRef}
                    type="file"
                    onChange={handleDirectoryChange}
                    style={{ display: 'none' }}
                />
                <input
                    ref={filesInputRef}
                    type="file"
                    accept=".csv,.json"
                    multiple
                    onChange={handleFilesChange}
                    style={{ display: 'none' }}
                />

                <button
                    className="control-button"
                    onClick={() => directoryInputRef.current?.click()}
                    disabled={player.isLoading}
                >
                    {player.isLoading ? '読み込み中...' : 'フォルダを選択'}
                </button>

                <button
                    className="control-button"
                    onClick={() => filesInputRef.current?.click()}
                    disabled={player.isLoading}
                >
                    個別ファイルを選択
                </button>

                {player.loadedData && (
                    <span className="skeleton-player-info">
                        {player.totalFrames} フレーム / {formatTime(player.totalDurationMs)}
                        {' '}({player.loadedData.metadata.fps.toFixed(1)} fps)
                    </span>
                )}
            </div>

            {(selectionError || player.error) && (
                <div className="skeleton-player-error">
                    {selectionError ?? player.error}
                </div>
            )}

            {player.loadedData && (
                <>
                    <div className="skeleton-player-canvas-container skeleton-player-3d-canvas-container">
                        <SkeletonPlayer3DCanvas
                            bodyLandmarks={player.currentBodyLandmarks}
                            leftHandLandmarks={player.currentLeftHandLandmarks}
                            rightHandLandmarks={player.currentRightHandLandmarks}
                            boundingBox={player.loadedData.metadata.boundingBox}
                            showLeftHand={showLeftHand}
                            showRightHand={showRightHand}
                        />
                    </div>

                    <div className="skeleton-player-controls">
                        <div className="skeleton-player-buttons skeleton-player-3d-buttons">
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

                            <select
                                className="speed-select"
                                value={player.speed}
                                onChange={handleSpeedChange}
                            >
                                {SPEED_OPTIONS.map(speed => (
                                    <option key={speed} value={speed}>
                                        {speed}x
                                    </option>
                                ))}
                            </select>

                            <label className="player-checkbox">
                                <input
                                    type="checkbox"
                                    checked={showLeftHand}
                                    onChange={() => setShowLeftHand(prev => !prev)}
                                    disabled={!player.loadedData.metadata.hasLeftHand}
                                />
                                左手
                            </label>

                            <label className="player-checkbox">
                                <input
                                    type="checkbox"
                                    checked={showRightHand}
                                    onChange={() => setShowRightHand(prev => !prev)}
                                    disabled={!player.loadedData.metadata.hasRightHand}
                                />
                                右手
                            </label>
                        </div>

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

export default SkeletonPlayer3D;
