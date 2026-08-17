# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Browser-based visual editor for `PythonGranularEngine` (sibling repo) YAML compositions. **No build step, no bundler, no package.json** — React + Babel are loaded from CDN inside `PGE Editor.html`, and `.jsx` files are transpiled in-browser. Open `PGE Editor.html` as a `file://` URL.

The renderer itself lives in a separate repo (`PythonGranularEngine`). This repo only contains the UI plus a thin Flask bridge (`server.py`) that shells out to `python src/main.py …` in that other repo.

## Common commands

```bash
make install          # pip install -r requirements.txt  (flask, flask-cors, gunicorn, numpy, soundfile)
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
  classification + render summary), `test-history-core.js` (undo/redo stack
  mechanics: 200-cap, gesture collapse, redo-clearing), and `test-tweaks-store.js`
  (preferences `applyEdit` merge + a guard against the removed design-tool residue),
  and `test-audio-clock.js` (the playback clock's latency/lead compensation —
  `audiblePosition`/`playAt` in `window.PGEAudioClock`), and
  `test-magnify-spec.js` (the `--magnify-at` SPEC grammar in
  `window.PGEMagnifySpec`, plus source guards on the UI wiring).
- **`make tests-python`** (pytest) — `test_render_pipeline.py`
  (`parse_render_line` events, `build_render_command` flags, the kill/watchdog,
  and a Flask `make_app` smoke test via `test_client`), `test_audio_pipeline.py`
  (path/security helpers), `test_yaml_structure.py`, and `test_engine_render.py`
  (an engine render smoke test that skips when the sibling engine checkout/venv
  is absent).

CI runs both on push and PR (`.github/workflows/ci.yml`). The python job checks
out the sibling engine and builds its venv, so the engine-dependent
`test_engine_render` runs there too — it only skips when the engine checkout is
absent (e.g. locally). There is no linter or typechecker, and the React UI itself has
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

### Score options that can kill a render

Most render options degrade gracefully — a wrong one produces a worse PDF. Two
don't: an unknown `--plot-envelopes` name and a malformed `--magnify-at` SPEC
both make `main.py` print and **exit 1**, taking the whole render (audio
included) with them. So both are filtered before they reach argv, in different
places for different reasons. Envelope names are checked *server-side*
(`server.py` intersects them with `engine_envelope_keys(root)`) because the
valid set is read from the engine source and the browser doesn't have it. The
lens SPEC is checked *client-side* (`src/lib/magnify-spec.js`,
`window.PGEMagnifySpec.error`, node-tested) because it's free text typed in the
render popover and the useful moment to say "chiave ignota 'zom'" is while
typing, not after a failed render. `render_pipeline.py` only drops a blank
SPEC; the grammar lives in the JS mirror of the engine's `_parse_magnify_spec`
— same parity pact as the fingerprint, so a grammar change in PGE lands here
too.

The request body carries `yamlContent` (the editor state serialized on every render, saved or not). `server.py` writes it **to the canonical `configs/<basename>.yml`** before invoking the engine — *not* to a throwaway temp file. This matters for the cache: the engine's per-stream manifest is keyed by the YAML basename (`cache/<basename>.json`), so a render-time temp name like `tmpXXXX.yml` would produce a fresh `cache/tmpXXXX.json` every run and mark **all** streams DIRTY — defeating incremental caching entirely. Writing the stable basename keeps the manifest persistent across renders, so only genuinely changed streams re-render.

Consequence: a render persists the current editor state to the source config even if the user never hit Save (Save only additionally clears the in-UI `dirty` flag). There is no "draft" copy. **Git is the versioning/rollback mechanism**: to discard unsaved edits, reset `configs/<basename>.yml` to the last commit (`git checkout -- configs/<basename>.yml`). Keep `configs/` under version control for this reason.

### Dynamic parameter bounds

The UI's clamps (min/max/range for every control + envelope, and the pitch-unit bounds) are sourced from the engine rather than hardcoded. `GET /bounds` in `server.py` **AST-parses** the engine's `parameter_definitions.py` (`GRANULAR_PARAMETERS`) and `pitch_unit.py` (EDO `edoFactor` + `RatioUnit`) under `src/pge/parameters/` (falling back to the pre-#162 flat `src/parameters/` for older engine checkouts; same layout dance for `/envelope-keys`, whose `ENVELOPE_COLORS` literal now lives in `src/pge/rendering/envelope_extractor.py`) — same venv-less trick in both, so it works before the engine venv exists; returns `{}` for an engine without those files. `backend.js` `bounds()` fetches it; `app.jsx` calls `window.PGEBounds.apply()` at boot. `bounds.js` (`mergeEngineBounds`, node-tested in `test-bounds.js`) folds the engine payload onto `window.PGE_BOUNDS` via `ENGINE_PARAM_MAP` — which says, per UI key, the engine param **and** whether it reads the value bounds (`min_val/max_val`) or the range bounds (`min_range/max_range`, e.g. `offsetRange`←`pointer_deviation`, `durationRange`←`grain_duration`). `window.PGE_BOUNDS` in `yaml-bridge.js` is now just the **static fallback** (used on `file://` / server down); the dynamic path overrides it. A `null` engine `max_val` keeps the static fallback cap — except the `loop_*` trio, whose engine `max_val` is `null` precisely because the real cap is the **chosen sample's duration** (`sample_dur_sec`). `loopEnvMax` in `envelope-utils.js` (node-tested) drives the EnvelopeEditor `hardMax` + the Inspector scalar clamp from that duration (the sample's `duration` from `GET /media`), unit-aware like the engine's `PointerController` (`loop_unit || time_mode`: seconds → `sample_dur`, normalized → `1`), and falls back to the static cap only when the duration is unknown (`file://` / server down / unreadable file / sample not found). UI controls with no engine counterpart (voices onset_offset, pan spread, dephase %, grain-env curve) stay static. **If you add a UI clamp, add its fallback in `yaml-bridge.js` and a mapping in `bounds.js`.**

