import argparse
from pathlib import Path

import numpy as np
import pandas as pd


LANDMARK_SUFFIX = "_33landmarks.csv"
METADATA_SUFFIX = "_frame_metadata.csv"
HAND_SUFFIX = "_hand_landmarks.csv"

VISIBILITY_LANDMARKS = (
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftWrist",
    "rightWrist",
)
WRIST_LANDMARKS = ("leftWrist", "rightWrist")
HAND_FINGERTIPS = ("indexFingerTip", "middleFingerTip")
HAND_PANEL_ORDER = ("Left", "Right")
POSE_STATUSES = frozenset(("valid", "interpolated", "invalid", "missing"))
POSE_STATUS_PLOT_ORDER = ("missing", "invalid", "interpolated", "valid")
TRACKING_STATUS_PLOT_ORDER = ("missing", "invalid", "pose_interpolated", "pose_valid", "hand_valid")
PLOT_DPI = 300
PLOT_FILENAMES = {
    "pose_status_timeline": "pose_status_timeline.png",
    "landmark_visibility": "landmark_visibility.png",
    "wrist_xy": "wrist_xy.png",
    "wrist_speed": "wrist_speed.png",
}


def save_plot(fig, output_path: Path) -> None:
    fig.savefig(output_path, dpi=PLOT_DPI, bbox_inches="tight")


def extract_stem(path: Path, suffix: str) -> str:
    if not path.name.endswith(suffix):
        raise ValueError(f"File does not end with {suffix}: {path}")
    return path.name[: -len(suffix)]


def find_pose_csv_pair(input_dir: Path) -> tuple[Path, Path]:
    input_dir = Path(input_dir)
    landmark_files = sorted(input_dir.glob(f"*{LANDMARK_SUFFIX}"))
    metadata_files = sorted(input_dir.glob(f"*{METADATA_SUFFIX}"))

    if len(landmark_files) != 1 or len(metadata_files) != 1:
        raise ValueError(
            "Expected exactly one *_33landmarks.csv and exactly one "
            f"*_frame_metadata.csv in {input_dir}"
        )

    landmarks_path = landmark_files[0]
    metadata_path = metadata_files[0]
    landmarks_stem = extract_stem(landmarks_path, LANDMARK_SUFFIX)
    metadata_stem = extract_stem(metadata_path, METADATA_SUFFIX)
    if landmarks_stem != metadata_stem:
        raise ValueError(
            "Landmark CSV and frame metadata CSV stems do not match: "
            f"{landmarks_path.name} vs {metadata_path.name}"
        )

    return landmarks_path, metadata_path


def find_hand_csv(input_dir: Path, pose_stem: str) -> Path | None:
    hand_path = Path(input_dir) / f"{pose_stem}{HAND_SUFFIX}"
    return hand_path if hand_path.exists() else None


def require_columns(frame: pd.DataFrame, required_columns: list[str], label: str) -> None:
    missing = [column for column in required_columns if column not in frame.columns]
    if missing:
        raise ValueError(f"{label} is missing required columns: {', '.join(missing)}")


def read_pose_csvs(input_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame, str]:
    landmarks_path, metadata_path = find_pose_csv_pair(input_dir)
    landmarks = pd.read_csv(landmarks_path)
    metadata = pd.read_csv(metadata_path)
    pose_stem = extract_stem(landmarks_path, LANDMARK_SUFFIX)

    landmark_columns = ["timestamp_ms", "frame_index"]
    for landmark in VISIBILITY_LANDMARKS:
        landmark_columns.append(f"{landmark}_visibility")
    for wrist in WRIST_LANDMARKS:
        landmark_columns.extend([f"{wrist}_x", f"{wrist}_y"])
    require_columns(landmarks, landmark_columns, str(landmarks_path))
    require_columns(metadata, ["timestamp_ms", "frame_index", "pose_status"], str(metadata_path))

    if not landmarks[["timestamp_ms", "frame_index"]].equals(metadata[["timestamp_ms", "frame_index"]]):
        raise ValueError("Landmark CSV and frame metadata CSV timestamp_ms/frame_index columns do not match")

    return landmarks, metadata, pose_stem


