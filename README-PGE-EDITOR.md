# PGE Editor — local setup

The PGE Editor is a single-page browser app. It edits the `configs/*.yml`
files of [`PythonGranularEngine`](https://github.com/DMGiulioRomano/PythonGranularEngine)
visually and launches `python src/main.py …` for you via a tiny local bridge.

You don't need to "install" the editor. You need three things on disk:

1. The editor source (this folder — `PGE Editor.html` + the `.jsx`/`.css`/`.js` files)
2. A local clone of `PythonGranularEngine` (the actual renderer)
3. Python with `flask` + `flask-cors` (the bridge)

The bridge is `server.py` in this folder. **You copy or symlink it into the
PythonGranularEngine repo root and run it from there.**

---

## Quick start

### 1) Set up `PythonGranularEngine` (one-time)

Follow that repo's README — `make setup` after the system-deps step.

### 2) Install the bridge deps in this repo (PGE-ui)

```bash
cd /path/to/PGE-ui
pip install -r requirements.txt
```

(Use the engine's venv if you want, or any python ≥ 3.10 — the bridge only depends on flask + flask-cors.)

### 3) Start the bridge

If the two repos are cloned side-by-side (`~/projects/PythonGranularEngine` and `~/projects/PGE-ui`):

```bash
make serve
# or
python server.py
```

Otherwise point at the engine explicitly:

```bash
python server.py --root /path/to/PythonGranularEngine
```

You'll see:

```
PGE bridge
  root:    /path/to/PythonGranularEngine
  refs/:   /path/to/PythonGranularEngine/refs
  configs/: /path/to/PythonGranularEngine/configs
  output/: /path/to/PythonGranularEngine/output
  cache/:  /path/to/PythonGranularEngine/cache
  listen:  http://127.0.0.1:7878
```

The bridge serves only on `127.0.0.1`. CORS is open for all origins so the
editor (which you open as a `file://` URL) can talk to it.

### 4) Open the editor

Just open `PGE Editor.html` in Chrome, Firefox, Safari, anything. Then:

1. Click the **⚙ gear icon** in the top-right.
2. **Backend → switch from "mock" to "local"**.
3. **Backend → server URL** should already say `http://localhost:7878`.
4. Click **"test connection"** — it turns green and shows the root path.
5. The **Media** and **Projects** panels will now show the actual contents
   of `refs/` and `configs/` from the python repo.
6. Hit **Render**. The progress bar in the top-bar, the per-clip status dots,
   and the embedded **log** terminal are all live output from `main.py`.

---

## What changes between mock and local

|                   | mock (default)                  | local                                    |
| ----------------- | ------------------------------- | ---------------------------------------- |
| Storage           | `localStorage`                  | real filesystem via `server.py`           |
| Save              | fake                            | `PUT /file?kind=projects&name=foo.yml`    |
| Save As…          | fake                            | same, with new name                       |
| Render            | timers + fake log lines         | `POST /render` → spawns `python src/main.py` |
| Render cache      | fake fingerprints in localStorage | real `cache/<basename>.json` on disk  |
| Media / Projects  | hardcoded sample list           | `GET /media` / `GET /projects`            |
| Play audio        | silent timeline                 | (planned — see below)                     |

> **Play audio in local mode** — currently the timeline still plays
> silently. Wiring the `<audio>` elements to `GET /output/<basename>__<sid>.aif`
> per stream, aligned to onsets, is the next step. The endpoint and per-stream
> URL helper (`render.stemUrl(basename, sid)`) are already wired server-side
> and in `backend.js`.

---

## Endpoints exposed by `server.py`

```
GET  /health                — sanity check + resolved repo paths
GET  /media                 — list refs/ (returns { path, files:[{name,duration?}] })
GET  /projects              — list configs/*.yml
GET  /file?kind=…&name=…    — read a project file
PUT  /file?kind=…&name=…    — write a project file
GET  /cache_manifest/<base> — read cache/<base>.json
POST /render                — start a render, returns NDJSON stream of events
POST /render/cancel         — terminate the running subprocess
GET  /output/<file>.aif     — serve a rendered stem
```

The `kind` parameter is one of `media | projects | output | cache` and is
resolved against the repo's `refs / configs / output / cache` folders. Path
traversal is rejected.

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
- **Save writes to the wrong folder** — the bridge ALWAYS writes inside the
  repo root passed to `--root`. There's no escaping that. If you want to
  point at a different project, restart the bridge with a different `--root`.

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
├── PythonGranularEngine/        ← --root points here
│   ├── src/main.py              ← bridge invokes this
│   ├── configs/*.yml            ← Projects panel
│   ├── refs/*.wav               ← Media panel
│   ├── output/                  ← rendered stems land here; /output/ serves from here
│   └── cache/                   ← /cache_manifest reads here
│
└── PGE-ui/                      ← THIS repo
    ├── server.py                ← the bridge
    ├── PGE Editor.html          ← open in browser
    └── …
```

The browser editor is opened as a `file://` URL and lives entirely in this repo. The engine repo is never modified — the bridge only reads + writes to it.
