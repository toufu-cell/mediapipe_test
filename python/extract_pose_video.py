import argparse
import csv
from datetime import datetime
import json
import math
import urllib.request
from pathlib import Path
from typing import Any

from progress_utils import build_progress_reporter, ProgressCallback
from render_pose_overlay_video import render_pose_overlay_video


DEFAULT_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
)
DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / ".cache" / "pose_landmarker_lite.task"
DEFAULT_HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
DEFAULT_HAND_MODEL_PATH = Path(__file__).resolve().parent / ".cache" / "hand_landmarker.task"

POSE_LANDMARK_NAMES = [
    "nose", "leftEyeInner", "leftEye", "leftEyeOuter",
    "rightEyeInner", "rightEye", "rightEyeOuter",
    "leftEar", "rightEar", "mouthLeft", "mouthRight",
    "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
    "leftWrist", "rightWrist", "leftPinky", "rightPinky",
    "leftIndex", "rightIndex", "leftThumb", "rightThumb",
    "leftHip", "rightHip", "leftKnee", "rightKnee",
    "leftAnkle", "rightAnkle", "leftHeel", "rightHeel",
    "leftFootIndex", "rightFootIndex",
]
HAND_LANDMARK_NAMES = [
    "wrist",
    "thumbCmc", "thumbMcp", "thumbIp", "thumbTip",
    "indexFingerMcp", "indexFingerPip", "indexFingerDip", "indexFingerTip",
    "middleFingerMcp", "middleFingerPip", "middleFingerDip", "middleFingerTip",
    "ringFingerMcp", "ringFingerPip", "ringFingerDip", "ringFingerTip",
    "pinkyMcp", "pinkyPip", "pinkyDip", "pinkyTip",
]

UPPER_BODY_LANDMARK_INDICES = {
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
}
POSE_FILTER_LANDMARK_INDICES = (11, 12, 13, 14, 15, 16)
LEFT_ARM_LANDMARK_INDICES = (13, 15, 17, 19, 21)
RIGHT_ARM_LANDMARK_INDICES = (14, 16, 18, 20, 22)
LEFT_SHOULDER_INDEX = 11
RIGHT_SHOULDER_INDEX = 12

DEFAULT_POSE_FILTER_VISIBILITY_THRESHOLD = 0.5
DEFAULT_MIN_VALID_UPPER_BODY_LANDMARKS = 4
DEFAULT_MIN_POSE_BBOX_AREA = 0.006
DEFAULT_MIN_SHOULDER_WIDTH = 0.05
DEFAULT_MAX_CENTER_JUMP = 0.35
DEFAULT_MAX_INTERPOLATION_MS = 250.0
DEFAULT_ARM_SELECTION = "both"
DEFAULT_ARM_SELECTION_MIN_SCORE_MARGIN = 0.5
ARM_SELECTION_CHOICES = ("both", "left", "right", "auto-visible")

CV2_CAP_PROP_FRAME_WIDTH = 3
CV2_CAP_PROP_FRAME_HEIGHT = 4
CV2_CAP_PROP_FPS = 5
CV2_CAP_PROP_FRAME_COUNT = 7


def ensure_model_file(model_path: Path, model_url: str = DEFAULT_MODEL_URL) -> Path:
    model_path.parent.mkdir(parents=True, exist_ok=True)
    if model_path.exists():
        return model_path

    with urllib.request.urlopen(model_url) as response:
        model_path.write_bytes(response.read())

    return model_path


def open_video_capture(video_path: Path):
    import cv2

    return cv2.VideoCapture(str(video_path))


def convert_frame_to_mp_image(frame: Any):
    import cv2
    import mediapipe as mp

    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)


def create_pose_landmarker(model_path: Path):
    import mediapipe as mp

    base_options = mp.tasks.BaseOptions(model_asset_path=str(model_path))
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return mp.tasks.vision.PoseLandmarker.create_from_options(options)


def create_hand_landmarker(model_path: Path, num_hands: int = 2):
    import mediapipe as mp

    base_options = mp.tasks.BaseOptions(model_asset_path=str(model_path))
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=num_hands,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return mp.tasks.vision.HandLandmarker.create_from_options(options)


