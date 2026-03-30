import os
import tempfile
from pathlib import Path


TEST_ROOT = Path(__file__).resolve().parents[1]
TEST_TMPDIR = TEST_ROOT / ".tmp"
TEST_TMPDIR.mkdir(exist_ok=True)

os.environ["TMPDIR"] = str(TEST_TMPDIR)
tempfile.tempdir = str(TEST_TMPDIR)
