import json
from pathlib import Path


def normalize_label_studio(path: Path) -> list[dict]:
    """Label Studio export JSON（時間ベース）を内部形式に変換する。"""
    with path.open() as file:
        data = json.load(file)

    annotations: list[dict] = []
    for task in data:
        for annotation in task.get("annotations", []):
            for result in annotation.get("result", []):
                value = result.get("value", {})
                labels = value.get("labels", [])
                if labels:
                    annotations.append(
                        {
                            "start_ms": int(value["start"] * 1000),
                            "end_ms": int(value["end"] * 1000),
                            "label": labels[0],
                        }
                    )

    return annotations


def normalize_timeline_labels(data: list[dict], fps: float = 30.0) -> dict[str, list[dict]]:
    """Label Studio TimelineLabels形式を動画ファイル名ごとの内部形式に変換する。

    TimelineLabels形式:
        result[].value.ranges[].start/end = フレーム番号
        result[].value.timelinelabels = ["label"]
        task.file_upload = "uuid-FILENAME.mp4"

    Returns:
        dict: {ファイル名: [{"start_ms", "end_ms", "label"}, ...]}
    """
    ms_per_frame = 1000.0 / fps
    result_by_file: dict[str, list[dict]] = {}

    for task in data:
        file_upload = task.get("file_upload", "")
        # "uuid-IMG_1688.mp4" → "IMG_1688.mp4"
        parts = file_upload.split("-", 1)
        filename = parts[1] if len(parts) > 1 else file_upload

        annotations: list[dict] = []
        for annotation in task.get("annotations", []):
            for res in annotation.get("result", []):
                value = res.get("value", {})
                timeline_labels = value.get("timelinelabels", [])
                ranges = value.get("ranges", [])
                if timeline_labels and ranges:
                    label = timeline_labels[0]
                    for r in ranges:
                        annotations.append(
                            {
                                "start_ms": int(r["start"] * ms_per_frame),
                                "end_ms": int(r["end"] * ms_per_frame),
                                "label": label,
                            }
                        )

        annotations.sort(key=lambda a: a["start_ms"])
        result_by_file[filename] = annotations

    return result_by_file


def load_simple_annotations(path: Path) -> list[dict]:
    """kjlb 形式のシンプルな JSON を内部形式へ変換する。"""
    with path.open() as file:
        data = json.load(file)

    annotations: list[dict] = []
    for item in data:
        labels = item.get("labels", [])
        if labels:
            annotations.append(
                {
                    "start_ms": int(item["start"] * 1000),
                    "end_ms": int(item["end"] * 1000),
                    "label": labels[0],
                }
            )

    return annotations


def load_annotations(path: Path, fps: float = 30.0) -> list[dict]:
    """JSON 構造を自動判定して内部形式で返す。

    TimelineLabels形式（複数動画）の場合は最初の動画のラベルを返す。
    動画ごとに分割したい場合は normalize_timeline_labels() を直接使う。
    """
    with path.open() as file:
        data = json.load(file)

    if isinstance(data, list) and data:
        first = data[0]
        # 既に内部形式（setup_data.pyで変換済み）
        if "start_ms" in first and "end_ms" in first and "label" in first:
            return data
        # Label Studio TimelineLabels形式（annotations.result[].value.timelinelabels）
        if "annotations" in first:
            first_annotations = first.get("annotations", [])
            if first_annotations:
                first_results = first_annotations[0].get("result", [])
                if first_results and "timelinelabels" in first_results[0].get("value", {}):
                    by_file = normalize_timeline_labels(data, fps)
                    # 最初の動画のラベルを返す
                    if by_file:
                        return next(iter(by_file.values()))
                    return []
            return normalize_label_studio(path)
        if "start" in first and "labels" in first:
            return load_simple_annotations(path)

    raise ValueError(f"Unknown annotation format in {path}")
