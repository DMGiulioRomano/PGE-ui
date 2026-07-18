import math
import os
import re
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

# `sample:` lines in the showcase config, with optional quotes and trailing
# comment. Regex instead of a YAML parser so the fixture stays stdlib-only.
_SAMPLE_RE = re.compile(r"""^\s*sample:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$""",
                        re.MULTILINE)


def _showcase_samples():
    """Sample filenames referenced by the showcase config.

    Read from the config itself rather than hardcoded: the showcase drifts
    with the engine (it referenced weNeedToTalkAboutIt.wav, now voice.wav),
    and a hardcoded name silently stops covering the render's real inputs."""
    try:
        with open(SHOWCASE, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    return sorted({m.group(1).strip() for m in _SAMPLE_RE.finditer(text)})

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
    """Ensure every source sample the config references exists for the render.

    Samples already present (a dev's own refs/) are left untouched; the missing
    ones are synthesized and removed afterwards so the checkout stays clean.
    """
    created = []
    for name in _showcase_samples():
        path = os.path.join(PGE_ROOT, "refs", name)
        if not os.path.exists(path):
            _synthesize_sample(path)
            created.append(path)
    try:
        yield
    finally:
        for path in created:
            if os.path.exists(path):
                os.unlink(path)


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