def read_hand_csv(input_dir: Path, pose_stem: str) -> pd.DataFrame | None:
    hand_path = find_hand_csv(input_dir, pose_stem)
    if hand_path is None:
        return None

    hands = pd.read_csv(hand_path)
    required_columns = ["timestamp_ms", "frame_index", "hand_index", "handedness"]
    for fingertip in HAND_FINGERTIPS:
        required_columns.extend([f"{fingertip}_x", f"{fingertip}_y"])
    require_columns(hands, required_columns, str(hand_path))
    return hands


def time_seconds(frame: pd.DataFrame) -> pd.Series:
    return pd.to_numeric(frame["timestamp_ms"], errors="coerce") / 1000.0


def compute_wrist_speed(landmarks: pd.DataFrame, wrist: str) -> pd.Series:
    required_columns = ["timestamp_ms", f"{wrist}_x", f"{wrist}_y", f"{wrist}_visibility"]
    require_columns(landmarks, required_columns, "landmarks")

    timestamps = pd.to_numeric(landmarks["timestamp_ms"], errors="coerce")
    dt_seconds = timestamps.diff() / 1000.0
    if dt_seconds.iloc[1:].isna().any() or (dt_seconds.iloc[1:] <= 0).any():
        raise ValueError("timestamp_ms must be strictly increasing to compute wrist speed")

    x = pd.to_numeric(landmarks[f"{wrist}_x"], errors="coerce")
    y = pd.to_numeric(landmarks[f"{wrist}_y"], errors="coerce")
    visibility = pd.to_numeric(landmarks[f"{wrist}_visibility"], errors="coerce")
    visible = visibility > 0
    x = x.where(visible)
    y = y.where(visible)
    distance = np.sqrt(x.diff() ** 2 + y.diff() ** 2)
    speed = distance / dt_seconds
    speed.iloc[0] = 0.0
    return speed


def hand_track_label(row: pd.Series) -> str:
    hand_index = row.get("hand_index", "")
    handedness = row.get("handedness", "")
    if pd.isna(handedness) or str(handedness).strip() == "":
        return f"hand_index={hand_index}"
    return f"{handedness}#{hand_index}"


def with_hand_track_labels(hands: pd.DataFrame) -> pd.DataFrame:
    labeled = hands.copy()
    labeled["_track_label"] = labeled.apply(hand_track_label, axis=1)
    return labeled


def normalize_handedness_label(handedness: object) -> str:
    if pd.isna(handedness):
        return "Unknown"
    handedness_text = str(handedness).strip()
    return handedness_text if handedness_text else "Unknown"


def with_hand_panel_labels(hands: pd.DataFrame) -> pd.DataFrame:
    labeled = hands.copy()
    labeled["_handedness_label"] = labeled["handedness"].map(normalize_handedness_label)
    return labeled


def ordered_hand_panel_labels(hands: pd.DataFrame) -> list[str]:
    labels = set(hands["_handedness_label"]) if not hands.empty else {"Unknown"}
    ordered = [label for label in HAND_PANEL_ORDER if label in labels]
    ordered.extend(sorted(labels - set(ordered)))
    return ordered


def hand_xy_landmark_names(hands: pd.DataFrame) -> list[str]:
    landmarks = []
    for column in hands.columns:
        if not column.endswith("_x") or column.startswith("_"):
            continue
        landmark = column[:-2]
        if f"{landmark}_y" in hands.columns:
            landmarks.append(landmark)
    return landmarks


def make_vertical_hand_axes(plt, panel_labels: list[str], height_per_panel: float = 3.2):
    fig, axes = plt.subplots(
        nrows=len(panel_labels),
        ncols=1,
        sharex=True,
        figsize=(14, max(4.0, height_per_panel * len(panel_labels))),
    )
    return fig, np.atleast_1d(axes).ravel()


def compute_hand_keypoint_speed(hands: pd.DataFrame, keypoint: str) -> pd.Series:
    required_columns = ["timestamp_ms", "hand_index", "handedness", f"{keypoint}_x", f"{keypoint}_y"]
    require_columns(hands, required_columns, "hands")

    labeled = with_hand_track_labels(hands)
    speed = pd.Series(np.nan, index=hands.index, dtype=float)
    for _, track in labeled.groupby("_track_label", sort=True):
        track = track.sort_values("timestamp_ms")
        timestamps = pd.to_numeric(track["timestamp_ms"], errors="coerce")
        dt_seconds = timestamps.diff() / 1000.0
        if dt_seconds.iloc[1:].isna().any() or (dt_seconds.iloc[1:] <= 0).any():
            raise ValueError("timestamp_ms must be strictly increasing within each hand track")

        x = pd.to_numeric(track[f"{keypoint}_x"], errors="coerce")
        y = pd.to_numeric(track[f"{keypoint}_y"], errors="coerce")
        track_speed = np.sqrt(x.diff() ** 2 + y.diff() ** 2) / dt_seconds
        if not track_speed.empty:
            track_speed.iloc[0] = 0.0
        speed.loc[track.index] = track_speed

    return speed


