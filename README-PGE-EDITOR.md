# PGE Editor — operational deep-dive

Setup and quick start live in **[README.md](README.md)**. This document is the
operational reference for the bridge: how the local backend maps to HTTP, the
full endpoint list, the NDJSON render protocol, troubleshooting and security.

The bridge is `server.py` in this repo. It runs **from PGE-ui** and points at a
separately-cloned `PythonGranularEngine` via `--root` (default
`../PythonGranularEngine`) — it never copies itself into or mutates the engine
source. It binds `127.0.0.1` only; CORS is open so the editor (a `file://`
page) can reach it.

Two directories, not one. `--root` is engine source (`src/main.py`, `.venv`,
`csound/`); `--workspace` is the folder holding `configs/`, `output/` and
`cache/` — the work itself. Omit it and they coincide, which is the historical
behavior. `refs/` still comes from `--root`. See **Workspace** below.

---

## How the local backend maps to the server

|                   | local backend                                |
| ----------------- | -------------------------------------------- |
| Storage           | real filesystem via `server.py`              |
| Save              | `PUT /file?kind=projects&name=foo.yml`       |
| Save As…          | same, with new name                          |
| Render            | `POST /render` → spawns `python src/main.py` |
| Render cache      | real `cache/<basename>.json` on disk         |
| Media / Projects  | `GET /media` / `GET /projects`               |
| Play audio        | `GET /audio/<basename>__<sid>.wav` (sox transcode), scheduled to onsets |

---

## Endpoints exposed by `server.py`

```
# introspection / config
GET  /health                     — sanity check + resolved paths (root, workspace, …)
GET  /config                     — the same resolved paths
GET  /workspace                  — current workspace + its project list
POST /workspace                  — switch it ({"path": …}; "" returns to --root)
GET  /diagnose                   — system checks (sox, soxi, numpy, venv, …)

# listing + file I/O
GET  /media                      — list refs/ ({ path, files:[{name,duration?}] })
GET  /projects                   — list configs/*.yml
GET  /file?kind=…&name=…         — read a file
PUT  /file?kind=…&name=…         — write a file
GET  /stems/<base>               — stream IDs with a rendered stem on disk
GET  /cache_manifest/<base>      — read cache/<base>.json

# render
POST /render                     — start a render, returns NDJSON stream of events
POST /render/cancel              — terminate the running subprocess
POST /setup                      — create the engine venv (NDJSON stream)

# rendered-stem audio / analysis (output/)
GET  /output/<file>              — serve a rendered stem (raw)
GET  /audio/<file>               — stem transcoded to WAV via sox (Firefox-friendly)
GET  /peaks/<file>               — waveform peaks (float32) for a stem
GET  /spectrogram/<file>?scale=  — STFT spectrogram (scale=linear|log) for a stem

# refs/ media preview
GET  /media_audio/<file>         — refs/ media as WAV (sox transcode)
GET  /media_peaks/<file>         — waveform peaks for a refs/ media file
GET  /media_spectrogram/<file>   — STFT spectrogram for a refs/ media file
```

The `kind` parameter is one of `media | projects | output | cache`. `media`
resolves against the engine's `refs/`; the other three against the workspace.
Path traversal is rejected; derived audio artifacts (WAV/peaks/spectrogram) are
cached under `cache/` and never written into `refs/`.

---

## Workspace

Before #147 the four working directories were derived from `--root` and nothing
else, so every piece opened in the editor was a file *inside the engine
checkout* — and `/render`, which writes the editor state to the canonical
`configs/<basename>.yml` (see the NDJSON section), rewrote it there. Composing
dirtied the engine repo, and rollback meant the engine's `git`.

The engine was never the constraint: `src/main.py` takes absolute paths and
`--cache-dir` is arbitrary. So:

```bash
python server.py --root ../PythonGranularEngine --workspace ~/brani
make serve WORKSPACE=~/brani
```

| | comes from |
| --- | --- |
| `src/main.py`, `.venv/`, `csound/`, `logs/` | `--root` (engine source) |
| `configs/`, `output/`, `cache/` | `--workspace` (defaults to `--root`) |
| `refs/` | `--root`, still — see below |

Missing **sub**directories are created on startup; the workspace folder itself
is not. A mistyped `--workspace` stops the bridge rather than fabricating an
empty folder and making the author's projects disappear from the list.

