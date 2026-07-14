import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from xgboost import XGBClassifier

SUPPORTED_CLASSIFIERS = ("xgboost", "randomforest")


def build_classifier(classifier: str, num_classes: int):
    """分類器インスタンスを生成する。"""
    if classifier == "xgboost":
        return XGBClassifier(
            objective="multi:softmax",
            num_class=num_classes,
            eval_metric="mlogloss",
            n_estimators=32,
            max_depth=4,
            learning_rate=0.1,
            verbosity=0,
        )
    if classifier == "randomforest":
        return RandomForestClassifier(
            n_estimators=300,
            max_features="sqrt",
            min_samples_leaf=2,
            min_samples_split=4,
            class_weight="balanced",
            random_state=42,
            n_jobs=-1,
        )
    raise ValueError(
        f"未対応の分類器: {classifier}（対応: {', '.join(SUPPORTED_CLASSIFIERS)}）"
    )


def train_and_evaluate(
    features_df: pd.DataFrame,
    test_subject: str,
    class_ids: list[int],
    label_names: list[str],
    classifier: str = "xgboost",
) -> dict:
    """被験者単位で train/test 分割し、学習・評価する。

    class_ids と label_names は呼び出し側で作った「fold 内で有効な全クラス」の
    対応表。fold に出ないクラスも含めることで、fold 間で classification_report /
    confusion_matrix の次元が揃い、混同行列の比較が容易になる。
    """
    if len(class_ids) != len(label_names):
        raise ValueError(
            f"class_ids と label_names の長さが一致していません: "
            f"{len(class_ids)} vs {len(label_names)}"
        )

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

    clf = build_classifier(classifier, len(unique_train_labels))
    clf.fit(x_train, y_train)

    y_pred_encoded = clf.predict(x_test)
    y_pred = [encoded_to_label[int(label)] for label in y_pred_encoded]
    accuracy = accuracy_score(y_test, y_pred)

    # class_ids は fold 内で有効な全クラス。テストに出ないクラスも
    # 0 行として報告・描画し、fold 間で次元を揃える。
    report = classification_report(
        y_test,
        y_pred,
        labels=class_ids,
        target_names=label_names,
        output_dict=True,
        zero_division=0,
    )
    conf_mat = confusion_matrix(
        y_test,
        y_pred,
        labels=class_ids,
    )

    return {
        "accuracy": accuracy,
        "macro_f1": report["macro avg"]["f1-score"],
        "y_pred": y_pred,
        "y_test": y_test,
        "model": clf,
        "report": report,
        "confusion_matrix": conf_mat,
        "feature_cols": feature_cols,
    }
