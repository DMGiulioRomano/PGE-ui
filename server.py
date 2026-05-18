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
    from flask import Flask, jsonify, request, send_file, Response, abort
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
# main.py prints lines like:
#   "  [3/5] stream3    rendering..."
#   "  [3/5] stream3    cached — skip"
#   "      → output/PGE_test__stream3.aif"
#   " Generazione completata! 5 file generati"
_RE_STREAM_LINE = re.compile(r"^\s*\[(\d+)/(\d+)\]\s+(\S+)\s+(.*)$")
_RE_GENERATED  = re.compile(r"^\s*[→\-]+>?\s+(output/\S+)")


def parse_render_line(line: str, state: dict) -> list:
    """Turn a single stdout line into one or more browser-bound events.

    `state` is a mutable dict tracking which stream is "currently rendering"
    so we can emit stream-done when we see the corresponding output line."""
    events = [{"type": "log", "line": line}]
    m = _RE_STREAM_LINE.match(line)
    if m:
        idx = int(m.group(1)) - 1
        total = int(m.group(2))
        sid = m.group(3)
        rest = m.group(4).lower()
        if "cached" in rest or "skip" in rest:
            events.append({"type": "stream-start",
                           "streamId": sid, "index": idx, "total": total})
            events.append({"type": "stream-done",
                           "streamId": sid, "cached": True})
            state["streamId"] = None
        elif "rendering" in rest:
            state["streamId"] = sid
            state["streamTotal"] = total
            events.append({"type": "stream-start",
                           "streamId": sid, "index": idx, "total": total})
        return events

    m2 = _RE_GENERATED.match(line)
    if m2 and state.get("streamId"):
        events.append({"type": "stream-done",
                       "streamId": state["streamId"], "cached": False,
                       "output": m2.group(1)})
        state["streamId"] = None
    return events


def safe_resolve(base: Path, name: str) -> "Path | None":
    """Resolve `base/name` while rejecting traversal and absolute paths."""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if name.startswith("."):
        return None
    return base / name


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

        # Build the python invocation. We call main.py directly rather than
        # going through `make` so we get clean stdout and don't depend on the
        # user's make targets.
        cmd = [
            sys.executable, str(root / "src" / "main.py"),
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

        def event_stream():
            """Generator: yields one NDJSON line per UI event."""
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
                state = {"streamId": None}
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
    print(f"PGE bridge")
    print(f"  root:    {root}")
    print(f"  refs/:   {root / 'refs'}")
    print(f"  configs/:{root / 'configs'}")
    print(f"  output/: {root / 'output'}")
    print(f"  cache/:  {root / 'cache'}")
    print(f"  listen:  http://{args.host}:{args.port}")
    print(f"")
    print(f"In the browser:")
    print(f"  1) open PGE Editor.html")
    print(f"  2) gear → Backend → local")
    print(f"  3) Backend → server URL → http://{args.host}:{args.port}")
    print(f"")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
