import { useRef, useEffect, useMemo, useCallback } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { MotionDataPoint, MotionGraphSettings, JointName, AngleName } from '../../types/motion';
import {
    ALL_JOINT_NAMES,
    ALL_ANGLE_NAMES,
    JOINT_COLORS,
    ANGLE_COLORS,
} from '../../types/motion';

interface MotionGraphProps {
    data: MotionDataPoint[];
    settings: MotionGraphSettings;
    updateCount: number;
}

/** 関節名の日本語ラベル */
const JOINT_LABELS: Record<JointName, string> = {
    leftShoulder: '左肩',
    rightShoulder: '右肩',
    leftElbow: '左肘',
    rightElbow: '右肘',
    leftWrist: '左手首',
    rightWrist: '右手首',
};

/** 角度名の日本語ラベル */
const ANGLE_LABELS: Record<AngleName, string> = {
    leftElbowAngle: '左肘角度',
    rightElbowAngle: '右肘角度',
    leftShoulderAngle: '左肩角度',
    rightShoulderAngle: '右肩角度',
    leftWristAngle: '左手首角度',
    rightWristAngle: '右手首角度',
};

/** 加速度のノルムを計算 */
function accelNorm(accel: { x: number; y: number; z: number }): number {
    return Math.sqrt(accel.x * accel.x + accel.y * accel.y + accel.z * accel.z);
}

/** uPlot AlignedData変換 */
function toAngleData(data: MotionDataPoint[], settings: MotionGraphSettings): uPlot.AlignedData {
    const timestamps = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
        timestamps[i] = data[i].timestamp / 1000; // 秒単位に変換
    }

    const series: (Float64Array | (number | null)[])[] = [timestamps];

    for (const angleName of ALL_ANGLE_NAMES) {
        if (!settings.visibleAngles[angleName]) continue;
        const values: (number | null)[] = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
            values[i] = data[i].angles[angleName];
        }
        series.push(values);
    }

    return series as uPlot.AlignedData;
}

function toAccelData(data: MotionDataPoint[], settings: MotionGraphSettings): uPlot.AlignedData {
    const timestamps = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
        timestamps[i] = data[i].timestamp / 1000;
    }

    const series: (Float64Array | (number | null)[])[] = [timestamps];

    for (const joint of ALL_JOINT_NAMES) {
        if (!settings.visibleJoints[joint]) continue;
        const values: (number | null)[] = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
            const accel = data[i].accelerations[joint];
            values[i] = accel ? accelNorm(accel) : null;
        }
        series.push(values);
    }

    return series as uPlot.AlignedData;
}

function toAngVelData(data: MotionDataPoint[], settings: MotionGraphSettings): uPlot.AlignedData {
    const timestamps = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
        timestamps[i] = data[i].timestamp / 1000;
    }

    const series: (Float64Array | (number | null)[])[] = [timestamps];

    for (const angleName of ALL_ANGLE_NAMES) {
        if (!settings.visibleAngles[angleName]) continue;
        const values: (number | null)[] = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
            values[i] = data[i].angularVelocities[angleName];
        }
        series.push(values);
    }

    return series as uPlot.AlignedData;
}

function buildAngleSeries(settings: MotionGraphSettings): uPlot.Series[] {
    const series: uPlot.Series[] = [{}]; // timestamp series
    for (const angleName of ALL_ANGLE_NAMES) {
        if (!settings.visibleAngles[angleName]) continue;
        series.push({
            label: ANGLE_LABELS[angleName],
            stroke: ANGLE_COLORS[angleName],
            width: 2,
            spanGaps: false,
        });
    }
    return series;
}

function buildAccelSeries(settings: MotionGraphSettings): uPlot.Series[] {
    const series: uPlot.Series[] = [{}];
    for (const joint of ALL_JOINT_NAMES) {
        if (!settings.visibleJoints[joint]) continue;
        series.push({
            label: JOINT_LABELS[joint],
            stroke: JOINT_COLORS[joint],
            width: 2,
            spanGaps: false,
        });
    }
    return series;
}

