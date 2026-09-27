import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from sync_session import (
    build_parser,
    default_tolerance_ms,
    estimate_start_end_transform,
    estimate_three_shake_offset,
    fit_sync_transform,
    infer_session_id,
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


def make_long_hand_and_imu(
    scale: float = 0.9995,
    intercept_ms: float = -420.0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    video_times = np.arange(0, 30_100, 100, dtype=float)
    wrist_x = np.full_like(video_times, 0.5)
    peak_times = [1200.0, 1900.0, 2700.0, 27_200.0, 28_000.0, 28_700.0]
    for peak_ms in peak_times:
        wrist_x += 0.22 * np.exp(-((video_times - peak_ms) / 80.0) ** 2)

    hand_rows = []
    for frame_index, (timestamp_ms, x) in enumerate(zip(video_times, wrist_x, strict=True)):
        hand_rows.extend([
            {
                "timestamp_ms": timestamp_ms,
                "frame_index": frame_index,
                "handedness": "Left",
                "score": "",
                "detected": "false",
                "raw_handedness": "",
                "wrist_x": "",
                "wrist_y": "",
            },
            {
                "timestamp_ms": timestamp_ms,
                "frame_index": frame_index,
                "handedness": "Right",
                "score": 0.95,
                "detected": "true",
                "raw_handedness": "Right",
                "wrist_x": x,
                "wrist_y": 0.5,
            },
        ])

    imu_times = np.arange(0, 31_000, 20, dtype=float)
    accel = np.full_like(imu_times, 0.03)
    for video_peak_ms in peak_times:
        imu_peak_ms = (video_peak_ms - intercept_ms) / scale
        accel += 4.0 * np.exp(-((imu_times - imu_peak_ms) / 45.0) ** 2)
    imu = pd.DataFrame({
        "session_id": "capture_long",
        "wrist_side": "right",
        "timestamp_ms": 1_779_000_000_000 + imu_times,
        "elapsed_ms": imu_times,
        "core_motion_elapsed_ms": imu_times,
        "accel_norm": accel,
        "gyro_norm": accel * 0.2,
    })
    return pd.DataFrame(hand_rows), imu


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


def test_start_end_sync_uses_hand_and_core_motion_timebase() -> None:
    hand, imu = make_long_hand_and_imu(scale=0.9995, intercept_ms=-420.0)

    estimate = estimate_start_end_transform(
        hand,
        imu,
        watch_side="right",
        search_window_ms=5_000.0,
        end_search_window_ms=5_000.0,
    )

    assert estimate.method == "start_end_three_shake_affine"
    assert estimate.video_signal == "right_hand_wrist_speed"
    assert estimate.imu_signal == "accel_norm"
    assert estimate.scale == pytest.approx(0.9995, abs=0.002)
    assert estimate.intercept_ms == pytest.approx(-420.0, abs=100.0)
    assert len(estimate.video_peaks_ms) == 6
    assert len(estimate.end_video_peaks_ms or []) == 3
    assert estimate.residual_max_ms < 150.0


def test_fit_sync_transform_rejects_non_monotonic_points_and_abnormal_drift() -> None:
    with pytest.raises(ValueError, match="strictly increasing"):
        fit_sync_transform(
            [0.0, 100.0, 90.0],
            [20.0, 120.0, 220.0],
            method="manual_points",
            watch_side="right",
            video_signal="manual",
            imu_signal="manual",
        )

    with pytest.raises(ValueError, match="outside the allowed range"):
        fit_sync_transform(
            [0.0, 100.0, 200.0],
            [0.0, 50.0, 100.0],
            method="manual_points",
            watch_side="right",
            video_signal="manual",
            imu_signal="manual",
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


def test_prepare_imu_frame_uses_core_motion_as_authoritative_sort_key() -> None:
    imu = pd.DataFrame({
        "elapsed_ms": [40, 0, 20],
        "core_motion_elapsed_ms": [0, 20, 40],
        "gyro_norm": [0.1, 0.2, 0.3],
    })

    prepared = prepare_imu_frame(imu)

    assert prepared["core_motion_elapsed_ms"].tolist() == [0, 20, 40]
    assert prepared["elapsed_ms"].tolist() == [40, 0, 20]


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


def test_hand_timeline_is_deduplicated_and_uses_frame_interval_tolerance() -> None:
    hand = pd.DataFrame({
        "timestamp_ms": [0, 0, 33, 33, 67, 67],
        "frame_index": [0, 0, 1, 1, 2, 2],
        "handedness": ["Left", "Right"] * 3,
    })
    imu = pd.DataFrame({
        "elapsed_ms": [0, 33, 67],
        "gyro_norm": [0.1, 0.2, 0.3],
    })

    synced, stats = join_pose_with_imu(hand, imu, offset_ms=0.0, tolerance_ms=34.0)

    assert synced["timestamp_ms"].tolist() == [0.0, 33.0, 67.0]
    assert stats["unmatched_pose_rows"] == 0
    assert default_tolerance_ms(hand) == 33.5
    assert infer_session_id(Path("capture_test_hand_landmarks.csv")) == "capture_test"


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
    assert metadata["scale"] == 1.0
    assert metadata["intercept_ms"] == -420.0
    assert metadata["manual_correction"] is True


def test_sync_session_manual_start_end_points_fit_affine_transform(tmp_path) -> None:
    hand, imu = make_long_hand_and_imu()
    hand_path = tmp_path / "capture_test_hand_landmarks.csv"
    imu_path = tmp_path / "capture_test_right_wrist_imu.csv"
    output_dir = tmp_path / "sync"
    hand.loc[hand["handedness"] == "Right", "wrist_x"] = 0.5
    imu["session_id"] = "capture_test"
    imu["accel_norm"] = 0.03
    hand.to_csv(hand_path, index=False)
    imu.to_csv(imu_path, index=False)
    imu_times = [
        (video_time + 420.0) / 0.9995
        for video_time in [1200.0, 1900.0, 2700.0, 27_200.0, 28_000.0, 28_700.0]
    ]

    result = sync_session(
        pose_csv_path=hand_path,
        imu_csv_path=imu_path,
        output_dir=output_dir,
        watch_side="right",
        manual_video_times_ms=[1200.0, 1900.0, 2700.0, 27_200.0, 28_000.0, 28_700.0],
        manual_imu_times_ms=imu_times,
    )

    metadata = json.loads(result["metadata_path"].read_text(encoding="utf-8"))
    assert result["metadata_path"].name == "capture_test_sync_metadata.json"
    assert metadata["method"] == "manual_start_end_affine"
    assert metadata["manual_correction"] is True
    assert metadata["auto_sync_failure_reason"]
    assert metadata["scale"] == pytest.approx(0.9995)
    assert metadata["intercept_ms"] == pytest.approx(-420.0)
    synced = pd.read_csv(result["synced_csv_path"])
    assert len(synced) == hand["frame_index"].nunique()


def test_manual_points_are_rejected_when_automatic_affine_sync_succeeds(tmp_path) -> None:
    hand, imu = make_long_hand_and_imu()
    hand_path = tmp_path / "capture_long_hand_landmarks.csv"
    imu_path = tmp_path / "capture_long_right_wrist_imu.csv"
    hand.to_csv(hand_path, index=False)
    imu.to_csv(imu_path, index=False)

    with pytest.raises(ValueError, match="automatic affine synchronization succeeded"):
        sync_session(
            pose_csv_path=hand_path,
            imu_csv_path=imu_path,
            output_dir=tmp_path / "sync",
            watch_side="right",
            manual_video_times_ms=[1200.0, 1900.0, 2700.0, 27_200.0, 28_000.0, 28_700.0],
            manual_imu_times_ms=[1620.0, 2320.0, 3120.0, 27_620.0, 28_420.0, 29_120.0],
        )


def test_affine_sync_validates_session_and_wrist_side(tmp_path) -> None:
    hand, imu = make_long_hand_and_imu()
    hand_path = tmp_path / "capture_long_hand_landmarks.csv"
    imu_path = tmp_path / "capture_long_right_wrist_imu.csv"
    hand.to_csv(hand_path, index=False)
    imu["wrist_side"] = "left"
    imu.to_csv(imu_path, index=False)

    with pytest.raises(ValueError, match="wrist_side must be right"):
        sync_session(
            pose_csv_path=hand_path,
            imu_csv_path=imu_path,
            output_dir=tmp_path / "sync",
            watch_side="right",
            sync_method="affine",
        )


@pytest.mark.parametrize(
    ("corruption", "expected_message"),
    [
        ("swapped", "re-extract"),
        ("missing_raw_column", "raw_handedness"),
        ("invalid_detected", "only true or false"),
        ("invalid_wrist", "finite timestamp"),
    ],
)
def test_sync_session_rejects_legacy_hand_labels_before_writing_outputs(
    tmp_path,
    corruption: str,
    expected_message: str,
) -> None:
    hand, imu = make_long_hand_and_imu()
    hand_path = tmp_path / "capture_long_hand_landmarks.csv"
    imu_path = tmp_path / "capture_long_right_wrist_imu.csv"
    if corruption == "swapped":
        hand.loc[hand["detected"] == "true", "raw_handedness"] = "Left"
    elif corruption == "missing_raw_column":
        hand = hand.drop(columns=["raw_handedness"])
    elif corruption == "invalid_detected":
        hand.loc[hand["detected"] == "true", "detected"] = "1"
    else:
        hand.loc[hand["detected"] == "true", "wrist_x"] = "invalid"
    hand.to_csv(hand_path, index=False)
    imu.to_csv(imu_path, index=False)
    output_dir = tmp_path / "sync"

    with pytest.raises(ValueError, match=expected_message):
        sync_session(
            pose_csv_path=hand_path,
            imu_csv_path=imu_path,
            output_dir=output_dir,
            watch_side="right",
            sync_method="legacy-offset",
            manual_offset_ms=420.0,
        )

    assert not output_dir.exists()


def test_cli_defaults_to_research_affine_sync() -> None:
    args = build_parser().parse_args([
        "--pose-csv", "hand.csv",
        "--imu-csv", "imu.csv",
        "--output-dir", "sync",
    ])

    assert args.sync_method == "affine"
