import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { HAND_CONNECTIONS } from '../../utils/handConnections';
import {
    HAND_COORDINATES_PER_SIDE,
    HAND_LANDMARK_COUNT,
    HAND_POINT_STRIDE,
    MIN_HAND_SCORE,
    MIN_PALM_WIDTH_PX,
    OVERLAY_FULL_PALM_WIDTH_PX,
    buildComparisonPlotData,
    buildHandSpeedLevels,
    buildWatchRotationSeries,
    createComparisonSessionData,
    findHandFrame,
    parseHandMotionFile,
    parseSyncedImuFile,
    resolveOverlayDetailLevel,
    sampleWatchRotationAtTime,
    sessionTimeAtPhase,
    type ComparisonHandFrame,
    type ComparisonInterval,
    type ComparisonSessionData,
    type HandSpeedLevel,
    type OverlayDetailLevel,
    type WatchRotationSeries,
    type WatchRotationSample,
} from './comparisonData';
import './MotionComparison.css';
import { NextPlanForm, type PlanEvidence } from './NextPlanForm';

type RecordingId = 'A' | 'B';
type RecordingFileKind = 'video' | 'hand' | 'right';
type PresentationMode = 'video' | 'handWatch';

interface RecordingSlot {
    videoFile: File | null;
    videoUrl: string | null;
    videoDurationSec: number | null;
    videoWidth: number | null;
    videoHeight: number | null;
    handCsvFile: File | null;
    rightCsvFile: File | null;
    data: ComparisonSessionData | null;
    startText: string;
    endText: string;
    loading: boolean;
    error: string | null;
}

interface ReadyRecording {
    data: ComparisonSessionData;
    interval: ComparisonInterval;
}

interface RecordingVisualization {
    speedLevels: Map<number, HandSpeedLevel>;
    watchRotations: WatchRotationSeries;
}

const RECORDING_COLORS: Record<RecordingId, string> = {
    A: '#2DD4BF',
    B: '#F59E0B',
};

const INTERVAL_ROUNDING_TOLERANCE_SEC = 0.001;
const CAPTURE_SESSION_ID_PATTERN = /^(capture_\d{8}_\d{6}_\d{3}_\d{2,3})(?=_|\.|$)/;
const INTERVAL_END_EPSILON_SEC = 0.01;
const PALM_LANDMARK_INDICES = [0, 5, 9, 13, 17] as const;
const PALM_CONNECTIONS = [[0, 5], [5, 9], [9, 13], [13, 17], [17, 0]] as const;
const SPEED_BAR_COLOR = '#FFD60A';
const WATCH_RING_COLOR = '#FF2D95';
const OVERLAY_INK_COLOR = '#080F16';
const PALM_COLOR = '#F0F0F0';
const WATCH_ROTATION_RADIUS_PALM_WIDTHS = 0.48;
const WATCH_ROTATION_ARC_START_RAD = -Math.PI / 2;
const WATCH_RING_FOREARM_OFFSET_PALM_WIDTHS = 0.25;
const WATCH_RING_FOREARM_DIRECTION_MIN_PALM_WIDTHS = 0.08;

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
}

function emptyRecording(): RecordingSlot {
    return {
        videoFile: null,
        videoUrl: null,
        videoDurationSec: null,
        videoWidth: null,
        videoHeight: null,
        handCsvFile: null,
        rightCsvFile: null,
        data: null,
        startText: '',
        endText: '',
        loading: false,
        error: null,
    };
}

function formatSeconds(value: number): string {
    return value.toFixed(3).replace(/\.?0+$/, '');
}

function sessionIdFromFileName(fileName: string): string | null {
    return fileName.match(CAPTURE_SESSION_ID_PATTERN)?.[1] ?? null;
}

function defaultInterval(
    data: ComparisonSessionData,
    videoDurationSec: number,
): ComparisonInterval | null {
    const startSec = Math.max(0, data.timelineStartSec);
    const endSec = Math.min(videoDurationSec, data.timelineEndSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
        return null;
    }
    return { startSec, endSec };
}

function readyRecording(slot: RecordingSlot): { value: ReadyRecording | null; error: string | null } {
    if (!slot.data || slot.videoDurationSec === null) {
        return { value: null, error: null };
    }
    const startSec = Number(slot.startText);
    const endSec = Number(slot.endText);
    const minimum = Math.max(0, slot.data.timelineStartSec);
    const maximum = Math.min(slot.videoDurationSec, slot.data.timelineEndSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        return { value: null, error: '開始と終了を秒単位の数値で入力してください' };
    }
    if (
        startSec < minimum - INTERVAL_ROUNDING_TOLERANCE_SEC ||
        endSec > maximum + INTERVAL_ROUNDING_TOLERANCE_SEC ||
        endSec <= startSec
    ) {
        return {
            value: null,
            error: `区間は ${formatSeconds(minimum)}〜${formatSeconds(maximum)} 秒の範囲で指定してください`,
        };
    }
    return {
        value: {
            data: slot.data,
            interval: {
                startSec: Math.max(minimum, startSec),
                endSec: Math.min(maximum, endSec),
            },
        },
        error: null,
    };
}

