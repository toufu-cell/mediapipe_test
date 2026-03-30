import pytest
from pathlib import Path

from modules.labels import Labels


@pytest.fixture
def sample_labels_csv() -> Path:
    return Path(__file__).resolve().parent / "fixtures" / "labels.csv"


def test_load_labels(sample_labels_csv: Path) -> None:
    labels = Labels(sample_labels_csv)
    assert labels.name(1) == "walk"
    assert labels.id("sit") == 2
    assert len(labels) == 4


def test_other_id(sample_labels_csv: Path) -> None:
    labels = Labels(sample_labels_csv)
    assert labels.other_id() == 0


def test_label_names(sample_labels_csv: Path) -> None:
    labels = Labels(sample_labels_csv)
    assert labels.names() == ["other", "walk", "sit", "stop"]
