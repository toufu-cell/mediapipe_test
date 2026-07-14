import csv
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


class FakeLandmark:
    def __init__(self, x: float, y: float, z: float, visibility: float) -> None:
        self.x = x
        self.y = y
        self.z = z
        self.visibility = visibility


class FakeResult:
    def __init__(self, pose_landmarks):
        self.pose_landmarks = pose_landmarks


class FakeLandmarker:
    def __init__(self, results: list[FakeResult]) -> None:
        self._results = results
        self.timestamps: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def detect_for_video(self, image, timestamp_ms: int):
        self.timestamps.append(timestamp_ms)
        return self._results.pop(0)

    def close(self) -> None:
        return None


class FakeHandCategory:
    def __init__(self, category_name: str, score: float) -> None:
        self.category_name = category_name
        self.score = score


class FakeHandResult:
    def __init__(self, hand_landmarks, handedness=None):
        self.hand_landmarks = hand_landmarks
        self.handedness = handedness or []


class FakeHandLandmarker(FakeLandmarker):
    pass


class FakeVideoCapture:
    def __init__(self, frames, fps: float = 30.0, width: int = 640, height: int = 480) -> None:
        self._frames = list(frames)
        self._fps = fps
        self._width = width
        self._height = height
        self._index = 0

    def isOpened(self) -> bool:
        return True

    def read(self):
        if self._index >= len(self._frames):
            return False, None
        frame = self._frames[self._index]
        self._index += 1
        return True, frame

    def get(self, prop_id: int) -> float:
        mapping = {
            5: self._fps,
            7: float(len(self._frames)),
            3: float(self._width),
            4: float(self._height),
        }
        return mapping.get(prop_id, 0.0)

    def release(self) -> None:
        return None


def build_landmarks(
    center_x: float = 0.5,
    center_y: float = 0.45,
    shoulder_width: float = 0.24,
    body_height: float = 0.45,
    visibility: float = 0.9,
) -> list[FakeLandmark]:
    landmarks = [FakeLandmark(center_x, center_y, 0.0, visibility) for _ in range(33)]
    landmarks[11] = FakeLandmark(center_x - shoulder_width / 2, center_y - body_height * 0.25, 0.0, visibility)
    landmarks[12] = FakeLandmark(center_x + shoulder_width / 2, center_y - body_height * 0.25, 0.0, visibility)
    landmarks[13] = FakeLandmark(center_x - shoulder_width * 0.75, center_y, 0.0, visibility)
    landmarks[14] = FakeLandmark(center_x + shoulder_width * 0.75, center_y, 0.0, visibility)
    landmarks[15] = FakeLandmark(center_x - shoulder_width * 0.95, center_y + body_height * 0.25, 0.0, visibility)
    landmarks[16] = FakeLandmark(center_x + shoulder_width * 0.95, center_y + body_height * 0.25, 0.0, visibility)
    landmarks[23] = FakeLandmark(center_x - shoulder_width * 0.35, center_y + body_height * 0.5, 0.0, visibility)
    landmarks[24] = FakeLandmark(center_x + shoulder_width * 0.35, center_y + body_height * 0.5, 0.0, visibility)
    return landmarks


def build_hand_landmarks(
    center_x: float = 0.5,
    center_y: float = 0.5,
    visibility: float = 1.0,
) -> list[FakeLandmark]:
    return [
        FakeLandmark(center_x + i * 0.001, center_y + i * 0.001, -i * 0.001, visibility)
        for i in range(21)
    ]


def test_apply_landmark_profile_upper_body_masks_face_and_lower_body() -> None:
    import extract_pose_video as epv

    landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.9}
        for _ in range(33)
    ]

    filtered = epv.apply_landmark_profile(
        landmarks,
        landmark_profile="upper-body",
        visibility_threshold=0.0,
    )

    assert filtered[0]["visibility"] == 0.0
    assert filtered[0]["x"] == 0.0
    assert filtered[11]["visibility"] == 0.9
    assert filtered[22]["visibility"] == 0.9
    assert filtered[23]["visibility"] == 0.0
    assert filtered[32]["visibility"] == 0.0