**Switching at runtime.** `POST /workspace {"path": …}` commutes the four paths
in place (they are process state, not closure constants — which is why the
gunicorn config runs `workers: 1`); an empty path returns to `--root`. The
response carries the new project list, because a switch invalidates what the
browser holds: it is a replacement, not a merge. In the editor: **⚙ → Workspace**.

Two refusals: a path that doesn't exist (400) and a render in flight (409) —
`/render` reads `configs`, `output` and `cache` while its NDJSON stream is open,
and it also pins them at the start of the route so a switch can't split stems
and cache manifest across two folders.

Browser-side, a successful switch drops the stem index, the peaks, the
spectrograms, the grain sidecars and the last-render fingerprints, then reloads
the project list and reopens a project (same name if the new folder has one).
Keeping any of it would mean a clip with a green dot and no audio behind it —
the 404 an `<audio>` element reports by never firing `canplay`.

**`refs/` doesn't move yet.** The subprocess runs with `cwd=root` and the numpy
renderer resolves samples against `./refs/` there, so samples still come from the
engine. Closing
[PythonGranularEngine#235](https://github.com/DMGiulioRomano/PythonGranularEngine/issues/235)
(`--samples-dir`) is what completes the split. `_ensure_venv_events` and the
csound paths (`--orc-path`, `--incdir`, `--log-dir`) stay bound to `--root` on
purpose: that is engine code, not the author's work.

---

## NDJSON event protocol

`POST /render` streams one JSON object per line. Event types:

```jsonc
{ "type": "log",           "line": "..." }
{ "type": "stream-start",  "streamId": "stream3", "index": 2, "total": 5 }
{ "type": "stream-done",   "streamId": "stream3", "cached": false, "output": "output/PGE_test__stream3.aif" }
{ "type": "done", "ok": true, "generated": ["output/..."], "returncode": 0 }
```

The server parses `main.py`'s stdout (`[3/5] stream3  rendering…` and
`→ output/…`) into these structured events so the UI can highlight the
"currently rendering" clip without you having to change anything in the
python engine.

---

## Troubleshooting

- **"test connection" fails** — is `server.py` actually running? Check the
  terminal you launched it in for tracebacks. Also confirm the URL in the
  settings panel matches what the server printed.
- **CORS error in DevTools** — you're probably hitting a different origin.
  CORS is wide-open on the bridge; if you still see it, you've installed
  flask without `flask-cors`. Run `pip install flask-cors` again.
- **"can't find src/main.py"** — you ran `server.py` from the wrong folder.
  Either `cd` into the PGE repo root first, or pass
  `python server.py --root /path/to/PythonGranularEngine`.
- **Render hangs at "starting render"** — the subprocess might be waiting on
  csound or a missing dep. Open the log panel in the editor (`log` button in
  the topbar), or just look at the server's terminal for the full python
  output.
- **Save writes to the wrong folder** — projects are written inside the
  workspace: `--workspace` if given, otherwise `--root`. Check the `configs/`
  line the bridge prints at startup, or `GET /workspace`. To move, either
  restart with a different `--workspace` or switch it live from **⚙ →
  Workspace** in the editor.

---

## Security notes

- The bridge binds to `127.0.0.1` only by default; nothing on your LAN can
  reach it. If you need to expose it (e.g. to a remote user), pass
  `--host 0.0.0.0` — but understand you're letting anyone reach you spawn
  arbitrary `python src/main.py …` against your configs.
- Path traversal is rejected: `name=../../etc/passwd` returns 400.
- The bridge does not authenticate. It's a local dev tool, not a service.

---

## File layout reference

```
~/projects/
├── PythonGranularEngine/        ← --root points here (engine source)
│   ├── src/main.py              ← bridge invokes this
│   ├── refs/*.wav               ← Media panel (always from here, for now)
│   ├── configs/*.yml            ┐ the default workspace, when --workspace
│   ├── output/                  ├ is omitted: pass one and these three
│   └── cache/                   ┘ live in your own folder instead
│
├── brani/                       ← --workspace points here
│   ├── configs/*.yml            ← Projects panel
│   ├── output/                  ← rendered stems land here; /output/ serves from here
│   └── cache/                   ← /cache_manifest reads here
│
└── PGE-ui/                      ← THIS repo
    ├── server.py                ← the bridge
    ├── PGE Editor.html          ← open in browser
    └── …
```

The browser editor is opened as a `file://` URL and lives entirely in this repo. Engine *source* is never modified — with a workspace of your own, the engine checkout isn't written to at all beyond reading `refs/`.
