import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from modules.labels import Labels
from modules.normalize_labels import load_annotations
from modules.plot import plot_confusion_matrix, plot_time_series_comparison
from modules.preprocess import (
    SUPPORTED_MODALITIES,
    assign_labels,
    load_motion_source,
    preprocess_eval,
    preprocess_train,
)
from modules.train import SUPPORTED_CLASSIFIERS, train_and_evaluate


def load_all_subjects(
    subjects_dir: Path,
    labels: Labels,
    label_name_to_id: dict[str, int],
) -> dict[str, pd.DataFrame]:
    """全被験者のラベル付きDataFrameを読み込む"""
    subjects: dict[str, pd.DataFrame] = {}
    for subject_dir in sorted(subjects_dir.iterdir()):
        if not subject_dir.is_dir():
            continue
        motion_file = subject_dir / "motion.csv"
        label_json = subject_dir / "labeling.json"
        if not motion_file.exists() or not label_json.exists():
            print(f"[SKIP] {subject_dir.name}: motion.csv or labeling.json not found")
            continue
        df = load_motion_source(motion_file)
        annotations = load_annotations(label_json)
        labeled = assign_labels(df, annotations, labels.other_id(), label_name_to_id)
        subjects[subject_dir.name] = labeled
    return subjects


def run_single(
    subjects: dict[str, pd.DataFrame],
    test_subject: str,
    labels: Labels,
    window_ms: float,
    step_ms: float,
    output_dir: Path,
    classifier: str = "xgboost",
    modality: str = "combined",
) -> dict:
    """単一テスト被験者での学習・評価"""
    train_features_list: list[pd.DataFrame] = []
    eval_features_list: list[pd.DataFrame] = []

    for name, labeled in subjects.items():
        if name == test_subject:
            features = preprocess_eval(labeled, window_ms, step_ms, modality)
        else:
            features = preprocess_train(labeled, window_ms, step_ms, modality)
        features["_data_name"] = name
        if name == test_subject:
            eval_features_list.append(features)
        else:
            train_features_list.append(features)

    train_df = pd.concat(train_features_list, ignore_index=True)
    eval_df = pd.concat(eval_features_list, ignore_index=True)

    # other（id=0）を除外し、ラベルIDを0始まりに振り直す
    other_id = labels.other_id()
    train_df = train_df[train_df["label"] != other_id].reset_index(drop=True)
    eval_df = eval_df[eval_df["label"] != other_id].reset_index(drop=True)

    active_ids = sorted(set(train_df["label"].unique()) | set(eval_df["label"].unique()))
    id_remap = {old_id: new_id for new_id, old_id in enumerate(active_ids)}
    train_df["label"] = train_df["label"].map(id_remap)
    eval_df["label"] = eval_df["label"].map(id_remap)

    output_dir.mkdir(parents=True, exist_ok=True)
    train_df.to_csv(output_dir / "train_features.csv", index=False)
    eval_df.to_csv(output_dir / "eval_features.csv", index=False)
    print(f"[保存] train: {len(train_df)}行, eval: {len(eval_df)}行")

    # active_ids (remap前の旧ID) と同じ順序でラベル名を構築する
    # → remap 後の新ID i ↔ active_label_names[i] が一致
    active_label_names = [labels.name(old_id) for old_id in active_ids]
    active_class_ids = list(range(len(active_label_names)))

    features_df = pd.concat([train_df, eval_df], ignore_index=True)
    result = train_and_evaluate(
        features_df=features_df,
        test_subject=test_subject,
        class_ids=active_class_ids,
        label_names=active_label_names,
        classifier=classifier,
    )

    plot_confusion_matrix(
        result["confusion_matrix"],
        active_label_names,
        str(output_dir / "confusion_matrix.png"),
    )
    plot_time_series_comparison(
        result["y_test"],
        result["y_pred"],
        active_class_ids,
        active_label_names,
        str(output_dir / "time_series.png"),
    )

    return result


def run_loso(
    subjects: dict[str, pd.DataFrame],
    labels: Labels,
    window_ms: float,
    step_ms: float,
    output_dir: Path,
    classifier: str = "xgboost",
    modality: str = "combined",
) -> pd.DataFrame:
    """全被験者を順番にテストに回すLOSO評価"""
    results: list[dict] = []
    subject_names = sorted(subjects.keys())

    print(f"=== LOSO評価（{len(subject_names)}被験者） ===\n")

    for test_subject in subject_names:
        print(f"--- テスト: {test_subject} ---")
        fold_dir = output_dir / test_subject
        result = run_single(
            subjects,
            test_subject,
            labels,
            window_ms,
            step_ms,
            fold_dir,
            classifier,
            modality,
        )
        results.append({
            "subject": test_subject,
            "accuracy": result["accuracy"],
            "macro_f1": result["macro_f1"],
        })
        print(f"精度: {result['accuracy']:.4f}, マクロF1: {result['macro_f1']:.4f}\n")

    # サマリ
    accuracies = [r["accuracy"] for r in results]
    f1_scores = [r["macro_f1"] for r in results]

    print("=== LOSO サマリ ===")
    print(f"{'被験者':<15} {'精度':>8} {'マクロF1':>10}")
    print("-" * 35)
    for r in results:
        print(f"{r['subject']:<15} {r['accuracy']:>8.4f} {r['macro_f1']:>10.4f}")
    print("-" * 35)
    print(f"{'平均':<15} {np.mean(accuracies):>8.4f} {np.mean(f1_scores):>10.4f}")
    print(f"{'標準偏差':<15} {np.std(accuracies):>8.4f} {np.std(f1_scores):>10.4f}")

    # サマリCSV保存
    summary_df = pd.DataFrame(results)
    summary_df.loc[len(summary_df)] = {"subject": "平均", "accuracy": np.mean(accuracies), "macro_f1": np.mean(f1_scores)}
    summary_df.to_csv(output_dir / "loso_summary.csv", index=False)
    print(f"\n[出力] {output_dir}/loso_summary.csv")
    for name in subject_names:
        print(f"[出力] {output_dir}/{name}/confusion_matrix.png")
    return summary_df


