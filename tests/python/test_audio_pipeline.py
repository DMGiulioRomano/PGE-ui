"""Tests for audio_pipeline.py path/security helpers and the cached-derivation
freshness rule (#43). DSP (numpy/soundfile) and sox are skipped when absent so
the suite runs in a minimal env / CI without the audio stack.
"""

import shutil

import pytest

import audio_pipeline as ap


# ---------------------------------------------------------------------------
# safe_resolve — path traversal rejection (security stance of the bridge)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["../etc/passwd", "a/b", "a\\b", "..", ".hidden", ""])
def test_safe_resolve_rejects(tmp_path, name):
    assert ap.safe_resolve(tmp_path, name) is None


def test_safe_resolve_accepts_plain_name(tmp_path):
    assert ap.safe_resolve(tmp_path, "ok.yml") == tmp_path / "ok.yml"


# ---------------------------------------------------------------------------
# _resolve_audio — extension fallback (browser may ask .aif for a .wav on disk)
# ---------------------------------------------------------------------------

def test_resolve_audio_extension_fallback(tmp_path):
    (tmp_path / "snd.wav").write_bytes(b"RIFF")
    # request .aif, get the .wav that's actually on disk
    assert ap._resolve_audio(tmp_path, "snd.aif") == tmp_path / "snd.wav"


def test_resolve_audio_missing_returns_none(tmp_path):
    assert ap._resolve_audio(tmp_path, "nope.aif") is None


def test_resolve_audio_rejects_traversal(tmp_path):
    assert ap._resolve_audio(tmp_path, "../snd.wav") is None


# ---------------------------------------------------------------------------
# audio_duration — soundfile-first, soxi fallback (no hard soxi dependency)
# ---------------------------------------------------------------------------

def test_soundfile_duration_unreadable_returns_none(tmp_path):
    # garbage / non-existent file → None (whether soundfile is installed or not)
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"not actually audio")
    assert ap._soundfile_duration(bad) is None
    assert ap._soundfile_duration(tmp_path / "nope.wav") is None


def test_audio_duration_via_soundfile(tmp_path):
    np = pytest.importorskip("numpy")
    sf = pytest.importorskip("soundfile")
    p = tmp_path / "tone.wav"
    sr = 22050
    sf.write(str(p), (0.1 * np.sin(2 * np.pi * 220 * np.arange(int(sr * 0.5)) / sr)).astype("float32"), sr)
    dur = ap.audio_duration(p)               # no soxi needed for this path
    assert dur is not None and abs(dur - 0.5) < 1e-3


def test_audio_duration_prefers_soundfile_over_soxi(tmp_path, monkeypatch):
    # soundfile yields a value → soxi must not override it
    monkeypatch.setattr(ap, "_soundfile_duration", lambda p: 2.5)
    monkeypatch.setattr(ap, "soxi_duration", lambda p: 99.0)
    assert ap.audio_duration(tmp_path / "x.wav") == 2.5


def test_audio_duration_falls_back_to_soxi(tmp_path, monkeypatch):
    # soundfile can't read it (None) → fall back to soxi
    monkeypatch.setattr(ap, "_soundfile_duration", lambda p: None)
    monkeypatch.setattr(ap, "soxi_duration", lambda p: 3.0)
    assert ap.audio_duration(tmp_path / "x.wav") == 3.0


def test_audio_duration_none_when_both_fail(tmp_path, monkeypatch):
    monkeypatch.setattr(ap, "_soundfile_duration", lambda p: None)
    monkeypatch.setattr(ap, "soxi_duration", lambda p: None)
    assert ap.audio_duration(tmp_path / "x.wav") is None


# ---------------------------------------------------------------------------
# Cached derivations — freshness rule (regenerate only when source is newer)
# ---------------------------------------------------------------------------

def test_is_fresh_rule(tmp_path):
    src = tmp_path / "src.bin"
    cache = tmp_path / "out.cache"
    src.write_bytes(b"x")
    assert not ap._is_fresh(cache, src)       # cache missing
    cache.write_bytes(b"y")
    import os, time
    now = time.time()
    os.utime(cache, (now, now))
    os.utime(src, (now - 10, now - 10))       # source older → fresh
    assert ap._is_fresh(cache, src)
    os.utime(src, (now + 10, now + 10))       # source newer → stale
    assert not ap._is_fresh(cache, src)


@pytest.mark.skipif(shutil.which("sox") is None, reason="sox not installed")
def test_transcode_wav_missing_source_raises(tmp_path):
    # sox on a non-existent source should fail → SoxFailed (not SoxNotFound)
    with pytest.raises(ap.SoxFailed):
        ap.transcode_wav(tmp_path / "nope.aif", tmp_path / "out.wav", timeout=10)


def test_peaks_file_without_numpy_raises_importerror(tmp_path):
    pytest.importorskip
    try:
        import numpy  # noqa: F401
        import soundfile  # noqa: F401
    except ImportError:
        src = tmp_path / "s.wav"
        src.write_bytes(b"x")
        with pytest.raises(ImportError):
            ap.peaks_file(src, tmp_path / "p.f32")
    else:
        pytest.skip("numpy/soundfile present — ImportError path not exercised")
