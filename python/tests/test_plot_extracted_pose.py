import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from plot_extracted_pose import (
    compute_hand_keypoint_speed,
    compute_hand_tip_center,
    compute_hand_tip_center_speed,
    compute_tracking_status,
    compute_wrist_speed,
    find_pose_csv_pair,
    plot_extracted_pose,
    plot_hand_fingertip_speed,
    plot_hand_fingertip_xy,
    plot_hand_raw_landmark_xy,
    plot_pose_status_timeline,
)


class FakeAxes:
    def __init__(self) -> None:
        self.lines = []
        self.title = None
        self.yticklabels = []

    def plot(self, *args, **kwargs) -> None:
        self.lines.append((args, kwargs))

    def set_ylabel(self, *args, **kwargs) -> None:
        return None

    def set_xlabel(self, *args, **kwargs) -> None:
        return None

    def set_title(self, title, *args, **kwargs) -> None:
        self.title = title

    def set_yticks(self, *args, **kwargs) -> None:
        return None

    def set_yticklabels(self, labels, *args, **kwargs) -> None:
        self.yticklabels = list(labels)

    def legend(self, *args, **kwargs) -> None:
        return None

    def grid(self, *args, **kwargs) -> None:
        return None


class FakeFigure:
    def __init__(self, saved_paths: list[Path], savefig_kwargs: list[dict] | None = None) -> None:
        self.saved_paths = saved_paths
        self.savefig_kwargs = savefig_kwargs

    def tight_layout(self) -> None:
        return None

    def savefig(self, path, *args, **kwargs) -> None:
        self.saved_paths.append(Path(path))
        if self.savefig_kwargs is not None:
            self.savefig_kwargs.append(kwargs)


def install_plot_stubs(
    monkeypatch,
    saved_paths: list[Path],
    created_axes: list[FakeAxes] | None = None,
    subplots_calls: list[dict] | None = None,
    savefig_kwargs: list[dict] | None = None,
) -> None:
    fake_pyplot = types.SimpleNamespace()

    def fake_subplots(*args, **kwargs):
        if subplots_calls is not None:
            subplots_calls.append({"args": args, "kwargs": kwargs})
        nrows = kwargs.get("nrows", args[0] if len(args) >= 1 else 1)
        ncols = kwargs.get("ncols", args[1] if len(args) >= 2 else 1)
        axes = [FakeAxes() for _ in range(nrows * ncols)]
        if created_axes is not None:
            created_axes.extend(axes)
        if len(axes) == 1:
            axes_result = axes[0]
        else:
            axes_result = np.array(axes, dtype=object).reshape(nrows, ncols).squeeze()
        return FakeFigure(saved_paths, savefig_kwargs), axes_result

    fake_pyplot.subplots = fake_subplots
    fake_pyplot.close = lambda fig: None

    fake_matplotlib = types.ModuleType("matplotlib")
    fake_matplotlib.pyplot = fake_pyplot
    monkeypatch.setitem(sys.modules, "matplotlib", fake_matplotlib)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", fake_pyplot)
    monkeypatch.setitem(sys.modules, "japanize_matplotlib", types.SimpleNamespace())


def write_sample_extract_csvs(output_dir: Path, stem: str = "sample") -> None:
    metadata = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300],
        "frame_index": [0, 1, 2, 3],
        "has_landmarks": ["true", "true", "false", "true"],
        "pose_status": ["valid", "valid", "invalid", "valid"],
        "interpolated": ["false", "false", "false", "false"],
        "interpolation_source_frame_index": ["", "", "", ""],
        "invalid_reason": ["", "", "insufficient_visible_upper_body_landmarks", ""],
        "arm_selection": ["auto-visible", "auto-visible", "auto-visible", "auto-visible"],
        "selected_arm": ["both", "both", "both", "both"],
        "left_arm_score": ["", "", "", ""],
        "right_arm_score": ["", "", "", ""],
    })
    landmarks = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300],
        "frame_index": [0, 1, 2, 3],
        "leftShoulder_visibility": [0.9, 0.8, np.nan, 0.7],
        "rightShoulder_visibility": [0.9, 0.8, np.nan, 0.7],
        "leftElbow_visibility": [0.9, 0.8, np.nan, 0.7],
        "rightElbow_visibility": [0.9, 0.8, np.nan, 0.7],
        "leftWrist_x": [0.1, 0.2, np.nan, 0.4],
        "leftWrist_y": [0.1, 0.1, np.nan, 0.1],
        "leftWrist_visibility": [0.9, 0.8, np.nan, 0.7],
        "rightWrist_x": [0.5, 0.5, np.nan, 0.5],
        "rightWrist_y": [0.2, 0.3, np.nan, 0.4],
        "rightWrist_visibility": [0.9, 0.8, np.nan, 0.7],
    })
    metadata.to_csv(output_dir / f"{stem}_frame_metadata.csv", index=False)
    landmarks.to_csv(output_dir / f"{stem}_33landmarks.csv", index=False)


