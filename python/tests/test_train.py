import numpy as np
import pandas as pd

from modules.train import train_and_evaluate


def test_train_and_evaluate() -> None:
    np.random.seed(42)
    n = 200
    features_df = pd.DataFrame(
        {
            "feat1-pos-avg": np.random.rand(n),
            "feat2-pos-avg": np.random.rand(n),
            "feat1-pos-std": np.random.rand(n),
            "feat2-pos-std": np.random.rand(n),
            "label": np.random.choice([0, 1, 2], n),
            "timestamp_ms": np.arange(n) * 500,
            "_data_name": ["subject-1"] * 100 + ["subject-2"] * 100,
        }
    )

    result = train_and_evaluate(
        features_df=features_df,
        test_subject="subject-2",
        label_names=["other", "walk", "sit"],
    )

    assert "accuracy" in result
    assert "y_pred" in result
    assert "y_test" in result
    assert "model" in result
    assert 0.0 <= result["accuracy"] <= 1.0
