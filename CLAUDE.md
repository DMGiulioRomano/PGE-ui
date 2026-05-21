# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Browser-based visual editor for `PythonGranularEngine` (sibling repo) YAML compositions. **No build step, no bundler, no package.json** — React + Babel are loaded from CDN inside `PGE Editor.html`, and `.jsx` files are transpiled in-browser. Open `PGE Editor.html` as a `file://` URL.

The renderer itself lives in a separate repo (`PythonGranularEngine`). This repo only contains the UI plus a thin Flask bridge (`server.py`) that shells out to `python src/main.py …` in that other repo.

## Common commands

```bash
make install          # pip install -r requirements.txt  (flask + flask-cors only)
make serve            # python server.py --root ../PythonGranularEngine --port 7878
python server.py --root /path/to/PythonGranularEngine    # explicit root
```

There is **no test suite, no linter, no typechecker**. Verification is manual: open `PGE Editor.html` in a browser, switch the Settings panel backend to `local`, hit "test connection", render.

## Architecture

### Two-repo split (deliberate)

`PythonGranularEngine` stays a pure CLI (no Flask, no UI). `PGE-ui` (this repo) holds the editor + bridge. The bridge talks to the engine repo via `--root` and never mutates engine source — it only reads/writes inside `refs/`, `configs/`, `output/`, `cache/`.

### Backend abstraction (`backend.js`)

UI never touches I/O directly. It calls `window.PGEBackend` which has two implementations:

| Kind    | Storage                       | Render                                                      |
|---------|-------------------------------|-------------------------------------------------------------|
| `mock`  | `localStorage`                | timers + fake `main.py`-shaped log lines                    |
| `local` | real disk via `server.py`     | `POST /render` → spawns subprocess, streams NDJSON          |

Contract is documented at the top of `backend.js`. Switch in the Settings panel (gear ⚙).

### NDJSON render protocol

`POST /render` returns one JSON object per line. Event types: `log`, `stream-start`, `stream-done`, `done`. `server.py` parses `main.py` stdout (`[3/5] streamX rendering…` / `→ output/…`) into these structured events. Adding a new render-time UI signal usually means: extend the parser in `server.py` AND the consumer in `backend.js` (`runLocalRender`-style flow) AND the React state in `app.jsx`.

### Fingerprint parity

Mock and local backends both compute per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over JSON with sorted keys, ignoring `color/mute/solo`) is intentionally aligned with python's per-stream hash. If you change what affects the hash on one side, mirror it on the other or stems will read stale.

### YAML round-trip (`yaml-bridge.js`)

Editor in-memory shape is camelCase JS with **parallel scalar/envelope fields** (e.g. `density` is a number, `densityEnv` is an array — exactly one is non-null). YAML on disk is snake_case with a **single field** that's either scalar OR envelope. `parse()` and `serialize()` translate between the two. Unknown stream keys are preserved verbatim under `_extra` so the round trip stays lossless for fields the editor doesn't model. `roundTripDiff(data)` returns the divergences; empty array means lossless.

### Audio playback (`audio-engine.js`)

`window.PGEAudio.engine` is the master clock once playing — visual playhead reads `engine.currentTime` from `audioCtx.currentTime`, not its own `requestAnimationFrame` counter. Two modes:

- `mock`: synthesized timbre per stream (no real stems).
- `http`: fetches `GET /audio/<basename>__<sid>.wav` from `server.py`. **Stems are stored as `.aif`** but `server.py` transcodes to WAV via sox at `/audio/` because Firefox can't decode AIFF natively. `/output/<file>.aif` still serves raw.

### History / undo (`app.jsx`)

`setData(updater)` wraps every mutation. `beginGesture()` / `endGesture()` bracket continuous interactions (drag, knob spin) so they collapse into a single undo step. Free-form mutations outside a gesture push to `historyRef.past` each call. Cap is 200 entries. Anything mutating `data` must go through `setData`, not `_setDataRaw`, or undo breaks.

### EDITMODE block

`app.jsx` has `/*EDITMODE-BEGIN*/{…}/*EDITMODE-END*/` around `TWEAK_DEFAULTS`. A sibling design tool rewrites this block from the Tweaks panel. Do not reformat or reorder keys inside it — keep one key per line, double-quoted, trailing-comma-free, or the external writer breaks.

## File-load order (matters)

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `data.js` → `yaml-bridge.js` → `envelope-loops.js` → `backend.js` → `audio-engine.js` → JSX files → `app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`).

## Conventions

- Stem filenames: `<basename>__<streamId>.aif` (double underscore separator).
- Cache manifests: `cache/<basename>.json`, one file per project.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