function drawWatchRotationArc(
    context: CanvasRenderingContext2D,
    preferredCenterX: number,
    preferredCenterY: number,
    desiredRadius: number,
    rotation: WatchRotationSample,
    reducedMotion: boolean,
    bounds: { left: number; top: number; right: number; bottom: number },
): void {
    context.save();
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const availableMarkerExtent = Math.max(
        1,
        Math.min(bounds.right - bounds.left, bounds.bottom - bounds.top) / 2 - 1,
    );
    const maximumRadius = Math.max(1, availableMarkerExtent - 15);
    const radius = Math.min(desiredRadius, maximumRadius);
    const ringLineWidth = clamp(radius * 0.11, 2, 6);
    const inkLineWidth = ringLineWidth + 4;
    const arrowSize = ringLineWidth * 1.6;
    const markerExtent = radius + Math.max(inkLineWidth / 2, arrowSize * Math.SQRT2) + 1;
    const centerX = bounds.right - bounds.left <= markerExtent * 2
        ? (bounds.left + bounds.right) / 2
        : clamp(preferredCenterX, bounds.left + markerExtent, bounds.right - markerExtent);
    const centerY = bounds.bottom - bounds.top <= markerExtent * 2
        ? (bounds.top + bounds.bottom) / 2
        : clamp(preferredCenterY, bounds.top + markerExtent, bounds.bottom - markerExtent);

    context.strokeStyle = OVERLAY_INK_COLOR;
    context.lineWidth = inkLineWidth;
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.stroke();

    context.strokeStyle = WATCH_RING_COLOR;
    context.lineWidth = ringLineWidth;
    // 固定長の弧と矢印。位相は動画時刻から得て、一時停止中も同じ形に保つ。
    const direction = rotation.side === 'left' ? -1 : 1;
    const head = WATCH_ROTATION_ARC_START_RAD + (reducedMotion ? 0 : rotation.phase);
    const tail = head - direction * Math.PI * 1.5;
    context.beginPath();
    context.arc(centerX, centerY, radius, tail, head, direction < 0);
    context.stroke();
    const headX = centerX + Math.cos(head) * radius;
    const headY = centerY + Math.sin(head) * radius;
    const tangentX = -Math.sin(head) * direction;
    const tangentY = Math.cos(head) * direction;
    context.fillStyle = WATCH_RING_COLOR;
    context.beginPath();
    context.moveTo(headX + tangentX * arrowSize, headY + tangentY * arrowSize);
    context.lineTo(headX - tangentX * arrowSize + Math.cos(head) * arrowSize, headY - tangentY * arrowSize + Math.sin(head) * arrowSize);
    context.lineTo(headX - tangentX * arrowSize - Math.cos(head) * arrowSize, headY - tangentY * arrowSize - Math.sin(head) * arrowSize);
    context.closePath();
    context.fill();
    context.restore();
}

function drawMotionOverlay(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    frame: ComparisonHandFrame | null,
    color: string,
    speedLevel: HandSpeedLevel | null,
    rotation: WatchRotationSample | null,
    reducedMotion: boolean,
    previousDetailLevel: OverlayDetailLevel | null,
): OverlayDetailLevel | null {
    const width = video.clientWidth;
    const height = video.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) {
        return null;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (
        !frame ||
        width === 0 ||
        height === 0 ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
    ) {
        canvas.dataset.overlayDetail = 'none';
        return null;
    }

    const containScale = Math.min(width / video.videoWidth, height / video.videoHeight);
    const contentWidth = video.videoWidth * containScale;
    const contentHeight = video.videoHeight * containScale;
    const contentLeft = (width - contentWidth) / 2;
    const contentTop = (height - contentHeight) / 2;
    const pointX = (offset: number) => contentLeft + frame.points[offset] * contentWidth;
    const pointY = (offset: number) => contentTop + frame.points[offset + 1] * contentHeight;
    const validPoint = (offset: number) => (
        Number.isFinite(frame.points[offset]) && Number.isFinite(frame.points[offset + 1])
    );

    const rightOffset = HAND_COORDINATES_PER_SIDE;
    const palmPoints = PALM_LANDMARK_INDICES.map(pointIndex => {
        const offset = rightOffset + pointIndex * HAND_POINT_STRIDE;
        return validPoint(offset) ? { x: pointX(offset), y: pointY(offset) } : null;
    });
    const palmGeometry = palmPoints.every(point => point !== null)
        ? {
            centerX: palmPoints.reduce((sum, point) => sum + (point?.x ?? 0), 0) / palmPoints.length,
            centerY: palmPoints.reduce((sum, point) => sum + (point?.y ?? 0), 0) / palmPoints.length,
            width: Math.hypot(
                (palmPoints[1]?.x ?? 0) - (palmPoints[4]?.x ?? 0),
                (palmPoints[1]?.y ?? 0) - (palmPoints[4]?.y ?? 0),
            ),
        }
        : null;
    const usablePalmGeometry = palmGeometry &&
        frame.scores[1] >= MIN_HAND_SCORE &&
        palmGeometry.width / containScale >= MIN_PALM_WIDTH_PX
        ? palmGeometry
        : null;
    const detailLevel = usablePalmGeometry
        ? resolveOverlayDetailLevel(usablePalmGeometry.width, previousDetailLevel)
        : null;
    canvas.dataset.overlayDetail = detailLevel ?? 'none';
    const visualPalmWidth = usablePalmGeometry?.width ?? OVERLAY_FULL_PALM_WIDTH_PX;
    const skeletonLineWidth = clamp(visualPalmWidth * 0.035, 1, 2);
    const skeletonPointRadius = clamp(visualPalmWidth * 0.05, 1.5, 3);

    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = skeletonLineWidth;
    context.lineCap = 'round';
    for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const sideOffset = sideIndex * HAND_COORDINATES_PER_SIDE;
        context.globalAlpha = sideIndex === 0 ? 0.72 : 0.92;
        context.setLineDash(sideIndex === 0 ? [] : [5, 3]);
        for (const [startLandmark, endLandmark] of HAND_CONNECTIONS) {
            const startOffset = sideOffset + startLandmark * HAND_POINT_STRIDE;
            const endOffset = sideOffset + endLandmark * HAND_POINT_STRIDE;
            if (!validPoint(startOffset) || !validPoint(endOffset)) {
                continue;
            }
            context.beginPath();
            context.moveTo(pointX(startOffset), pointY(startOffset));
            context.lineTo(pointX(endOffset), pointY(endOffset));
            context.stroke();
        }
        context.setLineDash([]);
        for (let pointIndex = 0; pointIndex < HAND_LANDMARK_COUNT; pointIndex += 1) {
            const offset = sideOffset + pointIndex * HAND_POINT_STRIDE;
            if (!validPoint(offset)) {
                continue;
            }
            context.beginPath();
            context.arc(pointX(offset), pointY(offset), skeletonPointRadius, 0, Math.PI * 2);
            context.fill();
        }
    }

    if (usablePalmGeometry && detailLevel) {
        context.globalAlpha = 1;
        const palmEmphasisScale = detailLevel === 'full'
            ? 1
            : detailLevel === 'compact'
                ? 0.78
                : 0.55;
        const drawPalm = (strokeStyle: string, lineWidth: number, pointRadius: number) => {
            context.strokeStyle = strokeStyle;
            context.fillStyle = strokeStyle;
            context.lineWidth = lineWidth;
            context.setLineDash([]);
            for (const [start, end] of PALM_CONNECTIONS) {
                const startPoint = palmPoints[PALM_LANDMARK_INDICES.indexOf(start)];
                const endPoint = palmPoints[PALM_LANDMARK_INDICES.indexOf(end)];
                if (!startPoint || !endPoint) {
                    continue;
                }
                context.beginPath();
                context.moveTo(startPoint.x, startPoint.y);
                context.lineTo(endPoint.x, endPoint.y);
                context.stroke();
            }
            for (const point of palmPoints) {
                if (!point) {
                    continue;
                }
                context.beginPath();
                context.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
                context.fill();
            }
        };
        drawPalm(
            OVERLAY_INK_COLOR,
            clamp(usablePalmGeometry.width * 0.11 * palmEmphasisScale, 1.5, 7),
            clamp(usablePalmGeometry.width * 0.095 * palmEmphasisScale, 1.75, 6),
        );
        drawPalm(
            PALM_COLOR,
            clamp(usablePalmGeometry.width * 0.065 * palmEmphasisScale, 1, 4),
            clamp(usablePalmGeometry.width * 0.06 * palmEmphasisScale, 1.25, 4),
        );

        if (detailLevel !== 'tiny' && speedLevel !== null) {
            const indexBase = palmPoints[1];
            const pinkyBase = palmPoints[4];
            if (indexBase && pinkyBase) {
                const acrossX = (pinkyBase.x - indexBase.x) / usablePalmGeometry.width;
                const acrossY = (pinkyBase.y - indexBase.y) / usablePalmGeometry.width;
                const stackX = -acrossY;
                const stackY = acrossX;
                const offsets = speedLevel === 1
                    ? [0]
                    : speedLevel === 2
                        ? [-0.12, 0.12]
                        : [-0.18, 0, 0.18];
                const halfLength = usablePalmGeometry.width * 0.24;
                const lineWidth = clamp(usablePalmGeometry.width * 0.065, 2, 5);
                const outlineWidth = lineWidth + clamp(usablePalmGeometry.width * 0.035, 1.5, 3);
                for (const offset of offsets) {
                    const centerX = usablePalmGeometry.centerX + stackX * usablePalmGeometry.width * offset;
                    const centerY = usablePalmGeometry.centerY + stackY * usablePalmGeometry.width * offset;
                    const startX = centerX - acrossX * halfLength;
                    const startY = centerY - acrossY * halfLength;
                    const endX = centerX + acrossX * halfLength;
                    const endY = centerY + acrossY * halfLength;
                    context.strokeStyle = OVERLAY_INK_COLOR;
                    context.lineWidth = outlineWidth;
                    context.beginPath();
                    context.moveTo(startX, startY);
                    context.lineTo(endX, endY);
                    context.stroke();
                    context.strokeStyle = SPEED_BAR_COLOR;
                    context.lineWidth = lineWidth;
                    context.beginPath();
                    context.moveTo(startX, startY);
                    context.lineTo(endX, endY);
                    context.stroke();
                }
            }
        }
    }
    context.globalAlpha = 1;
    if (usablePalmGeometry && detailLevel) {
        const wristX = pointX(rightOffset);
        const wristY = pointY(rightOffset);
        const forearmX = wristX - usablePalmGeometry.centerX;
        const forearmY = wristY - usablePalmGeometry.centerY;
        const forearmLength = Math.hypot(forearmX, forearmY);
        const offset = usablePalmGeometry.width * WATCH_RING_FOREARM_OFFSET_PALM_WIDTHS;
        const hasStableForearmDirection = forearmLength >= Math.max(
            1,
            usablePalmGeometry.width * WATCH_RING_FOREARM_DIRECTION_MIN_PALM_WIDTHS,
        );
        const watchX = hasStableForearmDirection
            ? wristX + forearmX / forearmLength * offset
            : wristX;
        const watchY = hasStableForearmDirection
            ? wristY + forearmY / forearmLength * offset
            : wristY;
        const contentBounds = {
            left: contentLeft,
            top: contentTop,
            right: contentLeft + contentWidth,
            bottom: contentTop + contentHeight,
        };
        const minimumRadius = detailLevel === 'tiny' ? 6 : 1;
        const radius = Math.max(
            minimumRadius,
            usablePalmGeometry.width * WATCH_ROTATION_RADIUS_PALM_WIDTHS,
        );
        if (rotation?.state === 'active') {
            drawWatchRotationArc(
                context,
                watchX,
                watchY,
                radius,
                rotation,
                reducedMotion,
                contentBounds,
            );
        }
    }
    context.globalAlpha = 1;
    return detailLevel;
}

