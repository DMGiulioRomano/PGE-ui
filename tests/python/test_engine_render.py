import os
import subprocess
import tempfile

import pytest

PGE_ROOT  = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../..", "PythonGranularEngine")
)
PYTHON    = os.path.join(PGE_ROOT, ".venv/bin/python")
MAIN      = os.path.join(PGE_ROOT, "src/main.py")
SHOWCASE  = os.path.join(PGE_ROOT, "configs/PGE_pitch_units_showcase.yml")


def test_render_pitch_units_showcase():
    with tempfile.NamedTemporaryFile(suffix=".aif", delete=False) as tmp:
        out_path = tmp.name

    try:
        r = subprocess.run(
            [PYTHON, MAIN, SHOWCASE, out_path, "--renderer", "numpy"],
            cwd=PGE_ROOT,
            capture_output=True,
            text=True,
            timeout=180,
        )
        combined = r.stdout + r.stderr
        assert r.returncode == 0, (
            f"exit {r.returncode}\nstdout:\n{r.stdout[-2000:]}\nstderr:\n{r.stderr[-2000:]}"
        )
        assert "InvalidFieldValueError"     not in combined
        assert "InvalidStrategyConfigError" not in combined
        assert "Traceback"                  not in combined
    finally:
        if os.path.exists(out_path):
            os.unlink(out_path)