def build_json_payload(
    frames: list[dict[str, Any]],
    width: int,
    height: int,
    fps: float,
) -> dict[str, Any]:
    duration_ms = frames[-1]["timestampMs"] - frames[0]["timestampMs"] if len(frames) > 1 else 0
    estimated_fps = round(fps, 1) if fps > 0 else 0
    return {
        "metadata": {
            "schemaVersion": 1,
            "exportedAt": datetime.now().isoformat(),
            "frameCount": len(frames),
            "durationMs": duration_ms,
            "estimatedFps": estimated_fps,
            "source": "videoFile",
            "landmarkModel": "mediapipe-pose-33",
            "coordinateSpace": "normalized",
            "sourceWidth": width,
            "sourceHeight": height,
            "mirrored": False,
        },
        "frames": frames,
    }


def build_hand_json_payload(
    frames: list[dict[str, Any]],
    width: int,
    height: int,
    fps: float,
    mirrored: bool = False,
) -> dict[str, Any]:
    duration_ms = frames[-1]["timestampMs"] - frames[0]["timestampMs"] if len(frames) > 1 else 0
    estimated_fps = round(fps, 1) if fps > 0 else 0
    return {
        "metadata": {
            "schemaVersion": 1,
            "exportedAt": datetime.now().isoformat(),
            "frameCount": len(frames),
            "durationMs": duration_ms,
            "estimatedFps": estimated_fps,
            "source": "videoFile",
            "handLandmarkModel": "mediapipe-hand-21",
            "coordinateSpace": "normalized",
            "sourceWidth": width,
            "sourceHeight": height,
            "mirrored": mirrored,
            "handednessAssumesMirroredInput": True,
            "handednessAdjustedForMirroring": not mirrored,
        },
        "frames": frames,
    }


def write_skeleton_csv(csv_path: Path, frames: list[dict[str, Any]]) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    headers = ["timestamp_ms", "frame_index"]
    for name in POSE_LANDMARK_NAMES:
        headers.extend([f"{name}_x", f"{name}_y", f"{name}_z", f"{name}_visibility"])

    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(headers)
        for frame in frames:
            row = [frame["timestampMs"], frame["frameIndex"]]
            landmarks = frame["landmarks"]
            if landmarks is None:
                for _ in POSE_LANDMARK_NAMES:
                    row.extend(["", "", "", ""])
            else:
                for landmark in landmarks:
                    row.extend([
                        landmark["x"],
                        landmark["y"],
                        landmark["z"],
                        landmark["visibility"],
                    ])
            writer.writerow(row)


def write_frame_metadata_csv(csv_path: Path, frames: list[dict[str, Any]]) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "timestamp_ms",
        "frame_index",
        "has_landmarks",
        "pose_status",
        "interpolated",
        "interpolation_source_frame_index",
        "invalid_reason",
        "arm_selection",
        "selected_arm",
        "left_arm_score",
        "right_arm_score",
    ]

    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers)
        writer.writeheader()
        for frame in frames:
            source_index = frame.get("interpolationSourceFrameIndex")
            writer.writerow({
                "timestamp_ms": frame["timestampMs"],
                "frame_index": frame["frameIndex"],
                "has_landmarks": "true" if frame["landmarks"] is not None else "false",
                "pose_status": frame.get("poseStatus", ""),
                "interpolated": "true" if frame.get("interpolated", False) else "false",
                "interpolation_source_frame_index": "" if source_index is None else source_index,
                "invalid_reason": frame.get("invalidReason") or "",
                "arm_selection": frame.get("armSelection", ""),
                "selected_arm": frame.get("selectedArm", ""),
                "left_arm_score": frame.get("leftArmScore", ""),
                "right_arm_score": frame.get("rightArmScore", ""),
            })


