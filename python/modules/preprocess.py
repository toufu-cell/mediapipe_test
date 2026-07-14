import logging
from pathlib import Path

import numpy as np
import pandas as pd


logger = logging.getLogger(__name__)

SUPPORTED_MODALITIES = ("combined", "video", "watch")
META_COLUMNS = {
    "timestamp_ms",
    "frame_index",
    "label",
    "imu_timestamp_ms",
    "imu_elapsed_ms",
    "aligned_imu_time_ms",
}


def load_motion_source(path: Path) -> pd.DataFrame:
    """入力アダプタ層。現 MVP では CSV のみ対応する。"""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".json":
        raise NotImplementedError(f"JSON input is planned but not yet implemented: {path}")
    raise ValueError(f"Unsupported file format: {suffix}")


def assign_labels(
    df: pd.DataFrame,
    annotations: list[dict],
    other_id: int,
    label_name_to_id: dict[str, int],
) -> pd.DataFrame:
    """タイムスタンプベースでラベルを付与する。"""
    labeled = df.copy()
    labeled["label"] = other_id

    for annotation in annotations:
        label_name = annotation["label"]
        if label_name not in label_name_to_id:
            logger.warning(
                "Unknown label '%s' in annotation, using other_id=%s",
                label_name,
                other_id,
            )
            label_id = other_id
        else:
            label_id = label_name_to_id[label_name]

        mask = (
            (labeled["timestamp_ms"] >= annotation["start_ms"])
            & (labeled["timestamp_ms"] < annotation["end_ms"])
        )
        labeled.loc[mask, "label"] = label_id

    return labeled


def split_by_label(df: pd.DataFrame) -> list[pd.DataFrame]:
    """連続ラベル区間に分割する。"""
    if df.empty:
        return []

    labels = df["label"].to_numpy()
    change_points = np.where(np.diff(labels) != 0)[0] + 1
    split_indices = [0, *change_points.tolist(), len(df)]

    return [df.iloc[split_indices[i] : split_indices[i + 1]].copy() for i in range(len(split_indices) - 1)]


def _get_feature_names(columns: pd.Index, suffix: str) -> list[str]:
    return [f"{column}-{suffix}" for column in columns]


def select_feature_columns(df: pd.DataFrame, modality: str = "combined") -> list[str]:
    """学習に使う数値特徴列を modality ごとに選ぶ。"""
    if modality not in SUPPORTED_MODALITIES:
        raise ValueError(
            f"Unsupported modality: {modality} "
            f"(supported: {', '.join(SUPPORTED_MODALITIES)})"
        )

    feature_candidates = [column for column in df.columns if column not in META_COLUMNS]
    numeric_cols = df[feature_candidates].select_dtypes(include=["number"]).columns

    if modality == "watch":
        feature_cols = [column for column in numeric_cols if column.startswith("imu_")]
    elif modality == "video":
        feature_cols = [column for column in numeric_cols if not column.startswith("imu_")]
    else:
        feature_cols = list(numeric_cols)

    if not feature_cols:
        raise ValueError(f"No numeric feature columns found for modality: {modality}")
    return feature_cols


def _extract_window_features(part_df: pd.DataFrame) -> tuple[pd.Series, list[str]]:
    avg = part_df.mean()
    var = part_df.var()
    std = part_df.std()
    max_val = part_df.max()
    min_val = part_df.min()
    median = part_df.median()

    names = (
        _get_feature_names(part_df.columns, "pos-avg")
        + _get_feature_names(part_df.columns, "pos-var")
        + _get_feature_names(part_df.columns, "pos-std")
        + _get_feature_names(part_df.columns, "pos-max")
        + _get_feature_names(part_df.columns, "pos-min")
        + _get_feature_names(part_df.columns, "pos-med")
    )
    values = pd.concat([avg, var, std, max_val, min_val, median])
    return values, names


def extract_features(
    df: pd.DataFrame,
    window_size_ms: float = 5000,
    step_size_ms: float = 500,
    modality: str = "combined",
) -> pd.DataFrame:
    """スライディングウィンドウで統計特徴量を抽出する。"""
    feature_cols = select_feature_columns(df, modality)

    timestamps = df["timestamp_ms"].to_numpy()
    rows: list[dict] = []
    current_time = float(timestamps[0])
    end_time = float(timestamps[-1] - window_size_ms)

    while current_time <= end_time:
        window_df = df[(timestamps >= current_time) & (timestamps < current_time + window_size_ms)]
        if len(window_df) < 2:
            current_time += step_size_ms
            continue

        values, names = _extract_window_features(window_df[feature_cols])
        row = dict(zip(names, values))
        row["label"] = int(window_df["label"].mode().iloc[0])
        row["timestamp_ms"] = float(window_df["timestamp_ms"].median())
        rows.append(row)
        current_time += step_size_ms

    return pd.DataFrame(rows)


def preprocess_train(
    labeled_df: pd.DataFrame,
    window_size_ms: float = 5000,
    step_size_ms: float = 500,
    modality: str = "combined",
) -> pd.DataFrame:
    """train 用: 連続ラベル区間のみで特徴量抽出する。"""
    features = [
        extract_features(segment, window_size_ms, step_size_ms, modality)
        for segment in split_by_label(labeled_df)
    ]
    features = [feature for feature in features if not feature.empty]
    if not features:
        return pd.DataFrame()
    return pd.concat(features, ignore_index=True)


def preprocess_eval(
    labeled_df: pd.DataFrame,
    window_size_ms: float = 5000,
    step_size_ms: float = 500,
    modality: str = "combined",
) -> pd.DataFrame:
    """eval 用: full sequence をそのまま windowing する。"""
    return extract_features(labeled_df, window_size_ms, step_size_ms, modality)