def compute_hand_tip_center(hands: pd.DataFrame) -> pd.DataFrame:
    required_columns = ["timestamp_ms", "hand_index", "handedness"]
    for fingertip in HAND_FINGERTIPS:
        required_columns.extend([f"{fingertip}_x", f"{fingertip}_y"])
    require_columns(hands, required_columns, "hands")

    centered = hands.copy()
    x_columns = [f"{fingertip}_x" for fingertip in HAND_FINGERTIPS]
    y_columns = [f"{fingertip}_y" for fingertip in HAND_FINGERTIPS]
    x_values = centered[x_columns].apply(pd.to_numeric, errors="coerce")
    y_values = centered[y_columns].apply(pd.to_numeric, errors="coerce")
    centered["_tipCenter_x"] = x_values.mean(axis=1, skipna=False)
    centered["_tipCenter_y"] = y_values.mean(axis=1, skipna=False)
    return centered


def compute_hand_tip_center_speed(hands: pd.DataFrame) -> pd.Series:
    centered = with_hand_track_labels(compute_hand_tip_center(hands))
    speed = pd.Series(np.nan, index=hands.index, dtype=float)
    for _, track in centered.groupby("_track_label", sort=True):
        track = track.sort_values("timestamp_ms")
        timestamps = pd.to_numeric(track["timestamp_ms"], errors="coerce")
        dt_seconds = timestamps.diff() / 1000.0
        if dt_seconds.iloc[1:].isna().any() or (dt_seconds.iloc[1:] <= 0).any():
            raise ValueError("timestamp_ms must be strictly increasing within each hand track")

        x = pd.to_numeric(track["_tipCenter_x"], errors="coerce")
        y = pd.to_numeric(track["_tipCenter_y"], errors="coerce")
        track_speed = np.sqrt(x.diff() ** 2 + y.diff() ** 2) / dt_seconds
        if not track_speed.empty:
            track_speed.iloc[0] = 0.0
        speed.loc[track.index] = track_speed

    return speed


def normalize_pose_status(status: object) -> str:
    if pd.isna(status):
        return "missing"
    status_text = str(status).strip()
    return status_text if status_text in POSE_STATUSES else "missing"


def compute_tracking_status(metadata: pd.DataFrame, hands: pd.DataFrame | None = None) -> pd.Series:
    require_columns(metadata, ["frame_index", "pose_status"], "metadata")

    pose_status = metadata["pose_status"].map(normalize_pose_status)
    if hands is None:
        return pose_status

    require_columns(hands, ["frame_index"], "hands")
    metadata_frame_indices = set(metadata["frame_index"])
    hand_frame_indices = set(hands["frame_index"])
    unknown_frame_indices = hand_frame_indices - metadata_frame_indices
    if unknown_frame_indices:
        sample = sorted(unknown_frame_indices)[:5]
        raise ValueError(f"Hand CSV contains frame_index values not present in metadata: {sample}")

    centered = compute_hand_tip_center(hands)
    valid_hand_rows = centered["_tipCenter_x"].notna() & centered["_tipCenter_y"].notna()
    valid_hand_frame_indices = set(centered.loc[valid_hand_rows, "frame_index"])

    tracking_status = []
    for frame_index, status in zip(metadata["frame_index"], pose_status):
        if frame_index in valid_hand_frame_indices:
            tracking_status.append("hand_valid")
        elif status == "valid":
            tracking_status.append("pose_valid")
        elif status == "interpolated":
            tracking_status.append("pose_interpolated")
        elif status == "invalid":
            tracking_status.append("invalid")
        else:
            tracking_status.append("missing")

    return pd.Series(tracking_status, index=metadata.index)


