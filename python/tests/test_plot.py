import sys
import types
from pathlib import Path

import numpy as np

from modules.plot import plot_confusion_matrix, plot_time_series_comparison


class FakeAxes:
    def plot(self, *args, **kwargs) -> None:
        return None

    def set_ylabel(self, *args, **kwargs) -> None:
        return None

    def set_yticks(self, *args, **kwargs) -> None:
        return None

    def set_yticklabels(self, *args, **kwargs) -> None:
        return None

    def set_xlabel(self, *args, **kwargs) -> None:
        return None

    def set_title(self, *args, **kwargs) -> None:
        return None


class FakeFigure:
    def __init__(self, saved_paths: list[Path]):
        self.saved_paths = saved_paths

    def tight_layout(self) -> None:
        return None

    def savefig(self, path, *args, **kwargs) -> None:
        self.saved_paths.append(Path(path))

    def suptitle(self, *args, **kwargs) -> None:
        return None


def install_plot_stubs(monkeypatch, saved_paths: list[Path]) -> None:
    fake_pyplot = types.SimpleNamespace()
    fake_pyplot.subplots = lambda *args, **kwargs: (
        FakeFigure(saved_paths),
        [FakeAxes(), FakeAxes()] if args[:2] == (2, 1) else FakeAxes(),
    )
    fake_pyplot.close = lambda fig: None

    class FakeConfusionMatrixDisplay:
        def __init__(self, confusion_matrix, display_labels):
            self.confusion_matrix = confusion_matrix
            self.display_labels = display_labels

        def plot(self, ax=None, cmap=None, values_format=None) -> None:
            return None

    fake_matplotlib = types.ModuleType("matplotlib")
    fake_matplotlib.pyplot = fake_pyplot
    fake_sklearn = types.ModuleType("sklearn")
    fake_sklearn_metrics = types.SimpleNamespace(
        ConfusionMatrixDisplay=FakeConfusionMatrixDisplay,
    )
    fake_sklearn.metrics = fake_sklearn_metrics

    monkeypatch.setitem(sys.modules, "matplotlib", fake_matplotlib)
    monkeypatch.setitem(sys.modules, "matplotlib.pyplot", fake_pyplot)
    monkeypatch.setitem(sys.modules, "sklearn", fake_sklearn)
    monkeypatch.setitem(sys.modules, "sklearn.metrics", fake_sklearn_metrics)
    monkeypatch.setitem(sys.modules, "japanize_matplotlib", types.SimpleNamespace())


def test_plot_confusion_matrix(monkeypatch) -> None:
    saved_paths: list[Path] = []
    install_plot_stubs(monkeypatch, saved_paths)

    plot_confusion_matrix(
        np.array([[3, 1], [0, 4]]),
        ["other", "walk"],
        "confusion_matrix.png",
    )

    assert saved_paths == [Path("confusion_matrix.png")]


def test_plot_time_series_comparison(monkeypatch) -> None:
    saved_paths: list[Path] = []
    install_plot_stubs(monkeypatch, saved_paths)

    plot_time_series_comparison(
        np.array([0, 1, 1, 0]),
        np.array([0, 1, 0, 0]),
        ["other", "walk"],
        "time_series.png",
    )

    assert saved_paths == [Path("time_series.png")]