def test_apply_landmark_profile_masks_low_visibility() -> None:
    import extract_pose_video as epv

    landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.9}
        for _ in range(33)
    ]
    landmarks[15] = {"x": 0.4, "y": 0.5, "z": 0.6, "visibility": 0.2}

    filtered = epv.apply_landmark_profile(
        landmarks,
        landmark_profile="full-body",
        visibility_threshold=0.5,
    )

    assert filtered[15]["x"] == 0.0
    assert filtered[15]["y"] == 0.0
    assert filtered[15]["z"] == 0.0
    assert filtered[15]["visibility"] == 0.0


def test_apply_arm_selection_auto_visible_masks_lower_score_arm() -> None:
    import extract_pose_video as epv

    landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.9}
        for _ in range(33)
    ]
    for index in epv.RIGHT_ARM_LANDMARK_INDICES:
        landmarks[index]["visibility"] = 0.1

    filtered, metadata = epv.apply_arm_selection(
        landmarks,
        arm_selection="auto-visible",
        min_score_margin=0.5,
    )

    assert metadata["selectedArm"] == "left"
    assert metadata["armSelection"] == "auto-visible"
    assert metadata["leftArmScore"] > metadata["rightArmScore"]
    assert filtered[11]["visibility"] == 0.9
    assert filtered[12]["visibility"] == 0.9
    assert filtered[13]["visibility"] == 0.9
    assert filtered[14]["visibility"] == 0.0
    assert filtered[16]["x"] == 0.0
    assert filtered[18]["visibility"] == 0.0


def test_apply_arm_selection_auto_visible_keeps_both_when_scores_are_close() -> None:
    import extract_pose_video as epv

    landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.9}
        for _ in range(33)
    ]

    filtered, metadata = epv.apply_arm_selection(
        landmarks,
        arm_selection="auto-visible",
        min_score_margin=0.5,
    )

    assert metadata["selectedArm"] == "both"
    assert filtered == landmarks


def test_apply_arm_selection_manual_left_masks_right_arm_only() -> None:
    import extract_pose_video as epv

    landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.9}
        for _ in range(33)
    ]

    filtered, metadata = epv.apply_arm_selection(
        landmarks,
        arm_selection="left",
        min_score_margin=0.5,
    )

    assert metadata["selectedArm"] == "left"
    assert filtered[11]["visibility"] == 0.9
    assert filtered[12]["visibility"] == 0.9
    assert filtered[13]["visibility"] == 0.9
    assert filtered[14]["visibility"] == 0.0
    assert filtered[16]["visibility"] == 0.0


def test_apply_arm_selection_uses_raw_score_source_when_output_is_profiled() -> None:
    import extract_pose_video as epv

    raw_landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.9}
        for _ in range(33)
    ]
    profiled_landmarks = [
        {"x": 0.1, "y": 0.2, "z": 0.3, "visibility": 0.0}
        for _ in range(33)
    ]
    for index in epv.LEFT_ARM_LANDMARK_INDICES:
        profiled_landmarks[index]["visibility"] = 0.9
    for index in epv.RIGHT_ARM_LANDMARK_INDICES:
        raw_landmarks[index]["visibility"] = 0.1

    filtered, metadata = epv.apply_arm_selection(
        profiled_landmarks,
        arm_selection="auto-visible",
        min_score_margin=0.5,
        score_landmarks=raw_landmarks,
    )

    assert metadata["selectedArm"] == "left"
    assert metadata["leftArmScore"] > metadata["rightArmScore"]
    assert filtered[13]["visibility"] == 0.9
    assert filtered[14]["visibility"] == 0.0


