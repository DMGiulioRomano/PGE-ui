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
make tests            # full suite: tests-node + tests-python + tests-parity (if the engine is there)
make tests-parity     # only the JS↔engine parity suites
```

`make tests` runs three parts (the third only when the sibling engine checkout
exists):

- **`make tests-node`** (node, no deps beyond npm) — `tests/node/test-yaml-bridge.js`
  (YAML round-trip fidelity incl. `serializeStream`/`parseStream`, with the real
  engine `configs/*.yml` as fixtures when present), `test-envelope-utils.js`
  (rescale/truncate/slice math — the last one is the split's tail half), `test-fingerprint.js` (fingerprint parity: which
  fields mark a stem stale), `test-render-status.js` (the stale/fresh/never
  classification + render summary, incl. the engine-semantics axis and source
  guards on the chain that carries the version from the engine to the dot), `test-history-core.js` (undo/redo stack
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
  reuses an id that still owns a stem, plus source guards on its three call sites
  and on `deleteStream` staying a data-only mutation), and `test-stem-index.js`
  (the `hasStem`/`ownsStem` split over the format-keyed stem index, plus source
  guards on the audio-error path), and `test-semantics-store.js` (where the two
  numbers of the semantics axis come from: `semanticsVersion` re-reading the
  bridge, and a whole `render.run()` writing/reading `pge-local-sem` — the real
  backend driven with a fake `fetch` and `localStorage`), and
  `test-suite-harness.js` (the suite's own
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
- **`make tests-parity`** (node + python, needs the engine checkout) — the
  suites in `tests/parity/`, which ask the **engine itself** the questions the
  mirrors in `src/lib/` answer from memory. See "Parity harness" below and
  `tests/parity/README.md`. The parity suites don't own their
  verdict (`harness.js` does, for all five), but `test-suite-harness.js` still
  guards them against taking it back with a brutal exit.

CI runs all of it on push and PR (`.github/workflows/ci.yml`). The python job
checks out the sibling engine and builds its venv. The node job checks it out
too, for the fixture-dependent parts and for `make tests-parity` (which needs no
engine venv at all), so both run on a PR: a `configs/` change in
`PythonGranularEngine` can turn PGE-ui CI red on purpose (the #131 canary), and
so can a change to any surface the parity suites pin. The
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
running it, and every suite file, by source guard. `harness.js` has one branch a
`tests/node` suite doesn't: *entered the cases and never reached the summary*.
That one exits 1 **unconditionally** — a partial summary is not a pass — and
lists the cases that never finished; before, it raised the code only if it had
already counted a failure, so a suite whose second case hung printed
`1 passed, 0 failed` and exited 0. `test-suite-harness.js` drives the real
runner for it (fake oracle in the require cache, a fake engine root), so the
probe needs no sibling checkout.

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
- **Lens SPEC** → filtered *client-side* (`src/lib/magnify-spec.js`, node-tested) because it's free text typed in the render popover and the useful error moment is while typing. The grammar mirrors Python's `float()`, not JS's `Number()` — they disagree on `0x10`, `1_000`, `inf` — and the strip is ASCII-only, a subset of Python's `str.strip()`, so the residual divergence is guaranteed safe-direction (JS `trim()` eats U+FEFF, `str.strip()` doesn't — that one killed renders). `tests/parity/test-magnify-parity.js` checks the whole corpus against the engine.

  **`error()` and `sendable()` answer different questions, and both live in the module.** `error(spec)` is the red text under the field; `sendable(spec)` returns *the bytes that reach argv*, or `null` when the flag must not be sent at all (empty SPEC, separators only, bad grammar). `app.jsx` and `RenderButton.buildCommand` both call `sendable` — when the gate was a copy in `app.jsx` it stayed on `.trim()` while the module moved to the ASCII strip, and the popover showed red on a SPEC that then went out cleaned. The tests call it too, so removing the empty-SPEC guard is red instead of silent.

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

**Compact block time distribution** overflow (`{type: geometric, ratio: 10, n_reps: 400}`): `timeDistError(dist, nReps)` in `envelope-utils.js` checks on logarithms. Thresholds model Python **integer** semantics (more permissive) and are re-derived from the running engine on every parity run (`tests/parity/test-time-dist-parity.js` bisects for the first rejected `n_reps` on both sides); the constants in `test-time-dist.js` are the transcript of an older run of the same question. There is an at-most-one-value band where the engine overflows and the UI stays quiet — always the safe direction, and zero wide on the probes where the integer and float thresholds land on the same `n_reps` (the parity suite caps it per probe and requires it to still exist somewhere in the corpus). `computeCycleDurations` has an output net: if durations aren't all finite or don't sum to `T`, it falls back to equal cycles and marks the array `previewFallback`. The warn text must NOT claim what the engine will do in the band — only "drawn durations are not the block's".

### Dynamic parameter bounds

`GET /bounds` in `server.py` **AST-parses** the engine's `parameter_definitions.py` (`GRANULAR_PARAMETERS`) and `pitch_unit.py` under `src/pge/parameters/` (falling back to pre-#162 flat `src/parameters/`). Returns `{}` for an engine without those files. `backend.js` `bounds()` fetches it; `app.jsx` calls `window.PGEBounds.apply()` at boot. `bounds.js` (`mergeEngineBounds`, node-tested) folds the engine payload onto `window.PGE_BOUNDS` via `ENGINE_PARAM_MAP` — which says, per UI key, the engine param and whether it reads `min_val/max_val` or `min_range/max_range`. `window.PGE_BOUNDS` in `yaml-bridge.js` is the **static fallback** (used on `file://` / server down).

A `null` engine `max_val` keeps the static fallback cap — except the `loop_*` trio, whose `max_val` is `null` because the real cap is the **chosen sample's duration**. `loopEnvMax` in `envelope-utils.js` drives the EnvelopeEditor `hardMax` + Inspector scalar clamp from that duration, unit-aware (`loop_unit || time_mode`: seconds → `sample_dur`, normalized → `1`), falling back to the static cap only when the duration is unknown.

Loop-window semantics: with a loop active the engine confines the grain read position to `[loop_start, loop_end)` via modular wrap. A loop straddling the file end is expressible **only** via `loop_dur` (`loop_start + loop_dur > sample_dur`); `loop_end` stays bound to `[0, sample_dur]`. `loopBoundsError` in `envelope-utils.js` mirrors the static degenerate-window check (`loop_end <= loop_start`).

`loopUnitInfo` in `envelope-utils.js` returns the unit **and** its provenance (`loop_unit` / `time_mode` / `default`). Picking the inherited unit deletes the key rather than materializing a redundant one — absence is the "inherit" state. Switching the unit re-clamps scalar endpoints; envelope endpoints are per-grain and exempt.

`grain.duration_unit` (`seconds | samples | milliseconds`, PGE #158 then #171) is the same shape of problem one level down: the engine's `grain_duration` bounds are in **seconds**, the YAML values are in the declared unit. `grainUnitFactor` / `grainUnitBounds` / `grainDefaultDuration` / `grainUnitSuffix` in `envelope-utils.js` are the single source — bounds, the `0.05` s default and the row suffix expressed in the unit in force (in ms the cap is `10000`, not `10`); they drive the EnvelopeEditor `hardMin/hardMax` + vis window and the seed of the scalar↔env toggle. Changing the unit goes through `convertGrainDurationUnit`, which **converts** `duration`/`duration_range` — scalars and envelopes, every form `Envelope._scale_raw_values_y` scales — instead of letting the old number be reinterpreted in the new scale, then re-clamps the scalars (envelope points need no clamp: bounds scale by the same factor). An unknown unit converts nothing and gets no suffix. The key is deleted only for `seconds` — absence *is* seconds. One asymmetry is deliberate: changing the unit **does** mark the stem stale even though the rendered audio is identical, because `fingerprintStream` sees `0.05` become `50` — the safe direction (one render too many, never one too few), and normalizing the hash to seconds would cost more than it's worth.

Every grafia converts, and that used to be false. Before PGE #234 the engine's `is_envelope_like` was **narrower than its own builder**: a list of only dict breakpoints or only 3-tuples was not envelope-like, so `scale_raw_param_values` left it alone and the engine read it in seconds whatever unit was declared. The UI mirrored that quirk with an `isEngineEnvelopeLike` gate, and derived a per-curve axis unit from it. The engine now scales every form its builder accepts (and stopped dropping the per-point interp inside a compact block), so the gate, the per-curve unit and the Inspector's warning row are gone — about 140 lines whose only job was to copy a defect. `deviation-probability.js` lost the matching `dictBPOk` parameter for the same reason. **If a future engine change re-narrows that predicate, this is the code that has to come back.**

Discrete-domain parameters (`grain.read_direction`): engine bounds are `-1`/`+1` but the domain is the **set** `{-1, +1}` — the engine rejects `0` at parse time. Every place the UI *computes* a y must **snap to the sign**, not clamp to the range. `snapDirection`/`snapForDomain` in `envelope-utils.js` are the single source; the envelope entry carries `domain: "direction"`. Interpolation is `step`, imposed and implicit; the editor hides the interp selectors. The two direction keys (`grain.reverse`, `grain.read_direction`) are an exclusive group the engine refuses (not resolves by priority) — both are kept in state and re-emitted so the author's mistake is visible; the Inspector flags the pair. Absence is preserved: with neither key present the engine uses `auto` mode.

**If you add a UI clamp, add its fallback in `yaml-bridge.js` and a mapping in `bounds.js`.** `tests/parity/test-bounds-parity.js` checks the AST read against the imported registry, that every `ENGINE_PARAM_MAP` entry names a parameter that exists, and that the static fallback never admits a value the engine rejects.

### Parity harness (`tests/parity/`)

Everything in the two sections that follow — and the bounds, magnify-spec,
deviation-probability and time-distribution mirrors above — is a **parity pact**
with the engine. Those pacts used to live only in prose. They are now executable:
`tests/parity/engine_oracle.py` imports the engine and answers JSON lines
(`fingerprint` — optionally with the semantics version swapped, to ask whether
it is really in the hash — `parse_magnify_spec`,
`classify_deviation_probability`, `build_time_distribution`,
`parameter_bounds`, `constants`);
`tests/parity/oracle.js` is the node client (one python process per suite);
`tests/parity/harness.js` runs the suites and, crucially, **counts and names the
cases that did not run** when the engine is absent — a skipped parity case is a
failure under `PGE_PARITY_STRICT=1` and in CI when the engine is present.

Two rules when touching it:

- **The oracle imports from the engine, it never reimplements it.** A copy would
  be a third mirror to keep aligned. The one exception is the `--magnify-at`
  grammar, which lives in `pge.cli` (unimportable without numpy/soundfile/
  matplotlib): the oracle extracts those AST nodes from `cli.py` and executes
  them — the engine's own bytes.
- **No op may need the engine venv.** The CI node job checks the engine out but
  builds no venv, and that is where parity runs. Verified module by module; if
  you add an op that drags in numpy, it will silently stop running there.

Deliberate divergences are listed in `tests/parity/README.md` **and asserted by
the suites**, so a divergence that disappears makes a test speak instead of
leaving a stale comment. The README also records the engine commit the pacts
were written against — the datum that tells "we broke it" from "the engine moved".

Engine-source introspection (`engine_introspect.py`) was split out of
`server.py` for this: it AST-parses the engine with the stdlib alone, so both the
bridge and the oracle can use it. It reads the envelope keys, the parameter
bounds and `VARIATION_SEMANTICS_VERSION`; each returns an empty/`None` result for
an engine that doesn't have the thing, and every caller must treat that as "don't
know", never as a value.

### Split at the playhead (`splitAtPlayhead` in `app.jsx`)

Reaper's S key, rebindable (`tweaks.shortcutSplit`, default `d`). Every selected
clip the playhead crosses becomes two streams, in one undo step. The head keeps
the original id (its stem goes stale by itself — the duration moved); the tail
gets a fresh id from `allocStreamIds` and lands in the head's lane via
`addStreamToTrackOf`.

The two halves fail in two different ways, and each has its own guard:

- **The head is always frozen**, whatever the Inspector's padlock says:
  `truncateStreamEnvelopes(rescaleStreamEnvelopes(...))`, so breakpoints keep
  their absolute time. A stretch would re-proportion the curves and the cut
  would stop being a cut.
- **The tail must resume reading the sample where the head stopped**, and that
  position is the engine's, not ours: it is the `ptr` of the grain sidecar, the
  same number the hover readout shows as `Read` (`readPositionAt` in
  `grain-map.js`). With no sidecar there is nothing to inherit, so **the split
  refuses** rather than inventing a `pointer.start`. With `pointer.offset_range`
  declared the position is a median estimate (`exact:false`) — split proceeds,
  with a toast saying so.

`pointer.start` is written in the unit in force (`loopUnitInfo`:
`pointer.loop_unit || time_mode`). Every stream the editor creates is born
`time_mode: normalized`, where `start` lives in `[0,1]` of the sample — writing
seconds there would send it off the end of the file. Normalized with an unknown
sample duration is the third refusal.

**`rescaleEnvArray` deliberately does not clamp x to 1** (and that clamp was a
bug, not a safety net): it ate exactly the information `truncateEnvArray` needs.
Shortening a stream with freeze on, every breakpoint past the new end used to
land on x=1 — `[[0,0],[0.5,1],[1,0]]` at ratio 2 became `[[0,0],[1,1],[1,0]]` —
indistinguishable from an envelope that genuinely ends there, so truncate kept
the pile instead of dropping the tail and interpolating one closing point. An
x > 1 is a **transient** state that lives between rescale and truncate (i.e.
inside a resize gesture); every commit path goes through `truncateEnvArray` or
`sliceEnvArray`. This fixed the split's head and the freeze-on-resize drag at
once — they are the same code.

The one y these functions *compute* rather than copy (the closing point of a
truncate, the opening point of a slice) goes through `boundaryY`, which reads
the interp tag of the **previous** point — the tag governs the *outgoing*
segment (`expandMixed` in `envelope-loops.js`), so on a `step` the value is held
instead of interpolated into a jump the envelope never had. `cubic` stays linear
there: real PCHIP needs the points beyond the segment and would misdraw the
surviving half anyway; the error is one point wide.

`sliceStreamEnvelopes` / `sliceEnvArray` in `envelope-utils.js` (node-tested)
are the tail's half of the freeze math: `x' = (x - cut) / (1 - cut)`, with an
interpolated breakpoint at `x'=0` so the value at the cut doesn't jump, and the
held last value when nothing survives the cut (the engine rejects an empty
envelope). `snapForDomain` applies there too — that interpolated point is a
*computed* y, and on `read_direction` an unsnapped one is a parse error.
**Compact blocks are out of scope**: cutting a `{type, ratio, n_reps}` block in
half isn't defined, so `sliceEnvArray` returns `null` on an array holding one,
the field is left verbatim, and the count comes back as `skipped` for the toast.

### Fingerprint parity

The backend computes per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over canonical JSON with recursively sorted keys) ignores `color/mute/solo/onset` plus `durationImplicit/durationUnresolved/deviationProbabilityLegacy`. Key non-obvious exclusions:

- `onset`: moving a clip on the timeline doesn't change the rendered audio.
- `duration*` flags: provenance of the length, not the length itself.
- `deviationProbabilityLegacy`: provenance (which spelling), not content — reopening a pre-v7 project shouldn't mark every stem stale.

The fresh/stale/never *classification* lives in `render-status.js` (`window.PGERenderStatus`, node-tested). **If you change what affects the hash on one side, mirror it on the other or stems will read stale.** `tests/parity/test-fingerprint-parity.js` enforces it: the two hashes differ by construction, but their *derivative* (which edits move them) must agree, `onset` excepted.

**Staleness has a second axis, and it is not in the hash.** The engine's
`VARIATION_SEMANTICS_VERSION` (`stream_cache_manager.py`) says *how* it reads
the YAML; it sits inside the engine's fingerprint, so a bump marks every stem of
every project dirty at rest. The UI hash deliberately has no counterpart — the
two hashes answer different questions ("did the user edit this" vs "must the
engine redo this stem") — but the *dot* answers the engine's, and at the 2→3 bump
(PGE #222) it showed 🟢 on stems the engine was about to rewrite. So the version
is a second axis beside the hash, never a field inside it: `staleReason` in
`render-status.js` returns `"yaml"` or `"semantics"`, the version is recorded
per stream next to the fingerprints (`loadSemantics` / `_persistSem` in
`backend.js`, localStorage key `pge-local-sem`), and it comes from the engine via
`GET /semantics-version` → `engine_introspect.engine_semantics_version` (AST, no
engine import).

**The engine's number is re-read, never remembered for the session.** It is a
property of the sibling checkout, not of the editor's session: a `git checkout`
or a pull next door changes it while the page stays open, and a cell memoized
for the session turns that into 🟢 on stems the engine will redo differently,
until a reload. So freshness lives in the callers: `refreshEngineSem` (app.jsx —
boot, project change, render start) asks `semanticsVersion({refresh: true})`;
`run()` reads the cell without the flag. That split is also what keeps **one**
render coherent: a re-read stores exactly what it returns — the failure `null`
included — so the ref app.jsx fills before starting and the number `backend.js`
records at the end cannot be two different answers. It is the same decision
`engine_introspect` takes one level down (mtime invalidation, pinned by
`test_engine_semantics_version_sees_a_live_bump`).

Two rules hold it up:

- **The two unknowns are not the same unknown**, and the difference is whether
  the yellow could ever clear. *Engine* unknown (bridge down, engine without the
  constant) claims nothing — `_persistSem` only writes when the number is known,
  so that yellow would be **permanent** on perfect stems. A *stem* with no
  recorded version and a known engine reads `stale`: that's every stem written
  before the axis existed — a stem written by an engine whose reading we don't
  know. The rule needs no number, and must not carry one: transcribing it here
  would put back the engine constant `ATTESA` already put in this repo once.
  That yellow clears itself on the first pass,
  even an empty one — the engine emits `stream-done` for the streams it skips
  (`cached: true`) and `backend.js` records the version on that event like a
  real render. One render too many, never one too few.
- **The number is never transcribed into this repo.** It used to be, as a canary
  (`ATTESA` in `test-fingerprint-parity.js`); with the UI reading it for itself
  the transcription became the very mirror the parity folder exists to close.
  The suite now pins the two facts the design rests on instead: the bridge's AST
  read equals the imported constant, and that constant really is inside the
  engine's hash.

A stale-by-semantics dot carries its own tooltip; the state stays `stale` so
nothing downstream needs a new case.

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

**A clip's waveform is drawn in time, not stretched to the clip.** Peaks (and
the spectrogram grid) cover the whole stem *on disk*, whose length stops
matching the clip's the moment an edit shortens the stream without a re-render —
a split, a resize. Mapped onto the clip's width, half a clip showed the entire
waveform squeezed into it, which reads as a broken redraw rather than as a stem
to regenerate. `GET /stems/<basename>` therefore carries `dur` per file
(`audio_duration`, a header-only read), `backend.render.stemDur(basename, id)`
serves it format-agnostically like `ownsStem`, and `ClipWaveform` /
`ClipSpectrogram` take a `span` = stem duration / clip duration: the excess
falls outside the clip, the missing tail stays flat, and the 🟡 dot says the
rest. `span` defaults to 1 when the duration is unknown — which is also the
truth right after a render, so `_markStemFresh` **drops** the cached duration
when a stem is rewritten (keeping the old one would be worse than having none:
it would crop the drawing to the previous length).

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
  stream laid out exactly once, unmentioned streams appended as singletons in
  file order. With the key absent it reproduces one-lane-per-stream exactly.
  Track ids and stream ids share **one** namespace
  (a singleton lane's id is its stream's), so the ids of the streams
  `ui_tracks` doesn't place are reserved *before* group ids are handed out: a
  hand-written group calling itself `stream2` gets suffixed, and the real
  stream2's lane keeps the id its `laneHeights` entry is filed under. The one
  case it can't repair is two streams sharing an id — they collapse onto one
  lane, and that's fine: a duplicate id is already fatal a layer down (stem
  filename, manifest key) and no `ui_tracks` could round-trip two lanes
  pointing at one id.
  An **empty lane is kept**: a track is an entity of its own, like a DAW track —
  `addTrack` creates one with no stream behind it, a move or a delete that
  empties a lane leaves it standing, and only `removeTrack` (the × on an empty
  header, refused on a lane that still holds clips) takes one away. Cost of that
  rule: group-then-ungroup no longer returns to the trivial layout, because the
  extracted lane can't reclaim its stream id while the empty source lane still
  holds it.
- **`applyTracks(data, tracks)`** reorders `data.streams` into visual order and
  writes `ui_tracks` **only when it says something the stream order doesn't** —
  a lane with two streams, an empty lane, a chosen name, an id that isn't its
  stream's. A project that never groups never grows the key; but the key is
  all-or-nothing,
  so **one rename or one group materializes every lane**, singletons included.
  It reuses the stream objects untouched, so **no stem goes stale**; if you ever
  make it rebuild one, the fingerprint moves with it.

That reorder has a cost on the React side, and it bit: **no effect may depend
on the identity of `data.streams`**. State is immutable, so every gesture that
recomposes the list produces a new array even when not one value changed, and
`applyTracks` recomposes it on every move between lanes. The three effects that
load per-stream media (peaks, spectrograms, grain sidecars) used to list
`data.streams` among their deps and so reloaded *every* stem on every lane
gesture, each reload calling `setState` — the engine of a render loop that
locked the page up (Firefox's "stop script", the stack pinned inside
`createElement`). They now key on `streamMediaKey`, a string of
`id:duration:sample` — `onset` deliberately left out, moving a clip in time does
not touch its audio — and their `setState`s bail out when the value is already
there. `resolveImplicitDurations` follows the same rule: it reuses
`data.streams` when it resolved nothing. The idiom was already in the file (the
mute/solo and onset/duration effects key on a string); the media effects were
the ones that had not been converted.

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

**Paste picks its lane from `_srcId`**, stamped on the clipboard at copy time
together with `_srcProject`: the copy joins the lane its original sits in, with
no similarity heuristic. When `_srcId` doesn't resolve, `addStreamToTrackOf`
opens a lane at the end — which is what paste did before tracks existed. Two
callers lean on that fallback instead of a special case: the source was deleted
while it sat in the clipboard, and the clipboard came from another project
(there `null` is passed outright — the clipboard deliberately outlives a project
switch, and default ids repeat across files, so a namesake would be the wrong
lane). `renameStream` rewrites a pending `_srcId` for the same reason: it has to
keep naming the same stream.

**Renaming a stream** (`renameStream` in `app.jsx`, `renameStreamId` in
`tracks.js`) is an identity change, not a patch, so it does not go through
`updateStream`. The lane id *and* a still-default lane name follow the stream —
that is what keeps `isTrivial` true, so a plain rename on an ungrouped project
writes no `ui_tracks` at all; a lane the user actually named keeps its name.
Three refusals, all at the trust boundary: a charset (the id becomes a filename
and a path segment), a live stream already holding the name, and `ownsStemFor`
— a stem still on disk under that name would be picked up as the renamed
stream's audio, the same hazard `allocStreamIds` guards against.

**The sound is deliberately not preserved.** `rng_id = rng_group or stream_id`
(engine `shared/seeding.py`, and every seeding site goes through it), so a
renamed stream reseeds and draws different grains. Writing
`rng_group: <old id>` would pin it bit-for-bit — the option was weighed and
declined: it makes the YAML carry the old name forever and makes `rng_group`
mean "renamed" instead of "shares an RNG". The id is hashed on both sides, so
the stem goes stale by itself and the 🟡 dot is the whole warning. (With no
top-level `seed` the point is moot anyway: `voice_rng` falls back to
`hash(stream_id + …)`, which Python randomizes per process.)

`app.jsx` derives `tracks` with `useMemo` and routes every layout change
through `mutateTracks`. Mute/solo do **not**: they stay per-stream because
that's what the engine filters on (`Generator._filter_solo_mute`) and what the
YAML carries. The header's M/S is a three-valued fan-out (all / some / none)
over the group; per-clip M/S buttons appear only once a lane holds more than
one clip. The header VU sums the group's analyser **powers** — there is no
summing node to read, and a visual meter doesn't justify rebuilding the audio
graph.

Clicking a **track header selects the lane** (`selectedTrackId` in `app.jsx`),
not only its clips: it is the only handle on an empty lane, and it is what tells
Delete "remove this track, with everything on it" (`deleteTrack`, one `setData`
= one undo step) from "remove this clip" (`deleteStream`). Clicking a clip, a
marquee or a range drops it; Ctrl-click on a header stays a plain multi-clip
toggle. The Delete branch is gated on `defaultPrevented` alone — the
EnvelopeEditor calls `preventDefault` only when a breakpoint or a loop really is
selected, so its own Delete still wins there.

Clip drag moves between lanes, and a vertical drag is a **lane delta, not a
destination** — the DAW rule. `dstIdx` is where the *anchor* (the grabbed clip,
`opts.anchor`) lands; every other selected clip keeps its offset from it, so a
selection spanning two lanes never collapses onto one. The clamp is one-sided:
upward the drag stops when the **highest** selected clip reaches lane 0 (hence
`topLane` in `Timeline.jsx`, over the whole selection, and the same clamp again
inside `moveStreams` — the pure function does not trust its caller); downward
the layout **grows**, `moveStreams` appending empty lanes until the lowest clip
has one, the way a DAW creates tracks under a drag. Undo takes them away with
the rest of the gesture for free: the lanes live in `ui_tracks` inside
`data._extra`, the whole `data` is the history snapshot, and the drag is
bracketed by `beginGesture`/`endGesture`, so onset and layout come back
together in one step.

**Alt**-drop is the exception, and stays a destination: everything extracts into
one new lane at that position. The drag threshold reads both axes — a purely
vertical drag leaves `onset` alone and would otherwise never start.

Because the drop creates lanes, the preview has to be able to point at lanes
that do not exist yet: `laneIndexAtY(y, overflow)` keeps counting past the
bottom, and `laneTracks` appends **phantom** lanes (`__new<i>`, `phantom: true`)
for the duration of the drag so the ghost, the highlight and the preview clip
all land somewhere visible. Per-clip destinations come from `dstLaneOf(id)`;
under Alt it collapses to the single target lane.

The lane move is gated on **vertical intent** (`verticalRef`, latched in `move`
once `|dy| >= THRESHOLD`), which also gates the lane highlight. Neither
`dstLane != null` alone nor `dstLane !== srcLane` works: the cursor never
leaves the grabbed clip's lane during an ordinary horizontal drag, so with no
gate a selection spanning two lanes would move vertically every time it is
dragged along the time axis; and `srcLane` is the *grabbed* clip's lane, so
comparing against it swallows a real move whose anchor happens to come back to
its own row (the rest of the selection having been clamped at the ceiling). Alt
is sampled the same way, in `move`, so the dashed highlight and the outcome
can't disagree.

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

Sources live under `src/lib/` (`.js` logic — `window.*` globals, no modules), `src/components/` (`.jsx` UI), and `styles/` (`.css`). `PGE Editor.html` and the Python bridge (`server.py` + helpers: `audio_pipeline.py`, `render_pipeline.py`, `engine_introspect.py`) stay in the repo root. `server.py` serves the editor and these subdirectories via its static catch-all.

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `src/lib/yaml-bridge.js` → `src/lib/bounds.js` → `src/lib/envelope-loops.js` → `src/lib/deviation-probability.js` → `src/lib/envelope-utils.js` → `src/lib/backend.js` → `src/lib/audio-engine.js` → `src/lib/grain-map.js` → `src/lib/render-status.js` → `src/lib/history-core.js` → `src/lib/tracks.js` → `src/lib/tweaks-store.js` → `src/lib/magnify-spec.js` → JSX files (`src/components/*.jsx`) → `src/components/app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`).

## Conventions

- Stem filenames: `<basename>__<streamId>.<ext>` (double underscore separator); `<ext>` follows the Settings output format (`tweaks.outputFormat`, default `wav` → `.wav`; `aiff` → `.aif`, `flac` → `.flac`).
- Cache manifests: `cache/<basename>.json`, one file per project. Keyed by the YAML basename — `/render` writes the editor state to the stable `configs/<basename>.yml` (never a temp file) so the manifest persists across renders and incremental caching works.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
