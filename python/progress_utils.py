from __future__ import annotations

import sys
from typing import Callable, TextIO


ProgressCallback = Callable[[int, int], None]


def build_progress_reporter(
    label: str,
    total_frames: int,
    interval_percent: int = 5,
    stream: TextIO | None = None,
) -> ProgressCallback:
    output_stream = stream or sys.stdout
    next_percent = interval_percent

    def reporter(current_frame: int, total_frame_count: int) -> None:
        nonlocal next_percent

        if total_frame_count <= 0:
            return

        percent = int((current_frame / total_frame_count) * 100)
        while next_percent <= 100 and (percent >= next_percent or current_frame >= total_frame_count):
            print(
                f"[進捗] {label}: {next_percent}% ({current_frame}/{total_frame_count})",
                file=output_stream,
                flush=True,
            )
            next_percent += interval_percent

    return reporter
