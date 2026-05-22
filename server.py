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
"""

import argparse
import json
import os
import re
import subprocess
import sys
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
# Matches absolute path ending in __<streamId>.aif
_RE_STEM_PATH  = re.compile(r"^\s+.+__(\w+)\.aif\s*$", re.IGNORECASE)


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
        for p in sorted(output.glob(f"{basename}__*.aif")):
            sid = p.stem[len(prefix):]
            if sid:
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

        yml = configs / f"{basename}.yml"
        if not yml.exists():
            return jsonify({"ok": False,
                            "error": f"configs/{basename}.yml not found"}), 404

        aif = output / f"{basename}.aif"

        # Optional: wipe previous stems if requested.
        if preclean:
            for p in output.glob(f"{basename}__*.aif"):
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
                str(yml), str(aif),
                "--renderer", renderer,
                "--per-stream",
                "--show-static",
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
                    for p in sorted(output.glob(f"{basename}__*.aif"))
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
