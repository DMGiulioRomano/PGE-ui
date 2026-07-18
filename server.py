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
    GET  /envelope-keys         — valid --plot-envelopes names (from engine src)
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
    GET  /grains/<basename>/<streamId> — per-stream grain JSON sidecar
    GET  /media_audio/<fname>   — serve a refs/ media file as WAV for playback
    GET  /media_peaks/<fname>   — waveform peaks for a refs/ media file
    GET  /media_spectrogram/<fname> — STFT spectrogram for a refs/ media file
"""

import argparse
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from flask import Flask, jsonify, request, send_file, send_from_directory, Response, abort
    from flask_cors import CORS
except ImportError:
    sys.exit("Missing deps. Run:\n    pip install flask flask-cors")

# Audio + render machinery extracted from this module (#43).
from audio_pipeline import (
    safe_resolve, audio_duration, _resolve_audio, PEAK_BUCKETS,
    transcode_wav, peaks_file, spectrogram_file, SoxNotFound, SoxFailed,
)
from render_pipeline import (
    RenderState, parse_render_line, build_render_command, start_watchdog,
)


# -------------------------------------------------------------------------
# Helpers
#
# Audio (sox transcode / peaks / spectrogram, path resolution) lives in
# audio_pipeline.py and render orchestration (parse_render_line, RenderState,
# command build, watchdog) in render_pipeline.py. Only the engine-venv
# bootstrap stays here — it's used by /setup and the render route and is a
# distinct concern. #43
# -------------------------------------------------------------------------


_ENVELOPE_KEYS_CACHE: dict = {}


def engine_envelope_keys(root: Path) -> list:
    """Valid `--plot-envelopes` names = keys of the engine's `ENVELOPE_COLORS`
    dict in src/rendering/score_visualizer.py (issue #31).

    We AST-parse the source rather than importing the module: it pulls in
    matplotlib/numpy/soundfile and may live in the engine's own venv, neither
    of which this bridge process has. Parsing the literal needs only stdlib and
    works even when the engine venv isn't set up yet. The UI fetches these to
    populate the score-envelope filter so the list is never hardcoded.

    Returns the keys in source order, or [] if the file/constant is missing (an
    older engine without the feature) — in which case the filter stays hidden
    and the flag is never sent. Result is cached per resolved root."""
    key = str(root)
    if key in _ENVELOPE_KEYS_CACHE:
        return _ENVELOPE_KEYS_CACHE[key]
    keys: list = []
    src = root / "src" / "rendering" / "score_visualizer.py"
    try:
        tree = ast.parse(src.read_text(encoding="utf-8"))
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if "ENVELOPE_COLORS" not in names or not isinstance(node.value, ast.Dict):
                continue
            for k in node.value.keys:
                if isinstance(k, ast.Constant) and isinstance(k.value, str):
                    keys.append(k.value)
            break
    except Exception:
        keys = []
    _ENVELOPE_KEYS_CACHE[key] = keys
    return keys


_PARAMETER_BOUNDS_CACHE: dict = {}

# Fields of the engine's ParameterBounds dataclass, in positional order, with
# the dataclass defaults for the ones that have them (min_val/max_val are
# required, so they have no default here).
_PB_FIELDS = ("min_val", "max_val", "min_range", "max_range",
              "default_jitter", "variation_mode")
_PB_DEFAULTS = {"min_range": 0.0, "max_range": 0.0,
                "default_jitter": 0.0, "variation_mode": "additive"}
# Used only if pitch_unit.py can't be parsed (older/odd engine): the nominal
# EDO presets and the ±3-octave factor, matching pitch_unit.py.
_PITCH_PRESET_DIVISIONS = {"semitones": 12, "cents": 1200,
                           "quarter_tone": 24, "eighth_tone": 48}


def _ast_literal(node):
    """ast.literal_eval a node, tolerating unary minus (e.g. -100.0) and None.
    Returns None on anything non-literal (an expression we can't resolve)."""
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def _ast_call_name(call):
    """Callee name of an ast.Call: `Foo(...)` → 'Foo', `mod.Foo(...)` → 'Foo'."""
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _parse_bounds_call(call):
    """Turn a `ParameterBounds(...)` AST call into a plain dict, applying the
    dataclass defaults for omitted fields. Positional args map onto _PB_FIELDS
    in order; keywords override. Returns None unless both min_val and max_val
    are present (max_val may legitimately be None — a sample-driven loop bound).
    """
    rec = dict(_PB_DEFAULTS)
    for field, arg in zip(_PB_FIELDS, call.args):
        rec[field] = _ast_literal(arg)
    for kw in call.keywords:
        if kw.arg in _PB_FIELDS:
            rec[kw.arg] = _ast_literal(kw.value)
    if "min_val" not in rec or "max_val" not in rec:
        return None
    return rec


def _assigned_dict(node, name):
    """Return the ast.Dict assigned to `name` by this node, handling both a
    plain `name = {…}` (Assign) and an annotated `name: T = {…}` (AnnAssign —
    the engine annotates GRANULAR_PARAMETERS / PITCH_UNIT_PRESETS). None if the
    node isn't that assignment or the value isn't a dict literal."""
    if isinstance(node, ast.Assign):
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        value = node.value
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        targets = [node.target.id]
        value = node.value
    else:
        return None
    if name in targets and isinstance(value, ast.Dict):
        return value
    return None


def _parse_granular_parameters(src_text):
    """Extract GRANULAR_PARAMETERS from parameter_definitions.py source as
    {name: {min_val, max_val, …}}."""
    out = {}
    tree = ast.parse(src_text)
    for node in ast.walk(tree):
        d = _assigned_dict(node, "GRANULAR_PARAMETERS")
        if d is None:
            continue
        for k, v in zip(d.keys, d.values):
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                continue
            if isinstance(v, ast.Call) and _ast_call_name(v) == "ParameterBounds":
                rec = _parse_bounds_call(v)
                if rec is not None:
                    out[k.value] = rec
        break
    return out


def _find_value_bounds_method(classdef):
    for fn in classdef.body:
        if isinstance(fn, ast.FunctionDef) and fn.name == "value_bounds":
            return fn
    return None


def _parse_edo_factor(tree):
    """The ±N·divisions octave factor from EdoUnit.value_bounds
    (`bound = 3.0 * self.divisions`). Defaults to 3.0 if not found."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.ClassDef) and node.name == "EdoUnit"):
            continue
        fn = _find_value_bounds_method(node)
        if fn is None:
            continue
        for sub in ast.walk(fn):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.Mult):
                for a, b in ((sub.left, sub.right), (sub.right, sub.left)):
                    if (isinstance(a, ast.Constant)
                            and isinstance(a.value, (int, float))
                            and not isinstance(a.value, bool)
                            and isinstance(b, ast.Attribute)
                            and b.attr == "divisions"):
                        return float(a.value)
    return 3.0


def _parse_ratio_bounds(tree):
    """{min, max, rangeMax} from RatioUnit.value_bounds. Defaults to the known
    [0.001, 8] / rangeMax 2 if not found."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.ClassDef) and node.name == "RatioUnit"):
            continue
        fn = _find_value_bounds_method(node)
        if fn is None:
            continue
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Call) and _ast_call_name(sub) == "ParameterBounds":
                rec = _parse_bounds_call(sub)
                if rec is not None and isinstance(rec.get("min_val"), (int, float)):
                    return {"min": rec["min_val"], "max": rec["max_val"],
                            "rangeMax": rec["max_range"]}
    return {"min": 0.001, "max": 8.0, "rangeMax": 2.0}


def _parse_pitch_presets(tree):
    """EDO divisions per nominal preset from PITCH_UNIT_PRESETS
    (`'semitones': lambda: EdoUnit(12, …)` → {'semitones': 12, …})."""
    out = {}
    for node in ast.walk(tree):
        d = _assigned_dict(node, "PITCH_UNIT_PRESETS")
        if d is None:
            continue
        for k, v in zip(d.keys, d.values):
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                continue
            body = v.body if isinstance(v, ast.Lambda) else v
            if (isinstance(body, ast.Call) and _ast_call_name(body) == "EdoUnit"
                    and body.args):
                div = _ast_literal(body.args[0])
                if isinstance(div, int) and not isinstance(div, bool):
                    out[k.value] = div
        break
    return out


def _parse_pitch_bounds(src_text):
    """Pitch bounds per unit, derived from pitch_unit.py: each EDO preset gets
    ±(edoFactor·divisions); ratio is read from RatioUnit. Shape mirrors the
    UI's window.PGE_BOUNDS.pitch."""
    tree = ast.parse(src_text)
    edo_factor = _parse_edo_factor(tree)
    presets = _parse_pitch_presets(tree) or dict(_PITCH_PRESET_DIVISIONS)
    out = {"edoFactor": edo_factor, "ratio": _parse_ratio_bounds(tree)}
    for name, div in presets.items():
        bound = edo_factor * div
        out[name] = {"min": -bound, "max": bound, "rangeMax": bound}
    return out


def engine_parameter_bounds(root: Path) -> dict:
    """Engine parameter clamps, AST-parsed from the engine source so the UI's
    bounds aren't hardcoded.

    Like engine_envelope_keys, we parse the literals rather than importing the
    modules: parameter_definitions.py / pitch_unit.py would drag in the engine
    package (and its venv), and parsing needs only stdlib — so this works even
    when the engine venv isn't set up. Shape:

        {"params": {name: {min_val, max_val, min_range, max_range,
                           default_jitter, variation_mode}},
         "pitch":  {semitones|cents|…: {min, max, rangeMax},
                    ratio: {…}, edoFactor: float}}

    Returns {} when neither source is present (an older engine) — the UI then
    keeps its static fallback bounds. Cached per resolved root."""
    key = str(root)
    if key in _PARAMETER_BOUNDS_CACHE:
        return _PARAMETER_BOUNDS_CACHE[key]
    pdir = root / "src" / "parameters"
    params, pitch = {}, {}
    pd = pdir / "parameter_definitions.py"
    if pd.exists():
        try:
            params = _parse_granular_parameters(pd.read_text(encoding="utf-8"))
        except Exception:
            params = {}
    pu = pdir / "pitch_unit.py"
    if pu.exists():
        try:
            pitch = _parse_pitch_bounds(pu.read_text(encoding="utf-8"))
        except Exception:
            pitch = {}
    out = {"params": params, "pitch": pitch} if (params or pitch) else {}
    _PARAMETER_BOUNDS_CACHE[key] = out
    return out


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

def make_app(root: Path, render_timeout: float = 600.0) -> Flask:
    refs    = root / "refs"
    configs = root / "configs"
    output  = root / "output"
    cache   = root / "cache"
    for p in (output, cache):
        p.mkdir(parents=True, exist_ok=True)

    app = Flask(__name__)
    # CORS open — the browser is on the same machine, no security risk.
    CORS(app, resources={r"/*": {"origins": "*"}})

    # State for the running render (only one at a time); the shared lock
    # serializes /render and /render/cancel. render_timeout is the hard cap
    # (seconds) after which a stuck subprocess is killed (0 disables). #43
    rs = RenderState()

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

        # soxi: now only a *fallback* for sample durations (soundfile is the
        # primary source) and still the binary behind the AIFF→WAV transcode.
        # soxi has no --version flag of its own (it exits non-zero), so probe by
        # running it bare: a missing binary raises FileNotFoundError.
        try:
            subprocess.run(["soxi"], capture_output=True, timeout=2)
            add("soxi", True, "available — duration fallback + AIFF→WAV transcode")
        except FileNotFoundError:
            add("soxi", False, "not installed — optional (durations come from "
                               "soundfile; sox/soxi only for AIFF→WAV playback)")
        except Exception as e:
            add("soxi", False, f"not available ({e}) — optional, durations use soundfile")

        # numpy + soundfile: server-side waveform peaks/spectrogram AND the
        # primary source of sample durations (sf.info, header-only).
        try:
            import numpy  # noqa: F401
            import soundfile  # noqa: F401
            add("waveform deps", True,
                f"numpy {numpy.__version__} · soundfile {soundfile.__version__} "
                f"— peaks, spectrogram & sample durations")
        except ImportError as e:
            add("waveform deps", False,
                f"{e} — `pip install -r requirements.txt` for /peaks waveforms "
                f"and sample durations (durations then fall back to soxi)")

        # engine venv
        venv_py = root / ".venv" / "bin" / "python"
        if venv_py.exists():
            add("engine venv", True, str(venv_py))
        else:
            add("engine venv", False,
                "not found — click 'Setup engine' in Settings ⚙ or POST /setup")

        # pyyaml available to the ENGINE venv that actually runs main.py
        # (not this server process — they can be different interpreters).
        if venv_py.exists():
            try:
                subprocess.check_output([str(venv_py), "-c", "import yaml"],
                                        stderr=subprocess.STDOUT, timeout=5)
                add("python yaml", True, "pyyaml present in engine venv")
            except subprocess.CalledProcessError:
                add("python yaml", False,
                    "pyyaml not in engine venv — main.py may fail; click "
                    "'Setup engine' in Settings ⚙ or pip install in .venv")
            except Exception as e:
                add("python yaml", False, f"could not check engine venv: {e}")
        else:
            add("python yaml", False,
                "engine venv missing — click 'Setup engine' in Settings ⚙")

        # stems present?
        stems = list(output.glob("*__*.aif")) + list(output.glob("*__*.wav"))
        add("rendered stems", True, f"{len(stems)} stem files in {output.name}/")

        return jsonify({"ok": all(c["ok"] for c in checks), "checks": checks})

    @app.get("/config")
    def config():
        return jsonify({"paths": _resolved_paths()})

    @app.get("/envelope-keys")
    def envelope_keys():
        """Valid `--plot-envelopes` names, read from the engine source so the
        UI score-envelope filter isn't hardcoded (issue #31). Empty list = the
        engine predates the feature; the UI then hides the filter."""
        return jsonify({"ok": True, "keys": engine_envelope_keys(root)})

    @app.get("/bounds")
    def bounds():
        """Engine parameter clamps (min/max/range + pitch), parsed from the
        engine source so the UI's bounds aren't hardcoded. Empty dict = an
        engine without these files; the UI then keeps its static fallback."""
        return jsonify({"ok": True, "bounds": engine_parameter_bounds(root)})

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
                "duration": audio_duration(p),
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
        try:
            transcode_wav(source, wav_cache, timeout=30)
        except SoxNotFound:
            abort(500, "sox not found — needed to transcode AIFF→WAV "
                       "for browser playback")
        except SoxFailed as e:
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
        # Bucket count in the name so bumping PEAK_BUCKETS invalidates old
        # caches automatically (stale .f32 files just become orphaned).
        cache_file = peaks_dir / (stem + f".{PEAK_BUCKETS}.f32")
        try:
            peaks_file(source, cache_file)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side waveforms")
        except Exception as e:
            abort(500, f"peak extraction failed: {e}")
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

        scale = request.args.get("scale", "linear")
        if scale not in ("linear", "log"):
            scale = "linear"

        spec_dir = cache / "spec"
        # scale in the filename so linear/log cache side-by-side.
        cache_file = spec_dir / (stem + f".{scale}.spec")
        try:
            spectrogram_file(source, cache_file, scale)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side spectrograms")
        except Exception as e:
            abort(500, f"spectrogram failed: {e}")
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
        wav_cache = wav_dir / (source.stem + ".wav")
        try:
            transcode_wav(source, wav_cache, timeout=60)
        except SoxNotFound:
            abort(500, "sox not found — needed to transcode media for "
                       "browser playback")
        except SoxFailed as e:
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
        cache_file = peaks_dir / (source.stem + f".{PEAK_BUCKETS}.f32")
        try:
            peaks_file(source, cache_file)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side waveforms")
        except Exception as e:
            abort(500, f"peak extraction failed: {e}")
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
        cache_file = spec_dir / (source.stem + ".spec")
        try:
            spectrogram_file(source, cache_file)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side spectrograms")
        except Exception as e:
            abort(500, f"spectrogram failed: {e}")
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

    @app.get("/grains/<basename>/<streamId>")
    def serve_grains(basename, streamId):
        """Serve the per-stream grain JSON sidecar produced by the engine's
        --grain-json flag: output/<basename>__<streamId>__grains.json.
        The editor draws these grains inside clips and in the score panel."""
        if "/" in basename or ".." in basename: abort(400)
        if "/" in streamId or ".." in streamId: abort(400)
        path = safe_resolve(output, f"{basename}__{streamId}__grains.json")
        if not path or not path.exists():
            abort(404)
        return send_file(str(path), mimetype="application/json", conditional=True)

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
        rs.cancel()
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
        # Per-voice offset curves in the PDF score (PGE #90 / issue #55).
        # Off by default; engines that predate the flag parse argv manually
        # and ignore unknown flags, so forwarding it is always safe.
        show_voice_offsets = bool(opts.get("showVoiceOffsets", False))
        page_duration = opts.get("pageDuration")
        # Selective score-envelope filter (issue #31). Keep only names the engine
        # actually knows: an unknown name makes main.py exit 1 and aborts the
        # render. If the engine predates the feature (no valid keys) we drop the
        # list entirely so the legacy engine never sees the unsupported flag.
        plot_envelopes = opts.get("plotEnvelopes")
        if plot_envelopes:
            valid = set(engine_envelope_keys(root))
            plot_envelopes = [n for n in plot_envelopes if n in valid] or None
        else:
            plot_envelopes = None
        reaper    = bool(opts.get("reaper", False))
        preclean  = bool(opts.get("preclean", False))
        # Per-stream grain sidecar (issue #68). Default True = historical
        # always-on behavior (#13); the UI can disable it to skip the heavy JSON.
        grain_json = bool(opts.get("grainJson", True))
        fmt       = opts.get("outputFormat", "aiff")
        if fmt not in {"aiff", "wav", "flac"}:
            abort(400, f"invalid format: {fmt!r}")
        _EXT = {"aiff": ".aif", "wav": ".wav", "flac": ".flac"}
        out_ext = _EXT[fmt]

        yaml_content = opts.get("yamlContent")
        # Write the editor state to the canonical config (never a temp file): the
        # engine's per-stream cache manifest is keyed by the YAML basename
        # (cache/<basename>.json), so a random temp name would orphan the manifest
        # every render and mark all streams DIRTY. Git is the versioning/rollback
        # mechanism for configs/ — see CLAUDE.md "NDJSON render protocol".
        yml = configs / f"{basename}.yml"
        if yaml_content:
            yml.write_text(yaml_content, encoding="utf-8")
        elif not yml.exists():
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
            cmd = build_render_command(
                venv_py, root, yml, output_stem,
                renderer=renderer, use_cache=use_cache, cache=cache,
                visualize=visualize, page_duration=page_duration, reaper=reaper,
                basename=basename, refs=refs, output=output, fmt=fmt,
                plot_envelopes=plot_envelopes, grain_json=grain_json,
                show_voice_offsets=show_voice_offsets,
            )

            yield json.dumps({"type": "log",
                              "line": "$ " + " ".join(cmd)}) + "\n"
            watchdog = None
            try:
                proc = rs.start(cmd, root)
                # Hard cap: kill a stuck main.py so it can't hold a worker
                # thread forever (workers=1, threads=4). The kill closes the
                # pipe → readline hits EOF → this loop ends normally. #43
                watchdog = start_watchdog(proc, render_timeout)
                n_streams = len(opts.get("streams") or [])
                state = {"streamId": None, "total": n_streams, "index": 0}
                # Read line-by-line and stream to client.
                for raw in iter(proc.stdout.readline, ""):
                    line = raw.rstrip("\n")
                    if rs.is_cancelled():
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
                if watchdog is not None:
                    watchdog.cancel()
                rs.clear()

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
    ap.add_argument("--render-timeout", type=float, default=600.0,
                    help="hard cap in seconds on a single render before the "
                         "subprocess is killed; 0 disables (default: 600)")
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

    app = make_app(root, render_timeout=args.render_timeout)

    def _check_cmd(cmd):
        try:
            subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=2)
            return True
        except Exception:
            return False
    def _binary_present(name):
        # soxi has no --version flag (exits non-zero); treat only a missing
        # binary (FileNotFoundError) as absent.
        try:
            subprocess.run([name], capture_output=True, timeout=2)
            return True
        except FileNotFoundError:
            return False
        except Exception:
            return True
    sox_ok  = _check_cmd(["sox", "--version"])
    soxi_ok = _binary_present("soxi")
    try:
        import soundfile  # noqa: F401
        sf_ok = True
    except Exception:
        sf_ok = False

    print(f"PGE bridge")
    print(f"  root:    {root}")
    print(f"  refs/:   {root / 'refs'}")
    print(f"  configs/:{root / 'configs'}")
    print(f"  output/: {root / 'output'}")
    print(f"  cache/:  {root / 'cache'}")
    print(f"  sox:     {'ok' if sox_ok else 'MISSING (brew install sox — needed for browser playback)'}")
    print(f"  soundfile:{' ok — sample durations' if sf_ok else ' MISSING (durations fall back to soxi)'}")
    print(f"  soxi:    {'ok' if soxi_ok else 'optional (durations via soundfile; sox/soxi for AIFF→WAV transcode)'}")
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
