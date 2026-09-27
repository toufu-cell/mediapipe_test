import json
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

import capture_quality_manifest
from capture_quality_manifest import build_manifest, inspect_video


HAND_LANDMARK_NAMES = (
    "wrist",
    "thumbCmc", "thumbMcp", "thumbIp", "thumbTip",
    "indexFingerMcp", "indexFingerPip", "indexFingerDip", "indexFingerTip",
    "middleFingerMcp", "middleFingerPip", "middleFingerDip", "middleFingerTip",
    "ringFingerMcp", "ringFingerPip", "ringFingerDip", "ringFingerTip",
    "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
)


def make_hand_csv(path: Path) -> None:
    rows = []
    for frame_index, timestamp_ms in enumerate((0, 33, 67)):
        for hand_index, side in enumerate(("Left", "Right")):
            detected = side == "Right" or frame_index != 1
            row = {
                "timestamp_ms": timestamp_ms,
                "frame_index": frame_index,
                "hand_index": hand_index if detected else "",
                "handedness": side,
                "score": 0.95 if detected else "",
                "detected": "true" if detected else "false",
                "missing_reason": "" if detected else "not_detected",
                "raw_handedness": side if detected else "",
                "timestamp_source": "container_pts",
            }
            for landmark_index, name in enumerate(HAND_LANDMARK_NAMES):
                row[f"{name}_x"] = 0.2 + landmark_index * 0.01 if detected else ""
                row[f"{name}_y"] = 0.3 + landmark_index * 0.01 if detected else ""
                row[f"{name}_z"] = 0.0 if detected else ""
            rows.append(row)
    pd.DataFrame(rows).to_csv(path, index=False)


def make_imu_csv(path: Path, wrist_side: str = "right") -> None:
    rows = []
    for index, elapsed_ms in enumerate((0, 20, 40, 60)):
        rows.append({
            "session_id": "capture_test",
            "wrist_side": wrist_side,
            "timestamp_ms": 1_779_000_000_000 + elapsed_ms,
            "elapsed_ms": elapsed_ms,
            "accel_x": 0.1,
            "accel_y": 0.2,
            "accel_z": 0.3,
            "gyro_x": 0.01,
            "gyro_y": 0.02,
            "gyro_z": 0.03,
            "core_motion_timestamp_s": 1000.0 + elapsed_ms / 1000.0,
            "core_motion_elapsed_ms": elapsed_ms,
            "gravity_x": 0.0,
            "gravity_y": 0.0,
            "gravity_z": -1.0,
            "quaternion_x": 0.0,
            "quaternion_y": 0.0,
            "quaternion_z": 0.0,
            "quaternion_w": 1.0,
        })
    pd.DataFrame(rows).to_csv(path, index=False)


def make_calibration_json(path: Path) -> None:
    path.write_text(json.dumps({
        "status": "valid",
        "baselineQuaternion": [0.0, 0.0, 0.0, 1.0],
        "watchToWristQuaternion": [0.0, 0.0, 0.0, 1.0],
        "cameraToScreenRotationDeg": 0.0,
        "mirrored": False,
        "calibrationErrorDeg": 1.2,
        "referenceFrame": "xArbitraryZVertical",
        "quaternionConvention": "x,y,z,w",
    }), encoding="utf-8")


def make_sync_json(path: Path, **overrides: object) -> None:
    payload = {
        "status": "valid",
        "session_id": "capture_test",
        "watch_side": "right",
        "method": "start_end_three_shake_affine",
        "imu_timebase_column": "core_motion_elapsed_ms",
        "offset_ms": 420.0,
        "scale": 0.9998,
        "intercept_ms": -419.9,
        "drift_ppm": -200.0,
        "residual_rms_ms": 12.0,
        "residual_max_ms": 25.0,
        "confidence": 0.9,
        "video_peaks_ms": [1000, 1700, 2500, 27_000, 27_800, 28_500],
        "imu_peaks_ms": [1420, 2120, 2920, 27_420, 28_220, 28_920],
        "end_video_peaks_ms": [27_000, 27_800, 28_500],
        "end_imu_peaks_ms": [27_420, 28_220, 28_920],
        "manual_correction": False,
    }
    payload.update(overrides)
    path.write_text(json.dumps(payload), encoding="utf-8")