def write_hand_csv(csv_path: Path, frames: list[dict[str, Any]]) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    headers = ["timestamp_ms", "frame_index", "hand_index", "handedness", "score"]
    for name in HAND_LANDMARK_NAMES:
        headers.extend([f"{name}_x", f"{name}_y", f"{name}_z"])

    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(headers)
        for frame in frames:
            for hand_index, hand in enumerate(frame.get("hands", [])):
                row = [
                    frame["timestampMs"],
                    frame["frameIndex"],
                    hand_index,
                    hand.get("handedness", ""),
                    hand.get("score", ""),
                ]
                for landmark in hand["landmarks"]:
                    row.extend([landmark["x"], landmark["y"], landmark["z"]])
                writer.writerow(row)


def apply_landmark_profile(
    landmarks: list[dict[str, float]],
    landmark_profile: str,
    visibility_threshold: float,
) -> list[dict[str, float]]:
    if landmark_profile not in {"full-body", "upper-body"}:
        raise ValueError(f"Unsupported landmark profile: {landmark_profile}")

    filtered: list[dict[str, float]] = []
    for index, landmark in enumerate(landmarks):
        masked = dict(landmark)
        keep = landmark_profile == "full-body" or index in UPPER_BODY_LANDMARK_INDICES
        visible = float(masked.get("visibility", 0.0)) >= visibility_threshold

        if not keep or not visible:
            masked["x"] = 0.0
            masked["y"] = 0.0
            masked["z"] = 0.0
            masked["visibility"] = 0.0

        filtered.append(masked)

    return filtered


def copy_landmarks(landmarks: list[dict[str, float]]) -> list[dict[str, float]]:
    return [dict(landmark) for landmark in landmarks]


def mask_landmark(landmark: dict[str, float]) -> dict[str, float]:
    masked = dict(landmark)
    masked["x"] = 0.0
    masked["y"] = 0.0
    masked["z"] = 0.0
    masked["visibility"] = 0.0
    return masked


def get_landmark_visibility(landmark: dict[str, float]) -> float:
    return float(landmark.get("visibility", 0.0))


def compute_arm_score(landmarks: list[dict[str, float]], arm_indices: tuple[int, ...]) -> float:
    return sum(get_landmark_visibility(landmarks[index]) for index in arm_indices)


def apply_arm_selection(
    landmarks: list[dict[str, float]],
    arm_selection: str,
    min_score_margin: float,
    score_landmarks: list[dict[str, float]] | None = None,
) -> tuple[list[dict[str, float]], dict[str, Any]]:
    if arm_selection not in ARM_SELECTION_CHOICES:
        raise ValueError(f"Unsupported arm selection: {arm_selection}")
    if min_score_margin < 0.0:
        raise ValueError("arm_selection_min_score_margin must be greater than or equal to 0.0")

    score_source = landmarks if score_landmarks is None else score_landmarks
    left_score = compute_arm_score(score_source, LEFT_ARM_LANDMARK_INDICES)
    right_score = compute_arm_score(score_source, RIGHT_ARM_LANDMARK_INDICES)
    selected_arm = arm_selection
    if arm_selection == "auto-visible":
        score_delta = left_score - right_score
        if score_delta >= min_score_margin:
            selected_arm = "left"
        elif score_delta <= -min_score_margin:
            selected_arm = "right"
        else:
            selected_arm = "both"

    filtered = copy_landmarks(landmarks)
    if selected_arm == "left":
        for index in RIGHT_ARM_LANDMARK_INDICES:
            filtered[index] = mask_landmark(filtered[index])
    elif selected_arm == "right":
        for index in LEFT_ARM_LANDMARK_INDICES:
            filtered[index] = mask_landmark(filtered[index])

    return filtered, {
        "armSelection": arm_selection,
        "selectedArm": selected_arm,
        "leftArmScore": left_score,
        "rightArmScore": right_score,
    }


def adjust_handedness_for_mirroring(label: str, mirrored: bool) -> str:
    if mirrored:
        return label
    if label == "Left":
        return "Right"
    if label == "Right":
        return "Left"
    return label


def get_handedness_label_and_score(handedness: Any, mirrored: bool = False) -> tuple[str, str, float | str]:
    if not handedness:
        return "", "", ""
    category = handedness[0]
    raw_label = getattr(category, "category_name", "")
    score = getattr(category, "score", "")
    label = adjust_handedness_for_mirroring(raw_label, mirrored=mirrored)
    return label, raw_label, score