def write_sample_hand_csv(output_dir: Path, stem: str = "sample") -> None:
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 0, 100],
        "frame_index": [0, 1, 0, 1],
        "hand_index": [0, 0, 1, 1],
        "handedness": ["Left", "Left", "Left", "Left"],
        "score": [0.9, 0.9, 0.8, 0.8],
        "indexFingerTip_x": [0.1, 0.2, 0.5, 0.5],
        "indexFingerTip_y": [0.1, 0.1, 0.5, 0.6],
        "middleFingerTip_x": [0.2, 0.2, 0.6, 0.7],
        "middleFingerTip_y": [0.2, 0.4, 0.6, 0.6],
    })
    hands.to_csv(output_dir / f"{stem}_hand_landmarks.csv", index=False)


def test_plot_extracted_pose_writes_four_plots(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    savefig_kwargs: list[dict] = []
    install_plot_stubs(monkeypatch, saved_paths, savefig_kwargs=savefig_kwargs)
    write_sample_extract_csvs(tmp_path)

    result = plot_extracted_pose(tmp_path)

    assert result == {
        "pose_status_timeline": tmp_path / "plots" / "pose_status_timeline.png",
        "landmark_visibility": tmp_path / "plots" / "landmark_visibility.png",
        "wrist_xy": tmp_path / "plots" / "wrist_xy.png",
        "wrist_speed": tmp_path / "plots" / "wrist_speed.png",
    }
    assert saved_paths == list(result.values())
    assert all(kwargs["dpi"] == 300 for kwargs in savefig_kwargs)
    assert all(kwargs["bbox_inches"] == "tight" for kwargs in savefig_kwargs)


def test_plot_extracted_pose_writes_hand_plots_when_hand_csv_exists(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    created_axes: list[FakeAxes] = []
    install_plot_stubs(monkeypatch, saved_paths, created_axes)
    write_sample_extract_csvs(tmp_path)
    write_sample_hand_csv(tmp_path)

    result = plot_extracted_pose(tmp_path)

    assert result == {
        "pose_status_timeline": tmp_path / "plots" / "pose_status_timeline.png",
        "landmark_visibility": tmp_path / "plots" / "landmark_visibility.png",
        "wrist_xy": tmp_path / "plots" / "wrist_xy.png",
        "wrist_speed": tmp_path / "plots" / "wrist_speed.png",
        "hand_fingertip_xy": tmp_path / "plots" / "hand_fingertip_xy.png",
        "hand_fingertip_speed": tmp_path / "plots" / "hand_fingertip_speed.png",
        "hand_raw_landmark_xy": tmp_path / "plots" / "hand_raw_landmark_xy.png",
    }
    assert saved_paths == list(result.values())
    assert len(created_axes[4].lines) == 4
    assert len(created_axes[5].lines) == 2


def test_plot_pose_status_timeline_orders_pose_status_by_confidence(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    created_axes: list[FakeAxes] = []
    install_plot_stubs(monkeypatch, saved_paths, created_axes)
    metadata = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300],
        "frame_index": [0, 1, 2, 3],
        "pose_status": ["valid", "interpolated", "invalid", "missing"],
    })

    plot_pose_status_timeline(metadata, tmp_path / "pose_status.png")

    assert created_axes[0].yticklabels == ["missing", "invalid", "interpolated", "valid"]
    assert created_axes[0].lines[0][1]["linewidth"] == 2.0


def test_plot_pose_status_timeline_orders_tracking_status_by_confidence(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    created_axes: list[FakeAxes] = []
    install_plot_stubs(monkeypatch, saved_paths, created_axes)
    metadata = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300, 400, 500],
        "frame_index": [0, 1, 2, 3, 4, 5],
        "pose_status": ["invalid", "valid", "interpolated", "missing", "valid", "invalid"],
    })
    hands = pd.DataFrame({
        "timestamp_ms": [0],
        "frame_index": [0],
        "hand_index": [0],
        "handedness": ["Left"],
        "indexFingerTip_x": [0.1],
        "indexFingerTip_y": [0.1],
        "middleFingerTip_x": [0.2],
        "middleFingerTip_y": [0.2],
    })

    plot_pose_status_timeline(metadata, tmp_path / "tracking_status.png", hands=hands)

    assert created_axes[0].yticklabels == [
        "missing",
        "invalid",
        "pose_interpolated",
        "pose_valid",
        "hand_valid",
    ]


