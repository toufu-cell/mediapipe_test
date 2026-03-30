from pathlib import Path

from modules.normalize_labels import load_annotations, normalize_label_studio


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