function ComparisonChart({
    recordingA,
    recordingB,
}: {
    recordingA: ReadyRecording;
    recordingB: ReadyRecording;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const plotData = useMemo(() => buildComparisonPlotData(
        recordingA.data,
        recordingA.interval,
        recordingB.data,
        recordingB.interval,
    ), [recordingA, recordingB]);
    const summaries = useMemo(() => {
        const labels = ['A右', 'B右'];
        return plotData.slice(1).map((values, index) => {
            const validValues = values.filter((value): value is number => value !== null);
            return {
                label: labels[index],
                minimum: validValues.length > 0 ? Math.min(...validValues) : null,
                maximum: validValues.length > 0 ? Math.max(...validValues) : null,
                missingCount: values.length - validValues.length,
            };
        });
    }, [plotData]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        const options: uPlot.Options = {
            width: Math.max(320, container.clientWidth),
            height: 260,
            scales: {
                x: { time: false, range: [0, 1] },
                y: { auto: true },
            },
            series: [
                {},
                { label: '記録A・右手', stroke: '#2DD4BF', width: 2 },
                { label: '記録B・右手', stroke: '#F59E0B', width: 2 },
            ],
            axes: [
                {
                    stroke: '#A9B8C8',
                    grid: { stroke: '#263A50', width: 1 },
                    values: (_plot, values) => values.map(value => `${Math.round(value * 100)}%`),
                },
                {
                    stroke: '#A9B8C8',
                    grid: { stroke: '#263A50', width: 1 },
                    label: 'X角速度（rad/s）',
                    labelSize: 16,
                    values: (_plot, values) => values.map(value => `${value.toFixed(1)}`),
                },
            ],
            legend: { show: true },
            cursor: { show: false },
        };
        const chart = new uPlot(options, plotData as uPlot.AlignedData, container);
        const observer = new ResizeObserver(entries => {
            const width = Math.floor(entries[0]?.contentRect.width ?? container.clientWidth);
            if (width > 0) {
                chart.setSize({ width, height: 260 });
            }
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            chart.destroy();
        };
    }, [plotData]);

    return (
        <>
            <div
                className="comparison-chart"
                ref={containerRef}
                role="img"
                aria-label="Watchの回転比較グラフ。数値要約は直後にあります"
            />
            <details className="comparison-data-summary">
                <summary>グラフの数値要約</summary>
                <table>
                    <thead>
                        <tr>
                            <th scope="col">系列</th>
                            <th scope="col">最小</th>
                            <th scope="col">最大</th>
                            <th scope="col">欠損点</th>
                        </tr>
                    </thead>
                    <tbody>
                        {summaries.map(summary => (
                            <tr key={summary.label}>
                                <th scope="row">{summary.label}</th>
                                <td>{formatWatchRotation(summary.minimum)}</td>
                                <td>{formatWatchRotation(summary.maximum)}</td>
                                <td>{summary.missingCount} / {plotData[0].length}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
        </>
    );
}

function RecordingInputs({
    id,
    slot,
    intervalError,
    onFileChange,
    onLoad,
    onIntervalChange,
}: {
    id: RecordingId;
    slot: RecordingSlot;
    intervalError: string | null;
    onFileChange: (id: RecordingId, kind: RecordingFileKind, file: File | null) => void;
    onLoad: (id: RecordingId) => void;
    onIntervalChange: (id: RecordingId, kind: 'start' | 'end', value: string) => void;
}) {
    const prefix = `recording-${id.toLowerCase()}`;
    return (
        <fieldset className={`comparison-recording-input recording-${id.toLowerCase()}`}>
            <legend>記録{id}</legend>
            <label htmlFor={`${prefix}-video`}>
                記録{id}の動画
                <input
                    id={`${prefix}-video`}
                    type="file"
                    accept="video/*"
                    onChange={event => onFileChange(id, 'video', event.target.files?.[0] ?? null)}
                />
            </label>
            <label htmlFor={`${prefix}-hand`}>
                記録{id}のMediaPipe Hands CSV（左右21点）
                <input
                    id={`${prefix}-hand`}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={event => onFileChange(id, 'hand', event.target.files?.[0] ?? null)}
                />
            </label>
            <label htmlFor={`${prefix}-right`}>
                記録{id}の右Watch同期CSV
                <input
                    id={`${prefix}-right`}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={event => onFileChange(id, 'right', event.target.files?.[0] ?? null)}
                />
            </label>
            <button
                type="button"
                className="comparison-load-button"
                disabled={
                    slot.loading ||
                    slot.videoDurationSec === null ||
                    !slot.videoFile ||
                    !slot.handCsvFile ||
                    !slot.rightCsvFile
                }
                onClick={() => onLoad(id)}
            >
                {slot.loading ? 'Hand・同期データを確認中…' : `記録${id}を読み込む`}
            </button>
            {slot.data && (
                <div className="comparison-intervals">
                    <p className="comparison-session-id">session: {slot.data.sessionId}</p>
                    <label htmlFor={`${prefix}-start`}>
                        比較開始（秒）
                        <input
                            id={`${prefix}-start`}
                            type="number"
                            step="0.1"
                            value={slot.startText}
                            onChange={event => onIntervalChange(id, 'start', event.target.value)}
                        />
                    </label>
                    <label htmlFor={`${prefix}-end`}>
                        比較終了（秒）
                        <input
                            id={`${prefix}-end`}
                            type="number"
                            step="0.1"
                            value={slot.endText}
                            onChange={event => onIntervalChange(id, 'end', event.target.value)}
                        />
                    </label>
                </div>
            )}
            {slot.data && slot.videoDurationSec !== null && !intervalError && (
                <p className="comparison-status" role="status">記録{id}は比較準備完了です</p>
            )}
            {(slot.error || intervalError) && (
                <p className="comparison-error" role="alert">{slot.error ?? intervalError}</p>
            )}
        </fieldset>
    );
}

function formatSpeedLevel(value: HandSpeedLevel | null): string {
    if (value === null) {
        return '取得不可';
    }
    return value === 1 ? '低' : value === 2 ? '中' : '高';
}

function formatWatchRotation(value: number | null): string {
    return value === null ? '取得不可' : `${value.toFixed(2)} rad/s`;
}

function formatWatchRotationSide(side: WatchRotationSample['side']): string {
    if (side === 'left') return '左回転';
    if (side === 'right') return '右回転';
    return side === 'missing' ? '取得不可' : '強い回転なし';
}

function WatchRotationRing({ rotation, reducedMotion }: {
    rotation: WatchRotationSample;
    reducedMotion: boolean;
}) {
    const phase = reducedMotion ? 0 : rotation.phase;
    const direction = rotation.side === 'left' ? -1 : 1;
    return (
        <svg
            className="comparison-watch-rotation-ring"
            data-rotation-side={rotation.side}
            data-animation-phase={phase}
            viewBox="0 0 24 24"
            aria-hidden="true"
        >
            <circle className="comparison-watch-rotation-track" cx="12" cy="12" r="8.5" />
            <g transform={`rotate(${phase * 180 / Math.PI} 12 12)`}>
                <circle
                    className="comparison-watch-rotation-value"
                    cx="12" cy="12" r="8.5"
                    pathLength="1"
                    strokeDasharray="0.75 0.25"
                    transform={direction < 0 ? 'rotate(-90 12 12)' : 'matrix(0 -1 -1 0 24 24)'}
                />
                <path
                    className="comparison-watch-rotation-arrow"
                    d={direction < 0 ? 'M 9 3.5 L 14 0.7 L 14 6.3 Z' : 'M 15 3.5 L 10 0.7 L 10 6.3 Z'}
                />
            </g>
        </svg>
    );
}

export function MotionComparison({ onUnsavedChange }: { onUnsavedChange: (dirty: boolean) => void }) {
    const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    useEffect(() => {
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(preference.matches);
        preference.addEventListener('change', update);
        return () => preference.removeEventListener('change', update);
    }, []);
    const [recordings, setRecordings] = useState<Record<RecordingId, RecordingSlot>>({
        A: emptyRecording(),
        B: emptyRecording(),
    });
    const [phases, setPhases] = useState<Record<RecordingId, number>>({ A: 0, B: 0 });
    const [presentationMode, setPresentationMode] = useState<PresentationMode>('handWatch');
    const [playing, setPlaying] = useState<Record<RecordingId, boolean>>({ A: false, B: false });
    const [playErrors, setPlayErrors] = useState<Record<RecordingId, string | null>>({
        A: null,
        B: null,
    });
    const videoRefs = useRef<Record<RecordingId, HTMLVideoElement | null>>({ A: null, B: null });
    const canvasRefs = useRef<Record<RecordingId, HTMLCanvasElement | null>>({ A: null, B: null });
    const videoUrls = useRef<Record<RecordingId, string | null>>({ A: null, B: null });
    const loadControllers = useRef<Record<RecordingId, AbortController | null>>({ A: null, B: null });
    const loadGenerations = useRef<Record<RecordingId, number>>({ A: 0, B: 0 });
    const playRequestGenerations = useRef<Record<RecordingId, number>>({ A: 0, B: 0 });
    const phasesRef = useRef<Record<RecordingId, number>>({ A: 0, B: 0 });
    const playingRef = useRef<Record<RecordingId, boolean>>({ A: false, B: false });
    const overlayDetailLevelsRef = useRef<Record<RecordingId, OverlayDetailLevel | null>>({
        A: null,
        B: null,
    });

    const updateRecording = useCallback((
        id: RecordingId,
        updater: (current: RecordingSlot) => RecordingSlot,
    ) => {
        setRecordings(current => ({ ...current, [id]: updater(current[id]) }));
    }, []);

    const updatePlaying = useCallback((id: RecordingId, value: boolean) => {
        playingRef.current = { ...playingRef.current, [id]: value };
        setPlaying(current => current[id] === value ? current : { ...current, [id]: value });
    }, []);

    const updatePhase = useCallback((id: RecordingId, value: number) => {
        const nextValue = Math.min(1, Math.max(0, value));
        phasesRef.current = { ...phasesRef.current, [id]: nextValue };
        setPhases(current => current[id] === nextValue ? current : { ...current, [id]: nextValue });
    }, []);

    const handlePresentationModeChange = useCallback((mode: PresentationMode) => {
        overlayDetailLevelsRef.current = { A: null, B: null };
        setPresentationMode(mode);
    }, []);

    useEffect(() => () => {
        for (const id of ['A', 'B'] as const) {
            playRequestGenerations.current[id] += 1;
            videoRefs.current[id]?.pause();
            loadControllers.current[id]?.abort();
            const url = videoUrls.current[id];
            if (url) {
                URL.revokeObjectURL(url);
            }
        }
    }, []);

    const validationA = useMemo(() => readyRecording(recordings.A), [recordings.A]);
    const validationB = useMemo(() => readyRecording(recordings.B), [recordings.B]);
    const readyA = validationA.value;
    const readyB = validationB.value;
    const comparisonReady = readyA !== null && readyB !== null;
    const currentEvidence: PlanEvidence | null = readyA && readyB
        && recordings.A.startText.trim() && recordings.A.endText.trim()
        && recordings.B.startText.trim() && recordings.B.endText.trim()
        && recordings.A.videoFile && recordings.B.videoFile
        ? {
            self: { sessionId: readyA.data.sessionId, videoName: recordings.A.videoFile.name, ...readyA.interval },
            other: { sessionId: readyB.data.sessionId, videoName: recordings.B.videoFile.name, ...readyB.interval },
            presentationMode,
        } : null;
    const readyRef = useRef<Record<RecordingId, ReadyRecording | null>>({ A: null, B: null });
    readyRef.current = { A: readyA, B: readyB };

    const setPlayError = useCallback((id: RecordingId, message: string | null) => {
        setPlayErrors(current => current[id] === message ? current : { ...current, [id]: message });
    }, []);

    const pauseRecording = useCallback((id: RecordingId) => {
        playRequestGenerations.current[id] += 1;
        const video = videoRefs.current[id];
        video?.pause();
        updatePlaying(id, false);
        const ready = readyRef.current[id];
        if (!video || !ready) {
            return;
        }
        const duration = ready.interval.endSec - ready.interval.startSec;
        updatePhase(id, (video.currentTime - ready.interval.startSec) / duration);
    }, [updatePhase, updatePlaying]);

    const resetRecording = useCallback((id: RecordingId) => {
        overlayDetailLevelsRef.current[id] = null;
        pauseRecording(id);
        updatePhase(id, 0);
        setPlayError(id, null);
    }, [pauseRecording, setPlayError, updatePhase]);

    const handleFileChange = useCallback((
        id: RecordingId,
        kind: RecordingFileKind,
        file: File | null,
    ) => {
        resetRecording(id);
        loadControllers.current[id]?.abort();
        loadGenerations.current[id] += 1;

        if (kind === 'video') {
            const previousUrl = videoUrls.current[id];
            if (previousUrl) {
                URL.revokeObjectURL(previousUrl);
            }
            const nextUrl = file ? URL.createObjectURL(file) : null;
            videoUrls.current[id] = nextUrl;
            updateRecording(id, current => ({
                ...current,
                videoFile: file,
                videoUrl: nextUrl,
                videoDurationSec: null,
                videoWidth: null,
                videoHeight: null,
                data: null,
                startText: '',
                endText: '',
                loading: false,
                error: null,
            }));
            return;
        }

        updateRecording(id, current => {
            const fileKey = kind === 'hand' ? 'handCsvFile' : 'rightCsvFile';
            return {
                ...current,
                [fileKey]: file,
                data: null,
                startText: '',
                endText: '',
                loading: false,
                error: null,
            };
        });
    }, [resetRecording, updateRecording]);

    const handleLoad = useCallback(async (id: RecordingId) => {
        const slot = recordings[id];
        if (
            !slot.videoFile ||
            slot.videoDurationSec === null ||
            !slot.handCsvFile ||
            !slot.rightCsvFile
        ) {
            return;
        }
        resetRecording(id);
        loadControllers.current[id]?.abort();
        const controller = new AbortController();
        loadControllers.current[id] = controller;
        const generation = loadGenerations.current[id] + 1;
        loadGenerations.current[id] = generation;
        updateRecording(id, current => ({ ...current, loading: true, error: null, data: null }));

        try {
            const hands = await parseHandMotionFile(slot.handCsvFile, controller.signal);
            const right = await parseSyncedImuFile(
                slot.rightCsvFile,
                'right',
                controller.signal,
            );
            const data = createComparisonSessionData(hands, right);
            const videoSessionId = sessionIdFromFileName(slot.videoFile.name);
            if (!videoSessionId) {
                throw new Error(
                    '動画ファイル名からsessionを確認できません。capture_...で始まる元の名前を使ってください',
                );
            }
            const handSessionId = sessionIdFromFileName(slot.handCsvFile.name);
            if (!handSessionId) {
                throw new Error(
                    'Hand CSVファイル名からsessionを確認できません。capture_...で始まる元の名前を使ってください',
                );
            }
            if (videoSessionId !== handSessionId) {
                throw new Error('動画とHand CSVが別のsessionです');
            }
            if (videoSessionId !== data.sessionId) {
                throw new Error('動画・Hand CSVと同期CSVが別のsessionです');
            }
            if (controller.signal.aborted || loadGenerations.current[id] !== generation) {
                return;
            }
            updateRecording(id, current => {
                const interval = current.videoDurationSec === null
                    ? null
                    : defaultInterval(data, current.videoDurationSec);
                return {
                    ...current,
                    data,
                    loading: false,
                    startText: interval ? formatSeconds(interval.startSec) : '',
                    endText: interval ? formatSeconds(interval.endSec) : '',
                    error: current.videoDurationSec !== null && !interval
                        ? '動画・Hand・同期CSVに共通する比較区間がありません'
                        : null,
                };
            });
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return;
            }
            if (loadGenerations.current[id] === generation) {
                updateRecording(id, current => ({
                    ...current,
                    loading: false,
                    error: error instanceof Error ? error.message : 'Hand・同期CSVを読み込めませんでした',
                }));
            }
        }
    }, [recordings, resetRecording, updateRecording]);

    const invalidateVideo = useCallback((id: RecordingId, message: string) => {
        resetRecording(id);
        loadControllers.current[id]?.abort();
        loadGenerations.current[id] += 1;
        updateRecording(id, current => ({
            ...current,
            videoDurationSec: null,
            videoWidth: null,
            videoHeight: null,
            data: null,
            startText: '',
            endText: '',
            loading: false,
            error: message,
        }));
    }, [resetRecording, updateRecording]);

    const handleLoadedMetadata = useCallback((id: RecordingId) => {
        const video = videoRefs.current[id];
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
            invalidateVideo(id, '動画の長さを取得できません');
            return;
        }
        updateRecording(id, current => {
            const interval = current.data ? defaultInterval(current.data, video.duration) : null;
            return {
                ...current,
                videoDurationSec: video.duration,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                startText: interval ? formatSeconds(interval.startSec) : current.startText,
                endText: interval ? formatSeconds(interval.endSec) : current.endText,
                error: current.data && !interval
                    ? '動画・Hand・同期CSVに共通する比較区間がありません'
                    : current.error,
            };
        });
    }, [invalidateVideo, updateRecording]);

    const handleVideoError = useCallback((id: RecordingId) => {
        invalidateVideo(id, `記録${id}の動画を読み込めません。形式またはcodecを確認してください`);
    }, [invalidateVideo]);

    const handleIntervalChange = useCallback((
        id: RecordingId,
        kind: 'start' | 'end',
        value: string,
    ) => {
        resetRecording(id);
        updateRecording(id, current => ({
            ...current,
            [kind === 'start' ? 'startText' : 'endText']: value,
        }));
    }, [resetRecording, updateRecording]);

    const visualizationA = useMemo<RecordingVisualization | null>(() => {
        if (!readyA || !recordings.A.videoWidth || !recordings.A.videoHeight) {
            return null;
        }
        return {
            speedLevels: buildHandSpeedLevels(
                readyA.data.handFrames,
                readyA.interval,
                recordings.A.videoWidth,
                recordings.A.videoHeight,
            ),
            watchRotations: buildWatchRotationSeries(readyA.data.rightWatchRotationSignal),
        };
    }, [readyA, recordings.A.videoHeight, recordings.A.videoWidth]);

    const visualizationB = useMemo<RecordingVisualization | null>(() => {
        if (!readyB || !recordings.B.videoWidth || !recordings.B.videoHeight) {
            return null;
        }
        return {
            speedLevels: buildHandSpeedLevels(
                readyB.data.handFrames,
                readyB.interval,
                recordings.B.videoWidth,
                recordings.B.videoHeight,
            ),
            watchRotations: buildWatchRotationSeries(readyB.data.rightWatchRotationSignal),
        };
    }, [readyB, recordings.B.videoHeight, recordings.B.videoWidth]);

    const drawOverlays = useCallback(() => {
        for (const id of ['A', 'B'] as const) {
            const ready = id === 'A' ? readyA : readyB;
            const visualization = id === 'A' ? visualizationA : visualizationB;
            const video = videoRefs.current[id];
            const canvas = canvasRefs.current[id];
            if (!video || !canvas) {
                continue;
            }
            const targetMs = ready ? video.currentTime * 1000 : 0;
            const frame = ready && presentationMode === 'handWatch'
                ? findHandFrame(ready.data.handFrames, targetMs)
                : null;
            const speedLevel = frame && visualization
                ? visualization.speedLevels.get(frame.timestampMs) ?? null
                : null;
            const rotation = visualization
                ? sampleWatchRotationAtTime(visualization.watchRotations, targetMs)
                : null;
            overlayDetailLevelsRef.current[id] = drawMotionOverlay(
                canvas,
                video,
                frame,
                RECORDING_COLORS[id],
                speedLevel,
                rotation,
                reducedMotion,
                overlayDetailLevelsRef.current[id],
            );
        }
    }, [presentationMode, readyA, readyB, visualizationA, visualizationB, reducedMotion]);

    useEffect(() => {
        for (const id of ['A', 'B'] as const) {
            const ready = id === 'A' ? readyA : readyB;
            const video = videoRefs.current[id];
            if (ready && video && !playingRef.current[id]) {
                video.currentTime = sessionTimeAtPhase(ready.interval, phasesRef.current[id]);
            }
        }
        drawOverlays();
    }, [drawOverlays, readyA, readyB]);

    useEffect(() => {
        const observer = new ResizeObserver(drawOverlays);
        for (const id of ['A', 'B'] as const) {
            const video = videoRefs.current[id];
            if (video) {
                observer.observe(video);
            }
        }
        window.addEventListener('resize', drawOverlays);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', drawOverlays);
        };
    }, [drawOverlays, recordings.A.videoUrl, recordings.B.videoUrl]);

    const playRecording = useCallback(async (id: RecordingId): Promise<boolean> => {
        const ready = readyRef.current[id];
        const video = videoRefs.current[id];
        if (!ready || !video || playingRef.current[id]) {
            return playingRef.current[id];
        }

        const generation = playRequestGenerations.current[id] + 1;
        playRequestGenerations.current[id] = generation;
        setPlayError(id, null);
        if (
            phasesRef.current[id] >= 0.9995 ||
            video.currentTime >= ready.interval.endSec - INTERVAL_END_EPSILON_SEC
        ) {
            overlayDetailLevelsRef.current[id] = null;
            video.currentTime = ready.interval.startSec;
            updatePhase(id, 0);
        } else if (
            video.currentTime < ready.interval.startSec ||
            video.currentTime > ready.interval.endSec
        ) {
            overlayDetailLevelsRef.current[id] = null;
            video.currentTime = sessionTimeAtPhase(ready.interval, phasesRef.current[id]);
        }
        video.playbackRate = 1;
        updatePlaying(id, true);

        try {
            await video.play();
            return playRequestGenerations.current[id] === generation && playingRef.current[id];
        } catch (error) {
            if (playRequestGenerations.current[id] !== generation) {
                return false;
            }
            updatePlaying(id, false);
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
                setPlayError(id, `記録${id}を再生できませんでした。ファイルを確認してください`);
            }
            return false;
        }
    }, [setPlayError, updatePhase, updatePlaying]);

    const handlePhaseChange = useCallback((id: RecordingId, value: number) => {
        overlayDetailLevelsRef.current[id] = null;
        pauseRecording(id);
        setPlayError(id, null);
        updatePhase(id, value);
        const ready = readyRef.current[id];
        const video = videoRefs.current[id];
        if (ready && video) {
            video.currentTime = sessionTimeAtPhase(ready.interval, value);
        }
        drawOverlays();
    }, [drawOverlays, pauseRecording, setPlayError, updatePhase]);

    const finishRecording = useCallback((id: RecordingId) => {
        playRequestGenerations.current[id] += 1;
        const ready = readyRef.current[id];
        const video = videoRefs.current[id];
        if (ready && video) {
            video.pause();
            video.currentTime = ready.interval.endSec;
        }
        updatePhase(id, 1);
        updatePlaying(id, false);
    }, [updatePhase, updatePlaying]);

    const handleBothPlayback = useCallback(() => {
        if (playingRef.current.A || playingRef.current.B) {
            pauseRecording('A');
            pauseRecording('B');
            return;
        }
        void playRecording('A');
        void playRecording('B');
    }, [pauseRecording, playRecording]);

    useEffect(() => {
        if (!playing.A && !playing.B) {
            return;
        }
        let animationFrame = 0;
        let previousStateUpdate = 0;
        let cancelled = false;
        const tick = (now: number) => {
            const nextPhases = { ...phasesRef.current };
            let phaseChanged = false;
            let hasActiveRecording = false;
            for (const id of ['A', 'B'] as const) {
                if (!playingRef.current[id]) {
                    continue;
                }
                const ready = readyRef.current[id];
                const video = videoRefs.current[id];
                if (!ready || !video) {
                    updatePlaying(id, false);
                    continue;
                }
                if (video.currentTime >= ready.interval.endSec - INTERVAL_END_EPSILON_SEC) {
                    finishRecording(id);
                    nextPhases[id] = 1;
                    phaseChanged = true;
                    continue;
                }
                hasActiveRecording = true;
                const duration = ready.interval.endSec - ready.interval.startSec;
                const nextPhase = Math.min(
                    1,
                    Math.max(0, (video.currentTime - ready.interval.startSec) / duration),
                );
                if (nextPhase !== nextPhases[id]) {
                    nextPhases[id] = nextPhase;
                    phaseChanged = true;
                }
            }
            drawOverlays();
            if (phaseChanged && (now - previousStateUpdate >= 33 || !hasActiveRecording)) {
                phasesRef.current = nextPhases;
                setPhases(nextPhases);
                previousStateUpdate = now;
            }
            if (!cancelled && hasActiveRecording) {
                animationFrame = requestAnimationFrame(tick);
            }
        };
        animationFrame = requestAnimationFrame(tick);
        return () => {
            cancelled = true;
            cancelAnimationFrame(animationFrame);
        };
    }, [drawOverlays, finishRecording, playing.A, playing.B, updatePlaying]);

    const currentMotion = useMemo(() => {
        const forRecording = (
            id: RecordingId,
            ready: ReadyRecording | null,
            visualization: RecordingVisualization | null,
        ) => {
            if (!ready || !visualization) {
                return null;
            }
            const time = sessionTimeAtPhase(ready.interval, phases[id]) * 1000;
            const frame = findHandFrame(ready.data.handFrames, time);
            const rotation = sampleWatchRotationAtTime(visualization.watchRotations, time);
            return {
                speedLevel: frame
                    ? visualization.speedLevels.get(frame.timestampMs) ?? null
                    : null,
                rotation,
            };
        };
        return {
            A: forRecording('A', readyA, visualizationA),
            B: forRecording('B', readyB, visualizationB),
        };
    }, [
        phases.A,
        phases.B,
        readyA,
        readyB,
        recordings.A.videoHeight,
        recordings.A.videoWidth,
        recordings.B.videoHeight,
        recordings.B.videoWidth,
        visualizationA,
        visualizationB,
    ]);

    return (
        <section className="motion-comparison" aria-labelledby="motion-comparison-title">
            <header className="comparison-header">
                <div>
                    <h2 id="motion-comparison-title">動作比較スタジオ</h2>
                    <p>
                        自分と相手の同じ工程を見比べ、次の調理でどうするか記録します。
                    </p>
                </div>
                <div className="comparison-header-actions">
                    <div className="comparison-mode-switch" role="group" aria-label="表示内容">
                        <button
                            type="button"
                            aria-pressed={presentationMode === 'video'}
                            onClick={() => handlePresentationModeChange('video')}
                        >
                            映像のみ
                        </button>
                        <button
                            type="button"
                            aria-pressed={presentationMode === 'handWatch'}
                            onClick={() => handlePresentationModeChange('handWatch')}
                        >
                            Hand＋Watch
                        </button>
                    </div>
                </div>
            </header>

            {presentationMode === 'handWatch' && (
                <aside className="comparison-overlay-legend" aria-label="可視化の凡例">
                    <span className="comparison-legend-hand">両手21点</span>
                    <span className="comparison-legend-speed">
                        <i aria-hidden="true"><b /><b /><b /></i>
                        黄色1〜3本：右手の速さ
                    </span>
                    <span className="comparison-legend-watch">
                        <i aria-hidden="true" />
                        マゼンタ：強い回転の方向と速さ
                    </span>
                    <small>
                        表示は動きの手掛かりです。実際の回転角度、力、上手下手は示しません。
                    </small>
                    <details className="comparison-legend-details">
                        <summary>表示の読み方</summary>
                        <p>ジャイロX軸の直近0.1秒平均を使います。軸と検出条件はこの装着状態での試用です。</p>
                        <p>+Xは左回転、−Xは右回転として表示します。カメラの鏡像では反転しません。</p>
                        <p>強い回転だけリングが動き、静止・弱い回転では隠れます。弧の長さは一定です。</p>
                        <p>欠測や100ms超の古い値はデータ不足とします。手が映らなくても固定表示で確認できます。</p>
                    </details>
                </aside>
            )}

            <details className="comparison-preparation" open>
                <summary>動画・データと比較区間を設定する</summary>
                <p>記録Aに自分、記録Bに比較相手を読み込みます。設定後は閉じて映像を見比べられます。</p>
                <div className="comparison-input-grid">
                <RecordingInputs
                    id="A"
                    slot={recordings.A}
                    intervalError={validationA.error}
                    onFileChange={handleFileChange}
                    onLoad={handleLoad}
                    onIntervalChange={handleIntervalChange}
                />
                <RecordingInputs
                    id="B"
                    slot={recordings.B}
                    intervalError={validationB.error}
                    onFileChange={handleFileChange}
                    onLoad={handleLoad}
                    onIntervalChange={handleIntervalChange}
                />
                </div>
            </details>

            <section className="comparison-group-controls" aria-label="2本の一括操作">
                <div>
                    <p>
                        2本はそれぞれの時刻で操作できます。動作の自動位置合わせは行いません。
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleBothPlayback}
                    disabled={!comparisonReady && !playing.A && !playing.B}
                >
                    {playing.A || playing.B ? '2本を一時停止' : '2本を再生'}
                </button>
            </section>

            <div className="comparison-video-grid">
                {(['A', 'B'] as const).map(id => (
                    <article className={`comparison-video-panel recording-${id.toLowerCase()}`} key={id}>
                        <div className="comparison-panel-heading">
                            <h3>記録{id}</h3>
                            <span>{recordings[id].data?.sessionId ?? '未読込'}</span>
                        </div>
                        <div className="comparison-video-controls">
                            <div className="comparison-video-controls-toolbar">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (playing[id]) {
                                            pauseRecording(id);
                                        } else {
                                            void playRecording(id);
                                        }
                                    }}
                                    disabled={!readyRef.current[id] && !playing[id]}
                                >
                                    {playing[id] ? `記録${id}を一時停止` : `記録${id}を再生`}
                                </button>
                                <output
                                    aria-label={`記録${id}の進行率表示`}
                                    data-testid={`recording-${id.toLowerCase()}-phase`}
                                >
                                    {Math.round(phases[id] * 100)}%
                                </output>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="1000"
                                value={Math.round(phases[id] * 1000)}
                                aria-label={`記録${id}の再生位置`}
                                aria-valuetext={readyRef.current[id]
                                    ? `${Math.round(phases[id] * 100)}%、${sessionTimeAtPhase(
                                        readyRef.current[id].interval,
                                        phases[id],
                                    ).toFixed(2)}秒`
                                    : `${Math.round(phases[id] * 100)}%`}
                                disabled={!readyRef.current[id]}
                                onChange={event => handlePhaseChange(
                                    id,
                                    Number(event.target.value) / 1000,
                                )}
                            />
                            {readyRef.current[id] && (
                                <div className="comparison-recording-time">
                                    <span>
                                        {sessionTimeAtPhase(
                                            readyRef.current[id].interval,
                                            phases[id],
                                        ).toFixed(2)}秒
                                    </span>
                                    <span>
                                        区間 {readyRef.current[id].interval.startSec.toFixed(2)}–
                                        {readyRef.current[id].interval.endSec.toFixed(2)}秒
                                    </span>
                                </div>
                            )}
                            {presentationMode === 'handWatch' && currentMotion[id] && (
                                <div
                                    className="comparison-motion-readout"
                                    data-testid={`recording-${id.toLowerCase()}-motion-status`}
                                    data-watch-state={currentMotion[id]!.rotation.state}
                                >
                                    <span className="comparison-sr-only">
                                        {`記録${id}、手速度：${formatSpeedLevel(currentMotion[id]!.speedLevel)}、Watchの回転：${currentMotion[id]!.rotation.state === 'unavailable'
                                            ? 'データ不足'
                                            : formatWatchRotationSide(currentMotion[id]!.rotation.side)}`}
                                    </span>
                                    {currentMotion[id]!.rotation.state === 'active' && (
                                        <WatchRotationRing rotation={currentMotion[id]!.rotation} reducedMotion={reducedMotion} />
                                    )}
                                    <span className="comparison-motion-readout-label" aria-hidden="true">Watchの回転</span>
                                    <strong aria-hidden="true">
                                        {currentMotion[id]!.rotation.state === 'unavailable' ? 'データ不足' : formatWatchRotationSide(currentMotion[id]!.rotation.side)}
                                    </strong>
                                </div>
                            )}
                            {playErrors[id] && (
                                <p className="comparison-error" role="alert">{playErrors[id]}</p>
                            )}
                        </div>
                        <div className="comparison-video-stage">
                            {recordings[id].videoUrl ? (
                                <>
                                    <video
                                        ref={element => { videoRefs.current[id] = element; }}
                                        src={recordings[id].videoUrl}
                                        muted
                                        playsInline
                                        preload="metadata"
                                        onLoadedMetadata={() => handleLoadedMetadata(id)}
                                        onError={() => handleVideoError(id)}
                                        onSeeked={drawOverlays}
                                        onEnded={() => finishRecording(id)}
                                    />
                                    <canvas
                                        ref={element => { canvasRefs.current[id] = element; }}
                                        aria-hidden="true"
                                    />
                                </>
                            ) : (
                                <p>{id === 'A' ? '自分の調理' : '比較相手の調理'}をここに表示します。</p>
                            )}
                        </div>
                    </article>
                ))}
            </div>

            <NextPlanForm currentEvidence={currentEvidence} onUnsavedChange={onUnsavedChange} />

            {presentationMode === 'handWatch' && readyA && readyB &&
                currentMotion.A && currentMotion.B && (
                <details className="comparison-signals">
                    <summary>手首回転グラフ（詳細）</summary>
                    <div className="comparison-signals-content">
                        <div className="comparison-section-heading">
                            <div>
                                <h3 id="comparison-signals-title">Watchの回転</h3>
                                <p>
                                    各選択区間を0–100%へ正規化した概要です。
                                    現在の再生位置対応や良否は示しません。
                                </p>
                            </div>
                            <div className="comparison-current-values" aria-label="現在位置のWatchの回転">
                                <span>A右 {formatWatchRotation(currentMotion.A.rotation.rate)}</span>
                                <span>B右 {formatWatchRotation(currentMotion.B.rotation.rate)}</span>
                            </div>
                        </div>
                        <ComparisonChart recordingA={readyA} recordingB={readyB} />
                    </div>
                </details>
            )}
        </section>
    );
}