def test_plot_hand_fingertip_xy_splits_handedness_into_vertical_panels(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    created_axes: list[FakeAxes] = []
    subplots_calls: list[dict] = []
    install_plot_stubs(monkeypatch, saved_paths, created_axes, subplots_calls)
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 0, 100, 0],
        "frame_index": [0, 1, 0, 1, 0],
        "hand_index": [0, 0, 1, 1, 2],
        "handedness": ["Left", "Left", "Right", "Right", ""],
        "indexFingerTip_x": [0.1, 0.2, 0.5, 0.6, 0.8],
        "indexFingerTip_y": [0.1, 0.2, 0.5, 0.6, 0.8],
        "middleFingerTip_x": [0.2, 0.3, 0.6, 0.7, 0.9],
        "middleFingerTip_y": [0.2, 0.3, 0.6, 0.7, 0.9],
    })

    plot_hand_fingertip_xy(hands, tmp_path / "hand_xy.png")

    assert subplots_calls[0]["kwargs"]["nrows"] == 3
    assert subplots_calls[0]["kwargs"]["sharex"] is True
    assert [axis.title for axis in created_axes] == ["Left hand fingertip center x/y", "Right hand fingertip center x/y", "Unknown hand fingertip center x/y"]
    assert [line[1]["label"] for line in created_axes[0].lines] == ["Left#0 tipCenter_x", "Left#0 tipCenter_y"]
    assert [line[1]["label"] for line in created_axes[1].lines] == ["Right#1 tipCenter_x", "Right#1 tipCenter_y"]
    assert [line[1]["label"] for line in created_axes[2].lines] == ["hand_index=2 tipCenter_x", "hand_index=2 tipCenter_y"]


def test_plot_hand_fingertip_speed_splits_handedness_into_vertical_panels(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    created_axes: list[FakeAxes] = []
    subplots_calls: list[dict] = []
    install_plot_stubs(monkeypatch, saved_paths, created_axes, subplots_calls)
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 0, 100],
        "frame_index": [0, 1, 0, 1],
        "hand_index": [0, 0, 1, 1],
        "handedness": ["Left", "Left", "Right", "Right"],
        "indexFingerTip_x": [0.0, 0.2, 0.5, 0.5],
        "indexFingerTip_y": [0.0, 0.0, 0.5, 0.7],
        "middleFingerTip_x": [0.0, 0.4, 0.5, 0.5],
        "middleFingerTip_y": [0.0, 0.0, 0.5, 0.9],
    })

    plot_hand_fingertip_speed(hands, tmp_path / "hand_speed.png")

    assert subplots_calls[0]["kwargs"]["nrows"] == 2
    assert subplots_calls[0]["kwargs"]["sharex"] is True
    assert [axis.title for axis in created_axes] == ["Left hand fingertip center speed", "Right hand fingertip center speed"]
    assert [line[1]["label"] for line in created_axes[0].lines] == ["Left#0 tipCenter"]
    assert [line[1]["label"] for line in created_axes[1].lines] == ["Right#1 tipCenter"]


def test_plot_hand_raw_landmark_xy_plots_all_hand_xy_columns_by_handedness(tmp_path, monkeypatch) -> None:
    saved_paths: list[Path] = []
    created_axes: list[FakeAxes] = []
    subplots_calls: list[dict] = []
    install_plot_stubs(monkeypatch, saved_paths, created_axes, subplots_calls)
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 0, 100],
        "frame_index": [0, 1, 0, 1],
        "hand_index": [0, 0, 1, 1],
        "handedness": ["Left", "Left", "Right", "Right"],
        "wrist_x": [0.0, 0.1, 0.5, 0.6],
        "wrist_y": [0.0, 0.1, 0.5, 0.6],
        "indexFingerTip_x": [0.2, 0.3, 0.7, 0.8],
        "indexFingerTip_y": [0.2, 0.3, 0.7, 0.8],
    })

    plot_hand_raw_landmark_xy(hands, tmp_path / "raw_hand_xy.png")

    assert subplots_calls[0]["kwargs"]["nrows"] == 2
    assert subplots_calls[0]["kwargs"]["sharex"] is True
    assert [axis.title for axis in created_axes] == ["Left raw hand landmark x/y", "Right raw hand landmark x/y"]
    assert [line[1]["label"] for line in created_axes[0].lines] == [
        "Left#0 wrist_x",
        "Left#0 wrist_y",
        "Left#0 indexFingerTip_x",
        "Left#0 indexFingerTip_y",
    ]
    assert [line[1]["label"] for line in created_axes[1].lines] == [
        "Right#1 wrist_x",
        "Right#1 wrist_y",
        "Right#1 indexFingerTip_x",
        "Right#1 indexFingerTip_y",
    ]


