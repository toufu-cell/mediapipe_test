import os
import sys
import tempfile
from pathlib import Path


TEST_ROOT = Path(__file__).resolve().parents[1]
TEST_TMPDIR = TEST_ROOT / ".tmp"
MPL_CONFIG_DIR = TEST_ROOT / "tests" / ".mplconfig"

sys.path.insert(0, str(TEST_ROOT))
TEST_TMPDIR.mkdir(exist_ok=True)

os.environ["TMPDIR"] = str(TEST_TMPDIR)
os.environ["MPLCONFIGDIR"] = str(MPL_CONFIG_DIR)
tempfile.tempdir = str(TEST_TMPDIR)
