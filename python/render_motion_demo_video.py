import argparse
import csv
import json
import math
import os
import statistics
import tempfile
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from render_pose_overlay_video import (
    CV2_CAP_PROP_FPS,
    CV2_CAP_PROP_FRAME_COUNT,
    CV2_CAP_PROP_FRAME_HEIGHT,
    CV2_CAP_PROP_FRAME_WIDTH,
    create_video_writer,
    open_video_capture,
)


CV2_CAP_PROP_POS_FRAMES = 1
MIN_HAND_SCORE = 0.5
MIN_HAND_SCORE_MARGIN = 0.1
MIN_PALM_WIDTH_PX = 8.0
MAX_SPEED_PALM_WIDTHS_PER_SEC = 24.0
LOW_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC = MAX_SPEED_PALM_WIDTHS_PER_SEC / 3.0
HIGH_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC = MAX_SPEED_PALM_WIDTHS_PER_SEC * 2.0 / 3.0
SPEED_SMOOTHING_WINDOW_MS = 400.0
MIN_SPEED_BAND_HOLD_MS = 500.0
SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC = 1.0

LOW_SPEED_MAX_PULSE = 1.0 / 3.0
MEDIUM_SPEED_MAX_PULSE = 2.0 / 3.0
HAND_LINE_WIDTH = 4
HAND_POINT_RADIUS = 4
HAND_SKELETON_COLOR = (240, 240, 240)
SPEED_BAR_COLOR = (10, 214, 255)  # OpenCV BGR for sRGB #FFD60A.
PALM_LANDMARK_INDICES = (0, 5, 9, 13, 17)
PALM_CONNECTIONS = ((0, 5), (5, 9), (9, 13), (13, 17), (17, 0))
INK_COLOR = (8, 15, 22)
TEXT_COLOR = (245, 250, 249)
WATCH_RING_COLOR = (149, 45, 255)  # OpenCV BGR for sRGB #FF2D95.
WATCH_RING_LINE_WIDTH = 6
WATCH_RING_MIN_RADIUS_PALM_WIDTHS = 0.28
WATCH_RING_MAX_RADIUS_PALM_WIDTHS = 0.75
WATCH_ACCEL_SMOOTHING_WINDOW_MS = 400.0
WATCH_ACCEL_BASELINE_G = 0.05
WATCH_ACCEL_MAX_G = 0.60


@dataclass(frozen=True)
class HandFrame:
    frame_index: int
    timestamp_ms: float
    hands: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class HandTimeline:
    metadata: dict[str, Any]
    frames_by_index: dict[int, HandFrame]