def test_build_progress_reporter_prints_5_percent_steps(capsys) -> None:
    import extract_pose_video as epv

    reporter = epv.build_progress_reporter("抽出", total_frames=20, interval_percent=5)
    for current in range(1, 21):
        reporter(current, 20)

    output = capsys.readouterr().out.strip().splitlines()
    assert output[0] == "[進捗] 抽出: 5% (1/20)"
    assert output[1] == "[進捗] 抽出: 10% (2/20)"
    assert output[-1] == "[進捗] 抽出: 100% (20/20)"


def test_build_progress_reporter_uses_runtime_total_and_final_flush(capsys) -> None:
    import extract_pose_video as epv

    reporter = epv.build_progress_reporter("抽出", total_frames=100, interval_percent=5)
    reporter(1, 20)
    reporter(19, 20)
    reporter(19, 19)

    output = capsys.readouterr().out.strip().splitlines()
    assert output[0] == "[進捗] 抽出: 5% (1/20)"
    assert output[-1] == "[進捗] 抽出: 100% (19/19)"


def test_extract_pose_video_writes_json_and_csv(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    fake_capture = FakeVideoCapture(frames=["frame-1", "frame-2"])
    fake_landmarker = FakeLandmarker([
        FakeResult([build_landmarks()]),
        FakeResult([]),
    ])
    progress_events = []

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    output_dir = tmp_path / "output"
    result = epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
        progress_callback=lambda current, total: progress_events.append((current, total)),
        landmark_profile="upper-body",
        max_interpolation_ms=0,
    )

    assert result["frame_count"] == 2
    assert fake_landmarker.timestamps == [0, 33]
    assert progress_events == [(1, 2), (2, 2)]

    json_path = output_dir / "sample_skeleton_data.json"
    csv_path = output_dir / "sample_33landmarks.csv"
    assert json_path.exists()
    assert csv_path.exists()

    data = json.loads(json_path.read_text())
    assert data["metadata"]["frameCount"] == 2
    assert data["metadata"]["source"] == "videoFile"
    assert data["metadata"]["sourceWidth"] == 640
    assert data["metadata"]["sourceHeight"] == 480
    assert data["frames"][0]["landmarks"][0]["x"] == 0.0
    assert data["frames"][0]["landmarks"][0]["visibility"] == 0.0
    assert data["frames"][0]["landmarks"][11]["visibility"] == 0.9
    assert data["frames"][0]["landmarks"][23]["visibility"] == 0.0
    assert data["frames"][1]["landmarks"] is None

    with csv_path.open(newline="") as fh:
        rows = list(csv.reader(fh))

    assert rows[0][0:2] == ["timestamp_ms", "frame_index"]
    assert rows[1][0:2] == ["0", "0"]
    assert rows[2][0:2] == ["33", "1"]
    assert all(value == "" for value in rows[2][2:])


