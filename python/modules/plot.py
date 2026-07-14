import numpy as np


def plot_confusion_matrix(
    conf_mat: np.ndarray,
    label_names: list[str],
    output_path: str,
) -> None:
    """混同行列をプロットする。"""
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt
    from sklearn.metrics import ConfusionMatrixDisplay

    fig, ax = plt.subplots(figsize=(8, 6))
    disp = ConfusionMatrixDisplay(
        confusion_matrix=conf_mat,
        display_labels=label_names,
    )
    disp.plot(ax=ax, cmap="Blues", values_format="d")
    ax.set_title("混同行列")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)


def plot_time_series_comparison(
    y_test: np.ndarray,
    y_pred: np.ndarray,
    class_ids: list[int],
    label_names: list[str],
    output_path: str,
) -> None:
    """真値と予測の時系列比較をプロットする。

    class_ids と label_names は呼び出し側が用意した「fold 内で有効な全クラス」
    の対応表。tick 位置は class_ids に固定し、fold 間で軸が揃うようにする。
    """
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    if len(class_ids) != len(label_names):
        raise ValueError(
            f"class_ids と label_names の長さが一致していません: "
            f"{len(class_ids)} vs {len(label_names)}"
        )

    fig, axes = plt.subplots(2, 1, figsize=(14, 5), sharex=True)

    axes[0].plot(y_test, linewidth=0.5)
    axes[0].set_ylabel("真値")
    axes[0].set_yticks(class_ids)
    axes[0].set_yticklabels(label_names)

    axes[1].plot(y_pred, linewidth=0.5, color="orange")
    axes[1].set_ylabel("予測")
    axes[1].set_yticks(class_ids)
    axes[1].set_yticklabels(label_names)
    axes[1].set_xlabel("ウィンドウ番号")

    fig.suptitle("行動分類 — 真値 vs 予測")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
