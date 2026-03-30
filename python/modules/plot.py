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
    label_names: list[str],
    output_path: str,
) -> None:
    """真値と予測の時系列比較をプロットする。"""
    import japanize_matplotlib  # noqa: F401
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 1, figsize=(14, 5), sharex=True)

    axes[0].plot(y_test, linewidth=0.5)
    axes[0].set_ylabel("真値")
    axes[0].set_yticks(range(len(label_names)))
    axes[0].set_yticklabels(label_names)

    axes[1].plot(y_pred, linewidth=0.5, color="orange")
    axes[1].set_ylabel("予測")
    axes[1].set_yticks(range(len(label_names)))
    axes[1].set_yticklabels(label_names)
    axes[1].set_xlabel("ウィンドウ番号")

    fig.suptitle("行動分類 — 真値 vs 予測")
    fig.tight_layout()
    fig.savefig(output_path, dpi=150)
    plt.close(fig)
