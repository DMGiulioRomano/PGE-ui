#!/usr/bin/env python3
"""server.py — local HTTP bridge between the PGE browser editor and the
PythonGranularEngine renderer.

Lives in the PGE-ui repo. Talks to a separately-cloned PythonGranularEngine.

Default layout (clones side-by-side):
    ~/projects/PythonGranularEngine/
    ~/projects/PGE-ui/
                 ├── server.py        ← this file
                 ├── requirements.txt
                 ├── PGE Editor.html
                 └── ...

Run from PGE-ui:
    pip install -r requirements.txt
    python server.py
    # or, if PythonGranularEngine is elsewhere:
    python server.py --root /path/to/PythonGranularEngine --port 7878

Then in the browser:
    1) open PGE Editor.html
    2) click the gear icon (top-right)
    3) Backend → switch to "local"
    4) Backend → server URL → http://localhost:7878  (default)
    5) click "test connection" — should turn green
    6) hit Render — the browser POSTs to /render and streams the log back

The server speaks JSON-lines (NDJSON) for the /render endpoint so the browser
can read events incrementally. All other endpoints are plain JSON.

Endpoints:
    GET  /health                — sanity check + resolved paths
    GET  /config                — same payload as /health
    GET  /media                 — list refs/ contents with durations
    GET  /projects              — list configs/*.yml
    GET  /file?kind=…&name=…    — read a file (kind: projects|media|cache|output)
    PUT  /file?kind=…&name=…    — write a file
    GET  /cache_manifest/<basename>  — read cache/<basename>.json
    POST /render                — run main.py, stream NDJSON events
    POST /render/cancel         — terminate the running render
    GET  /output/<fname>        — serve a rendered .aif for browser playback
    GET  /audio/<fname>         — same but transcoded to WAV (Firefox-friendly)
    GET  /spectrogram/<fname>   — STFT spectrogram for a rendered stem
    GET  /media_audio/<fname>   — serve a refs/ media file as WAV for playback
    GET  /media_peaks/<fname>   — waveform peaks for a refs/ media file
    GET  /media_spectrogram/<fname> — STFT spectrogram for a refs/ media file
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

try:
    from flask import Flask, jsonify, request, send_file, send_from_directory, Response, abort
    from flask_cors import CORS
except ImportError:
    sys.exit("Missing deps. Run:\n    pip install flask flask-cors")


# -------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------

def soxi_duration(path: Path) -> "float | None":
    """Get audio file duration via `soxi -D`. Returns None if soxi isn't
    installed or the file is unreadable. Cheap — runs once per file at
    list-time, results aren't cached server-side (the browser caches)."""
    try:
        out = subprocess.check_output(
            ["soxi", "-D", str(path)],
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        ).decode().strip()
        return float(out)
    except Exception:
        return None


# Regexes for parsing main.py's stdout into structured UI events.
#
# Actual main.py output format (numpy renderer):
#   "[CACHE] stream1: clean"   → stream is cached, will be skipped
#   "[CACHE] stream1: DIRTY"   → stream will be rendered
#   " Generazione completata! 5 file generati:"
#   "    /abs/path/to/output/PGE_test__stream1.aif"
#
# Note: [CACHE] lines appear one per stream as each starts.
# The absolute path lines appear all together at the end (summary block).
_RE_CACHE_LINE = re.compile(r"^\[CACHE\]\s+(\S+):\s+(.+)$")
# Matches absolute path ending in __<streamId>.<aif|wav|flac>
_RE_STEM_PATH  = re.compile(r"^\s+.+__(\w+)\.(aif|aiff|wav|flac)\s*$", re.IGNORECASE)


def parse_render_line(line: str, state: dict) -> list:
    """Turn a single stdout line into one or more browser-bound events."""
    events = [{"type": "log", "line": line}]

    # [CACHE] stream1: clean  → cached, emit start+done immediately
    # [CACHE] stream1: DIRTY  → about to render, emit start only
    m = _RE_CACHE_LINE.match(line)
    if m:
        sid   = m.group(1)
        dirty = m.group(2).strip().upper() == "DIRTY"
        total = state.get("total", 0)
        idx   = state.get("index", 0)
        state["index"] = idx + 1
        # Previous DIRTY stream is done now that we're starting the next one
        prev = state.get("streamId")
        if prev:
            events.append({"type": "stream-done", "streamId": prev, "cached": False})
            state["streamId"] = None
        events.append({"type": "stream-start",
                        "streamId": sid, "index": idx, "total": total})
        if not dirty:
            events.append({"type": "stream-done", "streamId": sid, "cached": True})
        else:
            state["streamId"] = sid  # track: this stream is being rendered
        return events

    # Summary path lines: "    /abs/path/output/PGE_test__stream1.aif"
    # Extract stream_id from filename to emit stream-done for the last DIRTY stream.
    m2 = _RE_STEM_PATH.match(line)
    if m2:
        prev = state.get("streamId")
        if prev:
            sid = m2.group(1)
            if sid == prev:
                events.append({"type": "stream-done",
                                "streamId": prev, "cached": False})
                state["streamId"] = None
    return events