Loop-window semantics (engine confinement, PGE-ui issue #97). With a loop active the engine confines the grain read position — base + `pointer.offset_range` + voice pointer offsets (`voices` → `pointer_range`/`step`) — to `[loop_start, loop_end)` via modular wrap (without a loop it scales/wraps over the whole file, unchanged). A loop straddling the file end is expressible **only** via `loop_dur` (`loop_start + loop_dur > sample_dur`); `loop_end` stays bound to `[0, sample_dur]`. The engine rejects a degenerate static window (`loop_end <= loop_start` → `InvalidFieldValueError`; envelope endpoints are dynamic → exempt). `loopBoundsError` in `envelope-utils.js` (node-tested) mirrors that static check so the Inspector can warn pre-render; the Inspector also surfaces the confinement in the `offset_range` / voices-pointer hints. The grain visualizations (`grain-map.js`) need no change — they plot the engine's post-render sidecar JSON, so the new confinement shows through automatically.

The EnvelopeEditor Y window **auto-fits the point values** for readability (`computeYFit` in `envelope-utils.js`, node-tested): it fits min..max of the breakpoints + 10% margin, clamped into the dynamic `[hardMin,hardMax]` — not the old `[visMin,visMax]` union, which could only grow and left points squashed against an edge. The fit is live while idle and **frozen during a drag** (a `useRef` snapshot) so the grabbed point can't slide under a rescaling axis; `visMin/visMax` are only the no-points fallback window.

### Fingerprint parity

The backend computes per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over canonical JSON with recursively sorted keys, ignoring `color/mute/solo/onset` plus `durationImplicit/durationUnresolved`) is semantically aligned with python's per-stream hash. The algorithms differ (FNV-1a vs SHA-256) and `onset` is intentionally excluded on the JS side: moving a clip on the timeline doesn't change the rendered audio, so it shouldn't mark the stem stale. The engine includes `onset` in its hash because it hashes the full YAML dict. The two `duration*` flags are excluded because they record *where* the stream's length comes from (written in the YAML vs inherited from the sample), not what it is — the resolved `duration` is hashed, so typing the value the sample already implied leaves the stem green. If you change what affects the hash on one side, mirror it on the other or stems will read stale.

