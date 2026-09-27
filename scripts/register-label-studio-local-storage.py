from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CAPTURES_ROOT = REPO_ROOT / "captures"
DEFAULT_VENV = REPO_ROOT / ".venv-labelstudio311"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Register capture videos in a Label Studio project."
    )
    parser.add_argument("capture_ids", nargs="+", help="Capture directory names")
    parser.add_argument("--project-id", type=int, default=9)
    parser.add_argument(
        "--captures-root",
        type=Path,
        default=DEFAULT_CAPTURES_ROOT,
    )
    return parser


def configure_label_studio(captures_root: Path) -> None:
    os.environ.setdefault(
        "DJANGO_SETTINGS_MODULE", "label_studio.core.settings.label_studio"
    )
    os.environ["LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED"] = "true"
    os.environ["LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT"] = str(captures_root)

    site_packages = next(
        (DEFAULT_VENV / "lib").glob("python*/site-packages"),
        None,
    )
    if site_packages is None:
        raise RuntimeError(f"Label Studio environment not found: {DEFAULT_VENV}")
    sys.path.insert(0, str(site_packages / "label_studio"))


def validate_capture(captures_root: Path, capture_id: str) -> tuple[Path, Path]:
    capture_dir = (captures_root / capture_id).resolve()
    if not capture_dir.is_relative_to(captures_root):
        raise ValueError(f"Capture is outside captures root: {capture_id}")
    if not capture_dir.is_dir():
        raise FileNotFoundError(f"Capture directory not found: {capture_dir}")

    video_path = capture_dir / f"{capture_id}_labelstudio.mp4"
    if not video_path.is_file():
        raise FileNotFoundError(f"Labeling video not found: {video_path}")
    return capture_dir, video_path


def main() -> None:
    args = build_parser().parse_args()
    captures_root = args.captures_root.expanduser().resolve()
    if not captures_root.is_dir():
        raise FileNotFoundError(f"Captures root not found: {captures_root}")

    captures = [
        (capture_id, *validate_capture(captures_root, capture_id))
        for capture_id in args.capture_ids
    ]

    configure_label_studio(captures_root)
    import django

    django.setup()

    from io_storages.localfiles.models import LocalFilesImportStorage
    from projects.models import Project
    from tasks.models import Task

    project = Project.objects.get(id=args.project_id)
    print(f"project {project.id}: {project.title}")

    for capture_id, capture_dir, video_path in captures:
        storage, storage_created = LocalFilesImportStorage.objects.get_or_create(
            project=project,
            path=str(capture_dir),
            defaults={
                "title": capture_id,
                "use_blob_urls": True,
                "recursive_scan": False,
            },
        )
        storage.title = capture_id
        storage.use_blob_urls = True
        storage.recursive_scan = False
        storage.save(
            update_fields=["title", "use_blob_urls", "recursive_scan"]
        )

        relative_video = video_path.relative_to(captures_root).as_posix()
        task_data = {"video": f"/data/local-files/?d={relative_video}"}
        task, task_created = Task.objects.get_or_create(
            project=project,
            data=task_data,
        )
        storage_status = "created" if storage_created else "exists"
        task_status = "created" if task_created else "exists"
        print(
            f"{capture_id}: storage={storage.id} ({storage_status}), "
            f"task={task.id} ({task_status})"
        )


if __name__ == "__main__":
    main()