def plot_pose_status_timeline(
    metadata: pd.DataFrame,
    output_path: Path,
    hands: pd.DataFrame | None = None,
) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    statuses = compute_tracking_status(metadata, hands=hands)
    status_name = "tracking_status" if hands is not None else "pose_status"
    title = "Tracking status timeline" if hands is not None else "Pose status timeline"
    preferred_order = list(TRACKING_STATUS_PLOT_ORDER if hands is not None else POSE_STATUS_PLOT_ORDER)
    status_order = [status for status in preferred_order if status in set(statuses)]
    status_order.extend(sorted(set(statuses) - set(status_order)))
    status_to_code = {status: index for index, status in enumerate(status_order)}
    codes = statuses.map(status_to_code)

    fig, ax = plt.subplots(figsize=(14, 4))
    ax.plot(time_seconds(metadata), codes, linewidth=2.0, drawstyle="steps-post")
    ax.set_title(title)
    ax.set_xlabel("Time (sec)")
    ax.set_ylabel(status_name)
    ax.set_yticks(list(status_to_code.values()))
    ax.set_yticklabels(list(status_to_code.keys()))
    ax.grid(True, axis="x", alpha=0.3)
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_landmark_visibility(landmarks: pd.DataFrame, output_path: Path) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    seconds = time_seconds(landmarks)
    fig, ax = plt.subplots(figsize=(14, 5))
    for landmark in VISIBILITY_LANDMARKS:
        column = f"{landmark}_visibility"
        ax.plot(seconds, pd.to_numeric(landmarks[column], errors="coerce"), linewidth=0.8, label=landmark)
    ax.set_title("Main landmark visibility")
    ax.set_xlabel("Time (sec)")
    ax.set_ylabel("Visibility")
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_wrist_xy(landmarks: pd.DataFrame, output_path: Path) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    seconds = time_seconds(landmarks)
    fig, ax = plt.subplots(figsize=(14, 5))
    for wrist in WRIST_LANDMARKS:
        for axis in ("x", "y"):
            column = f"{wrist}_{axis}"
            ax.plot(seconds, pd.to_numeric(landmarks[column], errors="coerce"), linewidth=0.8, label=column)
    ax.set_title("Wrist x/y coordinates")
    ax.set_xlabel("Time (sec)")
    ax.set_ylabel("Normalized coordinate")
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_wrist_speed(landmarks: pd.DataFrame, output_path: Path) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    seconds = time_seconds(landmarks)
    fig, ax = plt.subplots(figsize=(14, 5))
    for wrist in WRIST_LANDMARKS:
        ax.plot(seconds, compute_wrist_speed(landmarks, wrist), linewidth=0.8, label=wrist)
    ax.set_title("Wrist speed")
    ax.set_xlabel("Time (sec)")
    ax.set_ylabel("Normalized coordinate / sec")
    ax.legend(loc="best")
    ax.grid(True, alpha=0.3)
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_hand_fingertip_xy(hands: pd.DataFrame, output_path: Path) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    labeled = with_hand_panel_labels(with_hand_track_labels(compute_hand_tip_center(hands)))
    panel_labels = ordered_hand_panel_labels(labeled)
    fig, axes = make_vertical_hand_axes(plt, panel_labels)
    for ax, panel_label in zip(axes, panel_labels):
        panel = labeled[labeled["_handedness_label"] == panel_label]
        for track_label, track in panel.groupby("_track_label", sort=True):
            track = track.sort_values("timestamp_ms")
            seconds = time_seconds(track)
            for axis in ("x", "y"):
                column = f"_tipCenter_{axis}"
                label = f"{track_label} tipCenter_{axis}"
                ax.plot(seconds, pd.to_numeric(track[column], errors="coerce"), linewidth=0.8, label=label)
        ax.set_title(f"{panel_label} hand fingertip center x/y")
        ax.set_ylabel("Normalized coordinate")
        if not panel.empty:
            ax.legend(loc="best")
        ax.grid(True, alpha=0.3)
    axes[-1].set_xlabel("Time (sec)")
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_hand_fingertip_speed(hands: pd.DataFrame, output_path: Path) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    labeled = with_hand_panel_labels(with_hand_track_labels(compute_hand_tip_center(hands)))
    speed = compute_hand_tip_center_speed(hands)
    panel_labels = ordered_hand_panel_labels(labeled)
    fig, axes = make_vertical_hand_axes(plt, panel_labels)
    for ax, panel_label in zip(axes, panel_labels):
        panel = labeled[labeled["_handedness_label"] == panel_label]
        for track_label, track in panel.groupby("_track_label", sort=True):
            track = track.sort_values("timestamp_ms")
            seconds = time_seconds(track)
            label = f"{track_label} tipCenter"
            ax.plot(seconds, speed.loc[track.index], linewidth=0.8, label=label)
        ax.set_title(f"{panel_label} hand fingertip center speed")
        ax.set_ylabel("Normalized coordinate / sec")
        if not panel.empty:
            ax.legend(loc="best")
        ax.grid(True, alpha=0.3)
    axes[-1].set_xlabel("Time (sec)")
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_hand_raw_landmark_xy(hands: pd.DataFrame, output_path: Path) -> None:
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    landmark_names = hand_xy_landmark_names(hands)
    if not landmark_names:
        raise ValueError("hands does not contain any *_x/*_y landmark coordinate pairs")

    labeled = with_hand_panel_labels(with_hand_track_labels(hands))
    panel_labels = ordered_hand_panel_labels(labeled)
    fig, axes = make_vertical_hand_axes(plt, panel_labels, height_per_panel=3.8)
    for ax, panel_label in zip(axes, panel_labels):
        panel = labeled[labeled["_handedness_label"] == panel_label]
        plotted_lines = 0
        for track_label, track in panel.groupby("_track_label", sort=True):
            track = track.sort_values("timestamp_ms")
            seconds = time_seconds(track)
            for landmark in landmark_names:
                for axis in ("x", "y"):
                    column = f"{landmark}_{axis}"
                    label = f"{track_label} {column}"
                    ax.plot(
                        seconds,
                        pd.to_numeric(track[column], errors="coerce"),
                        linewidth=0.45,
                        alpha=0.65,
                        label=label,
                    )
                    plotted_lines += 1
        ax.set_title(f"{panel_label} raw hand landmark x/y")
        ax.set_ylabel("Normalized coordinate")
        if 0 < plotted_lines <= 16:
            ax.legend(loc="best")
        ax.grid(True, alpha=0.3)
    axes[-1].set_xlabel("Time (sec)")
    fig.tight_layout()
    save_plot(fig, output_path)
    plt.close(fig)


