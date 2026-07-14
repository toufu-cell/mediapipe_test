import json

import numpy as np
import pandas as pd
import pytest

from sync_session import (
    estimate_three_shake_offset,
    join_pose_with_imu,
    prepare_imu_frame,
    sync_session,
)


def make_pose_frame(offset_ms: float = 0.0) -> pd.DataFrame:
    timestamps = np.arange(0, 6000, 100, dtype=float)
    x = np.full_like(timestamps, 0.5)
    y = np.full_like(timestamps, 0.5)
    for peak_ms in [1200.0, 1900.0, 2700.0]:
        x += 0.22 * np.exp(-((timestamps - peak_ms) / 80.0) ** 2)

    return pd.DataFrame({
        "timestamp_ms": timestamps,
        "frame_index": np.arange(len(timestamps)),
        "leftWrist_x": x,
        "leftWrist_y": y,
        "leftWrist_visibility": 0.95,
        "rightWrist_x": 0.1,
        "rightWrist_y": 0.1,
        "rightWrist_visibility": 0.95,
    })


def make_imu_frame(offset_ms: float = 420.0) -> pd.DataFrame:
    elapsed = np.arange(0, 6500, 20, dtype=float)
    gyro = np.full_like(elapsed, 0.03)
    for peak_ms in [1200.0 + offset_ms, 1900.0 + offset_ms, 2700.0 + offset_ms]:
        gyro += 4.0 * np.exp(-((elapsed - peak_ms) / 45.0) ** 2)

    return pd.DataFrame({
        "session_id": "capture_test",
        "timestamp_ms": 1_779_000_000_000 + elapsed,
        "elapsed_ms": elapsed,
        "gyro_norm": gyro,
        "accel_norm": gyro * 0.2,
    })


def test_estimate_three_shake_offset_uses_left_wrist_and_gyro_norm() -> None:
    pose = make_pose_frame()
    imu = make_imu_frame(offset_ms=420.0)

    estimate = estimate_three_shake_offset(pose, imu, watch_side="left")

    assert estimate.watch_side == "left"
    assert estimate.offset_ms == pytest.approx(420.0, abs=80.0)
    assert len(estimate.video_peaks_ms) == 3
    assert len(estimate.imu_peaks_ms) == 3
    assert estimate.offset_std_ms < 80.0


def test_estimate_three_shake_offset_rejects_unstable_peak_pairing() -> None:
    pose = make_pose_frame()
    imu = make_imu_frame(offset_ms=420.0)
    imu.loc[imu["elapsed_ms"].between(4300, 4350), "gyro_norm"] = 9.0

    with pytest.raises(ValueError, match="stable three-shake"):
        estimate_three_shake_offset(
            pose,
            imu,
            watch_side="left",
            max_interval_delta_ms=80.0,
            max_offset_std_ms=30.0,
            max_candidate_peaks=3,
        )


def test_prepare_imu_frame_derives_gyro_norm_from_axes() -> None:
    imu = pd.DataFrame({
        "elapsed_ms": [0, 20],
        "gyro_x": [3.0, 0.0],
        "gyro_y": [4.0, 0.0],
        "gyro_z": [0.0, 12.0],
    })

    prepared = prepare_imu_frame(imu)

    assert prepared["gyro_norm"].tolist() == [5.0, 12.0]


def test_prepare_imu_frame_aggregates_duplicate_elapsed_samples() -> None:
    imu = pd.DataFrame({
        "session_id": ["capture_test", "capture_test", "capture_test", "capture_test"],
        "timestamp_ms": [1000, 1021, 1020, 1040],
        "elapsed_ms": [0, 20, 20, 40],
        "accel_x": [0.0, 1.0, 3.0, 4.0],
        "gyro_norm": [0.2, 10.0, 14.0, 0.4],
    })

    prepared = prepare_imu_frame(imu)

    assert prepared["elapsed_ms"].tolist() == [0, 20, 40]
    assert prepared["timestamp_ms"].tolist() == [1000, 1021, 1040]
    assert prepared["session_id"].tolist() == ["capture_test", "capture_test", "capture_test"]
    assert prepared["accel_x"].tolist() == [0.0, 2.0, 4.0]
    assert prepared["gyro_norm"].tolist() == [0.2, 12.0, 0.4]


