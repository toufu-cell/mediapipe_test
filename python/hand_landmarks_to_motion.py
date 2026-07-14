"""Convert MediaPipe hand landmarks CSV into one-row-per-frame motion.csv."""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


HAND_LANDMARK_NAMES = [
    "wrist",
    "thumbCmc",
    "thumbMcp",
    "thumbIp",
    "thumbTip",
    "indexFingerMcp",
    "indexFingerPip",
    "indexFingerDip",
    "indexFingerTip",
    "middleFingerMcp",
    "middleFingerPip",
    "middleFingerDip",
    "middleFingerTip",
    "ringFingerMcp",
    "ringFingerPip",
    "ringFingerDip",
    "ringFingerTip",
    "pinkyMcp",
    "pinkyPip",
    "pinkyDip",
    "pinkyTip",
]


def frame_key(timestamp_ms: object, frame_index: object) -> tuple[int, int]:
    return (int(timestamp_ms), int(frame_index))


def build_output_columns() -> list[str]:
    columns = ["timestamp_ms", "frame_index"]
    for side in ("left", "right"):
        columns.append(f"{side}Hand_score")
        for landmark in HAND_LANDMARK_NAMES:
            columns.extend(
                [
                    f"{side}Hand_{landmark}_x",
                    f"{side}Hand_{landmark}_y",
                    f"{side}Hand_{landmark}_z",
                ]
            )
    return columns


def convert_hand_csv(
    input_csv: Path,
    output_csv: Path,
    frame_metadata_csv: Path | None = None,
) -> None:
    df = pd.read_csv(input_csv)
    required = {"timestamp_ms", "frame_index", "handedness", "score"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns in {input_csv}: {sorted(missing)}")

    if frame_metadata_csv is not None:
        frame_df = pd.read_csv(frame_metadata_csv)
        frame_required = {"timestamp_ms", "frame_index"}
        frame_missing = frame_required - set(frame_df.columns)
        if frame_missing:
            raise ValueError(
                f"Missing required columns in {frame_metadata_csv}: {sorted(frame_missing)}"
            )
        output_rows: list[dict] = [
            {"timestamp_ms": row.timestamp_ms, "frame_index": row.frame_index}
            for row in frame_df[["timestamp_ms", "frame_index"]].itertuples(index=False)
        ]
        row_by_key = {
            frame_key(row["timestamp_ms"], row["frame_index"]): row
            for row in output_rows
        }
    else:
        output_rows = []
        row_by_key = {}
    landmark_columns = [
        column
        for landmark in HAND_LANDMARK_NAMES
        for column in (f"{landmark}_x", f"{landmark}_y", f"{landmark}_z")
    ]
    missing_landmarks = [column for column in landmark_columns if column not in df.columns]
    if missing_landmarks:
        raise ValueError(f"Missing landmark columns in {input_csv}: {missing_landmarks}")

    for (timestamp_ms, frame_index), frame_df in df.groupby(["timestamp_ms", "frame_index"], sort=True):
        key = frame_key(timestamp_ms, frame_index)
        row = row_by_key.get(key)
        if row is None:
            row = {"timestamp_ms": timestamp_ms, "frame_index": frame_index}
            output_rows.append(row)
            row_by_key[key] = row
        for side, label in (("left", "Left"), ("right", "Right")):
            candidates = frame_df[frame_df["handedness"] == label].copy()
            if candidates.empty:
                continue
            candidates["score"] = pd.to_numeric(candidates["score"], errors="coerce")
            hand = candidates.sort_values("score", ascending=False).iloc[0]
            row[f"{side}Hand_score"] = hand["score"]
            for landmark in HAND_LANDMARK_NAMES:
                for axis in ("x", "y", "z"):
                    row[f"{side}Hand_{landmark}_{axis}"] = hand[f"{landmark}_{axis}"]

    output = pd.DataFrame(output_rows, columns=build_output_columns())
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    output.to_csv(output_csv, index=False)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert long MediaPipe hand landmarks CSV to hand-only motion.csv"
    )
    parser.add_argument("input_csv", type=Path, help="*_hand_landmarks.csv")
    parser.add_argument("output_csv", type=Path, help="motion.csv output path")
    parser.add_argument(
        "--frame-metadata-csv",
        type=Path,
        default=None,
        help="Optional *_frame_metadata.csv to preserve frames with no detected hands",
    )
    args = parser.parse_args()

    convert_hand_csv(args.input_csv, args.output_csv, args.frame_metadata_csv)


if __name__ == "__main__":
    main()
