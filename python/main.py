import argparse
from pathlib import Path


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
    print(f"データ: {args.data_dir}, テスト: {args.test_subject}")


if __name__ == "__main__":
    main()