def extract_hand_payloads(result: Any, mirrored: bool = False) -> list[dict[str, Any]]:
    hand_landmarks = getattr(result, "hand_landmarks", None) or []
    handedness_list = getattr(result, "handedness", None) or []
    hands = []
    for hand_index, landmarks in enumerate(hand_landmarks):
        handedness, raw_handedness, score = get_handedness_label_and_score(
            handedness_list[hand_index] if hand_index < len(handedness_list) else None,
            mirrored=mirrored,
        )
        hands.append({
            "handedness": handedness,
            "rawHandedness": raw_handedness,
            "score": score,
            "landmarks": [
                {
                    "x": landmark.x,
                    "y": landmark.y,
                    "z": landmark.z,
                }
                for landmark in landmarks
            ],
        })
    return hands


def get_visible_filter_landmarks(
    landmarks: list[dict[str, float]],
    visibility_threshold: float,
) -> list[dict[str, float]]:
    visible = []
    for index in POSE_FILTER_LANDMARK_INDICES:
        landmark = landmarks[index]
        if get_landmark_visibility(landmark) >= visibility_threshold:
            visible.append(landmark)
    return visible


def compute_landmark_center(landmarks: list[dict[str, float]]) -> tuple[float, float]:
    x = sum(float(landmark["x"]) for landmark in landmarks) / len(landmarks)
    y = sum(float(landmark["y"]) for landmark in landmarks) / len(landmarks)
    return x, y


def compute_landmark_bbox_area(landmarks: list[dict[str, float]]) -> float:
    xs = [float(landmark["x"]) for landmark in landmarks]
    ys = [float(landmark["y"]) for landmark in landmarks]
    return (max(xs) - min(xs)) * (max(ys) - min(ys))


def compute_landmark_distance(a: dict[str, float], b: dict[str, float]) -> float:
    dx = float(a["x"]) - float(b["x"])
    dy = float(a["y"]) - float(b["y"])
    return math.sqrt(dx * dx + dy * dy)


def compute_center_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return math.sqrt(dx * dx + dy * dy)


def evaluate_pose_quality(
    landmarks: list[dict[str, float]],
    previous_center: tuple[float, float] | None,
    visibility_threshold: float,
    min_valid_upper_body_landmarks: int,
    min_pose_bbox_area: float,
    min_shoulder_width: float,
    max_center_jump: float,
) -> tuple[bool, str | None, tuple[float, float] | None]:
    visible_landmarks = get_visible_filter_landmarks(landmarks, visibility_threshold)
    if len(visible_landmarks) < min_valid_upper_body_landmarks:
        return False, "insufficient_visible_upper_body_landmarks", None

    left_shoulder = landmarks[LEFT_SHOULDER_INDEX]
    right_shoulder = landmarks[RIGHT_SHOULDER_INDEX]
    if (
        get_landmark_visibility(left_shoulder) < visibility_threshold
        or get_landmark_visibility(right_shoulder) < visibility_threshold
    ):
        return False, "shoulders_not_visible", None

    if compute_landmark_bbox_area(visible_landmarks) < min_pose_bbox_area:
        return False, "bbox_too_small", None

    if compute_landmark_distance(left_shoulder, right_shoulder) < min_shoulder_width:
        return False, "shoulder_width_too_small", None

    center = compute_landmark_center(visible_landmarks)
    if previous_center is not None and compute_center_distance(center, previous_center) > max_center_jump:
        return False, "center_jump_too_large", center

    return True, None, center


def max_interpolation_frames_for_fps(fps: float, max_interpolation_ms: float) -> int:
    if max_interpolation_ms <= 0:
        return 0
    return int(math.ceil(max_interpolation_ms * fps / 1000.0))


