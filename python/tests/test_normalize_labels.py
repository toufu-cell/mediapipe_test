import json
from pathlib import Path

from modules.normalize_labels import (
    load_annotations,
    normalize_label_studio,
    normalize_timeline_labels,
)


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


def test_normalize_label_studio() -> None:
    result = normalize_label_studio(FIXTURE_DIR / "label_studio.json")
    assert len(result) == 2
    assert result[0] == {"start_ms": 500, "end_ms": 3200, "label": "walk"}
    assert result[1] == {"start_ms": 5000, "end_ms": 8000, "label": "sit"}


def test_load_simple_annotations() -> None:
    result = load_annotations(FIXTURE_DIR / "simple_annotations.json")
    assert len(result) == 2
    assert result[0]["label"] == "walk"


def test_normalize_timeline_labels() -> None:
    data = [
        {
            "file_upload": "abc123-video1.mp4",
            "annotations": [{
                "result": [
                    {
                        "value": {
                            "ranges": [{"start": 0, "end": 90}],
                            "timelinelabels": ["walk"],
                        },
                        "type": "timelinelabels",
                    },
                    {
                        "value": {
                            "ranges": [{"start": 90, "end": 150}],
                            "timelinelabels": ["sit"],
                        },
                        "type": "timelinelabels",
                    },
                ],
            }],
        },
    ]
    result = normalize_timeline_labels(data, fps=30.0)
    assert "video1.mp4" in result
    annotations = result["video1.mp4"]
    assert len(annotations) == 2
    assert annotations[0]["label"] == "walk"
    assert annotations[0]["start_ms"] == 0
    assert annotations[0]["end_ms"] == 3000  # 90 frames / 30fps = 3s = 3000ms
    assert annotations[1]["label"] == "sit"
    assert annotations[1]["start_ms"] == 3000
    assert annotations[1]["end_ms"] == 5000  # 150 frames / 30fps = 5s = 5000ms


def test_load_annotations_timeline_format() -> None:
    """TimelineLabels形式のJSONをload_annotationsで自動判定できる"""
    data = [
        {
            "file_upload": "abc-test.mp4",
            "annotations": [{
                "result": [{
                    "value": {
                        "ranges": [{"start": 0, "end": 60}],
                        "timelinelabels": ["walk"],
                    },
                    "type": "timelinelabels",
                }],
            }],
        },
    ]
    fixture_path = FIXTURE_DIR / "timeline_labels.json"
    fixture_path.write_text(json.dumps(data))
    try:
        result = load_annotations(fixture_path, fps=30.0)
        assert len(result) == 1
        assert result[0]["label"] == "walk"
        assert result[0]["end_ms"] == 2000  # 60/30 = 2s
    finally:
        fixture_path.unlink()
