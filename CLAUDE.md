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
make tests            # full suite: tests-node + tests-python
```

`make tests` runs both halves of the suite:

- **`make tests-node`** (node, no deps beyond npm) — `tests/node/test-yaml-bridge.js`
  (YAML round-trip fidelity incl. `serializeStream`/`parseStream`, with the real
  engine `configs/*.yml` as fixtures when present), `test-envelope-utils.js`
  (rescale/truncate math), `test-fingerprint.js` (fingerprint parity: which
  fields mark a stem stale), `test-render-status.js` (the stale/fresh/never
  classification + render summary), and `test-history-core.js` (undo/redo stack
  mechanics: 200-cap, gesture collapse, redo-clearing).
- **`make tests-python`** (pytest) — `test_render_pipeline.py`
  (`parse_render_line` events, `build_render_command` flags, the kill/watchdog,
  and a Flask `make_app` smoke test via `test_client`), `test_audio_pipeline.py`
  (path/security helpers), `test_yaml_structure.py`, and `test_engine_render.py`
  (an engine render smoke test that skips when the sibling engine checkout/venv
  is absent).

CI runs both on push and PR (`.github/workflows/ci.yml`); the engine-dependent
test skips there. There is no linter or typechecker, and the React UI itself has
no component-level automated tests — UI verification is still manual: open
`PGE Editor.html` in a browser, switch the Settings panel backend to `local`,
hit "test connection", render.

## Architecture

### Two-repo split (deliberate)

`PythonGranularEngine` stays a pure CLI (no Flask, no UI). `PGE-ui` (this repo) holds the editor + bridge. The bridge talks to the engine repo via `--root` and never mutates engine source — it only reads/writes inside `refs/`, `configs/`, `output/`, `cache/`.

### Backend abstraction (`backend.js`)

UI never touches I/O directly. It calls `window.PGEBackend`, which has a single
implementation, `local`: real disk via `server.py`, `POST /render` spawns the
subprocess and streams NDJSON. The browser only does `fetch()`; the server holds
all disk access, so the editor works in any browser. Contract is documented at
the top of `backend.js`. If `server.py` isn't running the editor flags
`serverDown` and shows a "start server.py" notice (there is no in-browser
fallback).

### NDJSON render protocol

`POST /render` returns one JSON object per line. Event types: `log`, `stream-start`, `stream-done`, `done`. `server.py` parses `main.py` stdout (`[3/5] streamX rendering…` / `→ output/…`) into these structured events. Adding a new render-time UI signal usually means: extend the parser in `server.py` AND the consumer in `backend.js` (`runLocalRender`-style flow) AND the React state in `app.jsx`.

The request body carries `yamlContent` (the editor state serialized on every render, saved or not). `server.py` writes it **to the canonical `configs/<basename>.yml`** before invoking the engine — *not* to a throwaway temp file. This matters for the cache: the engine's per-stream manifest is keyed by the YAML basename (`cache/<basename>.json`), so a render-time temp name like `tmpXXXX.yml` would produce a fresh `cache/tmpXXXX.json` every run and mark **all** streams DIRTY — defeating incremental caching entirely. Writing the stable basename keeps the manifest persistent across renders, so only genuinely changed streams re-render.

Consequence: a render persists the current editor state to the source config even if the user never hit Save (Save only additionally clears the in-UI `dirty` flag). There is no "draft" copy. **Git is the versioning/rollback mechanism**: to discard unsaved edits, reset `configs/<basename>.yml` to the last commit (`git checkout -- configs/<basename>.yml`). Keep `configs/` under version control for this reason.

### Fingerprint parity

The backend computes per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over canonical JSON with recursively sorted keys, ignoring `color/mute/solo/onset`) is semantically aligned with python's per-stream hash. The algorithms differ (FNV-1a vs SHA-256) and `onset` is intentionally excluded on the JS side: moving a clip on the timeline doesn't change the rendered audio, so it shouldn't mark the stem stale. The engine includes `onset` in its hash because it hashes the full YAML dict. If you change what affects the hash on one side, mirror it on the other or stems will read stale.

The fresh/stale/never *classification* built on top of the hash (not the hash itself) — plus the aggregate render summary — lives in `render-status.js` (`window.PGERenderStatus`, node-tested in `test-render-status.js`). `app.jsx` keeps the render state (`lastRenderedFps`, `renderStatus`) and delegates the decision to it.

### YAML round-trip (`yaml-bridge.js`)

Editor in-memory shape is camelCase JS with **parallel scalar/envelope fields** (e.g. `density` is a number, `densityEnv` is an array — exactly one is non-null). YAML on disk is snake_case with a **single field** that's either scalar OR envelope. `parse()` and `serialize()` translate between the two. Unknown stream keys are preserved verbatim under `_extra` so the round trip stays lossless for fields the editor doesn't model; unknown keys *inside* `pointer`/`grain`/`pitch`/`voices` (blocks the serializer rebuilds in full) are preserved the same way under `<block>._extra`. `dephase: null` (engine: implicit 1% mode, distinct from key-absent = off) is stored in editor state as the sentinel `window.PGEYaml.DEPHASE_IMPLICIT` and serialized back to `dephase: null`. `roundTripDiff(data)` returns the divergences; empty array means lossless.

### Audio playback (`audio-engine.js`)

`window.PGEAudio.engine` is the master clock once playing — visual playhead reads `engine.currentTime` from `audioCtx.currentTime`, not its own `requestAnimationFrame` counter. It fetches `GET /audio/<basename>__<sid>.wav` from `server.py`. **Stems are stored as `.aif`** but `server.py` transcodes to WAV via sox at `/audio/` because Firefox can't decode AIFF natively. `/output/<file>.aif` still serves raw. Streams without a rendered stem stay silent (no procedural fallback).

### History / undo (`app.jsx`)

`setData(updater)` wraps every mutation. `beginGesture()` / `endGesture()` bracket continuous interactions (drag, knob spin) so they collapse into a single undo step. Free-form mutations outside a gesture push to `historyRef.past` each call. Cap is 200 entries. Anything mutating `data` must go through `setData`, not `_setDataRaw`, or undo breaks.

The pure stack mechanics (the 200-cap, gesture collapse, undo/redo, redo-clearing) live in `history-core.js` (`window.PGEHistoryCore`, node-tested in `test-history-core.js`). `app.jsx` keeps the React glue — the `[data, _setDataRaw]` state, the `historyRef`, the `setHistVer` re-render bump, the `window.PGEHistory` publication, the keyboard shortcuts, and the freeze-on-resize confirm inside `endGesture` — and delegates the bookkeeping to it.

### EDITMODE block

`app.jsx` has `/*EDITMODE-BEGIN*/{…}/*EDITMODE-END*/` around `TWEAK_DEFAULTS`. A sibling design tool rewrites this block from the Tweaks panel. Do not reformat or reorder keys inside it — keep one key per line, double-quoted, trailing-comma-free, or the external writer breaks.

## File-load order (matters)

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `yaml-bridge.js` → `envelope-loops.js` → `backend.js` → `audio-engine.js` → `render-status.js` (needs `window.PGEBackend`) → `history-core.js` → JSX files → `app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`).

## Conventions

- Stem filenames: `<basename>__<streamId>.aif` (double underscore separator).
- Cache manifests: `cache/<basename>.json`, one file per project. Keyed by the YAML basename — `/render` writes the editor state to the stable `configs/<basename>.yml` (never a temp file) so the manifest persists across renders and incremental caching works.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