def validate_pose_filter_options(
    pose_filter_visibility_threshold: float,
    min_valid_upper_body_landmarks: int,
    min_pose_bbox_area: float,
    min_shoulder_width: float,
    max_center_jump: float,
    max_interpolation_ms: float,
    arm_selection: str,
    arm_selection_min_score_margin: float,
) -> None:
    if not 0.0 <= pose_filter_visibility_threshold <= 1.0:
        raise ValueError("pose_filter_visibility_threshold must be between 0.0 and 1.0")
    if min_valid_upper_body_landmarks < 1:
        raise ValueError("min_valid_upper_body_landmarks must be greater than or equal to 1")
    if min_pose_bbox_area < 0.0:
        raise ValueError("min_pose_bbox_area must be greater than or equal to 0.0")
    if min_shoulder_width < 0.0:
        raise ValueError("min_shoulder_width must be greater than or equal to 0.0")
    if max_center_jump < 0.0:
        raise ValueError("max_center_jump must be greater than or equal to 0.0")
    if max_interpolation_ms < 0.0:
        raise ValueError("max_interpolation_ms must be greater than or equal to 0.0")
    if arm_selection not in ARM_SELECTION_CHOICES:
        raise ValueError(f"Unsupported arm selection: {arm_selection}")
    if arm_selection_min_score_margin < 0.0:
        raise ValueError("arm_selection_min_score_margin must be greater than or equal to 0.0")


