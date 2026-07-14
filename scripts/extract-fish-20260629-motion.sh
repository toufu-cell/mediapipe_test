#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_DIR="$ROOT_DIR/python"
DATA_DIR="$PYTHON_DIR/data/fish_20260629_labelstudio"
MANIFEST="$DATA_DIR/manifest.csv"
CAPTURES_DIR="$ROOT_DIR/captures"
PYTHON_BIN="$PYTHON_DIR/.venv-extract/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "missing extractor python: $PYTHON_BIN" >&2
    exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
    echo "missing manifest: $MANIFEST" >&2
    exit 1
fi

cd "$PYTHON_DIR"

tail -n +2 "$MANIFEST" | while IFS=, read -r subject task_id inner_id video segments max_end_ms; do
    subject_dir="$DATA_DIR/subjects/$subject"
    extract_dir="$subject_dir/extract"
    video_path="$CAPTURES_DIR/$video"
    video_name="$(basename "$video")"
    stem="${video_name%.mp4}"
    hand_csv_path="$extract_dir/${stem}_hand_landmarks.csv"
    frame_metadata_path="$extract_dir/${stem}_frame_metadata.csv"
    motion_csv="$subject_dir/motion.csv"

    if [[ ! -f "$video_path" ]]; then
        echo "missing video for $subject: $video_path" >&2
        exit 1
    fi

    mkdir -p "$extract_dir"

    echo "[$subject] task=$task_id video=$video_name"
    "$PYTHON_BIN" extract_pose_video.py "$video_path" \
        -o "$extract_dir" \
        --write-overlay-video \
        --landmark-profile upper-body \
        --visibility-threshold 0.5 \
        --arm-selection auto-visible \
        --arm-selection-min-score-margin 0.5 \
        --detect-hands \
        --max-hands 2 \
        --max-interpolation-ms 250 \
        --min-pose-bbox-area 0.006 \
        --min-shoulder-width 0.05 \
        --max-center-jump 0.35 \
        --min-valid-upper-body-landmarks 4

    if [[ ! -f "$hand_csv_path" ]]; then
        echo "expected hand CSV was not created: $hand_csv_path" >&2
        exit 1
    fi
    if [[ ! -f "$frame_metadata_path" ]]; then
        echo "expected frame metadata was not created: $frame_metadata_path" >&2
        exit 1
    fi

    "$PYTHON_BIN" hand_landmarks_to_motion.py \
        "$hand_csv_path" \
        "$motion_csv" \
        --frame-metadata-csv "$frame_metadata_path"
    echo "[$subject] wrote hand-only $motion_csv"
done

echo "done: $DATA_DIR"