def plot_extracted_pose(input_dir: Path, output_dir: Path | None = None) -> dict[str, Path]:
    input_dir = Path(input_dir)
    output_dir = input_dir / "plots" if output_dir is None else Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    landmarks, metadata, pose_stem = read_pose_csvs(input_dir)
    hands = read_hand_csv(input_dir, pose_stem)
    output_paths = {
        key: output_dir / filename
        for key, filename in PLOT_FILENAMES.items()
    }

    plot_pose_status_timeline(metadata, output_paths["pose_status_timeline"], hands=hands)
    plot_landmark_visibility(landmarks, output_paths["landmark_visibility"])
    plot_wrist_xy(landmarks, output_paths["wrist_xy"])
    plot_wrist_speed(landmarks, output_paths["wrist_speed"])

    if hands is not None:
        output_paths["hand_fingertip_xy"] = output_dir / "hand_fingertip_xy.png"
        output_paths["hand_fingertip_speed"] = output_dir / "hand_fingertip_speed.png"
        output_paths["hand_raw_landmark_xy"] = output_dir / "hand_raw_landmark_xy.png"
        plot_hand_fingertip_xy(hands, output_paths["hand_fingertip_xy"])
        plot_hand_fingertip_speed(hands, output_paths["hand_fingertip_speed"])
        plot_hand_raw_landmark_xy(hands, output_paths["hand_raw_landmark_xy"])

    return output_paths


def main() -> None:
    parser = argparse.ArgumentParser(description="抽出済み MediaPipe Pose CSV から確認用グラフを生成")
    parser.add_argument("input_dir", type=Path, help="*_33landmarks.csv と *_frame_metadata.csv を含む出力フォルダ")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=None,
        help="グラフ保存先。省略時は input_dir/plots",
    )
    args = parser.parse_args()

    output_paths = plot_extracted_pose(args.input_dir, output_dir=args.output_dir)
    for label, path in output_paths.items():
        print(f"[保存] {label}: {path}")


if __name__ == "__main__":
    main()