def safe_resolve(base: Path, name: str) -> "Path | None":
    """Resolve `base/name` while rejecting traversal and absolute paths."""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if name.startswith("."):
        return None
    return base / name


_AUDIO_EXTS = (".aif", ".aiff", ".wav", ".flac", ".mp3")


def _resolve_audio(base: Path, fname: str) -> "Path | None":
    """Resolve an audio source under `base` by its stem, accepting any of the
    known audio extensions (the browser may request `name.aif` for a `name.wav`
    on disk, or vice versa). Rejects traversal via safe_resolve. Returns the
    first existing match, else None."""
    stem = Path(fname).stem
    for ext in _AUDIO_EXTS:
        cand = safe_resolve(base, stem + ext)
        if cand is not None and cand.exists():
            return cand
    return None


PEAK_BUCKETS = 32768

# Spectrogram grid caps — keep the payload tiny regardless of file length.
SPEC_NFFT = 2048
SPEC_HOP = SPEC_NFFT // 4
SPEC_MAX_COLS = 512
SPEC_FREQ_BINS = 256
SPEC_DB_FLOOR = -90.0


def _compute_peaks(source: Path, buckets: int = PEAK_BUCKETS) -> bytes:
    """Reduce an audio file to `buckets` max-abs amplitude values in 0..1,
    returned as little-endian float32 bytes. Mirrors the browser-side
    `_computePeaks` in audio-engine.js so the visual result is identical.
    Raises ImportError if numpy/soundfile are missing."""
    import numpy as np
    import soundfile as sf

    data, _sr = sf.read(str(source), dtype="float32", always_2d=True)
    mono = np.abs(data).max(axis=1)            # max across channels → (frames,)
    n = int(min(buckets, max(1, mono.shape[0])))
    # Bucket boundaries, then max within each bucket via reduceat.
    edges = (np.arange(n) * (mono.shape[0] / n)).astype(np.int64)
    out = np.maximum.reduceat(mono, edges).astype("<f4")
    return out.tobytes()


def _compute_spectrogram(source: Path) -> bytes:
    """Compute a log-magnitude STFT spectrogram, returned as binary:
    8-byte little-endian header (uint32 width=time cols, uint32 height=freq
    bins) followed by width*height uint8 values (0..255). numpy-only — no
    scipy/matplotlib. Heavy FFT work runs here so the browser only paints.
    Raises ImportError if numpy/soundfile are missing."""
    import numpy as np
    import soundfile as sf

    data, _sr = sf.read(str(source), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)                    # downmix to mono
    n = mono.shape[0]
    if n < SPEC_NFFT:
        mono = np.pad(mono, (0, SPEC_NFFT - n))
        n = mono.shape[0]

    # Frame the signal: one column per hop.
    n_frames = 1 + (n - SPEC_NFFT) // SPEC_HOP
    n_frames = max(1, n_frames)
    window = np.hanning(SPEC_NFFT).astype("float32")
    idx = np.arange(SPEC_NFFT)[None, :] + np.arange(n_frames)[:, None] * SPEC_HOP
    frames = mono[idx] * window                 # (n_frames, nfft)

    spec = np.abs(np.fft.rfft(frames, axis=1))  # (n_frames, nfft/2+1)
    db = 20.0 * np.log10(spec + 1e-9)
    db = np.clip(db, SPEC_DB_FLOOR, 0.0)
    norm = ((db - SPEC_DB_FLOOR) / (-SPEC_DB_FLOOR) * 255.0)  # 0..255

    # Downsample to the capped grid via max-pool (reduceat) on each axis.
    def _pool(arr, target, axis):
        size = arr.shape[axis]
        if size <= target:
            return arr
        edges = (np.arange(target) * (size / target)).astype(np.int64)
        return np.maximum.reduceat(arr, edges, axis=axis)

    norm = _pool(norm, SPEC_MAX_COLS, axis=0)   # time cols
    norm = _pool(norm, SPEC_FREQ_BINS, axis=1)  # freq bins
    grid = norm.astype(np.uint8)                # (cols, bins)

    width, height = grid.shape[0], grid.shape[1]
    header = np.array([width, height], dtype="<u4").tobytes()
    # Row-major by time column: column c, then its freq bins low→high.
    return header + grid.tobytes()