def extract_pose_video(
    video_path: Path,
    output_dir: Path,
    model_path: Path,
    model_url: str = DEFAULT_MODEL_URL,
    write_overlay_video: bool = False,
    progress_callback: ProgressCallback | None = None,
    overlay_progress_callback: ProgressCallback | None = None,
    landmark_profile: str = "full-body",
    visibility_threshold: float = 0.0,
    pose_filter_visibility_threshold: float = DEFAULT_POSE_FILTER_VISIBILITY_THRESHOLD,
    min_valid_upper_body_landmarks: int = DEFAULT_MIN_VALID_UPPER_BODY_LANDMARKS,
    min_pose_bbox_area: float = DEFAULT_MIN_POSE_BBOX_AREA,
    min_shoulder_width: float = DEFAULT_MIN_SHOULDER_WIDTH,
    max_center_jump: float = DEFAULT_MAX_CENTER_JUMP,
    max_interpolation_ms: float = DEFAULT_MAX_INTERPOLATION_MS,
    arm_selection: str = DEFAULT_ARM_SELECTION,
    arm_selection_min_score_margin: float = DEFAULT_ARM_SELECTION_MIN_SCORE_MARGIN,
    detect_hands: bool = False,
    hand_model_path: Path = DEFAULT_HAND_MODEL_PATH,
    hand_model_url: str = DEFAULT_HAND_MODEL_URL,
    max_hands: int = 2,
) -> dict[str, Any]:
    if max_hands < 1:
        raise ValueError("max_hands must be greater than or equal to 1")
    validate_pose_filter_options(
        pose_filter_visibility_threshold=pose_filter_visibility_threshold,
        min_valid_upper_body_landmarks=min_valid_upper_body_landmarks,
        min_pose_bbox_area=min_pose_bbox_area,
        min_shoulder_width=min_shoulder_width,
        max_center_jump=max_center_jump,
        max_interpolation_ms=max_interpolation_ms,
        arm_selection=arm_selection,
        arm_selection_min_score_margin=arm_selection_min_score_margin,
    )

    model_path = ensure_model_file(model_path, model_url=model_url)
    if detect_hands:
        hand_model_path = ensure_model_file(hand_model_path, model_url=hand_model_url)
    output_dir.mkdir(parents=True, exist_ok=True)

    capture = open_video_capture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Failed to open video: {video_path}")

    fps = float(capture.get(CV2_CAP_PROP_FPS) or 0.0)
    if fps <= 0:
        fps = 30.0
    total_frames = int(capture.get(CV2_CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(CV2_CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(CV2_CAP_PROP_FRAME_HEIGHT) or 0)

    frames: list[dict[str, Any]] = []
    hand_frames: list[dict[str, Any]] = []
    frame_index = 0
    last_timestamp_ms = -1
    last_valid_landmarks: list[dict[str, float]] | None = None
    last_valid_frame_index: int | None = None
    last_valid_center: tuple[float, float] | None = None
    invalid_streak = 0
    max_interpolation_frames = max_interpolation_frames_for_fps(fps, max_interpolation_ms)

    try:
        with create_pose_landmarker(model_path) as landmarker:
            hand_landmarker = create_hand_landmarker(hand_model_path, num_hands=max_hands) if detect_hands else None
            try:
                while True:
                    ok, frame = capture.read()
                    if not ok:
                        break

                    timestamp_ms = int(round((frame_index / fps) * 1000))
                    if timestamp_ms <= last_timestamp_ms:
                        timestamp_ms = last_timestamp_ms + 1
                    last_timestamp_ms = timestamp_ms
                    mp_image = convert_frame_to_mp_image(frame)
                    result = landmarker.detect_for_video(mp_image, timestamp_ms)
                    hand_result = hand_landmarker.detect_for_video(mp_image, timestamp_ms) if hand_landmarker else None

                    landmarks_payload = None
                    pose_status = "missing"
                    invalid_reason = None
                    interpolated = False
                    interpolation_source_frame_index = None
                    arm_metadata = {
                        "armSelection": arm_selection,
                        "selectedArm": arm_selection if arm_selection != "auto-visible" else "both",
                        "leftArmScore": "",
                        "rightArmScore": "",
                    }
                    if getattr(result, "pose_landmarks", None):
                        pose_landmarks = result.pose_landmarks[0]
                        raw_landmarks_payload = [
                            {
                                "x": landmark.x,
                                "y": landmark.y,
                                "z": landmark.z,
                                "visibility": getattr(landmark, "visibility", 0.0),
                            }
                            for landmark in pose_landmarks
                        ]
                        is_valid_pose, invalid_reason, current_center = evaluate_pose_quality(
                            raw_landmarks_payload,
                            previous_center=last_valid_center,
                            visibility_threshold=pose_filter_visibility_threshold,
                            min_valid_upper_body_landmarks=min_valid_upper_body_landmarks,
                            min_pose_bbox_area=min_pose_bbox_area,
                            min_shoulder_width=min_shoulder_width,
                            max_center_jump=max_center_jump,
                        )

                        if is_valid_pose:
                            invalid_streak = 0
                            pose_status = "valid"
                            last_valid_landmarks = copy_landmarks(raw_landmarks_payload)
                            last_valid_frame_index = frame_index
                            last_valid_center = current_center
                            profiled_landmarks = apply_landmark_profile(
                                raw_landmarks_payload,
                                landmark_profile=landmark_profile,
                                visibility_threshold=visibility_threshold,
                            )
                            landmarks_payload, arm_metadata = apply_arm_selection(
                                profiled_landmarks,
                                arm_selection=arm_selection,
                                min_score_margin=arm_selection_min_score_margin,
                                score_landmarks=raw_landmarks_payload,
                            )
                        else:
                            invalid_streak += 1
                            pose_status = "invalid"

                    else:
                        invalid_reason = "no_pose_detected"
                        if last_valid_landmarks is not None:
                            invalid_streak += 1

                    if (
                        landmarks_payload is None
                        and last_valid_landmarks is not None
                        and 0 < invalid_streak <= max_interpolation_frames
                    ):
                        interpolated = True
                        pose_status = "interpolated"
                        interpolation_source_frame_index = last_valid_frame_index
                        profiled_landmarks = apply_landmark_profile(
                            copy_landmarks(last_valid_landmarks),
                            landmark_profile=landmark_profile,
                            visibility_threshold=visibility_threshold,
                        )
                        landmarks_payload, arm_metadata = apply_arm_selection(
                            profiled_landmarks,
                            arm_selection=arm_selection,
                            min_score_margin=arm_selection_min_score_margin,
                            score_landmarks=last_valid_landmarks,
                        )

                    frames.append({
                        "frameIndex": frame_index,
                        "timestampMs": timestamp_ms,
                        "landmarks": landmarks_payload,
                        "interpolated": interpolated,
                        "interpolationSourceFrameIndex": interpolation_source_frame_index,
                        "poseStatus": pose_status,
                        "invalidReason": invalid_reason,
                        **arm_metadata,
                    })
                    if detect_hands:
                        hand_frames.append({
                            "frameIndex": frame_index,
                            "timestampMs": timestamp_ms,
                            "hands": extract_hand_payloads(hand_result, mirrored=False),
                        })
                    frame_index += 1
                    if progress_callback is not None and total_frames > 0:
                        progress_callback(frame_index, total_frames)
            finally:
                if hand_landmarker is not None:
                    hand_landmarker.close()
    finally:
        capture.release()

    if progress_callback is not None and total_frames > 0 and 0 < frame_index < total_frames:
        progress_callback(frame_index, frame_index)

    stem = video_path.stem
    json_path = output_dir / f"{stem}_skeleton_data.json"
    csv_path = output_dir / f"{stem}_33landmarks.csv"
    frame_metadata_path = output_dir / f"{stem}_frame_metadata.csv"
    hand_json_path = output_dir / f"{stem}_hand_landmarks.json" if detect_hands else None
    hand_csv_path = output_dir / f"{stem}_hand_landmarks.csv" if detect_hands else None
    overlay_path = output_dir / f"{stem}_overlay.mp4" if write_overlay_video else None

    payload = build_json_payload(frames, width, height, fps)
    json_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    write_skeleton_csv(csv_path, frames)
    write_frame_metadata_csv(frame_metadata_path, frames)
    if hand_json_path is not None and hand_csv_path is not None:
        hand_payload = build_hand_json_payload(hand_frames, width, height, fps)
        hand_json_path.write_text(json.dumps(hand_payload, ensure_ascii=False), encoding="utf-8")
        write_hand_csv(hand_csv_path, hand_frames)
    if overlay_path is not None:
        render_pose_overlay_video(
            video_path,
            json_path,
            overlay_path,
            progress_callback=overlay_progress_callback,
            hand_json_path=hand_json_path,
        )

    return {
        "frame_count": len(frames),
        "json_path": json_path,
        "csv_path": csv_path,
        "frame_metadata_path": frame_metadata_path,
        "hand_json_path": hand_json_path,
        "hand_csv_path": hand_csv_path,
        "overlay_path": overlay_path,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="動画から MediaPipe Pose 33 ランドマークを抽出")
    parser.add_argument("video_path", type=Path, help="入力動画ファイル")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        required=True,
        help="出力ディレクトリ",
    )
    parser.add_argument(
        "--model-path",
        type=Path,
        default=DEFAULT_MODEL_PATH,
        help="Pose Landmarker task file の保存先",
    )
    parser.add_argument(
        "--model-url",
        type=str,
        default=DEFAULT_MODEL_URL,
        help="Pose Landmarker task file のダウンロード元 URL",
    )
    parser.add_argument(
        "--write-overlay-video",
        action="store_true",
        help="抽出後に骨格オーバーレイ確認用 mp4 も出力する",
    )
    parser.add_argument(
        "--landmark-profile",
        type=str,
        choices=("full-body", "upper-body"),
        default="full-body",
        help="抽出時に保持するランドマーク範囲",
    )
    parser.add_argument(
        "--visibility-threshold",
        type=float,
        default=0.0,
        help="この値未満の visibility ランドマークを 0 に潰す",
    )
    parser.add_argument(
        "--pose-filter-visibility-threshold",
        type=float,
        default=DEFAULT_POSE_FILTER_VISIBILITY_THRESHOLD,
        help="人体 pose と判定するために必要な上半身ランドマーク visibility の閾値",
    )
    parser.add_argument(
        "--min-valid-upper-body-landmarks",
        type=int,
        default=DEFAULT_MIN_VALID_UPPER_BODY_LANDMARKS,
        help="人体 pose と判定するために必要な visible 上半身ランドマーク数",
    )
    parser.add_argument(
        "--min-pose-bbox-area",
        type=float,
        default=DEFAULT_MIN_POSE_BBOX_AREA,
        help="上半身の visible ランドマーク bbox 面積がこの値未満なら誤検出として扱う",
    )
    parser.add_argument(
        "--min-shoulder-width",
        type=float,
        default=DEFAULT_MIN_SHOULDER_WIDTH,
        help="正規化座標上の肩幅がこの値未満なら誤検出として扱う",
    )
    parser.add_argument(
        "--max-center-jump",
        type=float,
        default=DEFAULT_MAX_CENTER_JUMP,
        help="直前の有効 pose 中心からこの距離を超えて飛んだ検出を誤検出として扱う",
    )
    parser.add_argument(
        "--max-interpolation-ms",
        type=float,
        default=DEFAULT_MAX_INTERPOLATION_MS,
        help="誤検出または未検出時に直前の有効 pose で補完する最大時間（ミリ秒）",
    )
    parser.add_argument(
        "--arm-selection",
        type=str,
        choices=ARM_SELECTION_CHOICES,
        default=DEFAULT_ARM_SELECTION,
        help="出力に残す腕を選択する。auto-visible は左右腕 visibility score 差が明確な場合だけ低 score 側を無効化する",
    )
    parser.add_argument(
        "--arm-selection-min-score-margin",
        type=float,
        default=DEFAULT_ARM_SELECTION_MIN_SCORE_MARGIN,
        help="auto-visible で片腕だけを残すために必要な左右腕 visibility score 差",
    )
    parser.add_argument(
        "--detect-hands",
        action="store_true",
        help="Pose とは別に HandLandmarker で画面内の手 21 点も抽出する",
    )
    parser.add_argument(
        "--hand-model-path",
        type=Path,
        default=DEFAULT_HAND_MODEL_PATH,
        help="Hand Landmarker task file の保存先",
    )
    parser.add_argument(
        "--hand-model-url",
        type=str,
        default=DEFAULT_HAND_MODEL_URL,
        help="Hand Landmarker task file のダウンロード元 URL",
    )
    parser.add_argument(
        "--max-hands",
        type=int,
        default=2,
        help="HandLandmarker が検出する最大手数",
    )
    args = parser.parse_args()

    import cv2

    preview_capture = cv2.VideoCapture(str(args.video_path))
    preview_total_frames = int(preview_capture.get(CV2_CAP_PROP_FRAME_COUNT) or 0)
    preview_capture.release()

    extract_progress = None
    overlay_progress = None
    if preview_total_frames > 0:
        extract_progress = build_progress_reporter("抽出", preview_total_frames)
        if args.write_overlay_video:
            overlay_progress = build_progress_reporter("Overlay", preview_total_frames)

    result = extract_pose_video(
        video_path=args.video_path,
        output_dir=args.output_dir,
        model_path=args.model_path,
        model_url=args.model_url,
        write_overlay_video=args.write_overlay_video,
        progress_callback=extract_progress,
        overlay_progress_callback=overlay_progress,
        landmark_profile=args.landmark_profile,
        visibility_threshold=args.visibility_threshold,
        pose_filter_visibility_threshold=args.pose_filter_visibility_threshold,
        min_valid_upper_body_landmarks=args.min_valid_upper_body_landmarks,
        min_pose_bbox_area=args.min_pose_bbox_area,
        min_shoulder_width=args.min_shoulder_width,
        max_center_jump=args.max_center_jump,
        max_interpolation_ms=args.max_interpolation_ms,
        arm_selection=args.arm_selection,
        arm_selection_min_score_margin=args.arm_selection_min_score_margin,
        detect_hands=args.detect_hands,
        hand_model_path=args.hand_model_path,
        hand_model_url=args.hand_model_url,
        max_hands=args.max_hands,
    )
    print(f"[保存] JSON: {result['json_path']}")
    print(f"[保存] CSV: {result['csv_path']}")
    print(f"[保存] Frame Metadata CSV: {result['frame_metadata_path']}")
    if result.get("hand_json_path") is not None:
        print(f"[保存] Hand JSON: {result['hand_json_path']}")
    if result.get("hand_csv_path") is not None:
        print(f"[保存] Hand CSV: {result['hand_csv_path']}")
    overlay_path = result.get("overlay_path")
    if overlay_path is not None:
        print(f"[保存] Overlay Video: {overlay_path}")
    print(f"[フレーム数] {result['frame_count']}")


if __name__ == "__main__":
    main()
