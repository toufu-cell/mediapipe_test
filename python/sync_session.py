import argparse
import json
from dataclasses import asdict, dataclass
from itertools import combinations
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


@dataclass
class SyncEstimate:
    method: str
    watch_side: str
    video_signal: str
    imu_signal: str
    offset_ms: float
    video_peaks_ms: list[float]
    imu_peaks_ms: list[float]
    offset_std_ms: float
    interval_delta_ms: float
    confidence: float


def require_columns(frame: pd.DataFrame, required_columns: list[str], label: str) -> None:
    missing = [column for column in required_columns if column not in frame.columns]
    if missing:
        raise ValueError(f"{label} is missing required columns: {', '.join(missing)}")


def prepare_imu_frame(imu: pd.DataFrame) -> pd.DataFrame:
    require_columns(imu, ["elapsed_ms"], "imu")
    prepared = imu.copy()

    axis_columns = ["gyro_x", "gyro_y", "gyro_z"]
    has_gyro_norm = "gyro_norm" in prepared.columns
    if not has_gyro_norm:
        if not all(column in prepared.columns for column in axis_columns):
            raise ValueError("imu is missing gyro_norm or gyro_x/gyro_y/gyro_z columns")

    prepared["elapsed_ms"] = pd.to_numeric(prepared["elapsed_ms"], errors="coerce")
    if prepared["elapsed_ms"].isna().any():
        raise ValueError("imu elapsed_ms contains non-numeric values")

    sensor_columns = [
        "accel_x",
        "accel_y",
        "accel_z",
        "gyro_x",
        "gyro_y",
        "gyro_z",
        "accel_norm",
        "gyro_norm",
    ]
    for column in sensor_columns:
        if column in prepared.columns:
            prepared[column] = pd.to_numeric(prepared[column], errors="coerce")

    if has_gyro_norm and prepared["gyro_norm"].isna().all():
        raise ValueError("imu gyro_norm contains no numeric values")

    if prepared["elapsed_ms"].duplicated().any():
        aggregation = {
            column: ("mean" if column in sensor_columns else "first")
            for column in prepared.columns
            if column != "elapsed_ms"
        }
        prepared = (
            prepared.groupby("elapsed_ms", as_index=False, sort=True)
            .agg(aggregation)
        )
    else:
        prepared = prepared.sort_values("elapsed_ms").reset_index(drop=True)

    if not has_gyro_norm:
        gyro_axes = prepared[axis_columns].apply(pd.to_numeric, errors="coerce")
        prepared["gyro_norm"] = np.sqrt((gyro_axes**2).sum(axis=1))

    if prepared["gyro_norm"].isna().all():
        raise ValueError("imu gyro_norm contains no numeric values")

    if (prepared["elapsed_ms"].diff().iloc[1:] <= 0).any():
        raise ValueError("imu elapsed_ms must be strictly increasing")
    return prepared


def compute_wrist_speed(landmarks: pd.DataFrame, watch_side: str) -> pd.Series:
    if watch_side not in {"left", "right"}:
        raise ValueError("watch_side must be 'left' or 'right'")

    wrist = f"{watch_side}Wrist"
    required_columns = ["timestamp_ms", f"{wrist}_x", f"{wrist}_y", f"{wrist}_visibility"]
    require_columns(landmarks, required_columns, "pose")

    timestamps = pd.to_numeric(landmarks["timestamp_ms"], errors="coerce")
    dt_seconds = timestamps.diff() / 1000.0
    if timestamps.isna().any() or dt_seconds.iloc[1:].isna().any() or (dt_seconds.iloc[1:] <= 0).any():
        raise ValueError("pose timestamp_ms must be strictly increasing")

    x = pd.to_numeric(landmarks[f"{wrist}_x"], errors="coerce")
    y = pd.to_numeric(landmarks[f"{wrist}_y"], errors="coerce")
    visibility = pd.to_numeric(landmarks[f"{wrist}_visibility"], errors="coerce")
    visible = visibility > 0
    distance = np.sqrt(x.where(visible).diff() ** 2 + y.where(visible).diff() ** 2)
    speed = distance / dt_seconds
    speed.iloc[0] = 0.0
    return speed