The fresh/stale/never *classification* built on top of the hash (not the hash itself) — plus the aggregate render summary — lives in `render-status.js` (`window.PGERenderStatus`, node-tested in `test-render-status.js`). `app.jsx` keeps the render state (`lastRenderedFps`, `renderStatus`) and delegates the decision to it.

### YAML round-trip (`yaml-bridge.js`)

Editor in-memory shape is camelCase JS with **parallel scalar/envelope fields** (e.g. `density` is a number, `densityEnv` is an array — exactly one is non-null). YAML on disk is snake_case with a **single field** that's either scalar OR envelope. `parse()` and `serialize()` translate between the two. Unknown stream keys are preserved verbatim under `_extra` so the round trip stays lossless for fields the editor doesn't model; unknown keys *inside* `pointer`/`grain`/`pitch`/`voices` (blocks the serializer rebuilds in full) are preserved the same way under `<block>._extra`. `dephase: null` (engine: implicit 1% mode, distinct from key-absent = off) is stored in editor state as the sentinel `window.PGEYaml.DEPHASE_IMPLICIT` and serialized back to `dephase: null`.

Stream `duration` is **optional** for the engine (PGE #205): absent or `null` means "as long as the sample". Editor state keeps `duration` a plain number for every reader (timeline width, envelope X axis, render extent), resolved from the media list (`parse(text, {samples})`, `parseStream(text, idx, {samples})` — both need the sample list or the length can't be known), and records the provenance in two flags: `durationImplicit` (serialization omits the key, so an implicit length is never materialized on save) and `durationUnresolved` (the sample's length is unknown — `file://`, server down, file missing — so the number is the `IMPLICIT_DURATION_FALLBACK` guess and the Inspector says so). `applyStreamPatch` clears `durationImplicit` when a patch sets `duration`, *unless* the patch carries its own flag — a whole re-parsed stream from the Raw tab must not materialize a key the author never wrote.

**Resolution is not only parse-time**, because both of its inputs move after the parse:

- *The media list arrives late.* At boot `GET /projects` and `GET /media` race (the latter opens every audio header), so a project can be parsed before the sample lengths are known. Two mechanisms cover it: `onProjectSelect` reads the list from `mediaFilesRef`, not from the render closure — the closure is captured before `await readFile(…)` and the list can land inside that await — and an effect keyed on `mediaList.path`/`files` calls `resolveImplicitDurations(data, files)` for the case where they land after the parse. That gate is `path !== null`, **not** `!loading`: the initial state is already "not loading" before the fetch starts. It goes through `_setDataRaw`, so a late arrival neither dirties the project nor becomes an undo step, and the function returns the same object when nothing changes so the effect can re-fire freely. It also refreshes `data.samples`, which `roundTripDiff` re-parses against.
- *The sample changes.* Picking another sample re-resolves an inherited duration, via `applyStreamPatch(stream, patch, {samples})` — `mergeStreamPatch` in `app.jsx` supplies the list. Skipped when the patch carries its own `durationImplicit` (Raw tab: already resolved) or when no `samples` is passed (a caller without the list would otherwise downgrade a good value to the fallback). `roundTripDiff(data)` returns the divergences; empty array means lossless.

### Audio playback (`audio-engine.js`)

`window.PGEAudio.engine` is the master clock once playing — visual playhead reads `engine.currentTime` from `audioCtx.currentTime`, not its own `requestAnimationFrame` counter. The clock is **latency-compensated** so the cursor sits on the *audible* sound rather than ahead of it: `scheduleStreams` anchors `startedAtCtx` a small **start lead** (`START_LEAD_SEC`) into the future — enough for the `<audio>` media elements to reach `canplay` before they must sound — and `currentTime` subtracts the device `outputLatency` (falling back to `baseLatency`), clamping to the start position during the lead so the playhead holds instead of jumping. The streaming path (`_scheduleStreaming`) preloads each element a lead before its onset, gates `play()` to the clip's ctx-clock start (`PGEAudioClock.playAt`, which clamps to "now" for a mid-playback reschedule whose anchor is in the past), and on residual lateness seeks the element forward so audio re-aligns with the playhead. A pure decoded-buffer schedule needs no lead (sample-accurate `source.start`), so the lead collapses to the output latency. The pure clock math (`audiblePosition`, `playAt`) is exposed as `window.PGEAudioClock` and node-tested in `test-audio-clock.js`. The render output format is a Settings preference (`tweaks.outputFormat`, **default `wav`**, also `aiff`/`flac`), forwarded to the engine as `--format`. `backend.js` `stemUrl` routes playback by format: `wav`/`flac` → `GET /output/<basename>__<sid>.<ext>` served **raw** (browsers decode these natively — no sox); `aiff` → `GET /audio/<basename>__<sid>.aif`, which `server.py` transcodes to WAV via sox because Firefox can't decode AIFF natively. So with the default WAV, playback needs no sox at all; the `/audio` transcode is only the AIFF path. Sample durations in `GET /media` come from `soundfile` (`sf.info`, header-only), with `soxi -D` as fallback. Streams without a rendered stem stay silent (no procedural fallback).

### History / undo (`app.jsx`)

`setData(updater)` wraps every mutation. `beginGesture()` / `endGesture()` bracket continuous interactions (drag, knob spin) so they collapse into a single undo step. Free-form mutations outside a gesture push to `historyRef.past` each call. Cap is 200 entries. Anything mutating `data` must go through `setData`, not `_setDataRaw`, or undo breaks.

The pure stack mechanics (the 200-cap, gesture collapse, undo/redo, redo-clearing) live in `history-core.js` (`window.PGEHistoryCore`, node-tested in `test-history-core.js`). `app.jsx` keeps the React glue — the `[data, _setDataRaw]` state, the `historyRef`, the `setHistVer` re-render bump, the `window.PGEHistory` publication, the keyboard shortcuts, and the freeze-on-resize confirm inside `endGesture` — and delegates the bookkeeping to it.

## File layout & load order (matters)

Sources live under `src/lib/` (the `.js` logic — `window.*` globals, no modules), `src/components/` (the `.jsx` UI), and `styles/` (the `.css`). `PGE Editor.html` and the Python bridge (`server.py` + helpers) stay in the repo root. `server.py` serves the editor and these subdirectories via its static catch-all, so the same relative paths work over `file://` and over the bridge. Node tests in `tests/node/` load the libs via relative paths (`../../src/lib/…`, `../../src/components/…`).

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `src/lib/yaml-bridge.js` → `src/lib/bounds.js` (needs `window.PGE_BOUNDS` from yaml-bridge) → `src/lib/envelope-loops.js` → `src/lib/backend.js` → `src/lib/audio-engine.js` → `src/lib/grain-map.js` → `src/lib/render-status.js` (needs `window.PGEBackend`) → `src/lib/history-core.js` → JSX files (`src/components/*.jsx`) → `src/components/app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`).

## Conventions

- Stem filenames: `<basename>__<streamId>.<ext>` (double underscore separator); `<ext>` follows the Settings output format (`tweaks.outputFormat`, default `wav` → `.wav`; `aiff` → `.aif`, `flac` → `.flac`).
- Cache manifests: `cache/<basename>.json`, one file per project. Keyed by the YAML basename — `/render` writes the editor state to the stable `configs/<basename>.yml` (never a temp file) so the manifest persists across renders and incremental caching works.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
