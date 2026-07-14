from pathlib import Path

import pandas as pd
import pytest

from hand_landmarks_to_motion import HAND_LANDMARK_NAMES, convert_hand_csv


def make_hand_row(frame_index: int, score: float, offset: float) -> dict:
    row = {
        "timestamp_ms": frame_index * 10,
        "frame_index": frame_index,
        "handedness": "Left",
        "score": score,
    }
    for landmark in HAND_LANDMARK_NAMES:
        for axis in ("x", "y", "z"):
            row[f"{landmark}_{axis}"] = offset
    return row


def test_convert_hand_csv_preserves_empty_frames_and_uses_highest_score(
    tmp_path: Path,
) -> None:
    input_csv = tmp_path / "hands.csv"
    frame_csv = tmp_path / "frames.csv"
    output_csv = tmp_path / "motion.csv"
    pd.DataFrame([
        make_hand_row(frame_index=0, score=0.2, offset=2.0),
        make_hand_row(frame_index=0, score=0.9, offset=9.0),
    ]).to_csv(input_csv, index=False)
    pd.DataFrame([
        {"timestamp_ms": 0, "frame_index": 0},
        {"timestamp_ms": 10, "frame_index": 1},
    ]).to_csv(frame_csv, index=False)

    convert_hand_csv(input_csv, output_csv, frame_csv)

    result = pd.read_csv(output_csv)
    assert list(result["frame_index"]) == [0, 1]
    assert result.loc[0, "leftHand_score"] == pytest.approx(0.9)
    assert result.loc[0, "leftHand_wrist_x"] == pytest.approx(9.0)
    assert pd.isna(result.loc[1, "leftHand_score"])


def test_convert_hand_csv_rejects_missing_required_columns(tmp_path: Path) -> None:
    input_csv = tmp_path / "hands.csv"
    output_csv = tmp_path / "motion.csv"
    pd.DataFrame([{"timestamp_ms": 0, "frame_index": 0}]).to_csv(
        input_csv,
        index=False,
    )

    with pytest.raises(ValueError, match="Missing required columns"):
        convert_hand_csv(input_csv, output_csv)