def _ensure_venv_events(root: Path):
    """Generator: yields NDJSON event dicts while creating the engine venv.

    Creates {root}/.venv and runs pip install -r requirements.txt if the venv
    is missing. Safe to call when venv already exists (emits a skip line).
    Last event is always {"type": "venv-done", "ok": bool}."""
    venv_py = root / ".venv" / "bin" / "python"
    if venv_py.exists():
        yield {"type": "log", "line": "[VENV] engine venv already present — skipping"}
        yield {"type": "venv-done", "ok": True}
        return

    venv_dir = root / ".venv"
    req_file = root / "requirements.txt"

    # Find a suitable python to create the venv with.
    py_cmd = None
    for candidate in ["python3.12", "python3.11", "python3.10", "python3"]:
        try:
            subprocess.check_output([candidate, "--version"],
                                    stderr=subprocess.DEVNULL, timeout=2)
            py_cmd = candidate
            break
        except Exception:
            continue

    if not py_cmd:
        yield {"type": "log", "line": "[ERROR] no python3 found — install python3.12"}
        yield {"type": "venv-done", "ok": False}
        return

    yield {"type": "log", "line": f"[VENV] creating .venv with {py_cmd} …"}
    try:
        result = subprocess.run(
            [py_cmd, "-m", "venv", str(venv_dir)],
            capture_output=True, text=True, timeout=120,
        )
        for line in (result.stdout or "").splitlines():
            if line.strip():
                yield {"type": "log", "line": line}
        if result.returncode != 0:
            for line in (result.stderr or "").splitlines():
                yield {"type": "log", "line": line}
            yield {"type": "log",
                   "line": f"[ERROR] venv creation failed (exit {result.returncode})"}
            yield {"type": "venv-done", "ok": False}
            return
    except Exception as e:
        yield {"type": "log", "line": f"[ERROR] venv creation failed: {e}"}
        yield {"type": "venv-done", "ok": False}
        return

    yield {"type": "log", "line": "[VENV] venv created"}

    if not req_file.exists():
        yield {"type": "log",
               "line": f"[ERROR] requirements.txt not found at {req_file}"}
        yield {"type": "venv-done", "ok": False}
        return

    pip = venv_dir / "bin" / "pip"
    yield {"type": "log", "line": f"[VENV] pip install -r requirements.txt …"}
    try:
        proc = subprocess.Popen(
            [str(pip), "install", "-r", str(req_file)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        for raw in iter(proc.stdout.readline, ""):
            line = raw.rstrip()
            if line:
                yield {"type": "log", "line": line}
        proc.wait()
        if proc.returncode != 0:
            yield {"type": "log",
                   "line": f"[ERROR] pip install failed (exit {proc.returncode})"}
            yield {"type": "venv-done", "ok": False}
            return
    except Exception as e:
        yield {"type": "log", "line": f"[ERROR] pip install failed: {e}"}
        yield {"type": "venv-done", "ok": False}
        return

    yield {"type": "log", "line": "[VENV] engine venv ready ✓"}
    yield {"type": "venv-done", "ok": True}


# -------------------------------------------------------------------------
# App factory
# -------------------------------------------------------------------------

def make_app(root: Path) -> Flask:
    refs    = root / "refs"
    configs = root / "configs"
    output  = root / "output"
    cache   = root / "cache"
    for p in (output, cache):
        p.mkdir(parents=True, exist_ok=True)

    app = Flask(__name__)
    # CORS open — the browser is on the same machine, no security risk.
    CORS(app, resources={r"/*": {"origins": "*"}})

    # Mutable state for the running render (only one at a time).
    rs = {"proc": None, "cancelled": False, "lock": threading.Lock()}

    BASES = {"media": refs, "projects": configs, "output": output, "cache": cache}

    # --------- introspection / config ---------

    def _resolved_paths():
        return {
            "root":    str(root),
            "refs":    str(refs),
            "configs": str(configs),
            "output":  str(output),
            "cache":   str(cache),
        }

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "version": "0.1", **_resolved_paths()})

    @app.get("/diagnose")
    def diagnose():
        """System-level checks. The browser surfaces these in the boot log
        and in the Settings → diagnose panel."""
        checks = []

        def add(label, ok, detail):
            checks.append({"label": label, "ok": bool(ok), "detail": detail})

        # main.py
        main_py = root / "src" / "main.py"
        add("main.py", main_py.exists(), str(main_py))

        # folders
        for label, p in (("refs/", refs), ("configs/", configs),
                         ("output/", output), ("cache/", cache)):
            if p.exists():
                try:
                    n = sum(1 for _ in p.iterdir())
                    add(label, True, f"{n} entries · {p}")
                except Exception as e:
                    add(label, False, f"{e}")
            else:
                add(label, False, f"missing: {p}")

        # sox (needed for AIF→WAV transcode for Firefox playback)
        try:
            v = subprocess.check_output(["sox", "--version"],
                                        stderr=subprocess.STDOUT,
                                        timeout=2).decode().splitlines()[0]
            add("sox", True, v)
        except FileNotFoundError:
            add("sox", False, "not installed — install via `brew install sox` "
                              "(needed for Firefox/Safari playback)")
        except Exception as e:
            add("sox", False, str(e))

        # soxi (used to read sample durations)
        try:
            subprocess.check_output(["soxi", "--version"],
                                    stderr=subprocess.STDOUT, timeout=2)
            add("soxi", True, "available — sample durations enabled")
        except Exception:
            add("soxi", False, "not available — sample list will lack durations")

        # numpy + soundfile (server-side waveform peak extraction)
        try:
            import numpy  # noqa: F401
            import soundfile  # noqa: F401
            add("waveform deps", True,
                f"numpy {numpy.__version__} · soundfile {soundfile.__version__}")
        except ImportError as e:
            add("waveform deps", False,
                f"{e} — `pip install -r requirements.txt` for /peaks waveforms")

        # engine venv
        venv_py = root / ".venv" / "bin" / "python"
        if venv_py.exists():
            add("engine venv", True, str(venv_py))
        else:
            add("engine venv", False,
                "not found — click 'Setup engine' in Settings ⚙ or POST /setup")

        # python deps available?
        try:
            __import__("yaml")
            add("python yaml", True, "pyyaml present (engine dep)")
        except ImportError:
            add("python yaml", False, "pyyaml not in venv — main.py may fail")

        # stems present?
        stems = list(output.glob("*__*.aif")) + list(output.glob("*__*.wav"))
        add("rendered stems", True, f"{len(stems)} stem files in {output.name}/")

        return jsonify({"ok": all(c["ok"] for c in checks), "checks": checks})

    @app.get("/config")
    def config():
        return jsonify({"paths": _resolved_paths()})

    # --------- listing ---------

    @app.get("/media")
    def list_media():
        if not refs.exists():
            return jsonify({"path": str(refs), "files": [],
                            "error": "refs/ folder missing"})
        files = []
        for p in sorted(refs.iterdir()):
            if not p.is_file():
                continue
            if p.suffix.lower() not in {".wav", ".aif", ".aiff", ".flac", ".mp3"}:
                continue
            files.append({
                "name": p.name,
                "duration": soxi_duration(p),
                "size": p.stat().st_size,
            })
        return jsonify({"path": str(refs), "files": files})

    @app.get("/projects")
    def list_projects():
        if not configs.exists():
            return jsonify({"path": str(configs), "files": [],
                            "error": "configs/ folder missing"})
        files = []
        for p in sorted(configs.iterdir()):
            if p.is_file() and p.suffix == ".yml":
                files.append({"name": p.name, "mtime": p.stat().st_mtime})
        return jsonify({"path": str(configs), "files": files})

    # --------- file read / write ---------

    @app.get("/file")
    def get_file():
        kind = request.args.get("kind")
        name = request.args.get("name", "")
        base = BASES.get(kind)
        if not base: abort(400, "bad kind")
        path = safe_resolve(base, name)
        if not path or not path.exists():
            abort(404)
        return path.read_text(encoding="utf-8")

    @app.put("/file")
    def put_file():
        kind = request.args.get("kind")
        name = request.args.get("name", "")
        base = BASES.get(kind)
        if not base: abort(400, "bad kind")
        path = safe_resolve(base, name)
        if not path: abort(400, "bad name")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(request.get_data(as_text=True), encoding="utf-8")
        return jsonify({"ok": True, "path": str(path), "bytes": path.stat().st_size})

    # --------- rendered audio playback ---------

    @app.get("/output/<path:fname>")
    def serve_output(fname):
        path = safe_resolve(output, fname)
        if not path or not path.exists():
            abort(404)
        mt = "audio/aiff" if path.suffix.lower() in {".aif", ".aiff"} else None
        return send_file(str(path), mimetype=mt, conditional=True)

    @app.get("/audio/<path:fname>")
    def serve_audio_as_wav(fname):
        """Serve a rendered stem as WAV, transcoding from .aif via sox if
        needed. The transcoded WAV is cached next to the .aif so subsequent
        requests are instant.

        Firefox can't decode AIFF via Web Audio's decodeAudioData; this
        endpoint exists so the editor can play stems in any browser. The
        editor calls /audio/<basename>__<sid>.aif and gets back a WAV body
        without renaming on disk."""
        # Find the source file regardless of requested extension.
        stem = Path(fname).stem
        # Look for any of .aif/.aiff/.wav/.flac/.mp3 under output/
        source = None
        for ext in (".aif", ".aiff", ".wav", ".flac", ".mp3"):
            cand = output / (stem + ext)
            if cand.exists():
                source = cand
                break
        if source is None:
            abort(404)

        if source.suffix.lower() == ".wav":
            return send_file(str(source), mimetype="audio/wav", conditional=True)

        wav_cache = output / (stem + ".transcoded.wav")
        needs_transcode = (
            not wav_cache.exists()
            or wav_cache.stat().st_mtime < source.stat().st_mtime
        )
        if needs_transcode:
            try:
                subprocess.check_call(
                    ["sox", str(source), str(wav_cache)],
                    stderr=subprocess.DEVNULL,
                    timeout=30,
                )
            except FileNotFoundError:
                abort(500, "sox not found — needed to transcode AIFF→WAV "
                           "for browser playback")
            except subprocess.CalledProcessError as e:
                abort(500, f"sox failed: {e}")
        return send_file(str(wav_cache), mimetype="audio/wav", conditional=True)

    @app.get("/peaks/<path:fname>")
    def serve_peaks(fname):
        """Return a waveform peak array for a rendered stem as raw binary:
        `PEAK_BUCKETS` little-endian float32 values in 0..1 (max abs amplitude
        per bucket across channels). ~128 KB regardless of stem length.

        Computed server-side so the browser never decodes the full PCM just to
        draw a waveform (a 8-min stereo stem is ~160 MB decoded; this is 16 KB).
        Cached on disk under cache/peaks/, regenerated only when the source is
        newer than the cache (same staleness rule as the WAV transcode above)."""
        stem = Path(fname).stem
        source = None
        for ext in (".aif", ".aiff", ".wav", ".flac", ".mp3"):
            cand = safe_resolve(output, stem + ext)
            if cand is not None and cand.exists():
                source = cand
                break
        if source is None:
            abort(404)

        peaks_dir = cache / "peaks"
        peaks_dir.mkdir(parents=True, exist_ok=True)
        # Bucket count in the name so bumping PEAK_BUCKETS invalidates old
        # caches automatically (stale .f32 files just become orphaned).
        cache_file = peaks_dir / (stem + f".{PEAK_BUCKETS}.f32")
        fresh = cache_file.exists() and cache_file.stat().st_mtime >= source.stat().st_mtime
        if not fresh:
            try:
                data = _compute_peaks(source)
            except ImportError:
                abort(500, "numpy/soundfile not installed — `pip install -r "
                           "requirements.txt` for server-side waveforms")
            except Exception as e:
                abort(500, f"peak extraction failed: {e}")
            cache_file.write_bytes(data)
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    @app.get("/spectrogram/<path:fname>")
    def serve_spectrogram(fname):
        """Log-magnitude STFT spectrogram for a rendered stem. Binary: uint32
        width + uint32 height header, then width*height uint8 values. Mirrors
        /peaks (same stem resolution + staleness rule) but spectrogram instead
        of waveform peaks. Cached under cache/spec/."""
        stem = Path(fname).stem
        source = None
        for ext in (".aif", ".aiff", ".wav", ".flac", ".mp3"):
            cand = safe_resolve(output, stem + ext)
            if cand is not None and cand.exists():
                source = cand
                break
        if source is None:
            abort(404)

        spec_dir = cache / "spec"
        spec_dir.mkdir(parents=True, exist_ok=True)
        cache_file = spec_dir / (stem + ".spec")
        fresh = cache_file.exists() and cache_file.stat().st_mtime >= source.stat().st_mtime
        if not fresh:
            try:
                data = _compute_spectrogram(source)
            except ImportError:
                abort(500, "numpy/soundfile not installed — `pip install -r "
                           "requirements.txt` for server-side spectrograms")
            except Exception as e:
                abort(500, f"spectrogram failed: {e}")
            cache_file.write_bytes(data)
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    # --------- media (refs/) preview: playback, waveform, spectrogram ---------
    # Same patterns as the output/ endpoints above but rooted at refs/, with
    # all derived artifacts cached under cache/ (never written into refs/).

    @app.get("/media_audio/<path:fname>")
    def media_audio(fname):
        """Serve a refs/ media file as WAV for browser playback (transcoding
        via sox if it isn't already WAV). Mirrors /audio but for refs/."""
        source = _resolve_audio(refs, fname)
        if source is None:
            abort(404)
        if source.suffix.lower() == ".wav":
            return send_file(str(source), mimetype="audio/wav", conditional=True)

        wav_dir = cache / "media_wav"
        wav_dir.mkdir(parents=True, exist_ok=True)
        wav_cache = wav_dir / (source.stem + ".wav")
        fresh = wav_cache.exists() and wav_cache.stat().st_mtime >= source.stat().st_mtime
        if not fresh:
            try:
                subprocess.check_call(["sox", str(source), str(wav_cache)],
                                      stderr=subprocess.DEVNULL, timeout=60)
            except FileNotFoundError:
                abort(500, "sox not found — needed to transcode media for "
                           "browser playback")
            except subprocess.CalledProcessError as e:
                abort(500, f"sox failed: {e}")
        return send_file(str(wav_cache), mimetype="audio/wav", conditional=True)

    @app.get("/media_peaks/<path:fname>")
    def media_peaks(fname):
        """Waveform peak array for a refs/ media file. Mirrors /peaks but for
        refs/, cached under cache/peaks_media/."""
        source = _resolve_audio(refs, fname)
        if source is None:
            abort(404)
        peaks_dir = cache / "peaks_media"
        peaks_dir.mkdir(parents=True, exist_ok=True)
        cache_file = peaks_dir / (source.stem + f".{PEAK_BUCKETS}.f32")
        fresh = cache_file.exists() and cache_file.stat().st_mtime >= source.stat().st_mtime
        if not fresh:
            try:
                data = _compute_peaks(source)
            except ImportError:
                abort(500, "numpy/soundfile not installed — `pip install -r "
                           "requirements.txt` for server-side waveforms")
            except Exception as e:
                abort(500, f"peak extraction failed: {e}")
            cache_file.write_bytes(data)
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    @app.get("/media_spectrogram/<path:fname>")
    def media_spectrogram(fname):
        """Log-magnitude STFT spectrogram for a refs/ media file (numpy-only,
        computed server-side). Binary: uint32 width + uint32 height header,
        then width*height uint8 values. Cached under cache/spec_media/."""
        source = _resolve_audio(refs, fname)
        if source is None:
            abort(404)
        spec_dir = cache / "spec_media"
        spec_dir.mkdir(parents=True, exist_ok=True)
        cache_file = spec_dir / (source.stem + ".spec")
        fresh = cache_file.exists() and cache_file.stat().st_mtime >= source.stat().st_mtime
        if not fresh:
            try:
                data = _compute_spectrogram(source)
            except ImportError:
                abort(500, "numpy/soundfile not installed — `pip install -r "
                           "requirements.txt` for server-side spectrograms")
            except Exception as e:
                abort(500, f"spectrogram failed: {e}")
            cache_file.write_bytes(data)
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    @app.get("/cache_manifest/<basename>")
    def cache_manifest(basename):
        if "/" in basename or ".." in basename: abort(400)
        path = cache / f"{basename}.json"
        if not path.exists():
            return jsonify({})
        try:
            return jsonify(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return jsonify({})

    @app.get("/stems/<basename>")
    def list_stems(basename):
        """Return stream IDs that have a rendered stem file on disk.
        The browser uses this to populate its stem index on page load
        so hasStem() works without requiring a render in the current session."""
        if "/" in basename or ".." in basename: abort(400)
        stream_ids = []
        prefix = basename + "__"
        seen = set()
        for p in sorted(output.glob(f"{basename}__*.*")):
            if p.suffix.lower() not in {".aif", ".aiff", ".wav", ".flac"}:
                continue
            sid = p.stem[len(prefix):]
            if sid and sid not in seen:
                seen.add(sid)
                stream_ids.append({"streamId": sid, "mtime": p.stat().st_mtime})
        return jsonify({"basename": basename, "stems": stream_ids})

    # --------- engine setup ---------

    @app.post("/setup")
    def setup_engine():
        """Create the engine venv and install requirements.txt if not present.
        Streams the same NDJSON format as /render so the UI can show it in the
        terminal. Safe to call repeatedly — skips if venv already exists."""
        def event_stream():
            overall_ok = True
            for ev in _ensure_venv_events(root):
                yield json.dumps(ev) + "\n"
                if ev.get("type") == "venv-done":
                    overall_ok = ev.get("ok", False)
            yield json.dumps({"type": "done", "ok": overall_ok}) + "\n"
        return Response(event_stream(), mimetype="application/x-ndjson")

    # --------- render ---------

    @app.post("/render/cancel")
    def cancel_render():
        with rs["lock"]:
            rs["cancelled"] = True
            proc = rs["proc"]
            if proc and proc.poll() is None:
                proc.terminate()
        return jsonify({"ok": True})

    @app.post("/render")
    def render():
        opts = request.get_json(force=True) or {}
        basename = opts.get("yamlBasename") or opts.get("projectBasename")
        if not basename:
            abort(400, "yamlBasename required")
        if "/" in basename or ".." in basename:
            abort(400, "bad basename")

        renderer = opts.get("renderer", "numpy")
        use_cache = bool(opts.get("useCache", True))
        visualize = bool(opts.get("visualize", False))
        reaper    = bool(opts.get("reaper", False))
        preclean  = bool(opts.get("preclean", False))
        fmt       = opts.get("outputFormat", "aiff")
        if fmt not in {"aiff", "wav", "flac"}:
            abort(400, f"invalid format: {fmt!r}")
        _EXT = {"aiff": ".aif", "wav": ".wav", "flac": ".flac"}
        out_ext = _EXT[fmt]

        yaml_content = opts.get("yamlContent")
        tmp_yml: Path | None = None
        if yaml_content:
            tf = tempfile.NamedTemporaryFile(
                mode="w", suffix=".yml", dir=configs, delete=False, encoding="utf-8"
            )
            tf.write(yaml_content)
            tf.close()
            yml = Path(tf.name)
            tmp_yml = yml
        else:
            yml = configs / f"{basename}.yml"
            if not yml.exists():
                return jsonify({"ok": False,
                                "error": f"configs/{basename}.yml not found"}), 404

        output_stem = output / f"{basename}{out_ext}"

        # Optional: wipe previous stems (current format only) if requested.
        if preclean:
            for p in output.glob(f"{basename}__*{out_ext}"):
                try: p.unlink()
                except Exception: pass

        def event_stream():
            """Generator: yields one NDJSON line per UI event."""
            # Ensure engine venv exists before running main.py.
            venv_py = root / ".venv" / "bin" / "python"
            if not venv_py.exists():
                yield json.dumps({"type": "log",
                                  "line": "[VENV] engine venv missing — setting up…"}) + "\n"
                setup_ok = True
                for ev in _ensure_venv_events(root):
                    yield json.dumps(ev) + "\n"
                    if ev.get("type") == "venv-done":
                        setup_ok = ev.get("ok", False)
                if not setup_ok or not venv_py.exists():
                    yield json.dumps({"type": "log",
                                      "line": "[ERROR] venv setup failed — render aborted"}) + "\n"
                    yield json.dumps({"type": "done", "ok": False,
                                      "error": "venv setup failed"}) + "\n"
                    return

            # Build the command using the engine venv python.
            cmd = [
                str(venv_py), str(root / "src" / "main.py"),
                str(yml), str(output_stem),
                "--renderer", renderer,
                "--per-stream",
                "--show-static",
                "--format", fmt,
            ]
            if use_cache:  cmd += ["--cache", "--cache-dir", str(cache)]
            if visualize:  cmd += ["--visualize"]
            if reaper:     cmd += ["--reaper",
                                    "--reaper-path", str(output / f"{basename}.rpp")]
            if renderer == "csound":
                cmd += [
                    "--orc-path", str(root / "csound" / "main.orc"),
                    "--incdir",   str(root / "src"),
                    "--ssdir",    str(refs),
                    "--sfdir",    str(output),
                    "--log-dir",  str(root / "logs"),
                ]

            yield json.dumps({"type": "log",
                              "line": "$ " + " ".join(cmd)}) + "\n"
            try:
                with rs["lock"]:
                    rs["cancelled"] = False
                    rs["proc"] = subprocess.Popen(
                        cmd, cwd=str(root),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True, bufsize=1,
                    )
                n_streams = len(opts.get("streams") or [])
                state = {"streamId": None, "total": n_streams, "index": 0}
                proc = rs["proc"]
                # Read line-by-line and stream to client.
                for raw in iter(proc.stdout.readline, ""):
                    line = raw.rstrip("\n")
                    if rs["cancelled"]:
                        proc.terminate()
                        yield json.dumps({"type": "log",
                                          "line": "[ABORT] cancelled"}) + "\n"
                        yield json.dumps({"type": "done", "ok": False}) + "\n"
                        return
                    for ev in parse_render_line(line, state):
                        yield json.dumps(ev) + "\n"
                proc.wait()
                ok = (proc.returncode == 0)
                generated = [
                    str(p.relative_to(root))
                    for p in sorted(output.glob(f"{basename}__*{out_ext}"))
                ]
                yield json.dumps({
                    "type": "done", "ok": ok,
                    "generated": generated,
                    "returncode": proc.returncode,
                }) + "\n"
            except FileNotFoundError as e:
                yield json.dumps({"type": "log",
                                  "line": f"[ERROR] {e}"}) + "\n"
                yield json.dumps({"type": "done", "ok": False,
                                  "error": str(e)}) + "\n"
            except Exception as e:
                yield json.dumps({"type": "log",
                                  "line": f"[ERROR] {type(e).__name__}: {e}"}) + "\n"
                yield json.dumps({"type": "done", "ok": False,
                                  "error": str(e)}) + "\n"
            finally:
                with rs["lock"]:
                    rs["proc"] = None
                if tmp_yml is not None:
                    try: tmp_yml.unlink(missing_ok=True)
                    except Exception: pass

        # mimetype "application/x-ndjson" is what the browser LocalBackend reads.
        return Response(event_stream(), mimetype="application/x-ndjson")

    # --------- static UI file serving ---------
    # Serves the PGE-ui directory so no separate http.server is needed.
    # API routes above take priority over this catch-all.
    ui_dir = str(Path(__file__).parent)

    @app.get("/")
    def ui_index():
        return send_from_directory(ui_dir, "PGE Editor.html")

    @app.get("/<path:filename>")
    def ui_static(filename):
        return send_from_directory(ui_dir, filename)

    return app


# -------------------------------------------------------------------------
# CLI entry point
# -------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Local HTTP bridge for the PGE browser editor.",
    )
    ap.add_argument("--port", type=int, default=7878,
                    help="port to listen on (default: 7878)")
    ap.add_argument("--root", default="../PythonGranularEngine",
                    help="path to the PythonGranularEngine repo root "
                         "(default: ../PythonGranularEngine, "
                         "i.e. cloned side-by-side with PGE-ui)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default: 127.0.0.1, localhost only)")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    main_py = root / "src" / "main.py"
    if not main_py.exists():
        sys.exit(
            f"Can't find src/main.py under {root}.\n"
            f"\n"
            f"Pass --root to point at your PythonGranularEngine clone:\n"
            f"    python server.py --root /path/to/PythonGranularEngine\n"
            f"\n"
            f"Or clone the engine side-by-side with PGE-ui:\n"
            f"    cd ..\n"
            f"    git clone https://github.com/DMGiulioRomano/PythonGranularEngine\n"
            f"    cd PGE-ui && python server.py\n"
        )

    app = make_app(root)

    def _check_cmd(cmd):
        try:
            subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=2)
            return True
        except Exception:
            return False
    sox_ok  = _check_cmd(["sox", "--version"])
    soxi_ok = _check_cmd(["soxi", "--version"])

    print(f"PGE bridge")
    print(f"  root:    {root}")
    print(f"  refs/:   {root / 'refs'}")
    print(f"  configs/:{root / 'configs'}")
    print(f"  output/: {root / 'output'}")
    print(f"  cache/:  {root / 'cache'}")
    print(f"  sox:     {'ok' if sox_ok else 'MISSING (brew install sox — needed for browser playback)'}")
    print(f"  soxi:    {'ok' if soxi_ok else 'MISSING (sample durations will be blank)'}")
    print(f"  listen:  http://{args.host}:{args.port}")
    print(f"")
    print(f"Open in browser:  http://{args.host}:{args.port}/")
    print(f"  (gear → Backend → local → server URL http://{args.host}:{args.port})")
    print(f"")
    from gunicorn.app.base import BaseApplication

    class _StandaloneApp(BaseApplication):
        def __init__(self, wsgi_app, options=None):
            self.options = options or {}
            self.application = wsgi_app
            super().__init__()

        def load_config(self):
            for key, value in self.options.items():
                self.cfg.set(key, value)

        def load(self):
            return self.application

    _StandaloneApp(app, {
        "bind": f"{args.host}:{args.port}",
        "workers": 1,
        "worker_class": "gthread",
        "threads": 4,
        "accesslog": "-",
        "loglevel": "warning",
    }).run()


if __name__ == "__main__":
    main()
