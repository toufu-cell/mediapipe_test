import sys
from pathlib import Path

import pandas as pd

import main


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "main_data"


def test_main_pipeline(monkeypatch) -> None:
    saved_csv_paths: list[Path] = []
    plotted_paths: list[Path] = []

    monkeypatch.setattr(main.Path, "mkdir", lambda self, parents=False, exist_ok=False: None)
    monkeypatch.setattr(
        pd.DataFrame,
        "to_csv",
        lambda self, path, index=False: saved_csv_paths.append(Path(path)),
    )
    monkeypatch.setattr(
        main,
        "plot_confusion_matrix",
        lambda conf_mat, label_names, output_path: plotted_paths.append(Path(output_path)),
    )
    monkeypatch.setattr(
        main,
        "plot_time_series_comparison",
        lambda y_test, y_pred, class_ids, label_names, output_path: plotted_paths.append(Path(output_path)),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "main.py",
            "-d",
            str(FIXTURE_DIR),
            "-o",
            str(FIXTURE_DIR / "output"),
            "-t",
            "subject-2",
            "-w",
            "0.05",
            "-s",
            "0.02",
        ],
    )

    main.main()

    assert saved_csv_paths == [
        FIXTURE_DIR / "output" / "train_features.csv",
        FIXTURE_DIR / "output" / "eval_features.csv",
    ]
    assert plotted_paths == [
        FIXTURE_DIR / "output" / "confusion_matrix.png",
        FIXTURE_DIR / "output" / "time_series.png",
    ]


def test_run_loso_returns_summary(monkeypatch) -> None:
    subjects = {
        "subject-1": pd.DataFrame(),
        "subject-2": pd.DataFrame(),
    }

    def fake_run_single(subjects, test_subject, labels, window_ms, step_ms, output_dir, classifier="xgboost", modality="combined"):
        macro_f1 = 0.6 if test_subject == "subject-1" else 0.4
        return {
            "accuracy": 0.75 if test_subject == "subject-1" else 0.5,
            "macro_f1": macro_f1,
            "report": {"macro avg": {"f1-score": macro_f1}},
        }

    monkeypatch.setattr(main, "run_single", fake_run_single)
    monkeypatch.setattr(main.Path, "mkdir", lambda self, parents=False, exist_ok=False: None)
    monkeypatch.setattr(pd.DataFrame, "to_csv", lambda self, path, index=False: None)

    summary = main.run_loso(
        subjects=subjects,
        labels=None,
        window_ms=50,
        step_ms=20,
        output_dir=FIXTURE_DIR / "output",
    )

    assert list(summary["subject"]) == ["subject-1", "subject-2", "平均"]
    assert summary.iloc[-1]["accuracy"] == 0.625
    assert summary.iloc[-1]["macro_f1"] == 0.5


def test_main_compare_modalities(monkeypatch) -> None:
    saved_csv_paths: list[Path] = []
    calls: list[tuple[str, Path]] = []

    def fake_run_single(subjects, test_subject, labels, window_ms, step_ms, output_dir, classifier="xgboost", modality="combined"):
        macro_f1 = {"watch": 0.1, "video": 0.4, "combined": 0.7}[modality]
        calls.append((modality, Path(output_dir)))
        return {
            "accuracy": {"watch": 0.2, "video": 0.5, "combined": 0.8}[modality],
            "macro_f1": macro_f1,
            "report": {"macro avg": {"f1-score": macro_f1}},
        }

    monkeypatch.setattr(main, "run_single", fake_run_single)
    monkeypatch.setattr(main.Path, "mkdir", lambda self, parents=False, exist_ok=False: None)
    monkeypatch.setattr(
        pd.DataFrame,
        "to_csv",
        lambda self, path, index=False: saved_csv_paths.append(Path(path)),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "main.py",
            "-d",
            str(FIXTURE_DIR),
            "-o",
            str(FIXTURE_DIR / "output" / "compare"),
            "-t",
            "subject-2",
            "--compare-modalities",
            "-w",
            "0.05",
            "-s",
            "0.02",
        ],
    )

    main.main()

    assert calls == [
        ("watch", FIXTURE_DIR / "output" / "compare" / "watch"),
        ("video", FIXTURE_DIR / "output" / "compare" / "video"),
        ("combined", FIXTURE_DIR / "output" / "compare" / "combined"),
    ]
    assert saved_csv_paths == [FIXTURE_DIR / "output" / "compare" / "modality_summary.csv"]
