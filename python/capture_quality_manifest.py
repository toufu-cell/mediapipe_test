"""Build one quality manifest from a cooking capture's recorded artifacts."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


SCHEMA_VERSION = "cooking-capture-quality-v1"
CONDITIONS = ("video-only", "multimodal")
CALIBRATION_STATES = ("not_processed", "valid", "invalid")
HAND_LANDMARK_NAMES = (
    "wrist",
    "thumbCmc", "thumbMcp", "thumbIp", "thumbTip",
    "indexFingerMcp", "indexFingerPip", "indexFingerDip", "indexFingerTip",
    "middleFingerMcp", "middleFingerPip", "middleFingerDip", "middleFingerTip",
    "ringFingerMcp", "ringFingerPip", "ringFingerDip", "ringFingerTip",
    "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
)


def issue(code: str, severity: str, message: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "message": message}


def inspect_video(video_path: Path) -> dict[str, Any]:
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        raise RuntimeError("ffprobe is required to inspect video dimensions, fps, and audio tracks")
    stream_command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,width,height,avg_frame_rate,nb_frames:format=duration",
        "-of",
        "json",
        str(video_path),
    ]
    result = subprocess.run(stream_command, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(video_streams) != 1:
        raise ValueError(f"expected one video stream, found {len(video_streams)}")
    stream = video_streams[0]
    numerator, denominator = str(stream.get("avg_frame_rate", "0/1")).split("/", maxsplit=1)
    fps = float(numerator) / float(denominator) if float(denominator) != 0 else 0.0
    frame_command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "json",
        str(video_path),
    ]
    frame_result = subprocess.run(frame_command, check=True, capture_output=True, text=True)
    frame_payload = json.loads(frame_result.stdout)
    frame_timestamps_ms = []
    for frame in frame_payload.get("frames", []):
        try:
            timestamp_ms = float(frame["best_effort_timestamp_time"]) * 1000.0
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(timestamp_ms):
            frame_timestamps_ms.append(timestamp_ms)
    if not frame_timestamps_ms:
        raise ValueError("video has no finite per-frame presentation timestamps")

    intervals_ms = np.diff(frame_timestamps_ms)
    pts_monotonic = bool(np.all(intervals_ms > 0))
    positive_intervals_ms = intervals_ms[intervals_ms > 0]
    median_interval_ms = (
        float(np.median(positive_intervals_ms))
        if len(positive_intervals_ms)
        else None
    )
    max_interval_ms = (
        float(np.max(positive_intervals_ms))
        if len(positive_intervals_ms)
        else None
    )
    gap_count = 0
    estimated_dropped_frames = 0
    if median_interval_ms:
        gap_intervals = positive_intervals_ms[positive_intervals_ms > 1.5 * median_interval_ms]
        gap_count = int(len(gap_intervals))
        estimated_dropped_frames = int(sum(
            max(0, round(float(interval_ms) / median_interval_ms) - 1)
            for interval_ms in gap_intervals
        ))
    measured_fps = 1000.0 / median_interval_ms if median_interval_ms else fps
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "fps": measured_fps,
        "containerAverageFps": fps,
        "frameCount": len(frame_timestamps_ms),
        "durationMs": float(payload.get("format", {}).get("duration") or 0.0) * 1000.0,
        "audioTrackCount": sum(stream.get("codec_type") == "audio" for stream in streams),
        "frameIntervalMedianMs": median_interval_ms,
        "frameIntervalMaxMs": max_interval_ms,
        "frameGapCount": gap_count,
        "estimatedDroppedFrames": estimated_dropped_frames,
        "ptsMonotonic": pts_monotonic,
    }


def continuous_missing_intervals(side_rows: pd.DataFrame) -> list[dict[str, float | int]]:
    ordered = side_rows.sort_values(["frame_index", "timestamp_ms"]).reset_index(drop=True)
    detected = ordered["detected"].astype(str).str.lower() == "true"
    intervals: list[dict[str, float | int]] = []
    start_index: int | None = None
    for index, is_detected in enumerate(detected.tolist() + [True]):
        if not is_detected and start_index is None:
            start_index = index
        elif is_detected and start_index is not None:
            end_index = index - 1
            start_row = ordered.iloc[start_index]
            end_row = ordered.iloc[end_index]
            intervals.append({
                "startFrame": int(start_row["frame_index"]),
                "endFrame": int(end_row["frame_index"]),
                "startMs": float(start_row["timestamp_ms"]),
                "endMs": float(end_row["timestamp_ms"]),
                "frameCount": end_index - start_index + 1,
            })
            start_index = None
    return intervals


def analyze_hand(hand_csv_path: Path, issues: list[dict[str, str]]) -> dict[str, Any]:
    frame = pd.read_csv(hand_csv_path, keep_default_na=False)
    point_columns = {
        f"{name}_{axis}"
        for name in HAND_LANDMARK_NAMES
        for axis in ("x", "y", "z")
    }
    required = {
        "timestamp_ms", "frame_index", "hand_index", "handedness", "score",
        "detected", "missing_reason", "raw_handedness",
        *point_columns,
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"hand CSV is missing required columns: {', '.join(missing)}")
    if frame.empty:
        raise ValueError("hand CSV contains no rows")

    frame["timestamp_ms"] = pd.to_numeric(frame["timestamp_ms"], errors="coerce")
    frame["frame_index"] = pd.to_numeric(frame["frame_index"], errors="coerce")
    if frame[["timestamp_ms", "frame_index"]].isna().any().any():
        raise ValueError("hand CSV contains non-numeric frame timestamps or indices")
    frame_keys = frame[["timestamp_ms", "frame_index"]].drop_duplicates().sort_values("frame_index")
    if (frame_keys["frame_index"].diff().iloc[1:] <= 0).any() or (
        frame_keys["timestamp_ms"].diff().iloc[1:] <= 0
    ).any():
        raise ValueError("hand frame_index and timestamp_ms must be strictly increasing")

    unknown_sides = sorted(set(frame["handedness"].astype(str)) - {"Left", "Right"})
    if unknown_sides:
        issues.append(issue("hand_unknown_side", "invalid", f"unknown handedness values: {unknown_sides}"))
    detected_text = frame["detected"].astype(str).str.lower()
    invalid_detected = ~detected_text.isin({"true", "false"})
    if invalid_detected.any():
        issues.append(issue("hand_detected_value", "invalid", "detected must be true or false"))
    detected_rows = frame[detected_text == "true"]
    numeric_points = detected_rows[list(sorted(point_columns))].apply(pd.to_numeric, errors="coerce")
    if numeric_points.isna().any().any() or not np.isfinite(numeric_points.to_numpy(dtype=float)).all():
        issues.append(issue("hand_landmark_invalid", "invalid", "detected Hand rows need finite x, y, z values"))
    missing_reason_absent = (detected_text == "false") & (frame["missing_reason"].astype(str).str.strip() == "")
    if missing_reason_absent.any():
        issues.append(issue("hand_missing_reason", "invalid", "undetected Hand rows need missing_reason"))

    sides: dict[str, Any] = {}
    for label, key in (("Left", "left"), ("Right", "right")):
        rows = frame[frame["handedness"] == label]
        counts = rows.groupby(["frame_index", "timestamp_ms"]).size()
        expected_keys = pd.MultiIndex.from_frame(frame_keys[["frame_index", "timestamp_ms"]])
        if not counts.reindex(expected_keys, fill_value=0).eq(1).all() or len(counts) != len(frame_keys):
            issues.append(issue(f"hand_{key}_row_count", "invalid", f"{label} must have exactly one row per frame"))
        detected = rows["detected"].astype(str).str.lower() == "true"
        sides[key] = {
            "detectedFrames": int(detected.sum()),
            "detectionRate": float(detected.mean()) if len(rows) else 0.0,
            "missingIntervals": continuous_missing_intervals(rows) if len(rows) else [],
        }

    timestamp_source = (
        frame["timestamp_source"].astype(str)
        if "timestamp_source" in frame.columns
        else pd.Series("unknown", index=frame.index, dtype=str)
    )
    if "timestamp_source" not in frame.columns:
        issues.append(issue("hand_timestamp_source_missing", "invalid", "Hand CSV has no timestamp_source"))
    timestamp_sources = sorted(set(timestamp_source))
    fallback_rows = int((timestamp_source == "frame_index_fps_fallback").sum())
    if fallback_rows:
        issues.append(issue("video_pts_fallback", "warning", f"{fallback_rows} Hand rows use synthesized timestamps"))
    return {
        "path": str(hand_csv_path),
        "frameCount": int(len(frame_keys)),
        "timestampSources": timestamp_sources,
        "fallbackRowCount": fallback_rows,
        "sides": sides,
    }


def analyze_imu(
    imu_csv_path: Path,
    session_id: str,
    requested_sample_rate_hz: float,
    issues: list[dict[str, str]],
) -> dict[str, Any]:
    frame = pd.read_csv(imu_csv_path)
    required = {
        "session_id", "wrist_side", "timestamp_ms", "elapsed_ms",
        "accel_x", "accel_y", "accel_z", "gyro_x", "gyro_y", "gyro_z",
        "core_motion_timestamp_s", "core_motion_elapsed_ms",
        "gravity_x", "gravity_y", "gravity_z",
        "quaternion_x", "quaternion_y", "quaternion_z", "quaternion_w",
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"IMU CSV is missing required columns: {', '.join(missing)}")
    if len(frame) < 2:
        raise ValueError("IMU CSV needs at least two samples")

    observed_sessions = sorted(set(frame["session_id"].astype(str)))
    observed_sides = sorted(set(frame["wrist_side"].astype(str)))
    if observed_sessions != [session_id]:
        issues.append(issue("imu_session_mismatch", "invalid", f"observed sessions: {observed_sessions}"))
    if observed_sides != ["right"]:
        issues.append(issue("imu_wrist_side", "invalid", f"observed wrist sides: {observed_sides}"))

    sensor_columns = [
        "accel_x", "accel_y", "accel_z",
        "gyro_x", "gyro_y", "gyro_z",
        "gravity_x", "gravity_y", "gravity_z",
        "quaternion_x", "quaternion_y", "quaternion_z", "quaternion_w",
    ]
    sensors = frame[sensor_columns].apply(pd.to_numeric, errors="coerce")
    if sensors.isna().any().any() or not np.isfinite(sensors.to_numpy(dtype=float)).all():
        issues.append(issue("imu_sensor_value", "invalid", "IMU sensor columns contain non-finite values"))

    timebase = pd.to_numeric(frame["core_motion_elapsed_ms"], errors="coerce")
    if timebase.isna().any() or not np.isfinite(timebase.to_numpy(dtype=float)).all():
        raise ValueError("IMU core_motion_elapsed_ms contains non-finite values")
    intervals = timebase.diff().iloc[1:]
    if (intervals <= 0).any():
        issues.append(issue("imu_timebase_not_monotonic", "invalid", "CoreMotion elapsed time is not strictly increasing"))
    positive_intervals = intervals[intervals > 0]
    median_interval_ms = float(positive_intervals.median()) if not positive_intervals.empty else None
    actual_rate_hz = 1000.0 / median_interval_ms if median_interval_ms else None
    gap_threshold_ms = 2.5 * median_interval_ms if median_interval_ms else None
    gap_count = int((positive_intervals > gap_threshold_ms).sum()) if gap_threshold_ms else 0
    if gap_count:
        issues.append(issue("imu_sample_gaps", "warning", f"detected {gap_count} sample gaps"))
    if actual_rate_hz is not None and not math.isclose(
        actual_rate_hz,
        requested_sample_rate_hz,
        rel_tol=0.1,
        abs_tol=1.0,
    ):
        issues.append(issue("imu_sample_rate", "warning", f"actual sample rate is {actual_rate_hz:.3f} Hz"))

    core_timestamp = pd.to_numeric(frame["core_motion_timestamp_s"], errors="coerce")
    if core_timestamp.isna().any() or (core_timestamp.diff().iloc[1:] <= 0).any():
        issues.append(issue("imu_core_timestamp_reset", "invalid", "CoreMotion timestamp is not strictly increasing"))
    wall_timestamp = pd.to_numeric(frame["timestamp_ms"], errors="coerce")
    if wall_timestamp.isna().any() or (wall_timestamp.diff().iloc[1:] <= 0).any():
        issues.append(issue("imu_wall_clock_reset", "warning", "wall-clock timestamp is not strictly increasing"))
    wall_elapsed = pd.to_numeric(frame["elapsed_ms"], errors="coerce")
    if wall_elapsed.isna().any() or (wall_elapsed.diff().iloc[1:] <= 0).any():
        issues.append(issue("imu_wall_elapsed_reset", "warning", "wall-clock elapsed time is not strictly increasing"))

    quaternion = frame[["quaternion_x", "quaternion_y", "quaternion_z", "quaternion_w"]].apply(
        pd.to_numeric,
        errors="coerce",
    )
    quaternion_norm = np.sqrt((quaternion**2).sum(axis=1))
    invalid_quaternion_count = int((~np.isfinite(quaternion_norm) | (np.abs(quaternion_norm - 1.0) > 0.05)).sum())
    if invalid_quaternion_count:
        issues.append(issue("imu_quaternion_invalid", "invalid", f"{invalid_quaternion_count} quaternion rows are invalid"))

    return {
        "path": str(imu_csv_path),
        "sampleCount": int(len(frame)),
        "requestedSampleRateHz": requested_sample_rate_hz,
        "medianIntervalMs": median_interval_ms,
        "actualSampleRateHz": actual_rate_hz,
        "gapCount": gap_count,
        "timebase": "core_motion_elapsed_ms",
        "referenceFrame": "xArbitraryZVertical",
        "invalidQuaternionCount": invalid_quaternion_count,
    }


def load_sync(
    sync_metadata_path: Path | None,
    session_id: str,
    issues: list[dict[str, str]],
) -> dict[str, Any]:
    if sync_metadata_path is None:
        return {"status": "not_processed", "reason": "sync metadata was not supplied"}
    payload = json.loads(sync_metadata_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        payload = {}

    validation_errors: list[str] = []
    if payload.get("status") != "valid":
        validation_errors.append("status must be valid")
    if payload.get("session_id") != session_id:
        validation_errors.append("session_id does not match the capture")
    if payload.get("watch_side") != "right":
        validation_errors.append("watch_side must be right")
    if payload.get("imu_timebase_column") != "core_motion_elapsed_ms":
        validation_errors.append("imu_timebase_column must be core_motion_elapsed_ms")
    if payload.get("method") not in {"start_end_three_shake_affine", "manual_start_end_affine"}:
        validation_errors.append("method must be a start/end affine synchronization")

    for field in ("video_peaks_ms", "imu_peaks_ms"):
        values = payload.get(field)
        try:
            numeric_values = [float(value) for value in values]
        except (TypeError, ValueError):
            numeric_values = []
        if (
            len(numeric_values) != 6
            or not all(math.isfinite(value) for value in numeric_values)
            or any(next_value <= value for value, next_value in zip(numeric_values, numeric_values[1:]))
        ):
            validation_errors.append(f"{field} must contain six finite increasing values")

    for field in ("end_video_peaks_ms", "end_imu_peaks_ms"):
        values = payload.get(field)
        try:
            numeric_values = [float(value) for value in values]
        except (TypeError, ValueError):
            numeric_values = []
        if len(numeric_values) != 3 or not all(math.isfinite(value) for value in numeric_values):
            validation_errors.append(f"{field} must contain three finite values")

    numeric_values: dict[str, float | None] = {}
    for field in (
        "offset_ms", "scale", "intercept_ms", "drift_ppm",
        "residual_rms_ms", "residual_max_ms", "confidence",
    ):
        try:
            value = float(payload[field])
        except (KeyError, TypeError, ValueError):
            value = float("nan")
        numeric_values[field] = value if math.isfinite(value) else None
        if not math.isfinite(value):
            validation_errors.append(f"{field} must be finite")

    if numeric_values["scale"] is not None and numeric_values["scale"] <= 0:
        validation_errors.append("scale must be positive")
    if numeric_values["drift_ppm"] is not None and abs(numeric_values["drift_ppm"]) > 10_000:
        validation_errors.append("absolute drift_ppm exceeds 10000")
    if numeric_values["residual_max_ms"] is not None and numeric_values["residual_max_ms"] > 150:
        validation_errors.append("residual_max_ms exceeds 150")
    for field in ("residual_rms_ms", "residual_max_ms"):
        if numeric_values[field] is not None and numeric_values[field] < 0:
            validation_errors.append(f"{field} must be non-negative")
    if numeric_values["confidence"] is not None and not 0 <= numeric_values["confidence"] <= 1:
        validation_errors.append("confidence must be between 0 and 1")
    if (
        payload.get("method") == "manual_start_end_affine"
        and not str(payload.get("auto_sync_failure_reason") or "").strip()
    ):
        validation_errors.append("manual synchronization needs auto_sync_failure_reason")
    if payload.get("method") == "manual_start_end_affine" and payload.get("manual_correction") is not True:
        validation_errors.append("manual synchronization needs manual_correction=true")

    status = "invalid" if validation_errors else "valid"
    reason = "; ".join(validation_errors) if validation_errors else payload.get("reason")
    if validation_errors:
        issues.append(issue("sync_metadata_invalid", "invalid", reason))
    return {
        "status": status,
        "reason": reason,
        "path": str(sync_metadata_path),
        "method": payload.get("method"),
        "timebase": payload.get("imu_timebase_column"),
        "offsetMs": numeric_values["offset_ms"],
        "scale": numeric_values["scale"],
        "interceptMs": numeric_values["intercept_ms"],
        "driftPpm": numeric_values["drift_ppm"],
        "residualRmsMs": numeric_values["residual_rms_ms"],
        "residualMaxMs": numeric_values["residual_max_ms"],
        "confidence": numeric_values["confidence"],
        "manualCorrection": bool(payload.get("manual_correction", False)),
        "autoSyncFailureReason": payload.get("auto_sync_failure_reason"),
    }


def load_calibration(
    calibration_metadata_path: Path | None,
    calibration_status: str,
    calibration_reason: str | None,
    issues: list[dict[str, str]],
) -> dict[str, Any]:
    calibration: dict[str, Any] = {
        "status": calibration_status,
        "reason": calibration_reason,
    }
    if calibration_metadata_path is not None:
        payload = json.loads(calibration_metadata_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("calibration metadata must be a JSON object")
        calibration.update(payload)
        calibration["path"] = str(calibration_metadata_path)

    if calibration.get("status") != "valid":
        return calibration

    required = {
        "baselineQuaternion",
        "watchToWristQuaternion",
        "cameraToScreenRotationDeg",
        "mirrored",
        "calibrationErrorDeg",
        "referenceFrame",
        "quaternionConvention",
    }
    missing = sorted(required - set(calibration))
    if missing:
        issues.append(issue(
            "calibration_metadata_missing",
            "invalid",
            f"valid calibration is missing: {', '.join(missing)}",
        ))
        calibration["status"] = "invalid"
        calibration["reason"] = "required calibration fields are missing"
        return calibration

    for field in ("baselineQuaternion", "watchToWristQuaternion"):
        try:
            quaternion = np.asarray(calibration[field], dtype=float)
            quaternion_is_valid = (
                quaternion.shape == (4,)
                and np.isfinite(quaternion).all()
                and math.isclose(float(np.linalg.norm(quaternion)), 1.0, abs_tol=0.05)
            )
        except (TypeError, ValueError):
            quaternion_is_valid = False
        if not quaternion_is_valid:
            issues.append(issue("calibration_quaternion_invalid", "invalid", f"{field} is not a unit quaternion"))
            calibration["status"] = "invalid"
            calibration[field] = None
    if calibration.get("referenceFrame") != "xArbitraryZVertical":
        issues.append(issue("calibration_reference_frame", "invalid", "unexpected CoreMotion reference frame"))
        calibration["status"] = "invalid"
    if calibration.get("quaternionConvention") != "x,y,z,w":
        issues.append(issue("calibration_quaternion_convention", "invalid", "unexpected quaternion convention"))
        calibration["status"] = "invalid"
    for field in ("cameraToScreenRotationDeg", "calibrationErrorDeg"):
        try:
            value = float(calibration[field])
        except (TypeError, ValueError):
            value = float("nan")
        if not math.isfinite(value):
            issues.append(issue("calibration_value_invalid", "invalid", f"{field} must be finite"))
            calibration["status"] = "invalid"
            calibration[field] = None
        else:
            calibration[field] = value
    if not isinstance(calibration["mirrored"], bool):
        issues.append(issue("calibration_mirroring_invalid", "invalid", "mirrored must be boolean"))
        calibration["status"] = "invalid"
        calibration["mirrored"] = None
    if calibration["status"] == "invalid" and not calibration.get("reason"):
        calibration["reason"] = "calibration metadata failed validation"
    return calibration


def build_manifest(
    *,
    session_id: str,
    participant_id: str,
    trial_id: str,
    condition: str,
    video_path: Path,
    hand_csv_path: Path,
    imu_csv_path: Path,
    sync_metadata_path: Path | None = None,
    requested_video_fps: float = 30.0,
    requested_imu_rate_hz: float = 50.0,
    calibration_status: str = "not_processed",
    calibration_reason: str | None = None,
    calibration_metadata_path: Path | None = None,
    video_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if condition not in CONDITIONS:
        raise ValueError(f"condition must be one of: {', '.join(CONDITIONS)}")
    if calibration_status not in CALIBRATION_STATES:
        raise ValueError(f"calibration_status must be one of: {', '.join(CALIBRATION_STATES)}")
    issues: list[dict[str, str]] = []
    inspected_video = dict(inspect_video(video_path) if video_info is None else video_info)
    if inspected_video.get("audioTrackCount") != 0:
        issues.append(issue("video_audio_track", "invalid", "video must contain no audio tracks"))
    if (inspected_video.get("width"), inspected_video.get("height")) != (1920, 1080):
        issues.append(issue("video_dimensions", "invalid", "video must be 1920x1080"))
    actual_fps = float(inspected_video.get("fps") or 0.0)
    if not math.isclose(actual_fps, requested_video_fps, rel_tol=0.02, abs_tol=0.5):
        issues.append(issue("video_fps", "warning", f"actual fps is {actual_fps:.3f}"))

    video_frame_count = inspected_video.get("frameCount")
    if inspected_video.get("ptsMonotonic") is False:
        issues.append(issue("video_pts_not_monotonic", "invalid", "video frame PTS is not strictly increasing"))
    estimated_dropped_frames = int(inspected_video.get("estimatedDroppedFrames") or 0)
    if estimated_dropped_frames:
        issues.append(issue(
            "video_frame_drop",
            "warning",
            f"detected approximately {estimated_dropped_frames} dropped frames from PTS gaps",
        ))

    hand = analyze_hand(hand_csv_path, issues)
    if video_frame_count is not None and int(video_frame_count) != hand["frameCount"]:
        issues.append(issue(
            "video_hand_frame_count",
            "invalid",
            f"video has {video_frame_count} frames but Hand CSV has {hand['frameCount']}",
        ))
    imu = analyze_imu(imu_csv_path, session_id, requested_imu_rate_hz, issues)
    sync = load_sync(sync_metadata_path, session_id, issues)
    if sync["status"] != "valid":
        issues.append(issue("sync_not_processed", "warning", str(sync.get("reason", "sync unavailable"))))
    calibration = load_calibration(
        calibration_metadata_path,
        calibration_status,
        calibration_reason,
        issues,
    )
    if calibration["status"] != "valid":
        issues.append(issue(
            "calibration_not_valid",
            "warning",
            str(calibration.get("reason") or calibration["status"]),
        ))

    technical_exclusions = []
    if sync["status"] != "valid":
        technical_exclusions.append("time_aligned_imu_display")
    if calibration["status"] != "valid":
        technical_exclusions.extend(["rotation_arrow", "orientation_marker"])
    if any(entry["code"] in {"imu_timebase_not_monotonic", "imu_core_timestamp_reset"} for entry in issues):
        technical_exclusions.append("imu_after_timebase_discontinuity")
    fallbacks = []
    if hand["fallbackRowCount"]:
        fallbacks.append({
            "component": "video_timestamp",
            "method": "frame_index_fps_fallback",
            "rowCount": hand["fallbackRowCount"],
        })

    severities = {entry["severity"] for entry in issues}
    status = "invalid" if "invalid" in severities else "warning" if issues else "valid"
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": session_id,
        "participantId": participant_id,
        "trialId": trial_id,
        "condition": condition,
        "status": status,
        "files": {
            "video": str(video_path),
            "handCsv": str(hand_csv_path),
            "imuCsv": str(imu_csv_path),
            "syncMetadata": str(sync_metadata_path) if sync_metadata_path else None,
            "calibrationMetadata": str(calibration_metadata_path) if calibration_metadata_path else None,
        },
        "video": {
            "requested": {"width": 1920, "height": 1080, "fps": requested_video_fps, "audio": False},
            "actual": inspected_video,
        },
        "hand": hand,
        "imu": imu,
        "sync": sync,
        "calibration": calibration,
        "vlm": {"status": "not_processed"},
        "technicalExclusions": sorted(set(technical_exclusions)),
        "fallbacks": fallbacks,
        "issues": issues,
    }
    json.dumps(manifest, allow_nan=False)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a cooking capture quality manifest.")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--participant-id", required=True)
    parser.add_argument("--trial-id", required=True)
    parser.add_argument("--condition", choices=CONDITIONS, required=True)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--hand-csv", type=Path, required=True)
    parser.add_argument("--imu-csv", type=Path, required=True)
    parser.add_argument("--sync-metadata", type=Path)
    parser.add_argument("--requested-video-fps", type=float, default=30.0)
    parser.add_argument("--requested-imu-rate-hz", type=float, default=50.0)
    parser.add_argument("--calibration-status", choices=CALIBRATION_STATES, default="not_processed")
    parser.add_argument("--calibration-reason")
    parser.add_argument("--calibration-metadata", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    manifest = build_manifest(
        session_id=args.session_id,
        participant_id=args.participant_id,
        trial_id=args.trial_id,
        condition=args.condition,
        video_path=args.video,
        hand_csv_path=args.hand_csv,
        imu_csv_path=args.imu_csv,
        sync_metadata_path=args.sync_metadata,
        requested_video_fps=args.requested_video_fps,
        requested_imu_rate_hz=args.requested_imu_rate_hz,
        calibration_status=args.calibration_status,
        calibration_reason=args.calibration_reason,
        calibration_metadata_path=args.calibration_metadata,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )
    print(f"[保存] Quality Manifest: {args.output}")


if __name__ == "__main__":
    main()