def test_find_pose_csv_pair_rejects_multiple_pairs(tmp_path) -> None:
    write_sample_extract_csvs(tmp_path, stem="sample_a")
    write_sample_extract_csvs(tmp_path, stem="sample_b")

    with pytest.raises(ValueError, match="exactly one"):
        find_pose_csv_pair(tmp_path)


def test_plot_extracted_pose_rejects_missing_required_columns(tmp_path) -> None:
    write_sample_extract_csvs(tmp_path)
    landmarks_path = tmp_path / "sample_33landmarks.csv"
    landmarks = pd.read_csv(landmarks_path)
    landmarks = landmarks.drop(columns=["leftWrist_x"])
    landmarks.to_csv(landmarks_path, index=False)

    with pytest.raises(ValueError, match="leftWrist_x"):
        plot_extracted_pose(tmp_path)


def test_plot_extracted_pose_rejects_malformed_hand_csv(tmp_path) -> None:
    write_sample_extract_csvs(tmp_path)
    write_sample_hand_csv(tmp_path)
    hand_path = tmp_path / "sample_hand_landmarks.csv"
    hands = pd.read_csv(hand_path)
    hands = hands.drop(columns=["indexFingerTip_x"])
    hands.to_csv(hand_path, index=False)

    with pytest.raises(ValueError, match="indexFingerTip_x"):
        plot_extracted_pose(tmp_path)


def test_plot_extracted_pose_rejects_hand_csv_without_frame_index(tmp_path) -> None:
    write_sample_extract_csvs(tmp_path)
    write_sample_hand_csv(tmp_path)
    hand_path = tmp_path / "sample_hand_landmarks.csv"
    hands = pd.read_csv(hand_path)
    hands = hands.drop(columns=["frame_index"])
    hands.to_csv(hand_path, index=False)

    with pytest.raises(ValueError, match="frame_index"):
        plot_extracted_pose(tmp_path)


def test_compute_wrist_speed_uses_nan_for_missing_coordinates() -> None:
    landmarks = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300],
        "leftWrist_x": [0.0, 0.3, np.nan, 0.9],
        "leftWrist_y": [0.0, 0.4, np.nan, 0.9],
        "leftWrist_visibility": [0.9, 0.9, np.nan, 0.9],
    })

    speed = compute_wrist_speed(landmarks, "leftWrist")

    assert speed.iloc[0] == 0.0
    assert speed.iloc[1] == pytest.approx(5.0)
    assert np.isnan(speed.iloc[2])
    assert np.isnan(speed.iloc[3])


def test_compute_tracking_status_prioritizes_valid_hand_tip_center() -> None:
    metadata = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300],
        "frame_index": [0, 1, 2, 3],
        "pose_status": ["invalid", "valid", "interpolated", ""],
    })
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 100],
        "frame_index": [0, 1, 1],
        "hand_index": [0, 0, 1],
        "handedness": ["Left", "Left", "Right"],
        "indexFingerTip_x": [0.1, np.nan, 0.5],
        "indexFingerTip_y": [0.1, 0.2, 0.5],
        "middleFingerTip_x": [0.2, 0.3, 0.6],
        "middleFingerTip_y": [0.2, 0.4, 0.6],
    })

    status = compute_tracking_status(metadata, hands)

    assert status.tolist() == ["hand_valid", "hand_valid", "pose_interpolated", "missing"]


def test_compute_tracking_status_uses_pose_status_when_hand_csv_is_missing() -> None:
    metadata = pd.DataFrame({
        "timestamp_ms": [0, 100, 200],
        "frame_index": [0, 1, 2],
        "pose_status": ["valid", "invalid", "unknown"],
    })

    status = compute_tracking_status(metadata, None)

    assert status.tolist() == ["valid", "invalid", "missing"]


def test_compute_tracking_status_rejects_hand_frames_outside_metadata() -> None:
    metadata = pd.DataFrame({
        "timestamp_ms": [0],
        "frame_index": [0],
        "pose_status": ["valid"],
    })
    hands = pd.DataFrame({
        "timestamp_ms": [100],
        "frame_index": [1],
        "hand_index": [0],
        "handedness": ["Left"],
        "indexFingerTip_x": [0.1],
        "indexFingerTip_y": [0.1],
        "middleFingerTip_x": [0.2],
        "middleFingerTip_y": [0.2],
    })

    with pytest.raises(ValueError, match="frame_index"):
        compute_tracking_status(metadata, hands)


