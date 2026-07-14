from pathlib import Path

import pandas as pd


class Labels:
    """ラベル定義の管理。labels.csv から動的に読み込む。"""

    def __init__(self, csv_path: Path):
        df = pd.read_csv(csv_path)
        self._id_to_name: dict[int, str] = dict(zip(df["id"], df["label"]))
        self._name_to_id: dict[str, int] = dict(zip(df["label"], df["id"]))

    def id(self, name: str) -> int:
        return self._name_to_id[name]

    def name(self, label_id: int) -> str:
        return self._id_to_name[label_id]

    def other_id(self) -> int:
        return self._name_to_id["other"]

    def names(self) -> list[str]:
        return list(self._id_to_name.values())

    def ids(self) -> list[int]:
        return list(self._id_to_name.keys())

    def name_to_id_map(self) -> dict[str, int]:
        return dict(self._name_to_id)

    def __len__(self) -> int:
        return len(self._id_to_name)