def test_extract_pose_video_interpolates_short_invalid_pose_and_writes_metadata(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import extract_pose_video as epv

    valid_landmarks = build_landmarks(center_x=0.4, center_y=0.45)
    tiny_false_pose = build_landmarks(center_x=0.75, center_y=0.75, shoulder_width=0.01, body_height=0.01)
    fake_capture = FakeVideoCapture(frames=["frame-1", "frame-2", "frame-3", "frame-4"], fps=10.0)
    fake_landmarker = FakeLandmarker([
        FakeResult([valid_landmarks]),
        FakeResult([tiny_false_pose]),
        FakeResult([tiny_false_pose]),
        FakeResult([tiny_false_pose]),
    ])

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    output_dir = tmp_path / "output"
    result = epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
        max_interpolation_ms=150,
        arm_selection="auto-visible",
        arm_selection_min_score_margin=0.5,
    )

    data = json.loads((output_dir / "sample_skeleton_data.json").read_text())
    assert data["frames"][0]["interpolated"] is False
    assert data["frames"][0]["armSelection"] == "auto-visible"
    assert data["frames"][0]["selectedArm"] == "both"
    assert data["frames"][1]["interpolated"] is True
    assert data["frames"][1]["interpolationSourceFrameIndex"] == 0
    assert data["frames"][1]["landmarks"][11]["x"] == data["frames"][0]["landmarks"][11]["x"]
    assert data["frames"][2]["interpolated"] is True
    assert data["frames"][2]["interpolationSourceFrameIndex"] == 0
    assert data["frames"][3]["landmarks"] is None
    assert data["frames"][3]["interpolated"] is False

    metadata_path = output_dir / "sample_frame_metadata.csv"
    assert result["frame_metadata_path"] == metadata_path
    with metadata_path.open(newline="") as fh:
        metadata_rows = list(csv.DictReader(fh))

    assert metadata_rows[0]["pose_status"] == "valid"
    assert metadata_rows[0]["arm_selection"] == "auto-visible"
    assert metadata_rows[0]["selected_arm"] == "both"
    assert metadata_rows[1]["pose_status"] == "interpolated"
    assert metadata_rows[1]["interpolation_source_frame_index"] == "0"
    assert metadata_rows[3]["pose_status"] == "invalid"
    assert metadata_rows[3]["has_landmarks"] == "false"

    with (output_dir / "sample_33landmarks.csv").open(newline="") as fh:
        landmark_rows = list(csv.reader(fh))

    assert landmark_rows[2][2:] == landmark_rows[1][2:]
    assert all(value == "" for value in landmark_rows[4][2:])


def test_extract_pose_video_does_not_interpolate_initial_invalid_pose(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    tiny_false_pose = build_landmarks(center_x=0.75, center_y=0.75, shoulder_width=0.01, body_height=0.01)
    valid_landmarks = build_landmarks(center_x=0.4, center_y=0.45)
    fake_capture = FakeVideoCapture(frames=["frame-1", "frame-2"], fps=30.0)
    fake_landmarker = FakeLandmarker([
        FakeResult([tiny_false_pose]),
        FakeResult([valid_landmarks]),
    ])

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    output_dir = tmp_path / "output"
    epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
    )

    data = json.loads((output_dir / "sample_skeleton_data.json").read_text())
    assert data["frames"][0]["landmarks"] is None
    assert data["frames"][0]["interpolated"] is False
    assert data["frames"][0]["poseStatus"] == "invalid"
    assert data["frames"][1]["landmarks"] is not None
    assert data["frames"][1]["interpolated"] is False


def test_extract_pose_video_applies_auto_visible_arm_selection_to_output(
    monkeypatch,
    tmp_path: Path,
) -> None:
    import extract_pose_video as epv

    landmarks = build_landmarks(center_x=0.4, center_y=0.45)
    for index in [14, 16, 18, 20, 22]:
        landmarks[index].visibility = 0.1

    fake_capture = FakeVideoCapture(frames=["frame-1"], fps=30.0)
    fake_landmarker = FakeLandmarker([FakeResult([landmarks])])

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    output_dir = tmp_path / "output"
    epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
        arm_selection="auto-visible",
        arm_selection_min_score_margin=0.5,
    )

    data = json.loads((output_dir / "sample_skeleton_data.json").read_text())
    frame = data["frames"][0]
    assert frame["selectedArm"] == "left"
    assert frame["leftArmScore"] > frame["rightArmScore"]
    assert frame["landmarks"][11]["visibility"] == 0.9
    assert frame["landmarks"][12]["visibility"] == 0.9
    assert frame["landmarks"][13]["visibility"] == 0.9
    assert frame["landmarks"][14]["visibility"] == 0.0
    assert frame["landmarks"][16]["visibility"] == 0.0

    with (output_dir / "sample_frame_metadata.csv").open(newline="") as fh:
        metadata_rows = list(csv.DictReader(fh))

    assert metadata_rows[0]["arm_selection"] == "auto-visible"
    assert metadata_rows[0]["selected_arm"] == "left"

    with (output_dir / "sample_33landmarks.csv").open(newline="") as fh:
        landmark_rows = list(csv.reader(fh))

    right_elbow_visibility_column = 2 + 14 * 4 + 3
    assert landmark_rows[1][right_elbow_visibility_column] == "0.0"