def test_prepare_imu_frame_derives_gyro_norm_after_duplicate_axis_aggregation() -> None:
    imu = pd.DataFrame({
        "elapsed_ms": [0, 20, 20, 40],
        "gyro_x": [0.0, 3.0, 0.0, 0.0],
        "gyro_y": [0.0, 4.0, 0.0, 0.0],
        "gyro_z": [0.0, 0.0, 12.0, 8.0],
    })

    prepared = prepare_imu_frame(imu)

    assert prepared["elapsed_ms"].tolist() == [0, 20, 40]
    assert prepared["gyro_x"].tolist() == [0.0, 1.5, 0.0]
    assert prepared["gyro_y"].tolist() == [0.0, 2.0, 0.0]
    assert prepared["gyro_z"].tolist() == [0.0, 6.0, 8.0]
    assert prepared["gyro_norm"].tolist() == [0.0, 6.5, 8.0]


def test_prepare_imu_frame_requires_elapsed_and_gyro_signal() -> None:
    with pytest.raises(ValueError, match="elapsed_ms"):
        prepare_imu_frame(pd.DataFrame({"gyro_norm": [1.0]}))

    with pytest.raises(ValueError, match="gyro_norm"):
        prepare_imu_frame(pd.DataFrame({"elapsed_ms": [0.0]}))


def test_join_pose_with_imu_accepts_int_pose_timestamps_and_float_offset() -> None:
    pose = pd.DataFrame({
        "timestamp_ms": [0, 100, 200],
        "frame_index": [0, 1, 2],
    })
    imu = pd.DataFrame({
        "elapsed_ms": [20, 120, 220],
        "gyro_norm": [0.1, 0.2, 0.3],
    })

    synced, stats = join_pose_with_imu(
        pose,
        imu,
        offset_ms=20.5,
        tolerance_ms=25.0,
    )

    assert stats["unmatched_pose_rows"] == 0
    assert synced["imu_gyro_norm"].tolist() == [0.1, 0.2, 0.3]


def test_sync_session_writes_metadata_joined_csv_and_diagnostic(tmp_path) -> None:
    pose_path = tmp_path / "capture_test_33landmarks.csv"
    imu_path = tmp_path / "capture_test_wrist_imu.csv"
    output_dir = tmp_path / "sync"
    make_pose_frame().to_csv(pose_path, index=False)
    make_imu_frame(offset_ms=420.0).to_csv(imu_path, index=False)

    result = sync_session(
        pose_csv_path=pose_path,
        imu_csv_path=imu_path,
        output_dir=output_dir,
        watch_side="left",
        tolerance_ms=60.0,
    )

    assert result["metadata_path"] == output_dir / "capture_test_sync_metadata.json"
    assert result["synced_csv_path"] == output_dir / "capture_test_synced_pose_imu.csv"
    assert result["diagnostic_path"] == output_dir / "capture_test_sync_diagnostic.png"
    assert result["metadata_path"].exists()
    assert result["synced_csv_path"].exists()
    assert result["diagnostic_path"].exists()

    metadata = json.loads(result["metadata_path"].read_text(encoding="utf-8"))
    assert metadata["method"] == "three_shake_peak"
    assert metadata["watch_side"] == "left"
    assert metadata["offset_ms"] == pytest.approx(420.0, abs=80.0)
    assert metadata["tolerance_ms"] == 60.0
    assert metadata["unmatched_pose_rows"] < len(make_pose_frame())

    synced = pd.read_csv(result["synced_csv_path"])
    assert "aligned_imu_time_ms" in synced.columns
    assert "imu_gyro_norm" in synced.columns
    assert synced["timestamp_ms"].tolist() == make_pose_frame()["timestamp_ms"].tolist()


def test_sync_session_manual_offset_bypasses_peak_detection(tmp_path) -> None:
    pose_path = tmp_path / "capture_test_33landmarks.csv"
    imu_path = tmp_path / "capture_test_wrist_imu.csv"
    output_dir = tmp_path / "sync"
    make_pose_frame().to_csv(pose_path, index=False)
    pd.DataFrame({
        "elapsed_ms": [0.0, 20.0, 40.0],
        "gyro_norm": [0.1, 0.1, 0.1],
    }).to_csv(imu_path, index=False)

    result = sync_session(
        pose_csv_path=pose_path,
        imu_csv_path=imu_path,
        output_dir=output_dir,
        watch_side="left",
        manual_offset_ms=420.0,
    )

    metadata = json.loads(result["metadata_path"].read_text(encoding="utf-8"))
    assert metadata["method"] == "manual_offset"
    assert metadata["offset_ms"] == 420.0
