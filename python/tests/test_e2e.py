import sys
from pathlib import Path

import pandas as pd

import main


FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "main_data"


def test_e2e_pipeline(monkeypatch) -> None:
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
