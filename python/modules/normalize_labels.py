import json
from pathlib import Path


def normalize_label_studio(path: Path) -> list[dict]:
    """Label Studio export JSON を内部形式に変換する。"""
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


def load_annotations(path: Path) -> list[dict]:
    """JSON 構造を自動判定して内部形式で返す。"""
    with path.open() as file:
        data = json.load(file)

    if isinstance(data, list) and data:
        first = data[0]
        if "annotations" in first:
            return normalize_label_studio(path)
        if "start" in first and "labels" in first:
            return load_simple_annotations(path)

    raise ValueError(f"Unknown annotation format in {path}")
