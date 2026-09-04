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


# ---------------------------------------------------------------------------
# _resolve_audio — l'estensione CHIESTA per prima (#153)
#
# Col default `wav`, un `.aif` rimasto da un render precedente vinceva sempre:
# la clip suonava il `.wav` appena reso (`/output`, estensione esatta) e
# disegnava il waveform dell'`.aif` vecchio (`/peaks`, che risolve di qui).
# ---------------------------------------------------------------------------

def _both_formats(tmp_path, stem="snd"):
    (tmp_path / f"{stem}.aif").write_bytes(b"FORM")
    (tmp_path / f"{stem}.wav").write_bytes(b"RIFF")


def test_resolve_audio_prefers_requested_extension(tmp_path):
    _both_formats(tmp_path)
    assert ap._resolve_audio(tmp_path, "snd.wav") == tmp_path / "snd.wav"
    assert ap._resolve_audio(tmp_path, "snd.aif") == tmp_path / "snd.aif"


def test_resolve_audio_still_falls_back_when_requested_absent(tmp_path):
    (tmp_path / "snd.aif").write_bytes(b"FORM")
    # il fallback e' la ragione per cui questa funzione esiste: chi chiede un
    # formato che sul disco non c'e' prende quello che c'e'.
    assert ap._resolve_audio(tmp_path, "snd.wav") == tmp_path / "snd.aif"


def test_resolve_audio_unknown_requested_extension_falls_back(tmp_path):
    (tmp_path / "snd.wav").write_bytes(b"RIFF")
    assert ap._resolve_audio(tmp_path, "snd.ogg") == tmp_path / "snd.wav"


# ---------------------------------------------------------------------------
# /peaks e /spectrogram: la route serve il formato chiesto, e ne tiene la
# cache in una voce sua (#153)
#
# Le due route avevano una copia in linea dello stesso ciclo di estensioni; il
# nome della cache non portava il suffisso, quindi i due formati dello stesso
# stem si dividevano una voce sola e `_is_fresh` la dichiarava fresca per
# sempre. Qui si misura sul contenuto servito, non sul path scelto.
# ---------------------------------------------------------------------------

def _write_tone(path, amp, sr=8000, secs=0.25):
    import numpy as np
    import soundfile as sf
    t = np.arange(int(sr * secs), dtype="float32") / sr
    data = (amp * np.sin(2 * np.pi * 220.0 * t)).astype("float32")
    fmt = "AIFF" if path.suffix.lower() in {".aif", ".aiff"} else None
    sf.write(str(path), data, sr, format=fmt)


def _peaks_app(tmp_path):
    pytest.importorskip("numpy")
    pytest.importorskip("soundfile")
    pytest.importorskip("flask")
    import server

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    app = server.make_app(tmp_path, render_timeout=600.0)
    out = tmp_path / "output"
    # Due render dello stesso stream, due formati, ampiezze diverse: l'aif e'
    # il piu' VECCHIO, come sul disco che ha prodotto la issue.
    _write_tone(out / "proj__s1.aif", 0.25)
    _write_tone(out / "proj__s1.wav", 0.9)
    import os
    old = out / "proj__s1.aif"
    os.utime(old, (1_600_000_000, 1_600_000_000))
    return app, tmp_path


def test_peaks_route_serves_the_requested_format(tmp_path):
    # numpy arriva dall'importorskip dentro _peaks_app: importarlo prima
    # sarebbe un errore invece di uno skip dove lo stack audio non c'e'.
    app, ws = _peaks_app(tmp_path)
    np = pytest.importorskip("numpy")
    client = app.test_client()

    wav = np.frombuffer(client.get("/peaks/proj__s1.wav").data, dtype="<f4")
    aif = np.frombuffer(client.get("/peaks/proj__s1.aif").data, dtype="<f4")

    assert wav.max() > 0.8, "il .wav chiesto ha ampiezza 0.9"
    assert aif.max() < 0.4, "il .aif chiesto ha ampiezza 0.25"
    # Prima del fix erano lo stesso array: la route sceglieva sempre l'.aif e
    # le due richieste si dividevano una voce di cache sola.
    assert not np.array_equal(wav, aif)


def test_peaks_cache_entry_is_per_format(tmp_path):
    app, ws = _peaks_app(tmp_path)
    client = app.test_client()
    client.get("/peaks/proj__s1.wav")
    client.get("/peaks/proj__s1.aif")

    names = sorted(p.name for p in (ws / "cache" / "peaks").iterdir())
    assert names == [f"proj__s1.aif.{ap.PEAK_BUCKETS}.f32",
                     f"proj__s1.wav.{ap.PEAK_BUCKETS}.f32"], names


def test_spectrogram_route_serves_the_requested_format(tmp_path):
    app, ws = _peaks_app(tmp_path)
    client = app.test_client()
    wav = client.get("/spectrogram/proj__s1.wav").data
    aif = client.get("/spectrogram/proj__s1.aif").data
    assert wav != aif
    names = sorted(p.name for p in (ws / "cache" / "spec").iterdir())
    assert names == ["proj__s1.aif.linear.spec", "proj__s1.wav.linear.spec"], names


def test_peaks_route_falls_back_to_the_other_format(tmp_path):
    """Un progetto reso solo in aiff continua a disegnarsi col formato wav
    selezionato: la route ricade sull'unico file che c'e'."""
    app, ws = _peaks_app(tmp_path)
    np = pytest.importorskip("numpy")
    (ws / "output" / "proj__s1.wav").unlink()
    client = app.test_client()
    r = client.get("/peaks/proj__s1.wav")
    assert r.status_code == 200
    assert np.frombuffer(r.data, dtype="<f4").max() < 0.4


# ---------------------------------------------------------------------------
# /audio: stessa risoluzione, e la copia transcodificata fuori da output/
# ---------------------------------------------------------------------------

def test_audio_route_prefers_the_requested_format(tmp_path):
    """Chiesto `.wav` con entrambi sul disco, il wav si serve tale e quale —
    prima vinceva l'`.aif` e la richiesta passava da sox per niente."""
    app, ws = _peaks_app(tmp_path)
    r = app.test_client().get("/audio/proj__s1.wav")
    assert r.status_code == 200
    assert r.data[:4] == b"RIFF"


def test_audio_transcode_cache_is_not_a_phantom_stem(tmp_path, monkeypatch):
    """La copia WAV dell'aiff non va in output/: li' dentro /stems la
    inventaria, e `<basename>__<sid>.transcoded.wav` diventava uno stem con
    l'id `<sid>.transcoded` — un nome bruciato per allocStreamIds."""
    import server
    app, ws = _peaks_app(tmp_path)
    (ws / "output" / "proj__s1.wav").unlink()      # resta solo l'aiff

    # sox non serve a questo test: quel che si misura e' DOVE finisce la copia.
    def _fake_transcode(source, cache_file, timeout=30.0):
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_bytes(b"RIFF....WAVE")
        return cache_file
    monkeypatch.setattr(server, "transcode_wav", _fake_transcode)

    client = app.test_client()
    assert client.get("/audio/proj__s1.aif").status_code == 200

    ids = [s["streamId"] for s in client.get("/stems/proj").get_json()["stems"]]
    assert ids == ["s1"], ids
    assert (ws / "cache" / "output_wav" / "proj__s1.aif.wav").exists()
