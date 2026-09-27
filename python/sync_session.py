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
    scale: float = 1.0
    intercept_ms: float = 0.0
    drift_ppm: float = 0.0
    residual_rms_ms: float = 0.0
    residual_max_ms: float = 0.0
    end_video_peaks_ms: list[float] | None = None
    end_imu_peaks_ms: list[float] | None = None
    manual_correction: bool = False
    auto_sync_failure_reason: str | None = None


def require_columns(frame: pd.DataFrame, required_columns: list[str], label: str) -> None:
    missing = [column for column in required_columns if column not in frame.columns]
    if missing:
        raise ValueError(f"{label} is missing required columns: {', '.join(missing)}")


def prepare_imu_frame(imu: pd.DataFrame) -> pd.DataFrame:
    require_columns(imu, ["elapsed_ms"], "imu")
    prepared = imu.copy()
    time_column = imu_sync_time_column(prepared)

    axis_columns = ["gyro_x", "gyro_y", "gyro_z"]
    has_gyro_norm = "gyro_norm" in prepared.columns
    if not has_gyro_norm:
        if not all(column in prepared.columns for column in axis_columns):
            raise ValueError("imu is missing gyro_norm or gyro_x/gyro_y/gyro_z columns")

    prepared["elapsed_ms"] = pd.to_numeric(prepared["elapsed_ms"], errors="coerce")
    if prepared["elapsed_ms"].isna().any():
        raise ValueError("imu elapsed_ms contains non-numeric values")
    if time_column != "elapsed_ms":
        prepared[time_column] = pd.to_numeric(prepared[time_column], errors="coerce")
        if prepared[time_column].isna().any():
            raise ValueError(f"imu {time_column} contains non-numeric values")

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

    if prepared[time_column].duplicated().any():
        aggregation = {
            column: ("mean" if column in sensor_columns else "first")
            for column in prepared.columns
            if column != time_column
        }
        prepared = (
            prepared.groupby(time_column, as_index=False, sort=True)
            .agg(aggregation)
        )
    else:
        prepared = prepared.sort_values(time_column).reset_index(drop=True)

    if not has_gyro_norm:
        gyro_axes = prepared[axis_columns].apply(pd.to_numeric, errors="coerce")
        prepared["gyro_norm"] = np.sqrt((gyro_axes**2).sum(axis=1))

    if prepared["gyro_norm"].isna().all():
        raise ValueError("imu gyro_norm contains no numeric values")

    accel_axes = ["accel_x", "accel_y", "accel_z"]
    if "accel_norm" not in prepared.columns and all(column in prepared.columns for column in accel_axes):
        acceleration = prepared[accel_axes].apply(pd.to_numeric, errors="coerce")
        prepared["accel_norm"] = np.sqrt((acceleration**2).sum(axis=1))

    if (prepared[time_column].diff().iloc[1:] <= 0).any():
        raise ValueError(f"imu {time_column} must be strictly increasing")
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


def prepare_video_sync_signal(
    landmarks: pd.DataFrame,
    watch_side: str,
) -> tuple[pd.Series, pd.Series, str]:
    pose_wrist = f"{watch_side}Wrist"
    if f"{pose_wrist}_x" in landmarks.columns:
        return (
            pd.to_numeric(landmarks["timestamp_ms"], errors="coerce"),
            compute_wrist_speed(landmarks, watch_side),
            f"{watch_side}_pose_wrist_speed",
        )

    require_columns(
        landmarks,
        [
            "timestamp_ms",
            "frame_index",
            "handedness",
            "score",
            "detected",
            "wrist_x",
            "wrist_y",
        ],
        "hand",
    )

    side_label = watch_side.title()
    selected = landmarks[landmarks["handedness"].astype(str) == side_label].copy()
    if "detected" in selected.columns:
        selected = selected[selected["detected"].astype(str).str.lower() == "true"]
    if selected.empty:
        raise ValueError(f"hand contains no detected {side_label} wrist rows")

    selected["score"] = pd.to_numeric(selected["score"], errors="coerce")
    selected = (
        selected.sort_values(["timestamp_ms", "score"], ascending=[True, False])
        .drop_duplicates(subset=["timestamp_ms"], keep="first")
        .sort_values("timestamp_ms")
        .reset_index(drop=True)
    )
    timestamps = pd.to_numeric(selected["timestamp_ms"], errors="coerce")
    dt_seconds = timestamps.diff() / 1000.0
    if timestamps.isna().any() or (dt_seconds.iloc[1:] <= 0).any():
        raise ValueError("hand timestamp_ms must be strictly increasing")
    x = pd.to_numeric(selected["wrist_x"], errors="coerce")
    y = pd.to_numeric(selected["wrist_y"], errors="coerce")
    speed = np.sqrt(x.diff() ** 2 + y.diff() ** 2) / dt_seconds
    speed.iloc[0] = 0.0
    return timestamps, speed, f"{watch_side}_hand_wrist_speed"