def test_extract_pose_video_writes_overlay_video_when_requested(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    fake_capture = FakeVideoCapture(frames=["frame-1"])
    fake_landmarker = FakeLandmarker([
        FakeResult([build_landmarks()]),
    ])
    overlay_calls = {}

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)
    monkeypatch.setattr(
        epv,
        "render_pose_overlay_video",
        lambda video_path, skeleton_json_path, output_path, progress_callback=None, hand_json_path=None: overlay_calls.update({
            "video_path": video_path,
            "skeleton_json_path": skeleton_json_path,
            "output_path": output_path,
            "json_exists": skeleton_json_path.exists(),
            "progress_callback": progress_callback,
            "hand_json_path": hand_json_path,
        }),
    )

    output_dir = tmp_path / "output"
    result = epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
        write_overlay_video=True,
    )

    assert result["overlay_path"] == output_dir / "sample_overlay.mp4"
    assert overlay_calls["video_path"] == tmp_path / "sample.mp4"
    assert overlay_calls["skeleton_json_path"] == output_dir / "sample_skeleton_data.json"
    assert overlay_calls["output_path"] == output_dir / "sample_overlay.mp4"
    assert overlay_calls["json_exists"] is True
    assert overlay_calls["progress_callback"] is None
    assert overlay_calls["hand_json_path"] is None


def test_extract_pose_video_writes_hand_json_and_csv_when_requested(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    fake_capture = FakeVideoCapture(frames=["frame-1", "frame-2"])
    fake_pose_landmarker = FakeLandmarker([
        FakeResult([build_landmarks()]),
        FakeResult([build_landmarks()]),
    ])
    fake_hand_landmarker = FakeHandLandmarker([
        FakeHandResult(
            [build_hand_landmarks(center_x=0.6, center_y=0.4)],
            [[FakeHandCategory("Right", 0.88)]],
        ),
        FakeHandResult([], []),
    ])

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_pose_landmarker)
    monkeypatch.setattr(epv, "create_hand_landmarker", lambda model_path, num_hands=2: fake_hand_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    output_dir = tmp_path / "output"
    result = epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
        hand_model_path=tmp_path / "hand.task",
        detect_hands=True,
    )

    hand_json_path = output_dir / "sample_hand_landmarks.json"
    hand_csv_path = output_dir / "sample_hand_landmarks.csv"
    assert result["hand_json_path"] == hand_json_path
    assert result["hand_csv_path"] == hand_csv_path
    assert fake_hand_landmarker.timestamps == [0, 33]

    hand_data = json.loads(hand_json_path.read_text())
    assert hand_data["metadata"]["handLandmarkModel"] == "mediapipe-hand-21"
    assert hand_data["metadata"]["sourceWidth"] == 640
    assert hand_data["metadata"]["sourceHeight"] == 480
    assert hand_data["metadata"]["mirrored"] is False
    assert hand_data["metadata"]["handednessAssumesMirroredInput"] is True
    assert hand_data["metadata"]["handednessAdjustedForMirroring"] is True
    assert hand_data["frames"][0]["hands"][0]["handedness"] == "Left"
    assert hand_data["frames"][0]["hands"][0]["rawHandedness"] == "Right"
    assert hand_data["frames"][0]["hands"][0]["score"] == 0.88
    assert len(hand_data["frames"][0]["hands"][0]["landmarks"]) == 21
    assert hand_data["frames"][1]["hands"] == []

    with hand_csv_path.open(newline="") as fh:
        hand_rows = list(csv.reader(fh))

    assert hand_rows[0][0:5] == ["timestamp_ms", "frame_index", "hand_index", "handedness", "score"]
    assert hand_rows[1][0:5] == ["0", "0", "0", "Left", "0.88"]
    assert len(hand_rows) == 2


