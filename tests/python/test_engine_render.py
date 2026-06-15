import math
import os
import struct
import subprocess
import tempfile
import wave

import pytest

PGE_ROOT  = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../..", "PythonGranularEngine")
)
PYTHON    = os.path.join(PGE_ROOT, ".venv/bin/python")
MAIN      = os.path.join(PGE_ROOT, "src/main.py")
SHOWCASE  = os.path.join(PGE_ROOT, "configs/PGE_pitch_units_showcase.yml")
SAMPLE    = os.path.join(PGE_ROOT, "refs/weNeedToTalkAboutIt.wav")

# Integration test: shells out to the engine. Skip cleanly when the sibling
# engine repo or its venv isn't present (e.g. CI without the checkout) instead
# of erroring with FileNotFoundError. #46
pytestmark = pytest.mark.skipif(
    not (os.path.exists(PYTHON) and os.path.exists(MAIN)),
    reason="PythonGranularEngine venv/main.py not available",
)


def _synthesize_sample(path, *, seconds=20, sr=48000):
    """Write a tiny synthetic mono WAV so the render has a source sample.

    The showcase config references refs/weNeedToTalkAboutIt.wav, which is
    gitignored in the engine repo (*.wav) and so absent from a fresh checkout
    (e.g. in CI). This smoke test only asserts the render exits 0 with no engine
    errors, so any content works; we use the stdlib `wave` module to stay
    dependency-free (no numpy/soundfile in the bridge's CI env).
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    frames = bytearray()
    for i in range(int(seconds * sr)):
        t = i / sr
        v = 0.2 * math.sin(2 * math.pi * 220 * t) + 0.1 * math.sin(2 * math.pi * 440 * t)
        frames += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))


@pytest.fixture
def sample_present():
    """Ensure the config's source sample exists for the render.

    If a real sample is already present (a dev's own refs/), leave it untouched.
    Otherwise synthesize one and remove it afterwards so the checkout stays clean.
    """
    if os.path.exists(SAMPLE):
        yield
        return
    _synthesize_sample(SAMPLE)
    try:
        yield
    finally:
        if os.path.exists(SAMPLE):
            os.unlink(SAMPLE)


def test_render_pitch_units_showcase(sample_present):
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