def _finite_float(value: Any, label: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a finite number") from error
    if not math.isfinite(parsed):
        raise ValueError(f"{label} must be a finite number")
    return parsed


def _non_negative_integer(value: Any, label: str) -> int:
    parsed = _finite_float(value, label)
    if not parsed.is_integer() or parsed < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return int(parsed)


def load_hand_timeline(hand_json_path: Path) -> HandTimeline:
    payload = json.loads(hand_json_path.read_text(encoding="utf-8"))
    metadata = payload.get("metadata")
    frames = payload.get("frames")
    if not isinstance(metadata, dict) or not isinstance(frames, list):
        raise ValueError("Hand JSON must contain metadata and frames")

    frames_by_index: dict[int, HandFrame] = {}
    previous_frame_index = -1
    previous_timestamp_ms = -math.inf
    for position, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise ValueError(f"Hand frame {position} must be an object")
        frame_index = _non_negative_integer(frame.get("frameIndex"), "Hand frameIndex")
        timestamp_ms = _finite_float(frame.get("timestampMs"), "Hand timestampMs")
        if frame_index <= previous_frame_index or timestamp_ms <= previous_timestamp_ms:
            raise ValueError("Hand frames must have unique, increasing frameIndex and timestampMs")
        hands = frame.get("hands", [])
        if not isinstance(hands, list):
            raise ValueError(f"Hand frame {frame_index} hands must be an array")
        frames_by_index[frame_index] = HandFrame(frame_index, timestamp_ms, tuple(hands))
        previous_frame_index = frame_index
        previous_timestamp_ms = timestamp_ms

    if not frames_by_index:
        raise ValueError("Hand JSON contains no frames")
    return HandTimeline(metadata=metadata, frames_by_index=frames_by_index)


def _valid_landmarks(hand: dict[str, Any]) -> list[dict[str, Any]] | None:
    landmarks = hand.get("landmarks")
    if not isinstance(landmarks, list) or len(landmarks) != 21:
        return None
    for landmark in landmarks:
        if not isinstance(landmark, dict):
            return None
        try:
            x = float(landmark["x"])
            y = float(landmark["y"])
        except (KeyError, TypeError, ValueError):
            return None
        if not math.isfinite(x) or not math.isfinite(y):
            return None
    return landmarks


def select_right_hand(hands: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates: list[tuple[float, dict[str, Any]]] = []
    for hand in hands:
        if not isinstance(hand, dict):
            continue
        if hand.get("handedness") != "Right" or _valid_landmarks(hand) is None:
            continue
        score = _finite_float(hand.get("score", 0.0), "Hand score")
        if score >= MIN_HAND_SCORE:
            candidates.append((score, hand))
    candidates.sort(key=lambda candidate: candidate[0], reverse=True)
    if not candidates:
        return None
    if len(candidates) > 1 and candidates[0][0] - candidates[1][0] < MIN_HAND_SCORE_MARGIN:
        return None
    return candidates[0][1]


def _palm_geometry_pixels(
    hand: dict[str, Any],
    width: int,
    height: int,
) -> tuple[tuple[float, float], float] | None:
    landmarks = _valid_landmarks(hand)
    if landmarks is None:
        return None

    palm_indices = (0, 5, 9, 13, 17)
    points = [
        (float(landmarks[index]["x"]) * width, float(landmarks[index]["y"]) * height)
        for index in palm_indices
    ]
    center = (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )
    palm_width = math.dist(points[1], points[4])
    return center, palm_width


def _speed_pulses(
    timeline: HandTimeline,
    selected_frame_indices: list[int],
    fps: float,
    width: int,
    height: int,
) -> dict[int, float]:
    geometries: dict[int, tuple[tuple[float, float], float] | None] = {}
    usable_widths: list[float] = []
    for frame_index in selected_frame_indices:
        hand = select_right_hand(timeline.frames_by_index[frame_index].hands)
        geometry = _palm_geometry_pixels(hand, width, height) if hand is not None else None
        if geometry is not None and geometry[1] >= MIN_PALM_WIDTH_PX:
            geometries[frame_index] = geometry
            usable_widths.append(geometry[1])
        else:
            geometries[frame_index] = None

    if not usable_widths:
        raise ValueError("Selected interval has no usable right-hand palm width")
    representative_palm_width = statistics.median(usable_widths)

    expected_interval_ms = 1_000.0 / fps
    minimum_interval_ms = expected_interval_ms * 0.5
    maximum_interval_ms = expected_interval_ms * 1.5
    pulses: dict[int, float] = {}
    previous_frame: HandFrame | None = None
    previous_geometry: tuple[tuple[float, float], float] | None = None
    speed_samples: deque[tuple[float, float]] = deque()
    speed_band = 0
    last_band_change_ms = timeline.frames_by_index[selected_frame_indices[0]].timestamp_ms

    for frame_index in selected_frame_indices:
        current_frame = timeline.frames_by_index[frame_index]
        current_geometry = geometries[frame_index]
        elapsed_ms = (
            current_frame.timestamp_ms - previous_frame.timestamp_ms
            if previous_frame is not None
            else 0.0
        )
        if (
            current_geometry is not None
            and previous_geometry is not None
            and previous_frame is not None
            and current_frame.frame_index == previous_frame.frame_index + 1
            and minimum_interval_ms <= elapsed_ms <= maximum_interval_ms
        ):
            distance_px = math.dist(previous_geometry[0], current_geometry[0])
            speed = distance_px / (elapsed_ms / 1_000.0) / representative_palm_width
            speed_samples.append((current_frame.timestamp_ms, speed))

        window_start_ms = current_frame.timestamp_ms - SPEED_SMOOTHING_WINDOW_MS
        while speed_samples and speed_samples[0][0] < window_start_ms:
            speed_samples.popleft()
        smoothed_speed = (
            statistics.fmean(sample[1] for sample in speed_samples)
            if speed_samples
            else 0.0
        )

        low_enter = (
            LOW_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC
            + SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC
        )
        low_exit = (
            LOW_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC
            - SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC
        )
        high_enter = (
            HIGH_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC
            + SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC
        )
        high_exit = (
            HIGH_SPEED_THRESHOLD_PALM_WIDTHS_PER_SEC
            - SPEED_HYSTERESIS_PALM_WIDTHS_PER_SEC
        )
        candidate_band = speed_band
        if speed_band == 0:
            if smoothed_speed >= high_enter:
                candidate_band = 2
            elif smoothed_speed >= low_enter:
                candidate_band = 1
        elif speed_band == 1:
            if smoothed_speed >= high_enter:
                candidate_band = 2
            elif smoothed_speed < low_exit:
                candidate_band = 0
        elif smoothed_speed < low_exit:
            candidate_band = 0
        elif smoothed_speed < high_exit:
            candidate_band = 1

        if (
            candidate_band != speed_band
            and current_frame.timestamp_ms - last_band_change_ms >= MIN_SPEED_BAND_HOLD_MS
        ):
            speed_band = candidate_band
            last_band_change_ms = current_frame.timestamp_ms

        pulses[frame_index] = (0.0, 0.5, 1.0)[speed_band]
        previous_frame = current_frame
        previous_geometry = current_geometry

    return pulses


def _draw_palm_overlay(
    frame: Any,
    hand: dict[str, Any],
    width: int,
    height: int,
    color: tuple[int, int, int],
    line_width: int,
    point_radius: int,
) -> None:
    import cv2

    landmarks = _valid_landmarks(hand)
    if landmarks is None:
        return
    points = {
        index: (
            round(float(landmarks[index]["x"]) * width),
            round(float(landmarks[index]["y"]) * height),
        )
        for index in PALM_LANDMARK_INDICES
    }
    for start, end in PALM_CONNECTIONS:
        cv2.line(frame, points[start], points[end], color, line_width, cv2.LINE_AA)
    for point in points.values():
        cv2.circle(frame, point, point_radius, color, -1, cv2.LINE_AA)


def _draw_speed_level_bars(
    frame: Any,
    hand: dict[str, Any],
    width: int,
    height: int,
    level: int,
) -> None:
    import cv2

    landmarks = _valid_landmarks(hand)
    geometry = _palm_geometry_pixels(hand, width, height)
    if landmarks is None or geometry is None or level not in {1, 2, 3}:
        return

    palm_center, palm_width = geometry
    index_base = (
        float(landmarks[5]["x"]) * width,
        float(landmarks[5]["y"]) * height,
    )
    little_base = (
        float(landmarks[17]["x"]) * width,
        float(landmarks[17]["y"]) * height,
    )
    across_x = (little_base[0] - index_base[0]) / palm_width
    across_y = (little_base[1] - index_base[1]) / palm_width
    stack_x, stack_y = -across_y, across_x
    offsets = {
        1: (0.0,),
        2: (-0.12, 0.12),
        3: (-0.18, 0.0, 0.18),
    }[level]
    half_length = palm_width * 0.24
    line_width = max(5, round(palm_width * 0.065))

    for offset in offsets:
        center_x = palm_center[0] + stack_x * palm_width * offset
        center_y = palm_center[1] + stack_y * palm_width * offset
        start = (
            round(center_x - across_x * half_length),
            round(center_y - across_y * half_length),
        )
        end = (
            round(center_x + across_x * half_length),
            round(center_y + across_y * half_length),
        )
        cv2.line(frame, start, end, INK_COLOR, line_width + 5, cv2.LINE_AA)
        cv2.line(frame, start, end, SPEED_BAR_COLOR, line_width, cv2.LINE_AA)


def draw_speed_hand(
    frame: Any,
    hands: tuple[dict[str, Any], ...] | list[dict[str, Any]],
    width: int,
    height: int,
    pulse: float,
) -> bool:
    right_hand = select_right_hand(hands)
    if right_hand is None:
        return False
    geometry = _palm_geometry_pixels(right_hand, width, height)
    if geometry is None or geometry[1] < MIN_PALM_WIDTH_PX:
        return False

    speed_state = max(0.0, min(1.0, float(pulse)))
    if speed_state < LOW_SPEED_MAX_PULSE:
        speed_level = 1
    elif speed_state < MEDIUM_SPEED_MAX_PULSE:
        speed_level = 2
    else:
        speed_level = 3

    _draw_palm_overlay(
        frame,
        right_hand,
        width,
        height,
        INK_COLOR,
        HAND_LINE_WIDTH + 3,
        HAND_POINT_RADIUS + 2,
    )
    _draw_palm_overlay(
        frame,
        right_hand,
        width,
        height,
        HAND_SKELETON_COLOR,
        HAND_LINE_WIDTH,
        HAND_POINT_RADIUS,
    )
    _draw_speed_level_bars(frame, right_hand, width, height, speed_level)
    return True


def load_watch_strengths(
    watch_csv_path: Path,
    video_session_id: str,
    selected_frame_indices: list[int],
) -> dict[int, float]:
    resolved_path = watch_csv_path.resolve(strict=True)
    expected_stem = f"{video_session_id}_synced_pose_imu"
    if resolved_path.stem != expected_stem:
        raise ValueError(
            "Watch CSV filename must contain the complete video session ID followed by "
            f"_synced_pose_imu; expected {expected_stem}.csv"
        )

    required_columns = {
        "timestamp_ms",
        "frame_index",
        "imu_session_id",
        "imu_wrist_side",
        "imu_accel_norm",
    }
    samples: list[tuple[int, float, float]] = []
    with resolved_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing_columns = required_columns.difference(reader.fieldnames or ())
        if missing_columns:
            raise ValueError(
                "Watch CSV is missing required columns: "
                + ", ".join(sorted(missing_columns))
            )
        previous_frame_index = -1
        previous_timestamp_ms = -math.inf
        for position, row in enumerate(reader):
            frame_index = _non_negative_integer(row["frame_index"], "Watch frame_index")
            timestamp_ms = _finite_float(row["timestamp_ms"], "Watch timestamp_ms")
            acceleration = _finite_float(row["imu_accel_norm"], "Watch imu_accel_norm")
            if frame_index <= previous_frame_index or timestamp_ms <= previous_timestamp_ms:
                raise ValueError("Watch rows must have increasing frame_index and timestamp_ms")
            if row["imu_session_id"] != video_session_id:
                raise ValueError(f"Watch row {position} session ID does not match the video")
            if row["imu_wrist_side"] != "right":
                raise ValueError(f"Watch row {position} must contain right-wrist data")
            if acceleration < 0:
                raise ValueError("Watch imu_accel_norm must not be negative")
            samples.append((frame_index, timestamp_ms, acceleration))
            previous_frame_index = frame_index
            previous_timestamp_ms = timestamp_ms

    if not samples:
        raise ValueError("Watch CSV contains no rows")

    strengths: dict[int, float] = {}
    acceleration_window: deque[tuple[float, float]] = deque()
    for frame_index, timestamp_ms, acceleration in samples:
        acceleration_window.append((timestamp_ms, acceleration))
        window_start_ms = timestamp_ms - WATCH_ACCEL_SMOOTHING_WINDOW_MS
        while acceleration_window and acceleration_window[0][0] < window_start_ms:
            acceleration_window.popleft()
        smoothed_acceleration = statistics.fmean(
            sample[1] for sample in acceleration_window
        )
        strength = (
            (smoothed_acceleration - WATCH_ACCEL_BASELINE_G)
            / (WATCH_ACCEL_MAX_G - WATCH_ACCEL_BASELINE_G)
        )
        strengths[frame_index] = max(0.0, min(1.0, strength))

    missing_frames = [
        frame_index
        for frame_index in selected_frame_indices
        if frame_index not in strengths
    ]
    if missing_frames:
        raise ValueError(f"Watch CSV is missing selected frame {missing_frames[0]}")
    return {frame_index: strengths[frame_index] for frame_index in selected_frame_indices}


def draw_watch_motion_ring(
    frame: Any,
    hands: tuple[dict[str, Any], ...] | list[dict[str, Any]],
    width: int,
    height: int,
    strength: float,
) -> bool:
    import cv2

    right_hand = select_right_hand(hands)
    if right_hand is None:
        return False
    geometry = _palm_geometry_pixels(right_hand, width, height)
    landmarks = _valid_landmarks(right_hand)
    if geometry is None or geometry[1] < MIN_PALM_WIDTH_PX or landmarks is None:
        return False

    wrist = landmarks[0]
    center = (
        round(float(wrist["x"]) * width),
        round(float(wrist["y"]) * height),
    )
    normalized_strength = max(0.0, min(1.0, float(strength)))
    radius_palm_widths = (
        WATCH_RING_MIN_RADIUS_PALM_WIDTHS
        + (WATCH_RING_MAX_RADIUS_PALM_WIDTHS - WATCH_RING_MIN_RADIUS_PALM_WIDTHS)
        * normalized_strength
    )
    radius = max(1, round(geometry[1] * radius_palm_widths))
    cv2.circle(
        frame,
        center,
        radius,
        INK_COLOR,
        WATCH_RING_LINE_WIDTH + 4,
        cv2.LINE_AA,
    )
    cv2.circle(
        frame,
        center,
        radius,
        WATCH_RING_COLOR,
        WATCH_RING_LINE_WIDTH,
        cv2.LINE_AA,
    )
    return True


def _draw_text_box(frame: Any, label: str) -> None:
    import cv2

    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = 0.55
    thickness = 1
    padding = 9
    text_width, text_height = cv2.getTextSize(label, font, font_scale, thickness)[0]
    overlay = frame.copy()
    cv2.rectangle(
        overlay,
        (16, 16),
        (16 + text_width + padding * 2, 16 + text_height + padding * 2),
        INK_COLOR,
        -1,
    )
    cv2.addWeighted(overlay, 0.82, frame, 0.18, 0.0, frame)
    cv2.putText(
        frame,
        label,
        (16 + padding, 16 + padding + text_height),
        font,
        font_scale,
        TEXT_COLOR,
        thickness,
        cv2.LINE_AA,
    )


def _validate_path_relationships(
    video_path: Path,
    hand_json_path: Path,
    output_path: Path,
) -> tuple[Path, Path, Path]:
    inputs = tuple(path.resolve(strict=True) for path in (video_path, hand_json_path))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_output = output_path.resolve()
    if resolved_output in inputs:
        raise ValueError("Output path must differ from every input path")
    if resolved_output.exists():
        raise FileExistsError(f"Output already exists: {resolved_output}")
    if resolved_output.suffix.lower() != ".mp4":
        raise ValueError("Output path must use the .mp4 extension")
    return (*inputs, resolved_output)


def _video_properties(video_path: Path) -> tuple[float, int, int, int]:
    capture = open_video_capture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Failed to open video: {video_path}")
    try:
        fps = float(capture.get(CV2_CAP_PROP_FPS) or 0.0)
        width = int(capture.get(CV2_CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(CV2_CAP_PROP_FRAME_HEIGHT) or 0)
        frame_count = int(capture.get(CV2_CAP_PROP_FRAME_COUNT) or 0)
    finally:
        capture.release()
    if not math.isfinite(fps) or fps <= 0 or width <= 0 or height <= 0 or frame_count <= 0:
        raise ValueError("Video must report positive fps, dimensions, and frame count")
    return fps, width, height, frame_count


def _validate_input_identity(
    video_path: Path,
    hand_json_path: Path,
    timeline: HandTimeline,
    fps: float,
    width: int,
    height: int,
    frame_count: int,
) -> None:
    expected_hand_stem = f"{video_path.stem}_hand_landmarks"
    if hand_json_path.stem != expected_hand_stem:
        raise ValueError(
            "Hand JSON filename must contain the complete video session ID followed by "
            f"_hand_landmarks; expected {expected_hand_stem}.json"
        )

    metadata = timeline.metadata
    if _non_negative_integer(metadata.get("frameCount"), "Hand metadata frameCount") != frame_count:
        raise ValueError("Hand JSON frame count does not match the video")
    if _non_negative_integer(metadata.get("sourceWidth"), "Hand metadata sourceWidth") != width:
        raise ValueError("Hand JSON width does not match the video")
    if _non_negative_integer(metadata.get("sourceHeight"), "Hand metadata sourceHeight") != height:
        raise ValueError("Hand JSON height does not match the video")
    estimated_fps = _finite_float(metadata.get("estimatedFps"), "Hand metadata estimatedFps")
    if abs(estimated_fps - fps) > max(0.5, fps * 0.02):
        raise ValueError("Hand JSON fps does not match the video")


def _selected_frame_indices(
    timeline: HandTimeline,
    start_sec: float,
    source_duration_sec: float | None,
    fps: float,
    video_frame_count: int,
) -> list[int]:
    start_frame_value = start_sec * fps
    if not math.isfinite(start_frame_value):
        raise ValueError("start-sec is too large")
    start_frame_index = int(math.floor(start_frame_value + 0.5))
    if start_frame_index >= video_frame_count:
        raise ValueError("start-sec is at or after the end of the video")

    if source_duration_sec is None:
        selected_frame_count = video_frame_count - start_frame_index
    else:
        selected_frame_value = source_duration_sec * fps
        if not math.isfinite(selected_frame_value):
            raise ValueError("duration-sec is too large")
        selected_frame_count = int(math.floor(selected_frame_value + 0.5))
        if selected_frame_count <= 0:
            raise ValueError("duration-sec is shorter than one output frame")
    selected_end_frame = start_frame_index + selected_frame_count
    if selected_end_frame > video_frame_count:
        raise ValueError("Requested interval extends past the end of the video")

    selected = list(range(start_frame_index, selected_end_frame))
    for frame_index in selected:
        if frame_index not in timeline.frames_by_index:
            raise ValueError(f"Hand JSON is missing selected frame {frame_index}")
    start_timestamp_ms = timeline.frames_by_index[selected[0]].timestamp_ms
    frame_interval_ms = 1_000.0 / fps
    maximum_timing_error_ms = frame_interval_ms / 2.0
    for offset, frame_index in enumerate(selected):
        actual_timestamp_ms = timeline.frames_by_index[frame_index].timestamp_ms
        expected_timestamp_ms = start_timestamp_ms + offset * frame_interval_ms
        if abs(actual_timestamp_ms - expected_timestamp_ms) > maximum_timing_error_ms:
            raise ValueError("Selected video interval must have a stable constant frame rate")
    return selected


def _open_video_at_frame(video_path: Path, frame_index: int):
    capture = open_video_capture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Failed to open video: {video_path}")
    if frame_index == 0:
        return capture
    seek_succeeded = bool(capture.set(CV2_CAP_PROP_POS_FRAMES, float(frame_index)))
    landed_frame = int(round(capture.get(CV2_CAP_PROP_POS_FRAMES) or 0))
    if seek_succeeded and landed_frame == frame_index:
        return capture

    capture.release()
    capture = open_video_capture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Failed to reopen video: {video_path}")
    for discarded_index in range(frame_index):
        ok, _frame = capture.read()
        if not ok:
            capture.release()
            raise ValueError(f"Video ended while seeking to frame {frame_index} at {discarded_index}")
    return capture


def _render_part(
    video_path: Path,
    writer: Any,
    selected_frame_indices: list[int],
    timeline: HandTimeline,
    width: int,
    height: int,
    label: str,
    pulses: dict[int, float] | None = None,
    watch_strengths: dict[int, float] | None = None,
) -> None:
    capture = _open_video_at_frame(video_path, selected_frame_indices[0])
    try:
        for frame_index in selected_frame_indices:
            ok, frame = capture.read()
            if not ok:
                raise ValueError(f"Video ended before selected frame {frame_index}")
            hands = timeline.frames_by_index[frame_index].hands
            if watch_strengths is not None:
                draw_watch_motion_ring(
                    frame,
                    hands,
                    width,
                    height,
                    watch_strengths[frame_index],
                )
            if pulses is not None:
                draw_speed_hand(
                    frame,
                    hands,
                    width,
                    height,
                    pulses[frame_index],
                )
            _draw_text_box(frame, label)
            writer.write(frame)
    finally:
        capture.release()


def _validate_rendered_video(
    output_path: Path,
    expected_frame_count: int,
    expected_fps: float,
    expected_width: int,
    expected_height: int,
) -> None:
    capture = open_video_capture(output_path)
    if not capture.isOpened():
        raise RuntimeError(f"Failed to reopen rendered video: {output_path}")
    try:
        fps = float(capture.get(CV2_CAP_PROP_FPS) or 0.0)
        width = int(capture.get(CV2_CAP_PROP_FRAME_WIDTH) or 0)
        height = int(capture.get(CV2_CAP_PROP_FRAME_HEIGHT) or 0)
        if abs(fps - expected_fps) > max(0.05, expected_fps * 0.002):
            raise RuntimeError(f"Rendered video fps is {fps}; expected {expected_fps}")
        if (width, height) != (expected_width, expected_height):
            raise RuntimeError("Rendered video dimensions do not match the input")
        decoded_frame_count = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame.shape[:2] != (expected_height, expected_width):
                raise RuntimeError(
                    f"Rendered frame {decoded_frame_count} dimensions do not match the input"
                )
            decoded_frame_count += 1
        if decoded_frame_count != expected_frame_count:
            raise RuntimeError(
                f"Rendered video has {decoded_frame_count} decodable frames; "
                f"expected {expected_frame_count}"
            )
    finally:
        capture.release()


def render_motion_demo_video(
    video_path: Path,
    hand_json_path: Path,
    output_path: Path,
    start_sec: float = 0.0,
    duration_sec: float | None = None,
    watch_csv_path: Path | None = None,
) -> dict[str, Any]:
    start_sec = _finite_float(start_sec, "start-sec")
    if duration_sec is not None:
        duration_sec = _finite_float(duration_sec, "duration-sec")
    if start_sec < 0:
        raise ValueError("start-sec must not be negative")
    if duration_sec is not None and duration_sec <= 0:
        raise ValueError("duration-sec must be greater than zero")

    video_path, hand_json_path, output_path = _validate_path_relationships(
        video_path,
        hand_json_path,
        output_path,
    )
    hand_timeline = load_hand_timeline(hand_json_path)
    fps, width, height, video_frame_count = _video_properties(video_path)
    _validate_input_identity(
        video_path,
        hand_json_path,
        hand_timeline,
        fps,
        width,
        height,
        video_frame_count,
    )
    selected_frame_indices = _selected_frame_indices(
        hand_timeline,
        start_sec,
        duration_sec,
        fps,
        video_frame_count,
    )
    pulses = _speed_pulses(
        hand_timeline,
        selected_frame_indices,
        fps,
        width,
        height,
    )
    watch_strengths = (
        load_watch_strengths(watch_csv_path, video_path.stem, selected_frame_indices)
        if watch_csv_path is not None
        else None
    )

    expected_frame_count = len(selected_frame_indices) * 2
    temporary_path: Path | None = None
    writer = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output_path.stem}-",
            suffix=".tmp.mp4",
            dir=output_path.parent,
        )
        os.close(descriptor)
        temporary_path = Path(temporary_name)
        writer = create_video_writer(temporary_path, fps, (width, height))
        if hasattr(writer, "isOpened") and not writer.isOpened():
            raise RuntimeError(f"Failed to open video writer: {temporary_path}")

        _render_part(
            video_path,
            writer,
            selected_frame_indices,
            hand_timeline,
            width,
            height,
            "ORIGINAL",
        )
        _render_part(
            video_path,
            writer,
            selected_frame_indices,
            hand_timeline,
            width,
            height,
            "HAND SPEED + WATCH MOTION" if watch_strengths is not None else "SPEED + RHYTHM",
            pulses,
            watch_strengths,
        )
        writer.release()
        writer = None

        _validate_rendered_video(temporary_path, expected_frame_count, fps, width, height)
        os.link(temporary_path, output_path)
        temporary_path.unlink()
        temporary_path = None
    finally:
        if writer is not None:
            writer.release()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

    return {
        "output_path": output_path,
        "frame_count": expected_frame_count,
        "fps": fps,
        "source_start_frame": selected_frame_indices[0],
        "source_frame_count": len(selected_frame_indices),
        "source_duration_sec": len(selected_frame_indices) / fps,
        "duration_sec": expected_frame_count / fps,
        "watch_ring": watch_strengths is not None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="一人分の調理動画を元映像と速度・リズム強調表示の2部で生成"
    )
    parser.add_argument("video_path", type=Path, help="入力動画")
    parser.add_argument("--hand-json", type=Path, required=True, help="Hand landmarks JSON")
    parser.add_argument(
        "--watch-csv",
        type=Path,
        default=None,
        help="動画frameへ同期済みの右手首IMU CSV",
    )
    parser.add_argument("--start-sec", type=float, default=0.0, help="対象区間の開始時刻（既定: 0秒）")
    parser.add_argument(
        "--duration-sec",
        type=float,
        default=None,
        help="対象区間の長さ（未指定時は動画末尾まで）",
    )
    parser.add_argument("-o", "--output-path", type=Path, required=True, help="新規出力MP4")
    args = parser.parse_args()

    result = render_motion_demo_video(
        video_path=args.video_path,
        hand_json_path=args.hand_json,
        output_path=args.output_path,
        start_sec=args.start_sec,
        duration_sec=args.duration_sec,
        watch_csv_path=args.watch_csv,
    )
    print(f"[保存] Motion demo: {result['output_path']}")
    print(
        f"[構成] {result['source_frame_count']} frames x 2 = "
        f"{result['frame_count']} frames / {result['duration_sec']:.2f} sec"
    )


if __name__ == "__main__":
    main()
