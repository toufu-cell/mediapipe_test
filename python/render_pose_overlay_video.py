import argparse
import json
from pathlib import Path
from typing import Any

from progress_utils import build_progress_reporter, ProgressCallback

CV2_CAP_PROP_FRAME_WIDTH = 3
CV2_CAP_PROP_FRAME_HEIGHT = 4
CV2_CAP_PROP_FPS = 5
CV2_CAP_PROP_FRAME_COUNT = 7

POSE_CONNECTIONS: list[tuple[int, int]] = [
    (0, 1), (1, 2), (2, 3), (3, 7),
    (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10),
    (11, 12), (11, 23), (12, 24), (23, 24),
    (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19),
    (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (23, 25), (25, 27), (27, 29), (27, 31), (29, 31),
    (24, 26), (26, 28), (28, 30), (28, 32), (30, 32),
]
HAND_CONNECTIONS: list[tuple[int, int]] = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (0, 9), (9, 10), (10, 11), (11, 12),
    (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
    (5, 9), (9, 13), (13, 17),
]

DEFAULT_STYLE = {
    "line_color": (0, 255, 0),
    "point_color": (0, 255, 255),
    "line_width": 2,
    "point_radius": 4,
    "min_visibility": 0.0,
}
DEFAULT_HAND_STYLE = {
    "line_color": (255, 128, 0),
    "point_color": (255, 255, 0),
    "line_width": 2,
    "point_radius": 3,
}


def open_video_capture(video_path: Path):
    import cv2

    return cv2.VideoCapture(str(video_path))


def create_video_writer(output_path: Path, fps: float, frame_size: tuple[int, int]):
    import cv2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    return cv2.VideoWriter(str(output_path), fourcc, fps, frame_size)


def load_skeleton_frames(skeleton_json_path: Path) -> dict[int, list[dict[str, float]] | None]:
    payload = json.loads(skeleton_json_path.read_text(encoding="utf-8"))
    frames = payload.get("frames", [])
    return {
        int(frame["frameIndex"]): frame.get("landmarks")
        for frame in frames
    }


def load_hand_frames(hand_json_path: Path | None) -> dict[int, list[dict[str, Any]]]:
    if hand_json_path is None:
        return {}
    payload = json.loads(hand_json_path.read_text(encoding="utf-8"))
    frames = payload.get("frames", [])
    return {
        int(frame["frameIndex"]): frame.get("hands", [])
        for frame in frames
    }


def _to_pixel_coordinates(landmark: dict[str, float], width: int, height: int) -> tuple[int, int]:
    x = int(round(float(landmark["x"]) * width))
    y = int(round(float(landmark["y"]) * height))
    x = max(0, min(width - 1, x))
    y = max(0, min(height - 1, y))
    return x, y


def _is_landmark_visible(landmark: dict[str, float], min_visibility: float) -> bool:
    visibility = float(landmark.get("visibility", 1.0))
    return visibility > 0.0 and visibility >= min_visibility


def draw_pose_overlay(
    frame: Any,
    landmarks: list[dict[str, float]],
    width: int,
    height: int,
    style: dict[str, Any],
) -> None:
    import cv2

    min_visibility = float(style["min_visibility"])

    for start_idx, end_idx in POSE_CONNECTIONS:
        start = landmarks[start_idx]
        end = landmarks[end_idx]
        if not _is_landmark_visible(start, min_visibility):
            continue
        if not _is_landmark_visible(end, min_visibility):
            continue

        start_xy = _to_pixel_coordinates(start, width, height)
        end_xy = _to_pixel_coordinates(end, width, height)
        cv2.line(frame, start_xy, end_xy, style["line_color"], style["line_width"], cv2.LINE_AA)

    for landmark in landmarks:
        if not _is_landmark_visible(landmark, min_visibility):
            continue
        center = _to_pixel_coordinates(landmark, width, height)
        cv2.circle(frame, center, style["point_radius"], style["point_color"], -1, cv2.LINE_AA)


def draw_hand_overlay(
    frame: Any,
    hands: list[dict[str, Any]],
    width: int,
    height: int,
    style: dict[str, Any],
) -> None:
    import cv2

    for hand in hands:
        landmarks = hand.get("landmarks", [])
        if len(landmarks) < 21:
            continue

        for start_idx, end_idx in HAND_CONNECTIONS:
            start_xy = _to_pixel_coordinates(landmarks[start_idx], width, height)
            end_xy = _to_pixel_coordinates(landmarks[end_idx], width, height)
            cv2.line(frame, start_xy, end_xy, style["line_color"], style["line_width"], cv2.LINE_AA)

        for landmark in landmarks:
            center = _to_pixel_coordinates(landmark, width, height)
            cv2.circle(frame, center, style["point_radius"], style["point_color"], -1, cv2.LINE_AA)


def render_pose_overlay_video(
    video_path: Path,
    skeleton_json_path: Path,
    output_path: Path,
    progress_callback: ProgressCallback | None = None,
    hand_json_path: Path | None = None,
) -> dict[str, Any]:
    skeleton_frames = load_skeleton_frames(skeleton_json_path)
    hand_frames = load_hand_frames(hand_json_path)
    capture = open_video_capture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Failed to open video: {video_path}")

    fps = float(capture.get(CV2_CAP_PROP_FPS) or 0.0)
    if fps <= 0:
        fps = 30.0
    total_frames = int(capture.get(CV2_CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(CV2_CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(CV2_CAP_PROP_FRAME_HEIGHT) or 0)

    writer = create_video_writer(output_path, fps, (width, height))
    if hasattr(writer, "isOpened") and not writer.isOpened():
        capture.release()
        raise RuntimeError(f"Failed to open video writer: {output_path}")

    frame_index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break

            landmarks = skeleton_frames.get(frame_index)
            if landmarks:
                draw_pose_overlay(frame, landmarks, width, height, DEFAULT_STYLE)
            hands = hand_frames.get(frame_index, [])
            if hands:
                draw_hand_overlay(frame, hands, width, height, DEFAULT_HAND_STYLE)

            writer.write(frame)
            frame_index += 1
            if progress_callback is not None and total_frames > 0:
                progress_callback(frame_index, total_frames)
    finally:
        capture.release()
        writer.release()

    if progress_callback is not None and total_frames > 0 and 0 < frame_index < total_frames:
        progress_callback(frame_index, frame_index)

    return {
        "frame_count": frame_index,
        "output_path": output_path,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="抽出済み骨格 JSON を元動画に重ねた確認用動画を生成")
    parser.add_argument("video_path", type=Path, help="入力動画ファイル")
    parser.add_argument(
        "--skeleton-json",
        type=Path,
        required=True,
        help="extract_pose_video.py が出力した skeleton_data.json",
    )
    parser.add_argument(
        "-o",
        "--output-path",
        type=Path,
        required=True,
        help="出力動画ファイル（.mp4）",
    )
    parser.add_argument(
        "--hand-json",
        type=Path,
        default=None,
        help="extract_pose_video.py が出力した hand_landmarks.json",
    )
    args = parser.parse_args()

    import cv2

    preview_capture = cv2.VideoCapture(str(args.video_path))
    preview_total_frames = int(preview_capture.get(CV2_CAP_PROP_FRAME_COUNT) or 0)
    preview_capture.release()

    progress_callback = None
    if preview_total_frames > 0:
        progress_callback = build_progress_reporter("Overlay", preview_total_frames)

    result = render_pose_overlay_video(
        video_path=args.video_path,
        skeleton_json_path=args.skeleton_json,
        output_path=args.output_path,
        progress_callback=progress_callback,
        hand_json_path=args.hand_json,
    )
    print(f"[保存] Overlay Video: {result['output_path']}")
    print(f"[フレーム数] {result['frame_count']}")


if __name__ == "__main__":
    main()
