import argparse
from pathlib import Path

import pandas as pd

from modules.labels import Labels
from modules.normalize_labels import load_annotations
from modules.plot import plot_confusion_matrix, plot_time_series_comparison
from modules.preprocess import (
    assign_labels,
    load_motion_source,
    preprocess_eval,
    preprocess_train,
)
from modules.train import train_and_evaluate


def main() -> None:
    parser = argparse.ArgumentParser(description="2D骨格データ行動分類")
    parser.add_argument(
        "-d",
        "--data-dir",
        type=Path,
        default=Path("data"),
        help="データディレクトリ",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("output"),
        help="出力ディレクトリ",
    )
    parser.add_argument(
        "-t",
        "--test-subject",
        type=str,
        required=True,
        help="テスト対象の被験者名",
    )
    parser.add_argument(
        "-w",
        "--window-sec",
        type=float,
        default=5.0,
        help="ウィンドウサイズ（秒）",
    )
    parser.add_argument(
        "-s",
        "--step-sec",
        type=float,
        default=0.5,
        help="ウィンドウステップ（秒）",
    )
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    window_ms = args.window_sec * 1000
    step_ms = args.step_sec * 1000

    labels = Labels(args.data_dir / "labels.csv")
    label_name_to_id = {labels.name(i): i for i in range(len(labels))}

    subjects_dir = args.data_dir / "subjects"
    subject_dirs = sorted(path for path in subjects_dir.iterdir() if path.is_dir())

    train_features_list: list[pd.DataFrame] = []
    eval_features_list: list[pd.DataFrame] = []

    for subject_dir in subject_dirs:
        subject_name = subject_dir.name
        motion_file = subject_dir / "motion.csv"
        label_json = subject_dir / "labeling.json"

        if not motion_file.exists() or not label_json.exists():
            print(f"[SKIP] {subject_name}: motion.csv or labeling.json not found")
            continue

        print(f"[前処理] {subject_name}")
        df = load_motion_source(motion_file)
        annotations = load_annotations(label_json)
        labeled = assign_labels(df, annotations, labels.other_id(), label_name_to_id)

        if subject_name == args.test_subject:
            features = preprocess_eval(labeled, window_ms, step_ms)
            features["_data_name"] = subject_name
            eval_features_list.append(features)
        else:
            features = preprocess_train(labeled, window_ms, step_ms)
            features["_data_name"] = subject_name
            train_features_list.append(features)

    train_df = pd.concat(train_features_list, ignore_index=True)
    eval_df = pd.concat(eval_features_list, ignore_index=True)

    train_path = args.output_dir / "train_features.csv"
    eval_path = args.output_dir / "eval_features.csv"
    train_df.to_csv(train_path, index=False)
    eval_df.to_csv(eval_path, index=False)
    print(f"[保存] train: {len(train_df)}行, eval: {len(eval_df)}行")

    features_df = pd.concat([train_df, eval_df], ignore_index=True)
    print(f"\n[学習] テスト対象: {args.test_subject}")
    result = train_and_evaluate(
        features_df=features_df,
        test_subject=args.test_subject,
        label_names=labels.names(),
    )

    print("\n=== 結果 ===")
    print(f"精度: {result['accuracy']:.4f}")
    print(f"マクロF1: {result['report']['macro avg']['f1-score']:.4f}")

    confusion_path = args.output_dir / "confusion_matrix.png"
    time_series_path = args.output_dir / "time_series.png"
    plot_confusion_matrix(
        result["confusion_matrix"],
        labels.names(),
        str(confusion_path),
    )
    plot_time_series_comparison(
        result["y_test"],
        result["y_pred"],
        labels.names(),
        str(time_series_path),
    )
    print(f"\n[出力] {confusion_path}")
    print(f"[出力] {time_series_path}")


if __name__ == "__main__":
    main()