def test_extract_pose_video_passes_hand_json_to_overlay_when_requested(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    fake_capture = FakeVideoCapture(frames=["frame-1"])
    fake_pose_landmarker = FakeLandmarker([FakeResult([build_landmarks()])])
    fake_hand_landmarker = FakeHandLandmarker([FakeHandResult([build_hand_landmarks()])])
    overlay_calls = {}

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_pose_landmarker)
    monkeypatch.setattr(epv, "create_hand_landmarker", lambda model_path, num_hands=2: fake_hand_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)
    monkeypatch.setattr(
        epv,
        "render_pose_overlay_video",
        lambda video_path, skeleton_json_path, output_path, progress_callback=None, hand_json_path=None: overlay_calls.update({
            "hand_json_path": hand_json_path,
            "skeleton_json_path": skeleton_json_path,
            "output_path": output_path,
        }),
    )

    output_dir = tmp_path / "output"
    epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=output_dir,
        model_path=tmp_path / "pose.task",
        hand_model_path=tmp_path / "hand.task",
        write_overlay_video=True,
        detect_hands=True,
    )

    assert overlay_calls["hand_json_path"] == output_dir / "sample_hand_landmarks.json"


def test_extract_pose_video_does_not_report_progress_when_total_frames_is_zero(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    class ZeroFrameCapture(FakeVideoCapture):
        def get(self, prop_id: int) -> float:
            if prop_id == 7:
                return 0.0
            return super().get(prop_id)

    fake_capture = ZeroFrameCapture(frames=["frame-1", "frame-2"])
    fake_landmarker = FakeLandmarker([
        FakeResult([build_landmarks()]),
        FakeResult([]),
    ])
    progress_events = []

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(epv, "create_pose_landmarker", lambda model_path: fake_landmarker)
    monkeypatch.setattr(epv, "convert_frame_to_mp_image", lambda frame: frame)
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    epv.extract_pose_video(
        video_path=tmp_path / "sample.mp4",
        output_dir=tmp_path / "output",
        model_path=tmp_path / "pose.task",
        progress_callback=lambda current, total: progress_events.append((current, total)),
    )

    assert progress_events == []


def test_main_passes_paths_to_extract_pose_video(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    called = {}
    preview_capture = SimpleNamespace(get=lambda _property: 0, release=lambda: None)
    monkeypatch.setitem(
        sys.modules,
        "cv2",
        SimpleNamespace(VideoCapture=lambda _path: preview_capture),
    )

    def fake_extract(
        video_path: Path,
        output_dir: Path,
        model_path: Path,
        model_url: str,
        write_overlay_video: bool,
        progress_callback=None,
        overlay_progress_callback=None,
        landmark_profile: str = "full-body",
        visibility_threshold: float = 0.0,
        pose_filter_visibility_threshold: float = 0.5,
        min_valid_upper_body_landmarks: int = 4,
        min_pose_bbox_area: float = 0.006,
        min_shoulder_width: float = 0.05,
        max_center_jump: float = 0.35,
        max_interpolation_ms: float = 250.0,
        arm_selection: str = "both",
        arm_selection_min_score_margin: float = 0.5,
        detect_hands: bool = False,
        hand_model_path: Path = epv.DEFAULT_HAND_MODEL_PATH,
        hand_model_url: str = epv.DEFAULT_HAND_MODEL_URL,
        max_hands: int = 2,
    ):
        called["video_path"] = video_path
        called["output_dir"] = output_dir
        called["model_path"] = model_path
        called["model_url"] = model_url
        called["write_overlay_video"] = write_overlay_video
        called["progress_callback"] = progress_callback
        called["overlay_progress_callback"] = overlay_progress_callback
        called["landmark_profile"] = landmark_profile
        called["visibility_threshold"] = visibility_threshold
        called["pose_filter_visibility_threshold"] = pose_filter_visibility_threshold
        called["min_valid_upper_body_landmarks"] = min_valid_upper_body_landmarks
        called["min_pose_bbox_area"] = min_pose_bbox_area
        called["min_shoulder_width"] = min_shoulder_width
        called["max_center_jump"] = max_center_jump
        called["max_interpolation_ms"] = max_interpolation_ms
        called["arm_selection"] = arm_selection
        called["arm_selection_min_score_margin"] = arm_selection_min_score_margin
        called["detect_hands"] = detect_hands
        called["hand_model_path"] = hand_model_path
        called["hand_model_url"] = hand_model_url
        called["max_hands"] = max_hands
        return {
            "frame_count": 1,
            "json_path": output_dir / "x.json",
            "csv_path": output_dir / "x.csv",
            "frame_metadata_path": output_dir / "x_frame_metadata.csv",
            "hand_json_path": output_dir / "x_hand_landmarks.json" if detect_hands else None,
            "hand_csv_path": output_dir / "x_hand_landmarks.csv" if detect_hands else None,
        }

    monkeypatch.setattr(epv, "extract_pose_video", fake_extract)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "extract_pose_video.py",
            str(tmp_path / "movie.mp4"),
            "-o",
            str(tmp_path / "out"),
            "--model-path",
            str(tmp_path / "model.task"),
            "--write-overlay-video",
            "--landmark-profile",
            "upper-body",
            "--visibility-threshold",
            "0.5",
            "--pose-filter-visibility-threshold",
            "0.6",
            "--min-valid-upper-body-landmarks",
            "5",
            "--min-pose-bbox-area",
            "0.01",
            "--min-shoulder-width",
            "0.08",
            "--max-center-jump",
            "0.4",
            "--max-interpolation-ms",
            "200",
            "--arm-selection",
            "auto-visible",
            "--arm-selection-min-score-margin",
            "0.7",
            "--detect-hands",
            "--hand-model-path",
            str(tmp_path / "hand.task"),
            "--hand-model-url",
            "https://example.test/hand.task",
            "--max-hands",
            "1",
        ],
    )

    epv.main()

    assert called["video_path"] == tmp_path / "movie.mp4"
    assert called["output_dir"] == tmp_path / "out"
    assert called["model_path"] == tmp_path / "model.task"
    assert called["write_overlay_video"] is True
    assert called["progress_callback"] is None
    assert called["overlay_progress_callback"] is None
    assert called["landmark_profile"] == "upper-body"
    assert called["visibility_threshold"] == 0.5
    assert called["pose_filter_visibility_threshold"] == 0.6
    assert called["min_valid_upper_body_landmarks"] == 5
    assert called["min_pose_bbox_area"] == 0.01
    assert called["min_shoulder_width"] == 0.08
    assert called["max_center_jump"] == 0.4
    assert called["max_interpolation_ms"] == 200.0
    assert called["arm_selection"] == "auto-visible"
    assert called["arm_selection_min_score_margin"] == 0.7
    assert called["detect_hands"] is True
    assert called["hand_model_path"] == tmp_path / "hand.task"
    assert called["hand_model_url"] == "https://example.test/hand.task"
    assert called["max_hands"] == 1


def test_extract_pose_video_raises_when_video_cannot_be_opened(monkeypatch, tmp_path: Path) -> None:
    import extract_pose_video as epv

    class ClosedCapture(FakeVideoCapture):
        def isOpened(self) -> bool:
            return False

    monkeypatch.setattr(epv, "open_video_capture", lambda video_path: ClosedCapture(frames=[]))
    monkeypatch.setattr(epv, "ensure_model_file", lambda model_path, model_url=None: model_path)

    with pytest.raises(RuntimeError, match="Failed to open video"):
        epv.extract_pose_video(
            video_path=tmp_path / "missing.mp4",
            output_dir=tmp_path / "output",
            model_path=tmp_path / "pose.task",
        )
