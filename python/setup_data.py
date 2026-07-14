"""Label StudioエクスポートJSONを動画ごとに分割し、subjectディレクトリに配置する。

Usage:
    python setup_data.py <label_studio_export.json> [--fps 30] [--data-dir data]
"""

import argparse
import json
from pathlib import Path

from modules.normalize_labels import normalize_timeline_labels


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Label StudioエクスポートJSONをsubjectごとに分割配置"
    )
    parser.add_argument("json_path", type=Path, help="Label StudioエクスポートJSON")
    parser.add_argument("--fps", type=float, default=30.0, help="動画のFPS（デフォルト30）")
    parser.add_argument(
        "--data-dir", type=Path, default=Path("data"), help="データディレクトリ"
    )
    args = parser.parse_args()

    with args.json_path.open() as f:
        data = json.load(f)

    by_file = normalize_timeline_labels(data, fps=args.fps)

    subjects_dir = args.data_dir / "subjects"
    print(f"動画数: {len(by_file)}")
    print()

    for i, (filename, annotations) in enumerate(sorted(by_file.items()), 1):
        subject_name = f"subject-{i}"
        subject_dir = subjects_dir / subject_name
        subject_dir.mkdir(parents=True, exist_ok=True)

        label_path = subject_dir / "labeling.json"
        with label_path.open("w") as f:
            json.dump(annotations, f, indent=2, ensure_ascii=False)

        label_counts = {}
        for ann in annotations:
            label_counts[ann["label"]] = label_counts.get(ann["label"], 0) + 1

        print(f"[{subject_name}] {filename}")
        print(f"  ラベル: {label_path}")
        print(f"  区間数: {len(annotations)} ({label_counts})")
        print(f"  → motion.csv を配置してください: {subject_dir / 'motion.csv'}")
        print()

    print("=== 次のステップ ===")
    print("mediapipeアプリで各動画をCSVエクスポートし、上記パスにmotion.csvとして保存してください。")
    print()
    print("動画とsubjectの対応:")
    for i, filename in enumerate(sorted(by_file.keys()), 1):
        print(f"  {filename} → subject-{i}/motion.csv")


if __name__ == "__main__":
    main()