def test_compute_wrist_speed_uses_nan_for_zero_visibility_masked_coordinates() -> None:
    landmarks = pd.DataFrame({
        "timestamp_ms": [0, 100, 200, 300],
        "leftWrist_x": [0.1, 0.2, 0.0, 0.4],
        "leftWrist_y": [0.1, 0.1, 0.0, 0.1],
        "leftWrist_visibility": [0.9, 0.9, 0.0, 0.9],
    })

    speed = compute_wrist_speed(landmarks, "leftWrist")

    assert speed.iloc[0] == 0.0
    assert speed.iloc[1] == pytest.approx(1.0)
    assert np.isnan(speed.iloc[2])
    assert np.isnan(speed.iloc[3])


def test_compute_wrist_speed_rejects_non_increasing_timestamps() -> None:
    landmarks = pd.DataFrame({
        "timestamp_ms": [0, 100, 100],
        "rightWrist_x": [0.0, 0.1, 0.2],
        "rightWrist_y": [0.0, 0.1, 0.2],
        "rightWrist_visibility": [0.9, 0.9, 0.9],
    })

    with pytest.raises(ValueError, match="timestamp_ms"):
        compute_wrist_speed(landmarks, "rightWrist")


def test_compute_hand_keypoint_speed_groups_by_handedness_and_hand_index() -> None:
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 0, 100],
        "hand_index": [0, 0, 1, 1],
        "handedness": ["Left", "Left", "Left", "Left"],
        "indexFingerTip_x": [0.0, 0.3, 0.0, 0.0],
        "indexFingerTip_y": [0.0, 0.4, 0.0, 0.2],
    })

    speed = compute_hand_keypoint_speed(hands, "indexFingerTip")

    assert speed.tolist() == pytest.approx([0.0, 5.0, 0.0, 2.0])


def test_compute_hand_tip_center_averages_index_and_middle_fingertips() -> None:
    hands = pd.DataFrame({
        "timestamp_ms": [0],
        "hand_index": [0],
        "handedness": ["Left"],
        "indexFingerTip_x": [0.1],
        "indexFingerTip_y": [0.2],
        "middleFingerTip_x": [0.3],
        "middleFingerTip_y": [0.6],
    })

    centered = compute_hand_tip_center(hands)

    assert centered["_tipCenter_x"].iloc[0] == pytest.approx(0.2)
    assert centered["_tipCenter_y"].iloc[0] == pytest.approx(0.4)


def test_compute_hand_tip_center_uses_nan_when_either_fingertip_is_missing() -> None:
    hands = pd.DataFrame({
        "timestamp_ms": [0],
        "hand_index": [0],
        "handedness": ["Left"],
        "indexFingerTip_x": [np.nan],
        "indexFingerTip_y": [0.2],
        "middleFingerTip_x": [0.3],
        "middleFingerTip_y": [0.6],
    })

    centered = compute_hand_tip_center(hands)

    assert np.isnan(centered["_tipCenter_x"].iloc[0])
    assert centered["_tipCenter_y"].iloc[0] == pytest.approx(0.4)


def test_compute_hand_tip_center_speed_uses_representative_tip_center() -> None:
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100],
        "hand_index": [0, 0],
        "handedness": ["Left", "Left"],
        "indexFingerTip_x": [0.0, 0.2],
        "indexFingerTip_y": [0.0, 0.0],
        "middleFingerTip_x": [0.0, 0.4],
        "middleFingerTip_y": [0.0, 0.0],
    })

    speed = compute_hand_tip_center_speed(hands)

    assert speed.tolist() == pytest.approx([0.0, 3.0])


def test_compute_hand_tip_center_speed_uses_nan_around_missing_tip_center() -> None:
    hands = pd.DataFrame({
        "timestamp_ms": [0, 100, 200],
        "hand_index": [0, 0, 0],
        "handedness": ["Left", "Left", "Left"],
        "indexFingerTip_x": [0.0, np.nan, 0.4],
        "indexFingerTip_y": [0.0, 0.0, 0.0],
        "middleFingerTip_x": [0.0, 0.2, 0.4],
        "middleFingerTip_y": [0.0, 0.0, 0.0],
    })

    speed = compute_hand_tip_center_speed(hands)

    assert speed.iloc[0] == 0.0
    assert np.isnan(speed.iloc[1])
    assert np.isnan(speed.iloc[2])
