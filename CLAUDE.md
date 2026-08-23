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
  `window.PGEMagnifySpec`, plus source guards on the UI wiring), and
  `test-time-dist.js` (the compact block's time-distribution registry mirror —
  `window.PGEEnv.timeDistError`, including the `(param, n_reps)` overflow whose
  thresholds are checked against the real engine, plus the no-longer-silent
  fallback in `computeCycleDurations` and the band where its warn may not speak
  for the engine), and `test-deviation-probability.js`
  (`window.PGEDeviationProb`: the off/implicit/global/perParam classifier,
  `error()` as the mirror of the bodies the engine rejects, the live/dead
  per-param keys tied to behaviour rather than to a copy of the list, and source
  guards on the UI wiring), and `test-stream-id.js` (`allocStreamIds` never
  reuses an id that still owns a stem, plus source guards on the two call sites
  and on `deleteStream` staying a data-only mutation), and `test-stem-index.js`
  (the `hasStem`/`ownsStem` split over the format-keyed stem index, plus source
  guards on the audio-error path), and `test-suite-harness.js` (the suite's own
  exit contract: the verdict is an `exit` handler, verified by running it, plus
  a guard that every `tests/node/*.js` uses it and none went back to a
  positional exit gate), and `test-tracks.js` (the track model: `deriveTracks`
  totality against hand-edited `ui_tracks`, `applyTracks` never rewriting a
  stream object, the key appearing only when it says something, plus source
  guards on the Timeline/app wiring), and `test-jsx-parse.js` (every `.jsx` file
  parses — there is no build step, so a syntax error would only surface as a
  blank editor, and the regex source guards stay green on a file that cannot
  run).
- **`make tests-python`** (pytest) — `test_render_pipeline.py`
  (`parse_render_line` events, `build_render_command` flags, the kill/watchdog,
  and a Flask `make_app` smoke test via `test_client`), `test_audio_pipeline.py`
  (path/security helpers), `test_yaml_structure.py` (the engine config corpus,
  gated by `engine_corpus.py`), and `test_engine_render.py`
  (an engine render smoke test that skips when the sibling engine checkout/venv
  is absent).