def video_info(frame_count: int = 3, *, audio_track_count: int = 0) -> dict[str, object]:
    return {
        "width": 1920,
        "height": 1080,
        "fps": 30.0,
        "frameCount": frame_count,
        "durationMs": 67.0,
        "audioTrackCount": audio_track_count,
        "frameIntervalMedianMs": 33.333,
        "frameIntervalMaxMs": 33.334,
        "frameGapCount": 0,
        "estimatedDroppedFrames": 0,
        "ptsMonotonic": True,
    }


def test_inspect_video_detects_pts_gaps(monkeypatch, tmp_path: Path) -> None:
    responses = iter([
        {
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "30/1",
                },
            ],
            "format": {"duration": "0.167"},
        },
        {
            "frames": [
                {"best_effort_timestamp_time": value}
                for value in ("0.000", "0.033", "0.067", "0.133", "0.167")
            ],
        },
    ])
    monkeypatch.setattr(capture_quality_manifest.shutil, "which", lambda _name: "/usr/bin/ffprobe")
    monkeypatch.setattr(
        capture_quality_manifest.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=json.dumps(next(responses))),
    )

    inspected = inspect_video(tmp_path / "capture.mov")

    assert inspected["frameCount"] == 5
    assert inspected["frameGapCount"] == 1
    assert inspected["estimatedDroppedFrames"] == 1
    assert inspected["ptsMonotonic"] is True


def test_build_manifest_reports_quality_without_nan(tmp_path: Path) -> None:
    video_path = tmp_path / "capture_test.mov"
    video_path.write_bytes(b"fixture")
    hand_path = tmp_path / "capture_test_hand_landmarks.csv"
    imu_path = tmp_path / "capture_test_right_wrist_imu.csv"
    sync_path = tmp_path / "capture_test_sync_metadata.json"
    calibration_path = tmp_path / "capture_test_calibration.json"
    make_hand_csv(hand_path)
    make_imu_csv(imu_path)
    make_calibration_json(calibration_path)
    make_sync_json(sync_path)

    manifest = build_manifest(
        session_id="capture_test",
        participant_id="participant_001",
        trial_id="trial_1",
        condition="multimodal",
        video_path=video_path,
        hand_csv_path=hand_path,
        imu_csv_path=imu_path,
        sync_metadata_path=sync_path,
        calibration_status="valid",
        calibration_metadata_path=calibration_path,
        video_info=video_info(),
    )

    assert manifest["schemaVersion"] == "cooking-capture-quality-v1"
    assert manifest["status"] == "valid"
    assert manifest["hand"]["sides"]["left"]["detectionRate"] == 2 / 3
    assert manifest["hand"]["sides"]["left"]["missingIntervals"][0]["startFrame"] == 1
    assert manifest["imu"]["actualSampleRateHz"] == 50.0
    assert manifest["sync"]["driftPpm"] == -200.0
    assert manifest["video"]["actual"]["estimatedDroppedFrames"] == 0
    assert manifest["calibration"]["baselineQuaternion"] == [0.0, 0.0, 0.0, 1.0]
    json.dumps(manifest, allow_nan=False)


def test_build_manifest_marks_wrong_wrist_and_audio_invalid(tmp_path: Path) -> None:
    video_path = tmp_path / "capture_test.mov"
    video_path.write_bytes(b"fixture")
    hand_path = tmp_path / "capture_test_hand_landmarks.csv"
    imu_path = tmp_path / "capture_test_left_wrist_imu.csv"
    make_hand_csv(hand_path)
    make_imu_csv(imu_path, wrist_side="left")

    manifest = build_manifest(
        session_id="capture_test",
        participant_id="participant_001",
        trial_id="trial_1",
        condition="video-only",
        video_path=video_path,
        hand_csv_path=hand_path,
        imu_csv_path=imu_path,
        video_info=video_info(audio_track_count=1),
    )

    assert manifest["status"] == "invalid"
    codes = {entry["code"] for entry in manifest["issues"]}
    assert "video_audio_track" in codes
    assert "imu_wrist_side" in codes