function buildAngVelSeries(settings: MotionGraphSettings): uPlot.Series[] {
    const series: uPlot.Series[] = [{}];
    for (const angleName of ALL_ANGLE_NAMES) {
        if (!settings.visibleAngles[angleName]) continue;
        series.push({
            label: ANGLE_LABELS[angleName],
            stroke: ANGLE_COLORS[angleName],
            width: 2,
            spanGaps: false,
        });
    }
    return series;
}

/** 個別グラフコンポーネント */
function GraphPanel({
    title,
    data,
    seriesConfig,
    yLabel,
    yRange,
}: {
    title: string;
    data: uPlot.AlignedData;
    seriesConfig: uPlot.Series[];
    yLabel: string;
    yRange?: [number, number];
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<uPlot | null>(null);
    const seriesConfigRef = useRef(seriesConfig);

    // series config変更時はチャートを再作成
    const seriesKey = useMemo(
        () => JSON.stringify(seriesConfig.map(s => s.label)),
        [seriesConfig],
    );

    useEffect(() => {
        seriesConfigRef.current = seriesConfig;
    }, [seriesConfig]);

    // ダブルクリックでズームリセット
    const handleResetZoom = useCallback(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.setScale('x', { min: chart.data[0][0], max: chart.data[0][chart.data[0].length - 1] });
    }, []);

    // グラフをPNG画像として保存
    const handleSaveImage = useCallback(() => {
        const chart = chartRef.current;
        if (!chart) return;

        // uPlotのCanvasを取得（.u-over の兄弟要素の canvas）
        const wrap = chart.root.querySelector('.u-wrap') as HTMLElement | null;
        const uCanvas = wrap?.querySelector('canvas') as HTMLCanvasElement | null;
        if (!uCanvas) return;

        const padding = 32;
        const titleHeight = 28;
        const legendHeight = 24;
        const totalWidth = uCanvas.width + padding * 2;
        const totalHeight = uCanvas.height + padding * 2 + titleHeight + legendHeight;

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = totalWidth;
        exportCanvas.height = totalHeight;
        const ctx = exportCanvas.getContext('2d');
        if (!ctx) return;

        // 背景
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, totalWidth, totalHeight);

        // タイトル
        ctx.fillStyle = '#aaa';
        ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.fillText(title, padding, padding + 14);

        // uPlotのCanvas描画
        ctx.drawImage(uCanvas, padding, padding + titleHeight);

        // 凡例（シリーズ情報）
        const legendY = padding + titleHeight + uCanvas.height + 16;
        let legendX = padding;
        ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        for (let i = 1; i < seriesConfigRef.current.length; i++) {
            const s = seriesConfigRef.current[i];
            const label = typeof s.label === 'string' ? s.label : '';
            const color = (s.stroke as string) ?? '#888';
            // 色ドット
            ctx.fillStyle = color;
            ctx.fillRect(legendX, legendY - 6, 8, 8);
            // ラベル
            ctx.fillStyle = '#aaa';
            ctx.fillText(label, legendX + 12, legendY);
            legendX += ctx.measureText(label).width + 28;
        }

        exportCanvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const now = new Date();
            const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
            link.href = url;
            link.download = `graph_${title}_${ts}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 'image/png');
    }, [title]);

    useEffect(() => {
        if (!containerRef.current) return;

        // 既存のチャートを破棄
        chartRef.current?.destroy();

        const opts: uPlot.Options = {
            width: containerRef.current.clientWidth || 640,
            height: 180,
            series: seriesConfigRef.current,
            axes: [
                {
                    label: '時間 (s)',
                    stroke: '#aaa',
                    grid: { stroke: '#333', width: 1 },
                    ticks: { stroke: '#444', width: 1 },
                },
                {
                    label: yLabel,
                    stroke: '#aaa',
                    grid: { stroke: '#333', width: 1 },
                    ticks: { stroke: '#444', width: 1 },
                    ...(yRange ? { range: () => yRange } : {}),
                },
            ],
            scales: {
                x: { time: false },
            },
            cursor: {
                drag: { x: true, y: false, uni: 50 },
            },
            select: {
                show: true,
                left: 0,
                top: 0,
                width: 0,
                height: 0,
            },
            hooks: {
                setSelect: [
                    (u) => {
                        const left = u.select.left;
                        const width = u.select.width;
                        if (width < 2) return;

                        const xMin = u.posToVal(left, 'x');
                        const xMax = u.posToVal(left + width, 'x');
                        u.setScale('x', { min: xMin, max: xMax });

                        // 選択範囲をリセット
                        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
                    },
                ],
            },
            legend: {
                show: true,
            },
        };

        // 最低限のダミーデータで初期化
        const initData = data.length > 0 && (data[0] as number[]).length > 0
            ? data
            : [new Float64Array(0)] as uPlot.AlignedData;

        chartRef.current = new uPlot(opts, initData, containerRef.current);

        return () => {
            chartRef.current?.destroy();
            chartRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seriesKey, yLabel]);

    // データのみ更新
    useEffect(() => {
        if (chartRef.current && data.length > 0 && (data[0] as number[]).length > 0) {
            chartRef.current.setData(data);
        }
    }, [data]);

    // リサイズ対応
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const width = entry.contentRect.width;
                if (chartRef.current && width > 0) {
                    chartRef.current.setSize({ width, height: 180 });
                }
            }
        });

        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    return (
        <div className="graph-panel">
            <div className="graph-header">
                <h3 className="graph-title">{title}</h3>
                <div className="graph-actions">
                    <button
                        className="graph-action-button"
                        onClick={handleSaveImage}
                        title="グラフをPNG画像として保存"
                    >
                        保存
                    </button>
                    <button
                        className="graph-action-button"
                        onClick={handleResetZoom}
                        title="ズームリセット (ダブルクリックでも可)"
                    >
                        全体表示
                    </button>
                </div>
            </div>
            <div
                ref={containerRef}
                className="graph-container"
                onDoubleClick={handleResetZoom}
            />
        </div>
    );
}

export function MotionGraph({ data, settings, updateCount }: MotionGraphProps) {
    const { visibleMetrics } = settings;

    // データ変換（各グラフ用）— updateCountを依存に含めてref更新を反映
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const angleData = useMemo(() => toAngleData(data, settings), [data, settings, updateCount]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const accelData = useMemo(() => toAccelData(data, settings), [data, settings, updateCount]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const angVelData = useMemo(() => toAngVelData(data, settings), [data, settings, updateCount]);

    const angleSeries = useMemo(() => buildAngleSeries(settings), [settings]);
    const accelSeries = useMemo(() => buildAccelSeries(settings), [settings]);
    const angVelSeries = useMemo(() => buildAngVelSeries(settings), [settings]);

    if (!visibleMetrics.angles && !visibleMetrics.accelerations && !visibleMetrics.angularVelocities) {
        return null;
    }

    return (
        <div className="motion-graphs">
            {visibleMetrics.angles && (
                <GraphPanel
                    title="関節角度"
                    data={angleData}
                    seriesConfig={angleSeries}
                    yLabel="角度 (度)"
                    yRange={[0, 180]}
                />
            )}
            {visibleMetrics.accelerations && (
                <GraphPanel
                    title="擬似加速度"
                    data={accelData}
                    seriesConfig={accelSeries}
                    yLabel="加速度 (norm/s²)"
                />
            )}
            {visibleMetrics.angularVelocities && (
                <GraphPanel
                    title="擬似角速度"
                    data={angVelData}
                    seriesConfig={angVelSeries}
                    yLabel="角速度 (度/s)"
                />
            )}
        </div>
    );
}