CI runs both on push and PR (`.github/workflows/ci.yml`). The python job checks
out the sibling engine and builds its venv. The node job checks it out too so
the fixture-dependent parts run on a PR — a `configs/` change in
`PythonGranularEngine` can turn PGE-ui CI red on purpose (the #131 canary). The
assertion count is engine-dependent: a config added/removed upstream moves it by
three (three assertions per file), so a local total that differs from CI's is
that, not a lost test.

**Engine fixtures never skip silently** (#132), on both halves of the suite.
`test-yaml-bridge.js` routes every engine config through `engineFixture(name)`;
`test_yaml_structure.py` goes through `tests/python/engine_corpus.py`. Same three
outcomes:

| situation | outcome |
| --- | --- |
| sibling engine checkout absent | SKIP — the only legitimate one (local dev, fork PR without the secret) |
| checkout present, named fixture (node) or non-empty `configs/` (python) missing | **FAIL** — renamed or deleted upstream: update the check, don't ignore it |
| `PGE_REQUIRE_ENGINE_FIXTURES=1` and the checkout is absent | **FAIL** |

Both CI jobs pass `PGE_REQUIRE_ENGINE_FIXTURES=1` when their engine checkout step
reports **`outcome`** (not `conclusion` — with `continue-on-error: true` that one
is `success` even on failure, which would make the gate inert), so even that last
skip can't go green in CI. The env var is read as `=== "1"` / `== "1"`, so `=0`
turns it off as expected. The node run ends with a fixture tally
(`N eseguite (M usi), K mancanti, corpus J config` — distinct names, `PGE_pino2.yml`
is used by two blocks); pytest prints the corpus line from
`pytest_terminal_summary` — at the end of the run, and it survives `-q`, where
the report header does not.

The two halves don't cover the same thing: only the node half expects **names**.
`engine_corpus.py` runs over whatever `*.yml` it finds, so an upstream deletion
thins the python corpus without turning it red — the seven named fixtures in
`test-yaml-bridge.js` are the presidio, over the same directory.

Still legitimately skippable: `test_engine_render.py`, which needs the engine's
**venv**, not just its checkout.

The engine checkout is not pinned to a ref — it tracks the engine's default
branch. That's the point (an upstream `configs/` change can turn PGE-ui red on
purpose, the #131/#132 canary), but the red then hits **every** open PGE-ui PR,
including unrelated ones. The way out is to update the name in the
`engineFixture(...)` call (or the config's own name upstream), not to re-silence
the check.

**That bill has come due before**, so budget for it rather than being surprised:
engine commit `a666fce` renamed `pino2.yml`→`PGE_pino2.yml`,
`pino3.yml`→`PGE_pino3.yml` and `PGE_pino.yaml`→`PGE_test.yml` while deleting
three more configs, all in one commit. Four of the seven names the node suite now
requires come out of that rename; `PGE_test.yml` and `PGE_detune_implicito_test.yml`
read like throwaway configs and are the likeliest to move next. Pinning the
checkout to a ref would stop the noise and kill the canary with it — the trade is
deliberate.

**The suite's verdict is an `exit` handler, not a line at the bottom.** Every
`tests/node/*.js` registers `process.on("exit", (code) => …)` that prints the
summary and sets `process.exitCode`; nothing calls `process.exit(…)` directly.
That's what makes an appended section count: `test-yaml-bridge.js` used to run 24
asserts *after* its positional exit gate, printing FAIL and exiting 0. The `code`
argument covers the other half of the same lie: a file that dies mid-run (an
exception in an appended section) exits 1 but its counters still read `0 failed`,
so the handler prints `interrotto prima della fine` instead of a clean summary
under a stack trace. `test-suite-harness.js` verifies all of it — the idiom, by
running it, and every suite file, by source guard.

There is no linter or typechecker — `test-jsx-parse.js` is the whole static net,
and it only proves a component parses. UI verification is manual (open
`PGE Editor.html`, Settings → local backend, test connection, render).

## Architecture

### Two-repo split (deliberate)

`PythonGranularEngine` stays a pure CLI (no Flask, no UI). `PGE-ui` (this repo) holds the editor + bridge. The bridge talks to the engine repo via `--root` and never mutates engine source — it only reads/writes inside `refs/`, `configs/`, `output/`, `cache/`.

### Backend abstraction (`backend.js`)

UI never touches I/O directly. It calls `window.PGEBackend`, which has a single
implementation, `local`: real disk via `server.py`, `POST /render` spawns the
subprocess and streams NDJSON. The browser only does `fetch()`; the server holds
all disk access. Contract is documented at the top of `backend.js`. If
`server.py` isn't running the editor flags `serverDown` (there is no in-browser
fallback).

### NDJSON render protocol

`POST /render` returns one JSON object per line. Event types: `log`, `stream-start`, `stream-done`, `done`. `server.py` parses `main.py` stdout into these structured events. Adding a new render-time UI signal usually means: extend the parser in `server.py` AND the consumer in `backend.js` AND the React state in `app.jsx`.

### Score options that can kill a render

Two options exit 1 (taking audio with them): unknown `--plot-envelopes` name, malformed `--magnify-at` SPEC. Both are filtered before reaching argv, but in different places:

- **Envelope names** → filtered *server-side* (`server.py` intersects them with `engine_envelope_keys(root)`) because the valid set lives in engine source.
- **Lens SPEC** → filtered *client-side* (`src/lib/magnify-spec.js`, `window.PGEMagnifySpec.error`, node-tested) because it's free text typed in the render popover and the useful error moment is while typing.

The request body carries `yamlContent`. `server.py` writes it **to the canonical `configs/<basename>.yml`** before invoking the engine — *not* a throwaway temp file. A temp name like `tmpXXXX.yml` would produce a fresh `cache/tmpXXXX.json` every run and mark **all** streams DIRTY, defeating incremental caching. Writing the stable basename keeps the manifest persistent. Consequence: a render persists the editor state to the source config even if the user never hit Save. **Git is the rollback mechanism** (`git checkout -- configs/<basename>.yml`).

### YAML bodies that can kill a render

Two engine rejections the UI mirrors client-side (PGE #209/#212, PGE-ui #123):

**`deviation_probability`** with a body that can't build as an envelope exits 1. `window.PGEDeviationProb.error` (`src/lib/deviation-probability.js`, node-tested) is the mirror — deliberately the *conservative half*: it flags only bodies that can't be an envelope in any reading, so mixed forms pass here and are caught by the engine. The Inspector shows the error below the mode selector.

Per-param key lists — important distinction:
- `PARAM_KEYS` (5): keys the engine consults **always** (`volume`, `pan`, `duration`, `pitch`, `pointer`).
- `liveParamKeys(stream)` (adds 3 conditional on the `grain` block): `reverse`/`read_direction` (exclusive group, engine reads exactly one) and `pc_rand_envelope` (live unless `grain.envelope` is transition/multistate).
- `ALL_PARAM_KEYS` (8 + dead `envelope`): every key the editor may find written — used by the envelope walk (`envelope-utils.js`) and `listEnvelopes` in the EnvelopeEditor, which need format-agnostic coverage regardless of liveness.

`isEnvValue` — which decides global-vs-per-param — is the engine's dict rule verbatim: **`'points' in obj`**, nothing more.

The `envelope` per-param key is always inert (its spec is `is_smart=False`). The Inspector shows rows for it so it's visible and removable; the EnvelopeEditor's selector marks it the same way via `window.PGE.deviationProbInertReason` (one function, shared).

`wouldEmptyEnv` guards all five delete/paste paths in the EnvelopeEditor. It takes the **desugared items** (not wrapped). A caller holding a wrapped value must `unwrapEnv` first. Two forms the item count can't see on its own are recognized inside the function: a bare compact block and a dict breakpoint `{t, v}`.

The per-param "remove" button must serialize the off state as `false` or absent — **never as an empty key** (empty key = implicit 1% mode, PGE #210).

**Compact block time distribution** overflow (`{type: geometric, ratio: 10, n_reps: 400}`): `timeDistError(dist, nReps)` in `envelope-utils.js` checks on logarithms. Thresholds are pinned against the real engine in `test-time-dist.js` and model Python **integer** semantics (more permissive). There is a one-value band where the engine overflows and the UI stays quiet — always the safe direction. `computeCycleDurations` has an output net: if durations aren't all finite or don't sum to `T`, it falls back to equal cycles and marks the array `previewFallback`. The warn text must NOT claim what the engine will do in the band — only "drawn durations are not the block's".

### Dynamic parameter bounds

`GET /bounds` in `server.py` **AST-parses** the engine's `parameter_definitions.py` (`GRANULAR_PARAMETERS`) and `pitch_unit.py` under `src/pge/parameters/` (falling back to pre-#162 flat `src/parameters/`). Returns `{}` for an engine without those files. `backend.js` `bounds()` fetches it; `app.jsx` calls `window.PGEBounds.apply()` at boot. `bounds.js` (`mergeEngineBounds`, node-tested) folds the engine payload onto `window.PGE_BOUNDS` via `ENGINE_PARAM_MAP` — which says, per UI key, the engine param and whether it reads `min_val/max_val` or `min_range/max_range`. `window.PGE_BOUNDS` in `yaml-bridge.js` is the **static fallback** (used on `file://` / server down).

A `null` engine `max_val` keeps the static fallback cap — except the `loop_*` trio, whose `max_val` is `null` because the real cap is the **chosen sample's duration**. `loopEnvMax` in `envelope-utils.js` drives the EnvelopeEditor `hardMax` + Inspector scalar clamp from that duration, unit-aware (`loop_unit || time_mode`: seconds → `sample_dur`, normalized → `1`), falling back to the static cap only when the duration is unknown.

Loop-window semantics: with a loop active the engine confines the grain read position to `[loop_start, loop_end)` via modular wrap. A loop straddling the file end is expressible **only** via `loop_dur` (`loop_start + loop_dur > sample_dur`); `loop_end` stays bound to `[0, sample_dur]`. `loopBoundsError` in `envelope-utils.js` mirrors the static degenerate-window check (`loop_end <= loop_start`).

`loopUnitInfo` in `envelope-utils.js` returns the unit **and** its provenance (`loop_unit` / `time_mode` / `default`). Picking the inherited unit deletes the key rather than materializing a redundant one — absence is the "inherit" state. Switching the unit re-clamps scalar endpoints; envelope endpoints are per-grain and exempt.

`grain.duration_unit` (`seconds | samples | milliseconds`, PGE #158 then #171) is the same shape of problem one level down: the engine's `grain_duration` bounds are in **seconds**, the YAML values are in the declared unit. `grainUnitFactor` / `grainUnitBounds` / `grainDefaultDuration` / `grainUnitSuffix` in `envelope-utils.js` are the single source — bounds, the `0.05` s default and the row suffix expressed in the unit in force (in ms the cap is `10000`, not `10`); they drive the EnvelopeEditor `hardMin/hardMax` + vis window and the seed of the scalar↔env toggle. Changing the unit goes through `convertGrainDurationUnit`, which **converts** `duration`/`duration_range` — scalars and envelopes, every form `Envelope._scale_raw_values_y` scales — instead of letting the old number be reinterpreted in the new scale, then re-clamps the scalars (envelope points need no clamp: bounds scale by the same factor). An unknown unit converts nothing and gets no suffix. The key is deleted only for `seconds` — absence *is* seconds. One asymmetry is deliberate: changing the unit **does** mark the stem stale even though the rendered audio is identical, because `fingerprintStream` sees `0.05` become `50` — the safe direction (one render too many, never one too few), and normalizing the hash to seconds would cost more than it's worth.

Every grafia converts, and that used to be false. Before PGE #234 the engine's `is_envelope_like` was **narrower than its own builder**: a list of only dict breakpoints or only 3-tuples was not envelope-like, so `scale_raw_param_values` left it alone and the engine read it in seconds whatever unit was declared. The UI mirrored that quirk with an `isEngineEnvelopeLike` gate, and derived a per-curve axis unit from it. The engine now scales every form its builder accepts (and stopped dropping the per-point interp inside a compact block), so the gate, the per-curve unit and the Inspector's warning row are gone — about 140 lines whose only job was to copy a defect. `deviation-probability.js` lost the matching `dictBPOk` parameter for the same reason. **If a future engine change re-narrows that predicate, this is the code that has to come back.**

Discrete-domain parameters (`grain.read_direction`): engine bounds are `-1`/`+1` but the domain is the **set** `{-1, +1}` — the engine rejects `0` at parse time. Every place the UI *computes* a y must **snap to the sign**, not clamp to the range. `snapDirection`/`snapForDomain` in `envelope-utils.js` are the single source; the envelope entry carries `domain: "direction"`. Interpolation is `step`, imposed and implicit; the editor hides the interp selectors. The two direction keys (`grain.reverse`, `grain.read_direction`) are an exclusive group the engine refuses (not resolves by priority) — both are kept in state and re-emitted so the author's mistake is visible; the Inspector flags the pair. Absence is preserved: with neither key present the engine uses `auto` mode.

**If you add a UI clamp, add its fallback in `yaml-bridge.js` and a mapping in `bounds.js`.**

### Fingerprint parity

The backend computes per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over canonical JSON with recursively sorted keys) ignores `color/mute/solo/onset` plus `durationImplicit/durationUnresolved/deviationProbabilityLegacy`. Key non-obvious exclusions:

- `onset`: moving a clip on the timeline doesn't change the rendered audio.
- `duration*` flags: provenance of the length, not the length itself.
- `deviationProbabilityLegacy`: provenance (which spelling), not content — reopening a pre-v7 project shouldn't mark every stem stale.

The fresh/stale/never *classification* lives in `render-status.js` (`window.PGERenderStatus`, node-tested). **If you change what affects the hash on one side, mirror it on the other or stems will read stale.**

### YAML round-trip (`yaml-bridge.js`)

Editor in-memory shape is camelCase JS with **parallel scalar/envelope fields** (e.g. `density` + `densityEnv` — exactly one non-null). YAML on disk is snake_case with a **single field** (scalar or envelope). `parse()` and `serialize()` translate. Unknown stream keys are preserved under `_extra`; unknown keys inside `pointer`/`grain`/`pitch`/`voices` under `<block>._extra`.

`deviation_probability: null` (implicit 1% mode, distinct from key-absent = off) is stored as `window.PGEYaml.DEVIATION_PROB_IMPLICIT` and serialized back to `null`.

**`dephase` → `deviation_probability` migration** (PGE #204 renamed without a back-compat alias): `parse()` reads either spelling into `deviationProbability`; `serialize()` only ever writes the current one. The parse also emits `deviationProbabilityLegacy: true` when the value came from the dead key. `app.jsx` clears the flag via `clearDeviationProbabilityLegacy` at both write sites (save and render) through `_setDataRaw` (not an undo step). `mergeDeviationProbabilityLegacy(parsed, live)` in the bridge handles the Raw tab's OR logic (one copy, node-tested). The flag is out of the fingerprint (`FP_IGNORE`) and out of `roundTripDiff` (`IGNORE_FIELDS`) — it legitimately changes across the round trip.

Stream `duration` is **optional** (PGE #205): absent or `null` means "as long as the sample". `parse(text, {samples})` and `parseStream(text, idx, {samples})` both need the sample list. Provenance flags: `durationImplicit` (serializer omits the key) and `durationUnresolved` (sample length unknown — uses `IMPLICIT_DURATION_FALLBACK`). `applyStreamPatch` clears `durationImplicit` when a patch sets `duration`, unless the patch carries its own flag.

**Resolution is not only parse-time:**
- Media list arrives late → `onProjectSelect` reads from `mediaFilesRef` (not the render closure), and an effect keyed on `mediaList.path/files` calls `resolveImplicitDurations(data, files)`. Goes through `_setDataRaw` (no dirty flag, no undo step). Gate is `path !== null`, not `!loading`.
- Sample changes → `applyStreamPatch(stream, patch, {samples})` re-resolves inherited duration.

The EnvelopeEditor Y window auto-fits point values (`computeYFit` in `envelope-utils.js`, node-tested): fits min..max + 10% margin, clamped into `[hardMin,hardMax]`. Frozen during drag (a `useRef` snapshot) so the grabbed point can't slide under a rescaling axis.

### Audio playback (`audio-engine.js`)

`window.PGEAudio.engine` is the master clock — visual playhead reads `engine.currentTime`, not its own `requestAnimationFrame` counter. The clock is **latency-compensated**: `scheduleStreams` anchors `startedAtCtx` a small `START_LEAD_SEC` into the future; `currentTime` subtracts `outputLatency` (falling back to `baseLatency`), clamping to the start position during the lead.

Render output format is a Settings preference (`tweaks.outputFormat`, **default `wav`**, also `aiff`/`flac`), forwarded as `--format`. `stemUrl` routes playback by format: `wav`/`flac` → `GET /output/<basename>__<sid>.<ext>` (browsers decode natively); `aiff` → `GET /audio/<basename>__<sid>.aif`, which `server.py` transcodes to WAV via sox (Firefox can't decode AIFF natively). With default WAV, playback needs no sox.

Streams without a rendered stem stay silent but **never silently**: a missing/undecodable stem fires `pge-audio-error` (once per stream per schedule), logged and surfaced as a toast. Without that, a 404 stem is indistinguishable from a quiet one because `canplay` simply never fires. Teardown marks the node dead **before** clearing `el.src` (clearing it fires `error` on the element).

The pure clock math (`audiblePosition`, `playAt`) is exposed as `window.PGEAudioClock`, node-tested in `test-audio-clock.js`.

### Stream identity (`allocStreamIds`, the stem index)

A stream's id is the stem filename (`<basename>__<id>.<ext>`) and the key of the engine's cache manifest. It must **never be recycled**. `allocStreamIds` in `yaml-bridge.js` (node-tested) takes an `isTaken` oracle — `app.jsx`'s `ownsStemFor` → `backend.render.ownsStem` — so an id whose stem is still on disk is skipped. The engine's GC can't cover this: it deletes only stems absent from the YAML, and a recycled id is present again.

`deleteStream` is a **data-only** mutation. With ids that never recycle, a leftover cache entry can never be picked up by a different stream — a Ctrl+Z'd stream comes back with its cached data intact.

The stem index is keyed by **filename, extension included**:
- `hasStem(basename, id, format)`: "playable now" — format-specific.
- `ownsStem(basename, id)`: "some file still claims this id" — format-agnostic. Allocation must use this one; filtering by format would recycle an id whose other-format stem survives.

`GET /stems/<basename>` returns one entry per **file** (with its `ext`), not one per stream id.

### Tracks: a lane holds N streams (`tracks.js`)

A timeline lane is a **track**, and a track holds one or more streams. Before
#141 there was no track entity: `Timeline.jsx` mapped `streams` twice in
parallel (heads, lanes) so lane *i* was stream *i*.

The grouping is a single **top-level** `ui_tracks` key, carried in
`data._extra`:

```yaml
ui_tracks:
  - id: t1
    name: bassi
    streams: [stream1, stream4]
```

It is top-level and not a per-stream key for one reason: the stem fingerprint
is computed **per stream** and both ignore-lists are deny-lists
(`FINGERPRINT_IGNORE_KEYS` = `{solo, mute}` in the engine, `FP_IGNORE` in
`backend.js`), so a per-stream `track:` would be hashed and reorganizing lanes
would mark every touched stem stale. Top-level it rides for free:
`KNOWN_PROJECT_KEYS` doesn't know it → `_extra` → re-emitted verbatim; the
engine's `load_yaml` reads only `seed` and `streams` and never validates the
top level. Unlike `laneHeights` (localStorage) it travels with the file.

Two pure functions in `tracks.js` (`window.PGETracks`, node-tested) are the
whole contract:

- **`deriveTracks(data)`** is total and self-healing — dead ids dropped, a
  stream laid out exactly once, emptied tracks removed, unmentioned streams
  appended as singletons in file order. With the key absent it reproduces
  one-lane-per-stream exactly. Track ids and stream ids share **one** namespace
  (a singleton lane's id is its stream's), so the ids of the streams
  `ui_tracks` doesn't place are reserved *before* group ids are handed out: a
  hand-written group calling itself `stream2` gets suffixed, and the real
  stream2's lane keeps the id its `laneHeights` entry is filed under. The one
  case it can't repair is two streams sharing an id — they collapse onto one
  lane, and that's fine: a duplicate id is already fatal a layer down (stem
  filename, manifest key) and no `ui_tracks` could round-trip two lanes
  pointing at one id.
- **`applyTracks(data, tracks)`** reorders `data.streams` into visual order and
  writes `ui_tracks` **only when it says something the stream order doesn't** —
  a lane with two streams, a chosen name, an id that isn't its stream's. A
  project that never groups never grows the key; but the key is all-or-nothing,
  so **one rename or one group materializes every lane**, singletons included.
  It reuses the stream objects untouched, so **no stem goes stale**; if you ever
  make it rebuild one, the fingerprint moves with it.

That reorder of `data.streams` is audio-neutral, and only because the engine
says so: `_create_streams` iterates the list without an index and every
stochastic site draws from an RNG derived from `(seed, stream_id, component)`,
so materialization order doesn't reach the grains (`generator.py`). **If the
engine ever derives randomness from list position, every grouping gesture in
the timeline starts rewriting audio.**

Stream ids are **strings**, coerced in `streamFromYaml`: an unquoted
`stream_id: 1` parses as a number, and the id is an identity key (stem
filename, cache-manifest key, `allocStreamIds`, the `ui_tracks` lists). A
number matching nothing against its own string is silent, and here it would
drop the grouping and let the next save erase it.

A singleton track's **id is its stream id**. That is what keeps pre-#141
`laneHeights` entries applying, and what lets pulling the last clip out of a
group land back on the trivial layout instead of leaving a `t1` behind.

`app.jsx` derives `tracks` with `useMemo` and routes every layout change
through `mutateTracks`. Mute/solo do **not**: they stay per-stream because
that's what the engine filters on (`Generator._filter_solo_mute`) and what the
YAML carries. The header's M/S is a three-valued fan-out (all / some / none)
over the group; per-clip M/S buttons appear only once a lane holds more than
one clip. The header VU sums the group's analyser **powers** — there is no
summing node to read, and a visual meter doesn't justify rebuilding the audio
graph.

Clip drag moves between lanes: plain drop joins the target lane, **Alt**-drop
extracts into a new lane at that position. The drag threshold reads both axes —
a purely vertical drag leaves `onset` alone and would otherwise never start.

The lane move is gated on **vertical intent** (`verticalRef`, latched in `move`
once `|dy| >= THRESHOLD`), which also gates the lane highlight. Neither
`dstLane != null` alone nor `dstLane !== srcLane` works: the cursor never
leaves the grabbed clip's lane during an ordinary horizontal drag, so with no
gate a selection spanning two lanes silently collapses into one every time it
is moved along the time axis; and `srcLane` is the *grabbed* clip's lane, so
comparing against it swallows the real "gather them all here" gesture. Alt is
sampled the same way, in `move`, so the dashed highlight and the outcome can't
disagree.

Clips sharing a lane are placed by `onset` alone, so they can cover each other
exactly — a paste with the playhead still on the source does it every time.
A fully covered clip is unreachable (raising the *selected* one is no escape:
selecting means clicking), so each row starts `CLIP_STACK_STEP` px below the
previous, with the step shrinking to fit the lane rather than pushing the last
clip out of it. `CLIP_PAD` must stay equal to the `.clip` inset in
`editor.css`, and the child canvases size to the clip's box, not the lane's.

### History / undo (`app.jsx`)

`setData(updater)` wraps every mutation. `beginGesture()` / `endGesture()` bracket continuous interactions (drag, knob spin) so they collapse into a single undo step. Cap is 200 entries. Anything mutating `data` must go through `setData`, not `_setDataRaw`, or undo breaks.

The pure stack mechanics live in `history-core.js` (`window.PGEHistoryCore`, node-tested). `app.jsx` keeps the React glue — state, historyRef, keyboard shortcuts, freeze-on-resize confirm inside `endGesture`.

## File layout & load order (matters)

Sources live under `src/lib/` (`.js` logic — `window.*` globals, no modules), `src/components/` (`.jsx` UI), and `styles/` (`.css`). `PGE Editor.html` and the Python bridge (`server.py` + helpers) stay in the repo root. `server.py` serves the editor and these subdirectories via its static catch-all.

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `src/lib/yaml-bridge.js` → `src/lib/bounds.js` → `src/lib/envelope-loops.js` → `src/lib/deviation-probability.js` → `src/lib/envelope-utils.js` → `src/lib/backend.js` → `src/lib/audio-engine.js` → `src/lib/grain-map.js` → `src/lib/render-status.js` → `src/lib/history-core.js` → `src/lib/tracks.js` → `src/lib/tweaks-store.js` → `src/lib/magnify-spec.js` → JSX files (`src/components/*.jsx`) → `src/components/app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`).

## Conventions

- Stem filenames: `<basename>__<streamId>.<ext>` (double underscore separator); `<ext>` follows the Settings output format (`tweaks.outputFormat`, default `wav` → `.wav`; `aiff` → `.aif`, `flac` → `.flac`).
- Cache manifests: `cache/<basename>.json`, one file per project. Keyed by the YAML basename — `/render` writes the editor state to the stable `configs/<basename>.yml` (never a temp file) so the manifest persists across renders and incremental caching works.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