def validate_hand_handedness(landmarks: pd.DataFrame) -> None:
    hand_schema_markers = {"handedness", "raw_handedness", "detected", "wrist_x", "wrist_y"}
    if hand_schema_markers.isdisjoint(landmarks.columns):
        return

    require_columns(
        landmarks,
        [
            "timestamp_ms",
            "frame_index",
            "handedness",
            "raw_handedness",
            "score",
            "detected",
            "wrist_x",
            "wrist_y",
        ],
        "hand",
    )
    detected_values = landmarks["detected"].astype(str).str.lower()
    if not detected_values.isin({"true", "false"}).all():
        raise ValueError("hand detected must contain only true or false")

    detected_rows = landmarks[detected_values == "true"]
    raw_handedness = detected_rows["raw_handedness"].astype(str)
    if (
        not raw_handedness.isin({"Left", "Right"}).all()
        or not detected_rows["handedness"].astype(str).eq(raw_handedness).all()
    ):
        raise ValueError(
            "hand CSV contains missing or transformed handedness; re-extract it from the source video"
        )

    numeric_columns = ["timestamp_ms", "frame_index", "score", "wrist_x", "wrist_y"]
    numeric_values = detected_rows[numeric_columns].apply(pd.to_numeric, errors="coerce")
    if not np.isfinite(numeric_values.to_numpy(dtype=float)).all():
        raise ValueError("detected hand rows must contain finite timestamp, frame, score, and wrist values")


def imu_sync_time_column(imu: pd.DataFrame) -> str:
    return "core_motion_elapsed_ms" if "core_motion_elapsed_ms" in imu.columns else "elapsed_ms"


def validate_raw_imu_timebase(imu: pd.DataFrame) -> str:
    column = imu_sync_time_column(imu)
    require_columns(imu, [column], "imu")
    values = pd.to_numeric(imu[column], errors="coerce")
    if values.isna().any() or not np.isfinite(values.to_numpy(dtype=float)).all():
        raise ValueError(f"imu {column} contains non-finite values")
    if (values.diff().iloc[1:] <= 0).any():
        raise ValueError(f"imu {column} must be strictly increasing in capture order")
    return column


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
    search_start_ms: float = 0.0,
) -> list[tuple[float, float]]:
    times = pd.to_numeric(timestamps_ms, errors="coerce").to_numpy(dtype=float)
    values = smooth_signal(signal).fillna(0.0).to_numpy(dtype=float)
    mask = (
        np.isfinite(times)
        & np.isfinite(values)
        & (times >= search_start_ms)
        & (times <= search_window_ms)
    )
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


