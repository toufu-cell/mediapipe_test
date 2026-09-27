import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

import render_motion_demo_video as rmdv


SESSION_ID = "capture_test_session"
FPS = 10.0
WIDTH = 640
HEIGHT = 360
FRAME_COUNT = 60


def _hand(
    handedness: str = "Right",
    score: float = 0.9,
    *,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
    collapsed_palm: bool = False,
) -> dict:
    landmarks = [
        {
            "x": 0.35 + index * 0.005 + offset_x,
            "y": 0.45 + index * 0.003 + offset_y,
            "z": 0.0,
        }
        for index in range(21)
    ]
    if collapsed_palm:
        landmarks[17] = dict(landmarks[5])
    return {
        "handedness": handedness,
        "score": score,
        "landmarks": landmarks,
    }


def _timeline(frames: list[rmdv.HandFrame]) -> rmdv.HandTimeline:
    return rmdv.HandTimeline(
        metadata={},
        frames_by_index={frame.frame_index: frame for frame in frames},
    )


def _write_hand_json(path: Path) -> None:
    frames = []
    for frame_index in range(FRAME_COUNT):
        frames.append({
            "frameIndex": frame_index,
            "timestampMs": frame_index * 100.0,
            "hands": [_hand(offset_x=frame_index * 0.001)],
        })
    payload = {
        "metadata": {
            "frameCount": FRAME_COUNT,
            "sourceWidth": WIDTH,
            "sourceHeight": HEIGHT,
            "estimatedFps": FPS,
        },
        "frames": frames,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_video(path: Path) -> None:
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        FPS,
        (WIDTH, HEIGHT),
    )
    assert writer.isOpened()
    for frame_index in range(FRAME_COUNT):
        frame = np.full((HEIGHT, WIDTH, 3), 24, dtype=np.uint8)
        marker_value = 30 + frame_index * 3
        cv2.rectangle(frame, (540, 300), (630, 350), (marker_value,) * 3, -1)
        cv2.putText(
            frame,
            f"FRAME {frame_index}",
            (220, 180),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (230, 230, 230),
            2,
            cv2.LINE_AA,
        )
        writer.write(frame)
    writer.release()


def _write_watch_csv(
    path: Path,
    accelerations: list[float],
    *,
    wrist_side: str = "right",
) -> None:
    rows = [
        "timestamp_ms,frame_index,imu_session_id,imu_wrist_side,imu_accel_norm"
    ]
    rows.extend(
        f"{frame_index * 100},{frame_index},{SESSION_ID},{wrist_side},{acceleration}"
        for frame_index, acceleration in enumerate(accelerations)
    )
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")


def _fixture_paths(tmp_path: Path) -> tuple[Path, Path, Path]:
    video_path = tmp_path / f"{SESSION_ID}.mp4"
    hand_json_path = tmp_path / f"{SESSION_ID}_hand_landmarks.json"
    output_path = tmp_path / "motion-demo.mp4"
    return video_path, hand_json_path, output_path


def test_speed_pulse_smooths_speed_and_holds_each_color_band() -> None:
    base_hand = _hand()
    palm_width_px = rmdv._palm_geometry_pixels(base_hand, WIDTH, HEIGHT)[1]
    high_speed_offset = 30.0 * palm_width_px * 0.1 / WIDTH
    frames = []
    offset_x = 0.0
    for frame_index in range(18):
        if 3 <= frame_index <= 8:
            offset_x += high_speed_offset
        frames.append(rmdv.HandFrame(
            frame_index,
            frame_index * 100.0,
            (_hand(offset_x=offset_x),),
        ))

    pulses = rmdv._speed_pulses(
        _timeline(frames),
        list(range(len(frames))),
        FPS,
        WIDTH,
        HEIGHT,
    )

    assert pulses[4] == 0.0
    assert pulses[5] == 1.0
    assert pulses[10] == 1.0
    assert pulses[11] == 0.5
    assert pulses[15] == 0.5
    assert pulses[16] == 0.0
    transition_indices = [
        index
        for index in range(1, len(frames))
        if pulses[index] != pulses[index - 1]
    ]
    assert transition_indices == [5, 11, 16]


def test_speed_pulse_rejects_interval_without_usable_palm_width() -> None:
    frames = [rmdv.HandFrame(0, 0.0, (_hand(collapsed_palm=True),))]

    with pytest.raises(ValueError, match="usable right-hand palm width"):
        rmdv._speed_pulses(_timeline(frames), [0], FPS, WIDTH, HEIGHT)