def test_build_manifest_handles_legacy_hand_timestamp_source_and_frame_mismatch(tmp_path: Path) -> None:
    video_path = tmp_path / "capture_test.mov"
    video_path.write_bytes(b"fixture")
    hand_path = tmp_path / "capture_test_hand_landmarks.csv"
    imu_path = tmp_path / "capture_test_right_wrist_imu.csv"
    make_hand_csv(hand_path)
    frame = pd.read_csv(hand_path)
    frame.drop(columns=["timestamp_source"]).to_csv(hand_path, index=False)
    make_imu_csv(imu_path)

    manifest = build_manifest(
        session_id="capture_test",
        participant_id="participant_001",
        trial_id="trial_1",
        condition="multimodal",
        video_path=video_path,
        hand_csv_path=hand_path,
        imu_csv_path=imu_path,
        video_info=video_info(frame_count=4),
    )

    assert manifest["status"] == "invalid"
    assert manifest["hand"]["timestampSources"] == ["unknown"]
    assert manifest["hand"]["fallbackRowCount"] == 0
    assert "video_hand_frame_count" in {entry["code"] for entry in manifest["issues"]}


def test_build_manifest_rejects_empty_or_cross_session_sync_metadata(tmp_path: Path) -> None:
    video_path = tmp_path / "capture_test.mov"
    video_path.write_bytes(b"fixture")
    hand_path = tmp_path / "capture_test_hand_landmarks.csv"
    imu_path = tmp_path / "capture_test_right_wrist_imu.csv"
    sync_path = tmp_path / "capture_test_sync_metadata.json"
    make_hand_csv(hand_path)
    make_imu_csv(imu_path)

    for payload in ({}, {"status": "valid", "session_id": "another_capture"}):
        sync_path.write_text(json.dumps(payload), encoding="utf-8")
        manifest = build_manifest(
            session_id="capture_test",
            participant_id="participant_001",
            trial_id="trial_1",
            condition="multimodal",
            video_path=video_path,
            hand_csv_path=hand_path,
            imu_csv_path=imu_path,
            sync_metadata_path=sync_path,
            video_info=video_info(),
        )

        assert manifest["status"] == "invalid"
        assert manifest["sync"]["status"] == "invalid"
        assert "sync_metadata_invalid" in {entry["code"] for entry in manifest["issues"]}


def test_build_manifest_rejects_incomplete_valid_calibration(tmp_path: Path) -> None:
    video_path = tmp_path / "capture_test.mov"
    video_path.write_bytes(b"fixture")
    hand_path = tmp_path / "capture_test_hand_landmarks.csv"
    imu_path = tmp_path / "capture_test_right_wrist_imu.csv"
    calibration_path = tmp_path / "capture_test_calibration.json"
    make_hand_csv(hand_path)
    make_imu_csv(imu_path)
    calibration_path.write_text(json.dumps({
        "status": "valid",
        "baselineQuaternion": [0.0, 0.0, 0.0, 1.0],
        "watchToWristQuaternion": [0.0, 0.0, 0.0, 1.0],
        "cameraToScreenRotationDeg": 0.0,
        "mirrored": False,
        "calibrationErrorDeg": 1.2,
    }), encoding="utf-8")

    manifest = build_manifest(
        session_id="capture_test",
        participant_id="participant_001",
        trial_id="trial_1",
        condition="multimodal",
        video_path=video_path,
        hand_csv_path=hand_path,
        imu_csv_path=imu_path,
        calibration_status="valid",
        calibration_metadata_path=calibration_path,
        video_info=video_info(),
    )

    assert manifest["status"] == "invalid"
    assert manifest["calibration"]["status"] == "invalid"
    assert "calibration_metadata_missing" in {entry["code"] for entry in manifest["issues"]}
