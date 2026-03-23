import { useCallback } from 'react';
import type {
    MotionDataPoint,
    JointName,
    AngleName,
    InputSource,
} from '../types/motion';
import { ALL_JOINT_NAMES, ALL_ANGLE_NAMES, MAX_BUFFER_FRAMES } from '../types/motion';
import type { SkeletonFrame, SkeletonSource } from '../types/skeletonData';
import type { SkeletonData } from '../types/skeletonData';

/** Blobをダウンロード（useRecorder.tsのdownloadBlobパターンを踏襲） */
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

/** タイムスタンプ文字列を生成 */
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

/** 軸名 */
const AXES = ['x', 'y', 'z'] as const;

interface ExportSkeletonOptions {
    frames: SkeletonFrame[];
    source: SkeletonSource;
    sourceWidth: number;
    sourceHeight: number;
    mirrored: boolean;
}

interface UseMotionExportReturn {
    exportCSV: (data: MotionDataPoint[]) => void;
    exportJSON: (data: MotionDataPoint[], source: InputSource) => void;
    exportSkeletonJSON: (options: ExportSkeletonOptions) => void;
}

export function useMotionExport(): UseMotionExportReturn {
    const exportCSV = useCallback((data: MotionDataPoint[]) => {
        if (data.length === 0) return;

        // ヘッダー構築（46列）
        const headers: string[] = ['timestamp_ms', 'frame_index'];

        // 座標列（6ジョイント × 3軸 = 18列）
        for (const joint of ALL_JOINT_NAMES) {
            for (const axis of AXES) {
                headers.push(`${joint}_${axis}`);
            }
        }

        // 角度列（4列）
        for (const angle of ALL_ANGLE_NAMES) {
            headers.push(angle);
        }

        // 加速度列（6ジョイント × 3軸 = 18列）
        for (const joint of ALL_JOINT_NAMES) {
            for (const axis of AXES) {
                headers.push(`${joint}_accel_${axis}`);
            }
        }

        // 角速度列（4列）
        for (const angle of ALL_ANGLE_NAMES) {
            headers.push(`${angle}_angVel`);
        }

        // データ行
        const rows = data.map(point => {
            const values: string[] = [
                String(point.timestamp),
                String(point.frameIndex),
            ];

            // 座標
            for (const joint of ALL_JOINT_NAMES) {
                const pos = point.positions[joint];
                for (const axis of AXES) {
                    values.push(pos ? String(pos[axis]) : '');
                }
            }

            // 角度
            for (const angle of ALL_ANGLE_NAMES) {
                const val = point.angles[angle];
                values.push(val !== null ? String(val) : '');
            }

            // 加速度
            for (const joint of ALL_JOINT_NAMES) {
                const accel = point.accelerations[joint];
                for (const axis of AXES) {
                    values.push(accel ? String(accel[axis]) : '');
                }
            }

            // 角速度
            for (const angle of ALL_ANGLE_NAMES) {
                const val = point.angularVelocities[angle];
                values.push(val !== null ? String(val) : '');
            }

            return values.join(',');
        });

        const csvContent = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        downloadBlob(blob, `motion_data_${getTimestamp()}.csv`);
    }, []);

    const exportJSON = useCallback((data: MotionDataPoint[], source: InputSource) => {
        if (data.length === 0) return;

        // MAX_BUFFER_FRAMES上限を適用
        const exportData = data.length > MAX_BUFFER_FRAMES
            ? data.slice(data.length - MAX_BUFFER_FRAMES)
            : data;

        const durationMs = exportData.length > 1
            ? exportData[exportData.length - 1].timestamp - exportData[0].timestamp
            : 0;

        const jsonData = {
            metadata: {
                exportedAt: new Date().toISOString(),
                frameCount: exportData.length,
                durationMs,
                source,
                joints: ALL_JOINT_NAMES as unknown as JointName[],
                angles: ALL_ANGLE_NAMES as unknown as AngleName[],
            },
            frames: exportData,
        };

        const blob = new Blob(
            [JSON.stringify(jsonData, null, 2)],
            { type: 'application/json;charset=utf-8;' },
        );
        downloadBlob(blob, `motion_data_${getTimestamp()}.json`);
    }, []);

    const exportSkeletonJSON = useCallback((options: ExportSkeletonOptions) => {
        const { frames, source, sourceWidth, sourceHeight, mirrored } = options;
        if (frames.length === 0) return;

        // MAX_BUFFER_FRAMES上限を適用
        const exportFrames = frames.length > MAX_BUFFER_FRAMES
            ? frames.slice(frames.length - MAX_BUFFER_FRAMES)
            : frames;

        const durationMs = exportFrames.length > 1
            ? exportFrames[exportFrames.length - 1].timestampMs - exportFrames[0].timestampMs
            : 0;

        // 有効フレーム数から推定fps算出（durationMs / 有効フレーム数）
        const validFrameCount = exportFrames.filter(f => f.landmarks !== null).length;
        const estimatedFps = durationMs > 0
            ? Math.round((validFrameCount / durationMs) * 1000 * 10) / 10
            : 0;

        const data: SkeletonData = {
            metadata: {
                schemaVersion: 1,
                exportedAt: new Date().toISOString(),
                frameCount: exportFrames.length,
                durationMs,
                estimatedFps,
                source,
                landmarkModel: 'mediapipe-pose-33',
                coordinateSpace: 'normalized',
                sourceWidth,
                sourceHeight,
                mirrored,
            },
            frames: exportFrames,
        };

        const blob = new Blob(
            [JSON.stringify(data)],
            { type: 'application/json;charset=utf-8;' },
        );
        downloadBlob(blob, `skeleton_data_${getTimestamp()}.json`);
    }, []);

    return { exportCSV, exportJSON, exportSkeletonJSON };
}