def smooth_signal(signal: pd.Series, window: int = 3) -> pd.Series:
    numeric = pd.to_numeric(signal, errors="coerce")
    return numeric.rolling(window=window, center=True, min_periods=1).median()


def find_peak_candidates(
    timestamps_ms: pd.Series,
    signal: pd.Series,
    *,
    search_window_ms: float,
    min_peak_distance_ms: float,
    max_candidate_peaks: int,
) -> list[tuple[float, float]]:
    times = pd.to_numeric(timestamps_ms, errors="coerce").to_numpy(dtype=float)
    values = smooth_signal(signal).fillna(0.0).to_numpy(dtype=float)
    mask = np.isfinite(times) & np.isfinite(values) & (times <= search_window_ms)
    times = times[mask]
    values = values[mask]
    if len(times) < 3:
        return []

    positive = values[values > 0]
    if len(positive) == 0:
        return []
    threshold = max(float(np.nanmedian(positive) + np.nanstd(positive)), float(np.nanquantile(positive, 0.75)))

    local_maxima: list[tuple[float, float]] = []
    for index in range(1, len(values) - 1):
        if values[index] >= threshold and values[index] >= values[index - 1] and values[index] > values[index + 1]:
            local_maxima.append((float(times[index]), float(values[index])))

    local_maxima.sort(key=lambda item: item[1], reverse=True)
    separated: list[tuple[float, float]] = []
    for candidate in local_maxima:
        candidate_time = candidate[0]
        if all(abs(candidate_time - selected[0]) >= min_peak_distance_ms for selected in separated):
            separated.append(candidate)
        if len(separated) >= max_candidate_peaks:
            break

    return sorted(separated, key=lambda item: item[0])


def select_peak_pairing(
    video_candidates: list[tuple[float, float]],
    imu_candidates: list[tuple[float, float]],
    *,
    expected_peaks: int,
    max_interval_delta_ms: float,
    max_offset_std_ms: float,
) -> tuple[list[float], list[float], float, float]:
    best: tuple[float, list[float], list[float], float, float] | None = None
    for video_combo in combinations(video_candidates, expected_peaks):
        video_peaks = [time for time, _value in video_combo]
        video_intervals = np.diff(video_peaks)
        for imu_combo in combinations(imu_candidates, expected_peaks):
            imu_peaks = [time for time, _value in imu_combo]
            imu_intervals = np.diff(imu_peaks)
            interval_delta = float(np.max(np.abs(video_intervals - imu_intervals)))
            offsets = np.array(imu_peaks) - np.array(video_peaks)
            offset_std = float(np.std(offsets))
            if interval_delta > max_interval_delta_ms or offset_std > max_offset_std_ms:
                continue
            score = interval_delta + offset_std
            if best is None or score < best[0]:
                best = (score, video_peaks, imu_peaks, interval_delta, offset_std)

    if best is None:
        raise ValueError("Could not find a stable three-shake peak pairing")

    _score, video_peaks, imu_peaks, interval_delta, offset_std = best
    return video_peaks, imu_peaks, interval_delta, offset_std


