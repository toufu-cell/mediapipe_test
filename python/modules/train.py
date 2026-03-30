import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from xgboost import XGBClassifier


def train_and_evaluate(
    features_df: pd.DataFrame,
    test_subject: str,
    label_names: list[str],
) -> dict:
    """被験者単位で train/test 分割し、XGBoost で学習・評価する。"""
    meta_cols = ["label", "timestamp_ms", "_data_name"]
    feature_cols = [column for column in features_df.columns if column not in meta_cols]

    train_df = features_df[features_df["_data_name"] != test_subject]
    test_df = features_df[features_df["_data_name"] == test_subject]

    x_train = train_df[feature_cols].to_numpy()
    y_train_raw = train_df["label"].to_numpy()
    x_test = test_df[feature_cols].to_numpy()
    y_test = test_df["label"].to_numpy()

    unique_train_labels = sorted(set(int(label) for label in y_train_raw))
    label_to_encoded = {
        label: index for index, label in enumerate(unique_train_labels)
    }
    encoded_to_label = {
        index: label for label, index in label_to_encoded.items()
    }
    y_train = [label_to_encoded[int(label)] for label in y_train_raw]

    clf = XGBClassifier(
        objective="multi:softmax",
        num_class=len(unique_train_labels),
        eval_metric="mlogloss",
        n_estimators=32,
        max_depth=4,
        learning_rate=0.1,
        verbosity=0,
    )
    clf.fit(x_train, y_train)

    y_pred_encoded = clf.predict(x_test)
    y_pred = [encoded_to_label[int(label)] for label in y_pred_encoded]
    accuracy = accuracy_score(y_test, y_pred)
    report = classification_report(
        y_test,
        y_pred,
        labels=list(range(len(label_names))),
        target_names=label_names,
        output_dict=True,
        zero_division=0,
    )
    conf_mat = confusion_matrix(
        y_test,
        y_pred,
        labels=list(range(len(label_names))),
    )

    return {
        "accuracy": accuracy,
        "y_pred": y_pred,
        "y_test": y_test,
        "model": clf,
        "report": report,
        "confusion_matrix": conf_mat,
        "feature_cols": feature_cols,
    }
