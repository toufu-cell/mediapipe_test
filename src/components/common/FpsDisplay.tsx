interface FpsDisplayProps {
    /** 表示するFPS値。nullなら非表示 */
    fps: number | null;
    /** ラベル（デフォルト: "FPS"） */
    label?: string;
}

/**
 * FPS値を表示する小さなバッジコンポーネント。
 * DOM要素として描画するため、Canvas録画やスクリーンショットには焼き込まれない。
 */
export function FpsDisplay({ fps, label = 'FPS' }: FpsDisplayProps) {
    if (fps === null) {
        return null;
    }

    return (
        <span className="fps-display">
            {label}: {fps.toFixed(1)}
        </span>
    );
}