def estimate_three_shake_offset(
    pose: pd.DataFrame,
    imu: pd.DataFrame,
    *,
    watch_side: str = "left",
    search_window_ms: float = 10_000.0,
    expected_peaks: int = 3,
    min_peak_distance_ms: float = 300.0,
    max_candidate_peaks: int = 8,
    max_interval_delta_ms: float = 250.0,
    max_offset_std_ms: float = 120.0,
) -> SyncEstimate:
    prepared_imu = prepare_imu_frame(imu)
    video_signal = compute_wrist_speed(pose, watch_side)
    imu_signal = prepared_imu["gyro_norm"]

    video_candidates = find_peak_candidates(
        pose["timestamp_ms"],
        video_signal,
        search_window_ms=search_window_ms,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    imu_candidates = find_peak_candidates(
        prepared_imu["elapsed_ms"],
        imu_signal,
        search_window_ms=search_window_ms,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    if len(video_candidates) < expected_peaks or len(imu_candidates) < expected_peaks:
        raise ValueError("Could not find enough three-shake peak candidates")

    video_peaks, imu_peaks, interval_delta, offset_std = select_peak_pairing(
        video_candidates,
        imu_candidates,
        expected_peaks=expected_peaks,
        max_interval_delta_ms=max_interval_delta_ms,
        max_offset_std_ms=max_offset_std_ms,
    )
    offsets = np.array(imu_peaks) - np.array(video_peaks)
    offset_ms = float(np.median(offsets))
    confidence = max(
        0.0,
        1.0 - ((offset_std / max_offset_std_ms) + (interval_delta / max_interval_delta_ms)) / 2.0,
    )
    return SyncEstimate(
        method="three_shake_peak",
        watch_side=watch_side,
        video_signal=f"{watch_side}_wrist_speed",
        imu_signal="gyro_norm",
        offset_ms=offset_ms,
        video_peaks_ms=[float(value) for value in video_peaks],
        imu_peaks_ms=[float(value) for value in imu_peaks],
        offset_std_ms=offset_std,
        interval_delta_ms=interval_delta,
        confidence=float(confidence),
    )


def infer_session_id(pose_csv_path: Path) -> str:
    stem = pose_csv_path.stem
    for suffix in ["_33landmarks", "_landmarks", "_pose"]:
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


def default_tolerance_ms(pose: pd.DataFrame) -> float:
    timestamps = pd.to_numeric(pose["timestamp_ms"], errors="coerce").dropna().sort_values()
    intervals = timestamps.diff().dropna()
    if intervals.empty:
        return 50.0
    return float(intervals.median())


def join_pose_with_imu(
    pose: pd.DataFrame,
    imu: pd.DataFrame,
    *,
    offset_ms: float,
    tolerance_ms: float,
) -> tuple[pd.DataFrame, dict[str, int]]:
    pose_sorted = pose.copy()
    pose_sorted["timestamp_ms"] = pd.to_numeric(pose_sorted["timestamp_ms"], errors="coerce").astype(float)
    pose_sorted = pose_sorted.sort_values("timestamp_ms").reset_index(drop=True)

    imu_aligned = prepare_imu_frame(imu)
    imu_aligned["aligned_imu_time_ms"] = (imu_aligned["elapsed_ms"] - offset_ms).astype(float)
    rename_map = {
        column: f"imu_{column}"
        for column in imu_aligned.columns
        if column not in {"aligned_imu_time_ms"}
    }
    imu_for_join = imu_aligned.rename(columns=rename_map).sort_values("aligned_imu_time_ms")

    synced = pd.merge_asof(
        pose_sorted,
        imu_for_join,
        left_on="timestamp_ms",
        right_on="aligned_imu_time_ms",
        direction="nearest",
        tolerance=tolerance_ms,
    )
    unmatched_pose_rows = int(synced["aligned_imu_time_ms"].isna().sum())

    pose_times = pose_sorted[["timestamp_ms"]].rename(columns={"timestamp_ms": "pose_timestamp_ms"})
    pose_times["pose_timestamp_ms"] = pose_times["pose_timestamp_ms"].astype(float)
    imu_match = pd.merge_asof(
        imu_aligned.sort_values("aligned_imu_time_ms"),
        pose_times.sort_values("pose_timestamp_ms"),
        left_on="aligned_imu_time_ms",
        right_on="pose_timestamp_ms",
        direction="nearest",
        tolerance=tolerance_ms,
    )
    unmatched_imu_rows = int(imu_match["pose_timestamp_ms"].isna().sum())

    return synced, {
        "unmatched_pose_rows": unmatched_pose_rows,
        "unmatched_imu_rows": unmatched_imu_rows,
    }


def write_diagnostic_plot(
    path: Path,
    pose: pd.DataFrame,
    imu: pd.DataFrame,
    estimate: SyncEstimate,
) -> None:
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    prepared_imu = prepare_imu_frame(imu)
    video_speed = compute_wrist_speed(pose, estimate.watch_side)
    fig, axes = plt.subplots(nrows=2, ncols=1, figsize=(10, 6), sharex=False)
    axes[0].plot(pd.to_numeric(pose["timestamp_ms"], errors="coerce") / 1000.0, video_speed)
    axes[0].set_ylabel("wrist speed")
    axes[0].set_title("Video sync signal")
    for peak in estimate.video_peaks_ms:
        axes[0].axvline(peak / 1000.0, color="tab:red", alpha=0.5)

    aligned_time = (prepared_imu["elapsed_ms"] - estimate.offset_ms) / 1000.0
    axes[1].plot(aligned_time, prepared_imu["gyro_norm"])
    axes[1].set_ylabel("gyro_norm")
    axes[1].set_xlabel("video time (s)")
    axes[1].set_title("Aligned IMU sync signal")
    for peak in estimate.imu_peaks_ms:
        axes[1].axvline((peak - estimate.offset_ms) / 1000.0, color="tab:red", alpha=0.5)

    for axis in axes:
        axis.grid(True, alpha=0.3)
    fig.tight_layout()
    fig.savefig(path, dpi=300, bbox_inches="tight")
    plt.close(fig)


def sync_session(
    *,
    pose_csv_path: Path,
    imu_csv_path: Path,
    output_dir: Path,
    watch_side: str = "left",
    search_window_ms: float = 10_000.0,
    manual_offset_ms: float | None = None,
    tolerance_ms: float | None = None,
) -> dict[str, Path]:
    pose = pd.read_csv(pose_csv_path)
    imu = pd.read_csv(imu_csv_path)
    require_columns(pose, ["timestamp_ms"], "pose")
    prepared_imu = prepare_imu_frame(imu)

    if tolerance_ms is None:
        tolerance_ms = default_tolerance_ms(pose)

    if manual_offset_ms is None:
        estimate = estimate_three_shake_offset(
            pose,
            prepared_imu,
            watch_side=watch_side,
            search_window_ms=search_window_ms,
        )
    else:
        estimate = SyncEstimate(
            method="manual_offset",
            watch_side=watch_side,
            video_signal=f"{watch_side}_wrist_speed",
            imu_signal="gyro_norm",
            offset_ms=float(manual_offset_ms),
            video_peaks_ms=[],
            imu_peaks_ms=[],
            offset_std_ms=0.0,
            interval_delta_ms=0.0,
            confidence=1.0,
        )

    synced, join_stats = join_pose_with_imu(
        pose,
        prepared_imu,
        offset_ms=estimate.offset_ms,
        tolerance_ms=float(tolerance_ms),
    )

    session_id = infer_session_id(pose_csv_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = output_dir / f"{session_id}_sync_metadata.json"
    synced_csv_path = output_dir / f"{session_id}_synced_pose_imu.csv"
    diagnostic_path = output_dir / f"{session_id}_sync_diagnostic.png"

    metadata: dict[str, Any] = asdict(estimate)
    metadata.update({
        "session_id": session_id,
        "pose_csv_path": str(pose_csv_path),
        "imu_csv_path": str(imu_csv_path),
        "tolerance_ms": float(tolerance_ms),
        **join_stats,
    })
    metadata_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
    synced.to_csv(synced_csv_path, index=False)
    write_diagnostic_plot(diagnostic_path, pose, prepared_imu, estimate)

    return {
        "metadata_path": metadata_path,
        "synced_csv_path": synced_csv_path,
        "diagnostic_path": diagnostic_path,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync MediaPipe pose CSV with Apple Watch IMU CSV.")
    parser.add_argument("--pose-csv", type=Path, required=True)
    parser.add_argument("--imu-csv", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--watch-side", choices=("left", "right"), default="left")
    parser.add_argument("--search-window-ms", type=float, default=10_000.0)
    parser.add_argument("--manual-offset-ms", type=float, default=None)
    parser.add_argument("--tolerance-ms", type=float, default=None)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    result = sync_session(
        pose_csv_path=args.pose_csv,
        imu_csv_path=args.imu_csv,
        output_dir=args.output_dir,
        watch_side=args.watch_side,
        search_window_ms=args.search_window_ms,
        manual_offset_ms=args.manual_offset_ms,
        tolerance_ms=args.tolerance_ms,
    )
    print(f"[保存] Sync Metadata: {result['metadata_path']}")
    print(f"[保存] Synced CSV: {result['synced_csv_path']}")
    print(f"[保存] Diagnostic Plot: {result['diagnostic_path']}")


if __name__ == "__main__":
    main()
