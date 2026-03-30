import logging
from pathlib import Path

import numpy as np
import pandas as pd

from modules.preprocess import (
    assign_labels,
    load_motion_source,
    preprocess_eval,
    preprocess_train,
    split_by_label,
)


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


def make_motion_df() -> pd.DataFrame:
    n = 1000
    return pd.DataFrame(
        {
            "timestamp_ms": np.arange(0, n * 10, 10),
            "frame_index": np.arange(n),
            "leftShoulder_x": np.linspace(0.0, 1.0, n),
            "leftShoulder_y": np.linspace(1.0, 2.0, n),
            "rightShoulder_x": np.linspace(2.0, 3.0, n),
            "rightShoulder_y": np.linspace(3.0, 4.0, n),
        }
    )


def test_load_motion_source_csv() -> None:
    df = load_motion_source(FIXTURE_DIR / "motion.csv")
    assert "timestamp_ms" in df.columns
    assert len(df) == 5


def test_load_motion_source_json_not_implemented() -> None:
    json_path = FIXTURE_DIR / "label_studio.json"
    try:
        load_motion_source(json_path)
    except NotImplementedError:
        pass
    else:
        raise AssertionError("JSON input should not be implemented yet")


def test_assign_labels() -> None:
    df = make_motion_df()
    annotations = [
        {"start_ms": 0, "end_ms": 5000, "label": "walk"},
        {"start_ms": 5000, "end_ms": 10000, "label": "sit"},
    ]
    labeled = assign_labels(
        df,
        annotations,
        other_id=0,
        label_name_to_id={"walk": 1, "sit": 2},
    )
    assert "label" in labeled.columns
    assert labeled[labeled["label"] == 1].shape[0] > 0
    assert labeled[labeled["label"] == 2].shape[0] > 0


def test_assign_labels_unknown_warns(caplog) -> None:
    df = make_motion_df()
    annotations = [{"start_ms": 0, "end_ms": 5000, "label": "unknown_action"}]
    with caplog.at_level(logging.WARNING):
        assign_labels(df, annotations, other_id=0, label_name_to_id={"walk": 1})
    assert "unknown_action" in caplog.text


def test_split_by_label() -> None:
    df = make_motion_df()
    annotations = [
        {"start_ms": 0, "end_ms": 5000, "label": "walk"},
        {"start_ms": 5000, "end_ms": 10000, "label": "sit"},
    ]
    labeled = assign_labels(
        df,
        annotations,
        other_id=0,
        label_name_to_id={"walk": 1, "sit": 2},
    )
    segments = split_by_label(labeled)
    assert len(segments) == 2
    for seg in segments:
        assert seg["label"].nunique() == 1


def test_preprocess_train_no_boundary_crossing() -> None:
    df = make_motion_df()
    annotations = [
        {"start_ms": 0, "end_ms": 5000, "label": "walk"},
        {"start_ms": 5000, "end_ms": 10000, "label": "sit"},
    ]
    labeled = assign_labels(
        df,
        annotations,
        other_id=0,
        label_name_to_id={"walk": 1, "sit": 2},
    )
    features = preprocess_train(labeled, window_size_ms=2000, step_size_ms=500)
    assert len(features) > 0
    assert "label" in features.columns
    assert any("pos-avg" in col for col in features.columns)


def test_preprocess_eval_full_sequence() -> None:
    df = make_motion_df()
    annotations = [
        {"start_ms": 0, "end_ms": 5000, "label": "walk"},
        {"start_ms": 5000, "end_ms": 10000, "label": "sit"},
    ]
    labeled = assign_labels(
        df,
        annotations,
        other_id=0,
        label_name_to_id={"walk": 1, "sit": 2},
    )
    eval_features = preprocess_eval(labeled, window_size_ms=2000, step_size_ms=500)
    train_features = preprocess_train(labeled, window_size_ms=2000, step_size_ms=500)
    assert len(eval_features) > 0
    assert len(eval_features) >= len(train_features)
