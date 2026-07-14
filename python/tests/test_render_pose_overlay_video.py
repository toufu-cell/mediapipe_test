import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


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
            3: float(self._width),
            4: float(self._height),
            7: float(len(self._frames)),
        }
        return mapping.get(prop_id, 0.0)

    def release(self) -> None:
        return None


class FakeVideoWriter:
    def __init__(self) -> None:
        self.frames = []
        self.released = False

    def write(self, frame) -> None:
        self.frames.append(frame)

    def release(self) -> None:
        self.released = True


def build_skeleton_json(path: Path) -> None:
    frames = [
        {
            "frameIndex": 0,
            "timestampMs": 0,
            "landmarks": [
                {"x": 0.1, "y": 0.2, "z": 0.0, "visibility": 0.9}
                for _ in range(33)
            ],
        },
        {
            "frameIndex": 1,
            "timestampMs": 33,
            "landmarks": None,
        },
    ]
    payload = {
        "metadata": {
            "frameCount": 2,
            "sourceWidth": 640,
            "sourceHeight": 480,
            "estimatedFps": 30.0,
        },
        "frames": frames,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def build_hand_json(path: Path) -> None:
    frames = [
        {
            "frameIndex": 0,
            "timestampMs": 0,
            "hands": [
                {
                    "handedness": "Right",
                    "score": 0.9,
                    "landmarks": [
                        {"x": 0.2, "y": 0.3, "z": 0.0}
                        for _ in range(21)
                    ],
                }
            ],
        },
        {
            "frameIndex": 1,
            "timestampMs": 33,
            "hands": [],
        },
    ]
    payload = {
        "metadata": {
            "frameCount": 2,
            "sourceWidth": 640,
            "sourceHeight": 480,
            "estimatedFps": 30.0,
            "coordinateSpace": "normalized",
        },
        "frames": frames,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_render_pose_overlay_video_writes_all_frames(monkeypatch, tmp_path: Path) -> None:
    import render_pose_overlay_video as rpov

    skeleton_path = tmp_path / "sample_skeleton_data.json"
    build_skeleton_json(skeleton_path)

    fake_capture = FakeVideoCapture(frames=["frame-1", "frame-2"])
    fake_writer = FakeVideoWriter()
    draw_calls = []
    progress_events = []

    monkeypatch.setattr(rpov, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(
        rpov,
        "create_video_writer",
        lambda output_path, fps, frame_size: fake_writer,
    )
    monkeypatch.setattr(
        rpov,
        "draw_pose_overlay",
        lambda frame, landmarks, width, height, style: draw_calls.append(
            (frame, landmarks, width, height, style["line_color"])
        ),
    )

    result = rpov.render_pose_overlay_video(
        video_path=tmp_path / "sample.mp4",
        skeleton_json_path=skeleton_path,
        output_path=tmp_path / "overlay.mp4",
        progress_callback=lambda current, total: progress_events.append((current, total)),
    )

    assert result["frame_count"] == 2
    assert result["output_path"] == tmp_path / "overlay.mp4"
    assert fake_writer.frames == ["frame-1", "frame-2"]
    assert fake_writer.released is True
    assert len(draw_calls) == 1
    assert draw_calls[0][0] == "frame-1"
    assert draw_calls[0][2:4] == (640, 480)
    assert progress_events == [(1, 2), (2, 2)]


def test_render_pose_overlay_video_draws_hand_overlay_when_hand_json_is_provided(monkeypatch, tmp_path: Path) -> None:
    import render_pose_overlay_video as rpov

    skeleton_path = tmp_path / "sample_skeleton_data.json"
    hand_path = tmp_path / "sample_hand_landmarks.json"
    build_skeleton_json(skeleton_path)
    build_hand_json(hand_path)

    fake_capture = FakeVideoCapture(frames=["frame-1", "frame-2"])
    fake_writer = FakeVideoWriter()
    hand_draw_calls = []

    monkeypatch.setattr(rpov, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(rpov, "create_video_writer", lambda output_path, fps, frame_size: fake_writer)
    monkeypatch.setattr(rpov, "draw_pose_overlay", lambda frame, landmarks, width, height, style: None)
    monkeypatch.setattr(
        rpov,
        "draw_hand_overlay",
        lambda frame, hands, width, height, style: hand_draw_calls.append((frame, hands, width, height)),
    )

    rpov.render_pose_overlay_video(
        video_path=tmp_path / "sample.mp4",
        skeleton_json_path=skeleton_path,
        output_path=tmp_path / "overlay.mp4",
        hand_json_path=hand_path,
    )

    assert len(hand_draw_calls) == 1
    assert hand_draw_calls[0][0] == "frame-1"
    assert hand_draw_calls[0][2:4] == (640, 480)


def test_render_pose_overlay_video_does_not_report_progress_when_total_frames_is_zero(monkeypatch, tmp_path: Path) -> None:
    import render_pose_overlay_video as rpov

    skeleton_path = tmp_path / "sample_skeleton_data.json"
    build_skeleton_json(skeleton_path)

    class ZeroFrameCapture(FakeVideoCapture):
        def get(self, prop_id: int) -> float:
            if prop_id == 7:
                return 0.0
            return super().get(prop_id)

    fake_capture = ZeroFrameCapture(frames=["frame-1", "frame-2"])
    fake_writer = FakeVideoWriter()
    progress_events = []

    monkeypatch.setattr(rpov, "open_video_capture", lambda video_path: fake_capture)
    monkeypatch.setattr(
        rpov,
        "create_video_writer",
        lambda output_path, fps, frame_size: fake_writer,
    )
    monkeypatch.setattr(rpov, "draw_pose_overlay", lambda frame, landmarks, width, height, style: None)

    rpov.render_pose_overlay_video(
        video_path=tmp_path / "sample.mp4",
        skeleton_json_path=skeleton_path,
        output_path=tmp_path / "overlay.mp4",
        progress_callback=lambda current, total: progress_events.append((current, total)),
    )

    assert progress_events == []


def test_render_pose_overlay_video_raises_when_video_cannot_be_opened(monkeypatch, tmp_path: Path) -> None:
    import render_pose_overlay_video as rpov

    skeleton_path = tmp_path / "sample_skeleton_data.json"
    build_skeleton_json(skeleton_path)

    class ClosedCapture(FakeVideoCapture):
        def isOpened(self) -> bool:
            return False

    monkeypatch.setattr(rpov, "open_video_capture", lambda video_path: ClosedCapture(frames=[]))

    with pytest.raises(RuntimeError, match="Failed to open video"):
        rpov.render_pose_overlay_video(
            video_path=tmp_path / "sample.mp4",
            skeleton_json_path=skeleton_path,
            output_path=tmp_path / "overlay.mp4",
        )


def test_main_passes_paths_to_render_pose_overlay_video(monkeypatch, tmp_path: Path) -> None:
    import render_pose_overlay_video as rpov

    called = {}
    preview_capture = SimpleNamespace(get=lambda _property: 0, release=lambda: None)
    monkeypatch.setitem(
        sys.modules,
        "cv2",
        SimpleNamespace(VideoCapture=lambda _path: preview_capture),
    )

    def fake_render(
        video_path: Path,
        skeleton_json_path: Path,
        output_path: Path,
        progress_callback=None,
        hand_json_path=None,
    ):
        called["video_path"] = video_path
        called["skeleton_json_path"] = skeleton_json_path
        called["output_path"] = output_path
        called["progress_callback"] = progress_callback
        called["hand_json_path"] = hand_json_path
        return {"frame_count": 2, "output_path": output_path}

    monkeypatch.setattr(rpov, "render_pose_overlay_video", fake_render)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "render_pose_overlay_video.py",
            str(tmp_path / "sample.mp4"),
            "--skeleton-json",
            str(tmp_path / "sample_skeleton_data.json"),
            "--hand-json",
            str(tmp_path / "sample_hand_landmarks.json"),
            "-o",
            str(tmp_path / "overlay.mp4"),
        ],
    )

    rpov.main()

    assert called["video_path"] == tmp_path / "sample.mp4"
    assert called["skeleton_json_path"] == tmp_path / "sample_skeleton_data.json"
    assert called["hand_json_path"] == tmp_path / "sample_hand_landmarks.json"
    assert called["output_path"] == tmp_path / "overlay.mp4"
    assert called["progress_callback"] is None


def test_draw_pose_overlay_skips_zero_visibility_landmarks(monkeypatch) -> None:
    import render_pose_overlay_video as rpov

    line_calls = []
    circle_calls = []
    fake_cv2 = SimpleNamespace(
        LINE_AA=16,
        line=lambda frame, start, end, color, width, line_type: line_calls.append((start, end)),
        circle=lambda frame, center, radius, color, thickness, line_type: circle_calls.append(center),
    )
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)

    landmarks = [
        {"x": 0.0, "y": 0.0, "z": 0.0, "visibility": 0.0}
        for _ in range(33)
    ]
    landmarks[11] = {"x": 0.25, "y": 0.4, "z": 0.0, "visibility": 0.9}
    landmarks[12] = {"x": 0.75, "y": 0.4, "z": 0.0, "visibility": 0.8}

    rpov.draw_pose_overlay(
        frame=object(),
        landmarks=landmarks,
        width=640,
        height=480,
        style=rpov.DEFAULT_STYLE,
    )

    assert line_calls == [((160, 192), (480, 192))]
    assert sorted(circle_calls) == [(160, 192), (480, 192)]