def summarize_single_modality_result(modality: str, result: dict) -> dict:
    return {
        "modality": modality,
        "accuracy": result["accuracy"],
        "macro_f1": result["macro_f1"],
    }


def summarize_loso_modality_result(modality: str, summary_df: pd.DataFrame) -> dict:
    mean_row = summary_df[summary_df["subject"] == "平均"].iloc[0]
    return {
        "modality": modality,
        "accuracy": mean_row["accuracy"],
        "macro_f1": mean_row["macro_f1"],
    }


def run_modality_comparison(
    subjects: dict[str, pd.DataFrame],
    labels: Labels,
    window_ms: float,
    step_ms: float,
    output_dir: Path,
    classifier: str,
    test_subject: str | None = None,
    loso: bool = False,
) -> pd.DataFrame:
    """watch / video / combined の同条件比較を実行する。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict] = []

    for modality in ("watch", "video", "combined"):
        modality_dir = output_dir / modality
        if loso:
            summary_df = run_loso(
                subjects,
                labels,
                window_ms,
                step_ms,
                modality_dir,
                classifier,
                modality,
            )
            rows.append(summarize_loso_modality_result(modality, summary_df))
        else:
            result = run_single(
                subjects,
                test_subject,
                labels,
                window_ms,
                step_ms,
                modality_dir,
                classifier,
                modality,
            )
            rows.append(summarize_single_modality_result(modality, result))

    summary_df = pd.DataFrame(rows)
    summary_df.to_csv(output_dir / "modality_summary.csv", index=False)
    print(f"\n[出力] {output_dir}/modality_summary.csv")
    return summary_df


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
        default=None,
        help="テスト対象の被験者名（省略で LOSO）",
    )
    parser.add_argument(
        "--loso",
        action="store_true",
        help="全被験者でLOSO評価を実行（注: subjects/ 直下を1被験者として扱うため、同一人物の複数動画が別 subject として登録されている場合は実質 Leave-One-Video-Out になる）",
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
    parser.add_argument(
        "-c",
        "--classifier",
        type=str,
        choices=SUPPORTED_CLASSIFIERS,
        default="xgboost",
        help=f"分類器（{', '.join(SUPPORTED_CLASSIFIERS)}）",
    )
    parser.add_argument(
        "--modality",
        type=str,
        choices=SUPPORTED_MODALITIES,
        default=None,
        help="学習に使う特徴量種別（combined, video, watch）",
    )
    parser.add_argument(
        "--compare-modalities",
        action="store_true",
        help="watch / video / combined の3条件で同じ学習評価を実行する",
    )
    args = parser.parse_args()

    if args.compare_modalities and args.modality is not None:
        parser.error("--compare-modalities と --modality は同時指定できません")
    if not args.loso and args.test_subject is None:
        parser.error("-t/--test-subject か --loso のどちらかを指定してください")

    window_ms = args.window_sec * 1000
    step_ms = args.step_sec * 1000
    modality = args.modality or "combined"

    labels = Labels(args.data_dir / "labels.csv")
    label_name_to_id = labels.name_to_id_map()

    subjects_dir = args.data_dir / "subjects"
    print("[読み込み中...]")
    subjects = load_all_subjects(subjects_dir, labels, label_name_to_id)
    print(f"被験者数: {len(subjects)}\n")

    print(f"[分類器] {args.classifier}")
    if args.compare_modalities:
        run_modality_comparison(
            subjects=subjects,
            labels=labels,
            window_ms=window_ms,
            step_ms=step_ms,
            output_dir=Path(args.output_dir),
            classifier=args.classifier,
            test_subject=args.test_subject,
            loso=args.loso,
        )
    elif args.loso:
        run_loso(subjects, labels, window_ms, step_ms, Path(args.output_dir), args.classifier, modality)
    else:
        print(f"[学習] テスト対象: {args.test_subject}")
        result = run_single(
            subjects,
            args.test_subject,
            labels,
            window_ms,
            step_ms,
            Path(args.output_dir),
            args.classifier,
            modality,
        )
        print(f"\n=== 結果 ===")
        print(f"精度: {result['accuracy']:.4f}")
        print(f"マクロF1: {result['macro_f1']:.4f}")
        print(f"\n[出力] {args.output_dir}/confusion_matrix.png")
        print(f"[出力] {args.output_dir}/time_series.png")


if __name__ == "__main__":
    main()