def fit_sync_transform(
    video_peaks_ms: list[float],
    imu_peaks_ms: list[float],
    *,
    method: str,
    watch_side: str,
    video_signal: str,
    imu_signal: str,
    max_abs_drift_ppm: float = 10_000.0,
    max_residual_ms: float = 150.0,
    end_video_peaks_ms: list[float] | None = None,
    end_imu_peaks_ms: list[float] | None = None,
) -> SyncEstimate:
    if len(video_peaks_ms) != len(imu_peaks_ms) or len(video_peaks_ms) < 2:
        raise ValueError("video and imu sync points must have the same length of at least 2")
    imu_points = np.asarray(imu_peaks_ms, dtype=float)
    video_points = np.asarray(video_peaks_ms, dtype=float)
    if not np.isfinite(imu_points).all() or not np.isfinite(video_points).all():
        raise ValueError("sync points must be finite")
    if (np.diff(imu_points) <= 0).any() or (np.diff(video_points) <= 0).any():
        raise ValueError("sync points must be strictly increasing")

    scale, intercept_ms = np.polyfit(imu_points, video_points, 1)
    aligned = scale * imu_points + intercept_ms
    residuals = video_points - aligned
    residual_rms_ms = float(np.sqrt(np.mean(residuals**2)))
    residual_max_ms = float(np.max(np.abs(residuals)))
    drift_ppm = float((scale - 1.0) * 1_000_000.0)
    if scale <= 0 or abs(drift_ppm) > max_abs_drift_ppm:
        raise ValueError(f"sync scale is outside the allowed range: {scale:.9f}")
    if residual_max_ms > max_residual_ms:
        raise ValueError(f"sync residual is too large: {residual_max_ms:.3f} ms")

    legacy_offset_ms = float(-intercept_ms / scale)
    confidence = max(0.0, 1.0 - residual_max_ms / max_residual_ms)
    return SyncEstimate(
        method=method,
        watch_side=watch_side,
        video_signal=video_signal,
        imu_signal=imu_signal,
        offset_ms=legacy_offset_ms,
        video_peaks_ms=[float(value) for value in video_peaks_ms],
        imu_peaks_ms=[float(value) for value in imu_peaks_ms],
        offset_std_ms=float(np.std(imu_points - video_points)),
        interval_delta_ms=float(np.max(np.abs(np.diff(imu_points) - np.diff(video_points)))),
        confidence=float(confidence),
        scale=float(scale),
        intercept_ms=float(intercept_ms),
        drift_ppm=drift_ppm,
        residual_rms_ms=residual_rms_ms,
        residual_max_ms=residual_max_ms,
        end_video_peaks_ms=end_video_peaks_ms,
        end_imu_peaks_ms=end_imu_peaks_ms,
    )


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
    video_timestamps, video_signal, video_signal_name = prepare_video_sync_signal(pose, watch_side)
    time_column = imu_sync_time_column(prepared_imu)
    imu_signal = prepared_imu["gyro_norm"]

    video_candidates = find_peak_candidates(
        video_timestamps,
        video_signal,
        search_window_ms=search_window_ms,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    imu_candidates = find_peak_candidates(
        prepared_imu[time_column],
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
        video_signal=video_signal_name,
        imu_signal="gyro_norm",
        offset_ms=offset_ms,
        video_peaks_ms=[float(value) for value in video_peaks],
        imu_peaks_ms=[float(value) for value in imu_peaks],
        offset_std_ms=offset_std,
        interval_delta_ms=interval_delta,
        confidence=float(confidence),
        scale=1.0,
        intercept_ms=-offset_ms,
    )


def estimate_start_end_transform(
    landmarks: pd.DataFrame,
    imu: pd.DataFrame,
    *,
    watch_side: str = "right",
    search_window_ms: float = 10_000.0,
    end_search_window_ms: float | None = None,
    expected_peaks: int = 3,
    min_peak_distance_ms: float = 300.0,
    max_candidate_peaks: int = 8,
    max_interval_delta_ms: float = 250.0,
    max_offset_std_ms: float = 120.0,
    max_abs_drift_ppm: float = 10_000.0,
    max_residual_ms: float = 150.0,
) -> SyncEstimate:
    prepared_imu = prepare_imu_frame(imu)
    video_timestamps, video_signal, video_signal_name = prepare_video_sync_signal(
        landmarks,
        watch_side,
    )
    time_column = imu_sync_time_column(prepared_imu)
    if "accel_norm" not in prepared_imu.columns or prepared_imu["accel_norm"].isna().all():
        raise ValueError("imu is missing accel_norm or accel_x/accel_y/accel_z columns")
    imu_signal = prepared_imu["accel_norm"]

    video_start = float(video_timestamps.min())
    video_end = float(video_timestamps.max())
    imu_times = pd.to_numeric(prepared_imu[time_column], errors="coerce")
    imu_start = float(imu_times.min())
    imu_end = float(imu_times.max())
    end_window_ms = search_window_ms if end_search_window_ms is None else end_search_window_ms
    if (
        video_end - video_start <= search_window_ms + end_window_ms
        or imu_end - imu_start <= search_window_ms + end_window_ms
    ):
        raise ValueError("capture is too short for non-overlapping start and end sync windows")

    start_video_candidates = find_peak_candidates(
        video_timestamps,
        video_signal,
        search_window_ms=video_start + search_window_ms,
        search_start_ms=video_start,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    start_imu_candidates = find_peak_candidates(
        imu_times,
        imu_signal,
        search_window_ms=imu_start + search_window_ms,
        search_start_ms=imu_start,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    end_video_candidates = find_peak_candidates(
        video_timestamps,
        video_signal,
        search_window_ms=video_end,
        search_start_ms=video_end - end_window_ms,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    end_imu_candidates = find_peak_candidates(
        imu_times,
        imu_signal,
        search_window_ms=imu_end,
        search_start_ms=imu_end - end_window_ms,
        min_peak_distance_ms=min_peak_distance_ms,
        max_candidate_peaks=max_candidate_peaks,
    )
    if min(
        len(start_video_candidates),
        len(start_imu_candidates),
        len(end_video_candidates),
        len(end_imu_candidates),
    ) < expected_peaks:
        raise ValueError("Could not find enough three-shake peak candidates")

    start_video_peaks, start_imu_peaks, _start_interval, _start_std = select_peak_pairing(
        start_video_candidates,
        start_imu_candidates,
        expected_peaks=expected_peaks,
        max_interval_delta_ms=max_interval_delta_ms,
        max_offset_std_ms=max_offset_std_ms,
    )
    end_video_peaks, end_imu_peaks, _end_interval, _end_std = select_peak_pairing(
        end_video_candidates,
        end_imu_candidates,
        expected_peaks=expected_peaks,
        max_interval_delta_ms=max_interval_delta_ms,
        max_offset_std_ms=max_offset_std_ms,
    )
    return fit_sync_transform(
        start_video_peaks + end_video_peaks,
        start_imu_peaks + end_imu_peaks,
        method="start_end_three_shake_affine",
        watch_side=watch_side,
        video_signal=video_signal_name,
        imu_signal="accel_norm",
        max_abs_drift_ppm=max_abs_drift_ppm,
        max_residual_ms=max_residual_ms,
        end_video_peaks_ms=[float(value) for value in end_video_peaks],
        end_imu_peaks_ms=[float(value) for value in end_imu_peaks],
    )


def infer_session_id(pose_csv_path: Path) -> str:
    stem = pose_csv_path.stem
    for suffix in ["_hand_landmarks", "_33landmarks", "_landmarks", "_pose"]:
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


def default_tolerance_ms(pose: pd.DataFrame) -> float:
    timestamps = (
        pd.to_numeric(pose["timestamp_ms"], errors="coerce")
        .dropna()
        .drop_duplicates()
        .sort_values()
    )
    intervals = timestamps.diff().dropna()
    intervals = intervals[intervals > 0]
    if intervals.empty:
        return 50.0
    return float(intervals.median())


def join_pose_with_imu(
    pose: pd.DataFrame,
    imu: pd.DataFrame,
    *,
    offset_ms: float,
    tolerance_ms: float,
    scale: float = 1.0,
    intercept_ms: float | None = None,
) -> tuple[pd.DataFrame, dict[str, int]]:
    pose_sorted = pose.copy()
    pose_sorted["timestamp_ms"] = pd.to_numeric(pose_sorted["timestamp_ms"], errors="coerce").astype(float)
    pose_sorted = pose_sorted.sort_values("timestamp_ms").reset_index(drop=True)
    if "handedness" in pose_sorted.columns:
        timeline_columns = ["timestamp_ms"]
        if "frame_index" in pose_sorted.columns:
            timeline_columns.append("frame_index")
        pose_sorted = pose_sorted[timeline_columns].drop_duplicates().reset_index(drop=True)

    imu_aligned = prepare_imu_frame(imu)
    time_column = imu_sync_time_column(imu_aligned)
    effective_intercept_ms = -offset_ms if intercept_ms is None else intercept_ms
    imu_aligned["aligned_imu_time_ms"] = (
        scale * pd.to_numeric(imu_aligned[time_column], errors="coerce") + effective_intercept_ms
    ).astype(float)
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
    video_timestamps, video_speed, _video_signal_name = prepare_video_sync_signal(
        pose,
        estimate.watch_side,
    )
    time_column = imu_sync_time_column(prepared_imu)
    fig, axes = plt.subplots(nrows=2, ncols=1, figsize=(10, 6), sharex=False)
    axes[0].plot(video_timestamps / 1000.0, video_speed)
    axes[0].set_ylabel("wrist speed")
    axes[0].set_title("Video sync signal")
    for peak in estimate.video_peaks_ms:
        axes[0].axvline(peak / 1000.0, color="tab:red", alpha=0.5)

    aligned_time = (
        estimate.scale * pd.to_numeric(prepared_imu[time_column], errors="coerce")
        + estimate.intercept_ms
    ) / 1000.0
    imu_signal = prepared_imu[estimate.imu_signal]
    axes[1].plot(aligned_time, imu_signal)
    axes[1].set_ylabel(estimate.imu_signal)
    axes[1].set_xlabel("video time (s)")
    axes[1].set_title("Aligned IMU sync signal")
    for peak in estimate.imu_peaks_ms:
        axes[1].axvline(
            (estimate.scale * peak + estimate.intercept_ms) / 1000.0,
            color="tab:red",
            alpha=0.5,
        )

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
    watch_side: str = "right",
    search_window_ms: float = 10_000.0,
    end_search_window_ms: float | None = None,
    manual_offset_ms: float | None = None,
    manual_video_times_ms: list[float] | None = None,
    manual_imu_times_ms: list[float] | None = None,
    tolerance_ms: float | None = None,
    sync_method: str | None = None,
) -> dict[str, Path]:
    pose = pd.read_csv(pose_csv_path)
    imu = pd.read_csv(imu_csv_path)
    require_columns(pose, ["timestamp_ms"], "pose")
    validate_hand_handedness(pose)
    has_manual_video = manual_video_times_ms is not None
    has_manual_imu = manual_imu_times_ms is not None
    if has_manual_video != has_manual_imu:
        raise ValueError("manual video and IMU times must be supplied together")
    if has_manual_video and manual_offset_ms is not None:
        raise ValueError("manual sync points and manual offset cannot be combined")
    if sync_method not in {None, "affine", "legacy-offset"}:
        raise ValueError("sync_method must be affine or legacy-offset")
    effective_sync_method = sync_method or (
        "affine" if end_search_window_ms is not None or has_manual_video else "legacy-offset"
    )
    if effective_sync_method == "affine" and manual_offset_ms is not None:
        raise ValueError("manual offset is only available with legacy-offset synchronization")

    session_id = infer_session_id(pose_csv_path)
    for column, expected in (("session_id", session_id), ("wrist_side", watch_side)):
        if column not in imu.columns:
            if effective_sync_method == "affine":
                raise ValueError(f"imu is missing required affine sync column: {column}")
            continue
        observed = sorted(set(imu[column].astype(str)))
        if observed != [expected]:
            raise ValueError(f"imu {column} must be {expected}; observed: {observed}")

    timebase_column = validate_raw_imu_timebase(imu)
    prepared_imu = prepare_imu_frame(imu)

    if tolerance_ms is None:
        tolerance_ms = default_tolerance_ms(pose)

    if has_manual_video and has_manual_imu:
        if len(manual_video_times_ms) != 6 or len(manual_imu_times_ms) != 6:
            raise ValueError("manual start/end synchronization requires exactly six video and six IMU times")
        try:
            estimate_start_end_transform(
                pose,
                prepared_imu,
                watch_side=watch_side,
                search_window_ms=search_window_ms,
                end_search_window_ms=end_search_window_ms,
            )
        except ValueError as error:
            auto_sync_failure_reason = str(error)
        else:
            raise ValueError("automatic affine synchronization succeeded; manual points are not allowed")
        _video_times, _video_values, video_signal_name = prepare_video_sync_signal(pose, watch_side)
        imu_signal_name = "accel_norm" if "accel_norm" in prepared_imu.columns else "gyro_norm"
        estimate = fit_sync_transform(
            manual_video_times_ms,
            manual_imu_times_ms,
            method="manual_start_end_affine",
            watch_side=watch_side,
            video_signal=video_signal_name,
            imu_signal=imu_signal_name,
            end_video_peaks_ms=[float(value) for value in manual_video_times_ms[3:]],
            end_imu_peaks_ms=[float(value) for value in manual_imu_times_ms[3:]],
        )
        estimate.manual_correction = True
        estimate.auto_sync_failure_reason = auto_sync_failure_reason
    elif effective_sync_method == "affine":
        estimate = estimate_start_end_transform(
            pose,
            prepared_imu,
            watch_side=watch_side,
            search_window_ms=search_window_ms,
            end_search_window_ms=end_search_window_ms,
        )
    elif manual_offset_ms is None:
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
            scale=1.0,
            intercept_ms=-float(manual_offset_ms),
            manual_correction=True,
        )

    synced, join_stats = join_pose_with_imu(
        pose,
        prepared_imu,
        offset_ms=estimate.offset_ms,
        tolerance_ms=float(tolerance_ms),
        scale=estimate.scale,
        intercept_ms=estimate.intercept_ms,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = output_dir / f"{session_id}_sync_metadata.json"
    synced_csv_path = output_dir / f"{session_id}_synced_pose_imu.csv"
    diagnostic_path = output_dir / f"{session_id}_sync_diagnostic.png"

    metadata: dict[str, Any] = asdict(estimate)
    metadata.update({
        "status": "valid",
        "session_id": session_id,
        "pose_csv_path": str(pose_csv_path),
        "imu_csv_path": str(imu_csv_path),
        "tolerance_ms": float(tolerance_ms),
        "imu_timebase_column": timebase_column,
        **join_stats,
    })
    metadata_path.write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )
    synced.to_csv(synced_csv_path, index=False)
    write_diagnostic_plot(diagnostic_path, pose, prepared_imu, estimate)

    return {
        "metadata_path": metadata_path,
        "synced_csv_path": synced_csv_path,
        "diagnostic_path": diagnostic_path,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync MediaPipe landmark CSV with Apple Watch IMU CSV.")
    parser.add_argument("--pose-csv", type=Path, required=True)
    parser.add_argument("--imu-csv", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--watch-side", choices=("left", "right"), default="right")
    parser.add_argument(
        "--sync-method",
        choices=("affine", "legacy-offset"),
        default="affine",
        help="研究用既定値は開始・終了の3振りを使うaffine同期",
    )
    parser.add_argument("--search-window-ms", type=float, default=10_000.0)
    parser.add_argument(
        "--end-search-window-ms",
        type=float,
        default=None,
        help="指定時は開始・終了の各窓から3ピークを取り、offsetとclock driftを推定する",
    )
    parser.add_argument("--manual-offset-ms", type=float, default=None)
    parser.add_argument(
        "--manual-video-times-ms",
        type=float,
        nargs=6,
        metavar=("START1", "START2", "START3", "END1", "END2", "END3"),
    )
    parser.add_argument(
        "--manual-imu-times-ms",
        type=float,
        nargs=6,
        metavar=("START1", "START2", "START3", "END1", "END2", "END3"),
    )
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
        end_search_window_ms=args.end_search_window_ms,
        manual_offset_ms=args.manual_offset_ms,
        manual_video_times_ms=args.manual_video_times_ms,
        manual_imu_times_ms=args.manual_imu_times_ms,
        tolerance_ms=args.tolerance_ms,
        sync_method=args.sync_method,
    )
    print(f"[保存] Sync Metadata: {result['metadata_path']}")
    print(f"[保存] Synced CSV: {result['synced_csv_path']}")
    print(f"[保存] Diagnostic Plot: {result['diagnostic_path']}")


if __name__ == "__main__":
    main()