def test_draw_speed_hand_uses_one_two_three_bars_without_drawing_left() -> None:
    left = _hand("Left", offset_x=-0.2)
    right = _hand("Right", offset_x=0.2)
    cases = (
        (0.0, 1),
        (0.5, 2),
        (1.0, 3),
    )

    for pulse, expected_bar_count in cases:
        frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
        assert rmdv.draw_speed_hand(frame, (left, right), WIDTH, HEIGHT, pulse)
        bar_mask = np.all(frame == rmdv.SPEED_BAR_COLOR, axis=2).astype(np.uint8)
        component_count, _labels = cv2.connectedComponents(bar_mask)
        assert component_count - 1 == expected_bar_count
        assert np.count_nonzero(np.all(frame == rmdv.HAND_SKELETON_COLOR, axis=2)) > 0
        assert np.count_nonzero(frame[:, : WIDTH // 2]) == 0
        assert np.count_nonzero(frame[:, WIDTH // 2 :]) > 0


def test_draw_speed_hand_only_marks_palm_landmarks() -> None:
    right = _hand("Right")
    right["landmarks"][8]["x"] = 0.1
    right["landmarks"][8]["y"] = 0.1
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)

    assert rmdv.draw_speed_hand(frame, (right,), WIDTH, HEIGHT, 0.5)

    fingertip = right["landmarks"][8]
    fingertip_x = round(fingertip["x"] * WIDTH)
    fingertip_y = round(fingertip["y"] * HEIGHT)
    assert np.count_nonzero(frame[
        fingertip_y - 2:fingertip_y + 3,
        fingertip_x - 2:fingertip_x + 3,
    ]) == 0


def test_watch_strength_uses_fixed_scale_after_rolling_average(tmp_path: Path) -> None:
    watch_csv_path = tmp_path / f"{SESSION_ID}_synced_pose_imu.csv"
    _write_watch_csv(watch_csv_path, [0.0, 0.0, 0.6, 0.6, 0.6, 0.6])

    strengths = rmdv.load_watch_strengths(
        watch_csv_path,
        SESSION_ID,
        list(range(6)),
    )

    assert strengths[1] == 0.0
    assert strengths[2] == pytest.approx((0.2 - 0.05) / 0.55)
    assert strengths[5] == pytest.approx((0.48 - 0.05) / 0.55)


def test_watch_strength_rejects_left_wrist_rows(tmp_path: Path) -> None:
    watch_csv_path = tmp_path / f"{SESSION_ID}_synced_pose_imu.csv"
    _write_watch_csv(watch_csv_path, [0.1], wrist_side="left")

    with pytest.raises(ValueError, match="right-wrist"):
        rmdv.load_watch_strengths(watch_csv_path, SESSION_ID, [0])


def test_watch_motion_ring_grows_without_filling_the_wrist() -> None:
    right = _hand("Right")
    small = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    large = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)

    assert rmdv.draw_watch_motion_ring(small, (right,), WIDTH, HEIGHT, 0.0)
    assert rmdv.draw_watch_motion_ring(large, (right,), WIDTH, HEIGHT, 1.0)

    small_pixels = np.argwhere(np.all(small == rmdv.WATCH_RING_COLOR, axis=2))
    large_pixels = np.argwhere(np.all(large == rmdv.WATCH_RING_COLOR, axis=2))
    assert np.ptp(large_pixels[:, 0]) > np.ptp(small_pixels[:, 0])
    assert np.ptp(large_pixels[:, 1]) > np.ptp(small_pixels[:, 1])
    wrist = right["landmarks"][0]
    wrist_x = round(wrist["x"] * WIDTH)
    wrist_y = round(wrist["y"] * HEIGHT)
    assert np.count_nonzero(large[wrist_y - 1:wrist_y + 2, wrist_x - 1:wrist_x + 2]) == 0


def test_out_of_frame_fingertip_does_not_hide_visible_palm() -> None:
    first_hand = _hand()
    second_hand = _hand(offset_x=0.02)
    second_hand["landmarks"][4]["x"] = 1.05
    frames = [
        rmdv.HandFrame(0, 0.0, (first_hand,)),
        rmdv.HandFrame(1, 100.0, (second_hand,)),
    ]
    rendered = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)

    assert rmdv.draw_speed_hand(rendered, (second_hand,), WIDTH, HEIGHT, 0.5)
    assert np.count_nonzero(rendered) > 0


def test_select_right_hand_never_uses_left_hand() -> None:
    assert rmdv.select_right_hand([_hand("Left")]) is None


def test_validate_input_identity_rejects_similar_session_prefix() -> None:
    timeline = rmdv.HandTimeline(metadata={}, frames_by_index={})

    with pytest.raises(ValueError, match="complete video session ID"):
        rmdv._validate_input_identity(
            Path(f"{SESSION_ID}.mp4"),
            Path(f"{SESSION_ID}2_hand_landmarks.json"),
            timeline,
            FPS,
            WIDTH,
            HEIGHT,
            FRAME_COUNT,
        )


def test_selected_frames_support_full_remainder_and_custom_duration(tmp_path: Path) -> None:
    hand_json_path = tmp_path / f"{SESSION_ID}_hand_landmarks.json"
    _write_hand_json(hand_json_path)
    timeline = rmdv.load_hand_timeline(hand_json_path)

    assert rmdv._selected_frame_indices(timeline, 0.5, None, FPS, FRAME_COUNT) == list(
        range(5, 60)
    )
    assert rmdv._selected_frame_indices(timeline, 0.5, 5.0, FPS, FRAME_COUNT) == list(
        range(5, 55)
    )
    assert rmdv._selected_frame_indices(timeline, 5.0, 1.0, FPS, FRAME_COUNT) == list(
        range(50, 60)
    )
    assert rmdv._selected_frame_indices(timeline, 0.0, 0.05, FPS, FRAME_COUNT) == [0]
    with pytest.raises(ValueError, match="shorter than one"):
        rmdv._selected_frame_indices(timeline, 0.0, 0.04, FPS, FRAME_COUNT)
    with pytest.raises(ValueError, match="past the end"):
        rmdv._selected_frame_indices(timeline, 5.0, 1.1, FPS, FRAME_COUNT)


def test_render_motion_demo_video_writes_two_aligned_parts(tmp_path: Path) -> None:
    video_path, hand_json_path, output_path = _fixture_paths(tmp_path)
    _write_video(video_path)
    _write_hand_json(hand_json_path)

    result = rmdv.render_motion_demo_video(
        video_path=video_path,
        hand_json_path=hand_json_path,
        output_path=output_path,
        start_sec=0.5,
        duration_sec=5.0,
    )

    assert result["source_frame_count"] == 50
    assert result["source_start_frame"] == 5
    assert result["source_duration_sec"] == pytest.approx(5.0)
    assert result["frame_count"] == 100
    assert result["duration_sec"] == pytest.approx(10.0)
    capture = cv2.VideoCapture(str(output_path))
    try:
        assert capture.isOpened()
        assert int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) == 100
        assert capture.get(cv2.CAP_PROP_FPS) == pytest.approx(FPS)
        sampled_frames = {}
        for frame_index in range(100):
            ok, frame = capture.read()
            assert ok
            if frame_index in {0, 49, 50, 99}:
                sampled_frames[frame_index] = frame
        marker_slice = np.s_[305:345, 545:625]
        assert np.mean(cv2.absdiff(
            sampled_frames[0][marker_slice], sampled_frames[50][marker_slice]
        )) < 3.0
        assert np.mean(cv2.absdiff(
            sampled_frames[49][marker_slice], sampled_frames[99][marker_slice]
        )) < 3.0
        assert np.mean(cv2.absdiff(
            sampled_frames[0][marker_slice], sampled_frames[49][marker_slice]
        )) > 20.0
        assert np.mean(cv2.absdiff(sampled_frames[0], sampled_frames[50])) > 0.1
    finally:
        capture.release()


def test_render_refuses_existing_output_before_overwrite(tmp_path: Path) -> None:
    video_path, hand_json_path, output_path = _fixture_paths(tmp_path)
    for input_path in (video_path, hand_json_path):
        input_path.write_text("placeholder", encoding="utf-8")
    output_path.write_bytes(b"keep-me")

    with pytest.raises(FileExistsError, match="Output already exists"):
        rmdv.render_motion_demo_video(
            video_path=video_path,
            hand_json_path=hand_json_path,
            output_path=output_path,
            start_sec=0.0,
        )

    assert output_path.read_bytes() == b"keep-me"


def test_render_does_not_overwrite_output_created_while_rendering(
    monkeypatch,
    tmp_path: Path,
) -> None:
    video_path, hand_json_path, output_path = _fixture_paths(tmp_path)
    _write_video(video_path)
    _write_hand_json(hand_json_path)
    validate_rendered_video = rmdv._validate_rendered_video

    def validate_then_create_competing_output(*args, **kwargs) -> None:
        validate_rendered_video(*args, **kwargs)
        output_path.write_bytes(b"competing-output")

    monkeypatch.setattr(rmdv, "_validate_rendered_video", validate_then_create_competing_output)

    with pytest.raises(FileExistsError):
        rmdv.render_motion_demo_video(
            video_path=video_path,
            hand_json_path=hand_json_path,
            output_path=output_path,
            start_sec=0.0,
            duration_sec=1.0,
        )

    assert output_path.read_bytes() == b"competing-output"


@pytest.mark.parametrize(
    ("optional_args", "expected"),
    [
        ([], (0.0, None, None)),
        (["--start-sec", "1.5", "--duration-sec", "4"], (1.5, 4.0, None)),
        (["--watch-csv", "synced.csv"], (0.0, None, Path("synced.csv"))),
    ],
)
def test_main_forwards_configurable_duration_options(
    monkeypatch,
    optional_args: list[str],
    expected: tuple[float, float | None, Path | None],
) -> None:
    calls = []

    def fake_render_motion_demo_video(**kwargs):
        calls.append(kwargs)
        return {
            "output_path": kwargs["output_path"],
            "source_frame_count": 10,
            "frame_count": 20,
            "duration_sec": 2.0,
        }

    monkeypatch.setattr(rmdv, "render_motion_demo_video", fake_render_motion_demo_video)
    monkeypatch.setattr(sys, "argv", [
        "render_motion_demo_video.py",
        "video.mp4",
        "--hand-json",
        "hand.json",
        "-o",
        "output.mp4",
        *optional_args,
    ])

    rmdv.main()

    assert len(calls) == 1
    assert (
        calls[0]["start_sec"],
        calls[0]["duration_sec"],
        calls[0]["watch_csv_path"],
    ) == expected
