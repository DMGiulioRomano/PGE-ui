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
  guards on the audio-error path).
- **`make tests-python`** (pytest) — `test_render_pipeline.py`
  (`parse_render_line` events, `build_render_command` flags, the kill/watchdog,
  and a Flask `make_app` smoke test via `test_client`), `test_audio_pipeline.py`
  (path/security helpers), `test_yaml_structure.py`, and `test_engine_render.py`
  (an engine render smoke test that skips when the sibling engine checkout/venv
  is absent).

CI runs both on push and PR (`.github/workflows/ci.yml`). The python job checks
out the sibling engine and builds its venv, so the engine-dependent
`test_engine_render` runs there too — it only skips when the engine checkout is
absent (e.g. locally). The **node** job checks it out too, so the parts of the
suite that read the engine's real `configs/` run on a PR instead of skipping —
which buys a deliberate cross-repo coupling: a commit in `PythonGranularEngine`
that touches `configs/` can turn PGE-ui's CI red, and that is the point, since
the #131 canary exists to notice that those fixtures have stopped exercising
`deviation_probability`. The same coupling makes the assertion count
engine-dependent: a config added or removed upstream moves it by three (the
corpus asserts three per file), so a local total that differs from CI's is that,
not a lost test. There is no linter or typechecker, and the React UI itself has
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

### YAML bodies that can kill a render

Two engine failures the UI mirrors client-side, because in both the engine used
to accept the body and now refuses it (PGE #209 / #212, PGE-ui issue #123).

`deviation_probability` with a body that will not build as an envelope — `[]`,
a list with no breakpoint, a dict whose `points` is missing or unusable, either
globally or under a per-param key — used to be silenced into an `AlwaysGate`:
the render succeeded applying the deviation to **100%** of the grains, the
opposite of what was written. It now raises and the render exits.
`window.PGEDeviationProb.error` (`src/lib/deviation-probability.js`,
node-tested) is the mirror, and the Inspector shows it right below the mode
selector.
It is deliberately the **conservative half** of the engine's builder: it flags
only bodies that cannot be an envelope in any reading, so a mixed
`[[0,1], 'x']` passes here and is caught by the engine — an alert fewer, never
one on a YAML that renders. The two forms where the body *is* the group or the
block (a bare BP group, a bare compact block) are tried on the whole array
before its elements, exactly as `is_envelope_like` does, or they would be
flagged on a YAML that renders.

A breakpoint can also be written as a **dict** `{t, v, type?}`: the engine's
builder normalizes it into `[t, v, type?]` before looking at it
(`envelope_builder.py`), so it is a first-class form, not a leftover. `PGEEnv.isBreakpoint`
does not see it (it requires an array) and must not be widened — the
EnvelopeEditor uses it to decide what is draggable, and the canvas does not draw
dict breakpoints. The predicate that accepts them is therefore local to
`deviation-probability.js`, and it is applied **only where the engine
normalizes**: inside `points:` and under a per-param key. A *bare* list of only
dicts at the global level stays flagged, because there the value first passes
`is_envelope_like`, which says False and makes the engine refuse. The asymmetry
is the engine's, and flattening it would trade four false positives for one
false negative.

The per-param key list is not the set of `deviation_probability_key` values
declared in the specs — those are two different things, and the difference is
the whole point. `PARAM_KEYS` holds the five the engine consults **always**
(`volume`, `pan`, `duration`, `pitch`, `pointer`). Three more are live but
**conditional on the `grain` block**, so they live in `liveParamKeys(stream)`:
`reverse` and `read_direction` are an exclusive group where the engine reads
exactly one (the direction written in `grain`, or `reverse` when neither is),
and `pc_rand_envelope` is live unless `grain.envelope` is a transition
(`{from, to}`) or multistate (`{states}`) spec. `error(d, stream)` takes the
stream so the Inspector gets those three; called without it, only the five are
validated — fewer alerts, never one on a YAML that renders. What is **not** in
either list is `envelope`: its spec (`grain_envelope`) is `is_smart=False`, so
it never reaches `GateFactory`: `{envelope: 50}` builds an `AlwaysGate` when
the gate is live and more than one window is declared (a list, or `all`), and a
`NeverGate` in every other case — including the transition/multistate dict,
where the gate is switched off upstream (`uses_gate`) and the window count is
two all the same. In neither does the number you wrote count — the key is
indistinguishable from an invented one.
The Inspector *offers* `pc_rand_envelope` instead, which is the param key the
`WindowController` actually asks for, but it still *shows* an `envelope` already
written in the file, marked inert: that row is the only place the mistake is
visible and removable. Which keys are inert is a per-stream question with
**three** answers, not two — `envelope` always, the loser of the
`reverse`/`read_direction` exclusive group always, and `pc_rand_envelope`
whenever `grain.envelope` is a transition or multistate spec — and the reason
text is one function, `window.PGE.deviationProbInertReason`, shared by the
Inspector's rows and by the EnvelopeEditor's catalog, which marks the same keys
in its selector. Two copies of that prose would drift the first time the rule
moves; and a key marked in one view and not the other lets you draw a curve on
a key the engine never reads.

A third list, `ALL_PARAM_KEYS`, is neither of those. It is the set of per-param
keys the editor may find written — the eight the engine reads in some
configuration, plus the dead `envelope` that existing projects carry — and it
exists for the constraint opposite to validation's. Two consumers need it: the
envelope walk in `envelope-utils.js`, which rescales and truncates (a key missed
there leaves an envelope out of scale on a YAML that renders), and
`listEnvelopes` in the EnvelopeEditor, which is the catalog of what can be
opened and drawn (a key missed there makes a written envelope unreachable, and
the Inspector's env-mini click open a different one). Neither asks whether the
engine consults the key — that is `error()`'s question, and it has the opposite
cost.

`isEnvValue` — which decides global-vs-per-param, and therefore which panel the
editor opens — is the engine's dict rule verbatim: **`'points' in obj`**,
nothing more. `isTypedEnv` next door stays stricter because there `type` is the
datum being read; here the only question is whether the engine will treat the
body as an envelope. Consequence to keep in mind when touching either: a bare
`{points: [...]}` without `type` (which the editor never emits, but a
hand-written file can carry) is a global envelope, so `unwrapEnv` reads that
form too — declaring it an envelope without teaching `unwrapEnv` to open it
would show it empty in the editor, and a commit there would empty it for real.
`true` is likewise **not** off: `bool` is a subclass of `int` in Python, so the
engine builds a `RandomGate` on `float(True)`, and `mode()` says `global`.

None of the Inspector controls can produce those bodies, so they arrive from the
Raw tab or a hand-written file — but that took closing two holes. The
EnvelopeEditor's "would this leave it empty?" check lived only in the
delete-a-breakpoint branch, while deleting a *block* (Delete key, or the loop
panel's "remove loop") had none: an envelope made of a single loop block
committed `[]`, which is exactly the body of PGE #209. The check is now one
function (`wouldEmptyEnv`) used by all five paths — Delete on a breakpoint, on a
block, the loop panel's button, double-click on a breakpoint, and pasting an
envelope — and the button is disabled (with its own `:disabled` rule) rather
than inert when it would empty the envelope. It takes the **items**: desugared,
and *not* wrapped. On a bare BP group it would say "empty" about a full
envelope, so a caller holding `rawEnvRaw` must desugar first — but a caller
holding a **wrapped** value must `unwrapEnv` instead, and desugaring is no
remedy there: `wrapEnv` returns the `{type, points}` dict for a pure-breakpoint
envelope with a non-linear global interp, `desugarBPGroups` leaves a non-array
untouched, and a non-array here is "empty". That is exactly how the paste came
to reject in silence every typed envelope — the form the editor writes itself
the moment you pick `cubic` in the header. Two contents the count could not see
on its own are now recognized inside the function, because for both the caller
has nothing to normalize: a **bare compact block** (where the value *is* the
block, a form neither `desugarBPGroups` nor `unwrapEnv` touches) and a
breakpoint in **dict** form `{t, v}`, which the engine normalizes to `[t, v]`
before looking at it. `PGEEnv.isBreakpoint` stays narrow — the editor uses it to
decide what is draggable — so that predicate is local to the guard. The other
hole was the
per-param "remove" button: emptying the dict wrote the **empty key**, which is
the single one of the five off-ish spellings that does *not* disable the
deviation (it is implicit 1%, PGE #210).
The off state must serialize as `false` or as no key at all — never as an empty
key. That rule holds for any future on/off control over this key.

The compact block's time distribution has a second one: `{type: geometric,
ratio: 10}` with `n_reps: 400` overflows a float. Neither value is out of place
alone — the constructor that receives the parameter never sees `n_reps` — so it
is not expressible as a bound, and `timeDistError(dist, nReps)` reports it as a
third kind, `overflow`, naming both. The check runs on logarithms (computing the
power to find out it overflows would only yield `Infinity`), and the thresholds
are pinned against the real engine in `test-time-dist.js`. They model Python's
**integer** semantics, the more permissive of the two: in `power` only a
fractional exponent is flagged (with an integer one Python computes on unbounded
ints and renders), and in `geometric`/`exponential` the float threshold sits one
`n_reps` lower than the integer one, so there is a one-value band where the
engine overflows and the UI stays quiet. Always the safe direction.

That leaves the mirror image — pairs the engine renders and `Math.pow`
does not — so `computeCycleDurations` has a second, cheaper net on its
**output**: if the durations are not all finite, or do not sum to `T`, it falls
back to equal cycles anyway. That covers the whole int/float casistica without
enumerating it. It must not be silent, because equal cycles are a plausible
wrong preview — worse than the old NaNs, which were at least visibly broken. The
guard marks the array `previewFallback` (non-enumerable, so no existing
comparison on the durations changes), `expandMixed` carries it onto the block
next to `distError`, and the loop panel says it in its own words — warn, not
error, because nothing in the YAML necessarily needs fixing.

**What that warn may not claim is what the engine will do.** The two fallbacks
look symmetrical and are not: `distError` fires because `timeDistError` has just
established that the engine rejects the block, so its text can say so. The
output guard fires where `Math.pow` gave up, which says nothing about the
engine: inside the band `timeDistError` deliberately lets through, the engine
*rejects* `{geometric, ratio: 2}` at 1024 cycles and `{exponential, rate: 0.5}`
at 1025, and *renders* `{geometric, ratio: 10}` at 309 in **integer** spelling —
which is the very pair the threshold comment cites as the reason not to adopt
the float one. The band holds both because it holds both spellings, and Python
tells them apart. The two conditions cannot be made to coincide without
replicating Python's integer semantics, which is what this net exists to avoid.
So the message states only what is known: the drawn durations are not the
block's. The thresholds stay as they are — at `ratio: 2` the parity is *exact*
in double precision, and tightening the inequality would bring back false
positives.

One threshold *was* misaligned, and is now the engine's: `computeCycleDurations`
took `geometric` to be uniform below `|ratio − 1| < 1e-9`, the engine below
`1e-6`. In the window between them the engine returned equal cycles while the
mirror still computed `1 - Math.pow(r, N)` — catastrophic cancellation, not
overflow — so the sum missed `T`, the output guard tripped, and the panel warned
about a preview that was exactly right. `exponential` and `logarithmic` have no
linear fallback engine-side, so there is nothing to align there.

### Dynamic parameter bounds

The UI's clamps (min/max/range for every control + envelope, and the pitch-unit bounds) are sourced from the engine rather than hardcoded. `GET /bounds` in `server.py` **AST-parses** the engine's `parameter_definitions.py` (`GRANULAR_PARAMETERS`) and `pitch_unit.py` (EDO `edoFactor` + `RatioUnit`) under `src/pge/parameters/` (falling back to the pre-#162 flat `src/parameters/` for older engine checkouts; same layout dance for `/envelope-keys`, whose `ENVELOPE_COLORS` literal now lives in `src/pge/rendering/envelope_extractor.py`) — same venv-less trick in both, so it works before the engine venv exists; returns `{}` for an engine without those files. `backend.js` `bounds()` fetches it; `app.jsx` calls `window.PGEBounds.apply()` at boot. `bounds.js` (`mergeEngineBounds`, node-tested in `test-bounds.js`) folds the engine payload onto `window.PGE_BOUNDS` via `ENGINE_PARAM_MAP` — which says, per UI key, the engine param **and** whether it reads the value bounds (`min_val/max_val`) or the range bounds (`min_range/max_range`, e.g. `offsetRange`←`pointer_deviation`, `durationRange`←`grain_duration`). `window.PGE_BOUNDS` in `yaml-bridge.js` is now just the **static fallback** (used on `file://` / server down); the dynamic path overrides it. A `null` engine `max_val` keeps the static fallback cap — except the `loop_*` trio, whose engine `max_val` is `null` precisely because the real cap is the **chosen sample's duration** (`sample_dur_sec`). `loopEnvMax` in `envelope-utils.js` (node-tested) drives the EnvelopeEditor `hardMax` + the Inspector scalar clamp from that duration (the sample's `duration` from `GET /media`), unit-aware like the engine's `PointerController` (`loop_unit || time_mode`: seconds → `sample_dur`, normalized → `1`), and falls back to the static cap only when the duration is unknown (`file://` / server down / unreadable file / sample not found). UI controls with no engine counterpart (voices onset_offset, pan spread, deviation_probability %, grain-env curve) stay static. **If you add a UI clamp, add its fallback in `yaml-bridge.js` and a mapping in `bounds.js`.**

Loop-window semantics (engine confinement, PGE-ui issue #97). With a loop active the engine confines the grain read position — base + `pointer.offset_range` + voice pointer offsets (`voices` → `pointer_range`/`step`) — to `[loop_start, loop_end)` via modular wrap (without a loop it scales/wraps over the whole file, unchanged). A loop straddling the file end is expressible **only** via `loop_dur` (`loop_start + loop_dur > sample_dur`); `loop_end` stays bound to `[0, sample_dur]`. The engine rejects a degenerate static window (`loop_end <= loop_start` → `InvalidFieldValueError`; envelope endpoints are dynamic → exempt). `loopBoundsError` in `envelope-utils.js` (node-tested) mirrors that static check so the Inspector can warn pre-render; the Inspector also surfaces the confinement in the `offset_range` / voices-pointer hints. The grain visualizations (`grain-map.js`) need no change — they plot the engine's post-render sidecar JSON, so the new confinement shows through automatically.

The unit of those coordinates is `pointer.loop_unit`, and its absence means *inherit* — the engine resolves `loop_unit or time_mode` (`PointerController._pre_normalize_loop_params`), so `normalized` puts the whole loop window in `[0,1]` and caps it at 1. Every stream the editor creates is born `time_mode: normalized`, which made that cap look arbitrary on a YAML that never mentions `loop_unit` (issue #126). `loopUnitInfo` in `envelope-utils.js` (node-tested) returns the unit **and** its provenance (`loop_unit` / `time_mode` / `default`); `loopEnvMax` reads it for the cap, and the Inspector renders the loop_unit row as a real `absolute | normalized` control labelled with that provenance, plus a hint stating the cap in force. Picking the inherited unit deletes the key rather than materializing a redundant one — absence is the "inherit" state, same care as the direction keys next door. Switching the unit re-clamps the *scalar* endpoints against the cap the new unit brings (the engine clamps them at render anyway); envelope endpoints are per-grain and exempt, as everywhere else in the loop block. The suffix follows the unit too — on the loop rows and on `pointer.start`, which the engine scales alongside them whether or not a loop exists (the scaling, not the bound: `pointer_start` is `is_smart=False` in the engine's schema, a raw value with no `Parameter` and so no clamp, which is why it stays out of `clampLoop` and out of the unit switch's re-clamp) — and `listEnvelopes` in the EnvelopeEditor reads the same resolution, so the two views of one key never disagree. Precision is declared per catalog entry as `fine`, **not** inferred from the unit string: the loop curves stay fine-grained in normalized, where they have no unit at all, and `computeYFit` takes `fine` for the same reason.

Discrete-domain parameters (`grain.read_direction`, PGE #207). Its engine bounds
are `-1`/`+1`, but the domain is the **set** `{-1, +1}`, not the interval: the
engine rejects `0` and `0.5` at parse time (`InvalidFieldValueError`) rather than
clamping them, and the bounds payload has no way to say so. So every place the UI
*computes* a y instead of the user *choosing* one must **snap to the sign**, not
clamp to the range — `truncateEnvArray`'s closing breakpoint (freeze-on-resize
could otherwise turn a valid project into one that won't render, without the user
touching the direction), the EnvelopeEditor drag, and the keyboard nudge.
`snapDirection` / `snapForDomain` in `envelope-utils.js` (node-tested) are the
single source; the envelope entry carries `domain: "direction"` and the editor
routes every y through one `clampY`. The nudge's `snapYFromDelta` takes the
**delta**, not the sum: on two states the value axis has a direction, not a
distance. Interpolation is `step`, imposed and implicit — the editor draws with
that default and hides the interp selectors, since `linear`/`cubic` are hard
parse errors here, not worse curves. `readDirectionError` mirrors the engine's
three rejections (`reverse` + `read_direction` together, the bare key, an
out-of-domain value) for the Inspector, because a hand-written YAML can carry all
three even though the direction control cannot produce them.

The EnvelopeEditor Y window **auto-fits the point values** for readability (`computeYFit` in `envelope-utils.js`, node-tested): it fits min..max of the breakpoints + 10% margin, clamped into the dynamic `[hardMin,hardMax]` — not the old `[visMin,visMax]` union, which could only grow and left points squashed against an edge. The fit is live while idle and **frozen during a drag** (a `useRef` snapshot) so the grabbed point can't slide under a rescaling axis; `visMin/visMax` are only the no-points fallback window.

### Fingerprint parity

The backend computes per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over canonical JSON with recursively sorted keys, ignoring `color/mute/solo/onset` plus `durationImplicit/durationUnresolved/deviationProbabilityLegacy`) is semantically aligned with python's per-stream hash. The algorithms differ (FNV-1a vs SHA-256) and `onset` is intentionally excluded on the JS side: moving a clip on the timeline doesn't change the rendered audio, so it shouldn't mark the stem stale. The engine includes `onset` in its hash because it hashes the full YAML dict. The two `duration*` flags are excluded because they record *where* the stream's length comes from (written in the YAML vs inherited from the sample), not what it is — the resolved `duration` is hashed, so typing the value the sample already implied leaves the stem green. `deviationProbabilityLegacy` is the same kind of provenance — *which spelling* the deviation was read from — so reopening a pre-v7 project doesn't mark every stem stale over a key name; the healed value itself is hashed, so the migration still marks stale exactly what it changes. If you change what affects the hash on one side, mirror it on the other or stems will read stale.

The fresh/stale/never *classification* built on top of the hash (not the hash itself) — plus the aggregate render summary — lives in `render-status.js` (`window.PGERenderStatus`, node-tested in `test-render-status.js`). `app.jsx` keeps the render state (`lastRenderedFps`, `renderStatus`) and delegates the decision to it.

### YAML round-trip (`yaml-bridge.js`)

Editor in-memory shape is camelCase JS with **parallel scalar/envelope fields** (e.g. `density` is a number, `densityEnv` is an array — exactly one is non-null). YAML on disk is snake_case with a **single field** that's either scalar OR envelope. `parse()` and `serialize()` translate between the two. Unknown stream keys are preserved verbatim under `_extra` so the round trip stays lossless for fields the editor doesn't model; unknown keys *inside* `pointer`/`grain`/`pitch`/`voices` (blocks the serializer rebuilds in full) are preserved the same way under `<block>._extra`. `deviation_probability: null` (engine: implicit 1% mode, distinct from key-absent = off) is stored in editor state as the sentinel `window.PGEYaml.DEVIATION_PROB_IMPLICIT` and serialized back to `deviation_probability: null`. That key was called `dephase` before PGE #204, which renamed it **without a back-compat alias** — a config still carrying the old spelling renders with no gate at all and the engine says nothing. So `parse()` reads either spelling into the single state field `deviationProbability`, and `serialize()` only ever writes the current one: opening and saving an old project migrates it. That rewrite would otherwise be **mute** — a render persists the editor state to `configs/<basename>.yml` even without a Save, so it would surface only in a `git diff` — so the parse (`parse` and the Raw tab's `parseStream` alike, via `streamFromYaml`) also emits `deviationProbabilityLegacy`, true when the value came from the dead key, and the Inspector says so above the mode selector — naming the render next to the Save, since `server.py` writes the config before it even builds the event stream, so someone who never saves still gets the file migrated. The flag is emitted **always**, `false` included, so a parsed stream always carries the boolean (same shape rule as `durationImplicit`) — but that is not what keeps the notice honest, because the flag is *parse-time* provenance and neither of the two moments that matter re-parses. Saving, and rendering (which persists `configs/<basename>.yml` before the engine even starts), migrate the file without touching editor state, so `app.jsx` puts the flag out at **both** write sites via `clearDeviationProbabilityLegacy` — through `_setDataRaw`, since clearing a provenance flag is neither a user edit nor an undo step — and not in `onSaveAs`, which writes a different file. It is deliberately optimistic: if the write never landed, reopening the project re-lights the flag from the file itself. In the other direction the Raw tab needs the flag to be an **OR**, because the dead spelling can enter from either side, and that rule is `mergeDeviationProbabilityLegacy(parsed, live)` in the bridge — one copy, node-tested there, called by `YamlEditor.applyEdits` alongside the `color`/`id` it already carries over. The tab shows the stream re-serialized under the live key, so `dephase` is never *shown* and a bare re-parse would clear the flag on a file that still carries it; that half drops only when the deviation is removed altogether and there is no key left to rewrite. But not shown is not not writable: the textarea is free, and whoever holds a pre-v7 project knows the dead spelling, so the other half takes the flag the re-parse itself computed — typing `dephase: 99` there introduces the key the engine does not read, and without it the next save would rewrite it in silence, which is #130's own failure on the one surface where `dephase` is still typable. The two halves cannot contradict each other: with the key present `readDeviationProbability` returns the value or the sentinel, never `undefined`. It is provenance, not content, so it is out of the fingerprint (`FP_IGNORE`) and out of `roundTripDiff` (`IGNORE_FIELDS`) — there it is the one field that legitimately *changes* across the round trip (parse sets it, serialize writes the current key, the re-parse clears it), and diffing it would raise "YAML lossy round-trip" on every pre-v7 project opened, about the one rewrite the editor performs on purpose. `window.PGEDeviationProb` (`src/lib/deviation-probability.js`, node-tested) classifies the value into off / implicit / global / perParam, mirroring the engine's `GateFactory._classify_deviation_probability`.

The two direction keys (`grain.reverse`, `grain.read_direction`) are an exclusive group the engine resolves by **refusing**, not by priority — unlike `loop_end`/`loop_dur` next door, where the serializer drops one. Here both are kept in state and both are re-emitted: the two keys say opposite things, so dropping one would hide the author's mistake, which is exactly what the engine declines to do. The Inspector flags the pair and the single direction control resolves it by writing exactly one key. The bare `read_direction:` is likewise kept verbatim (it is an engine error, unlike the bare `reverse:` which is that key's whole syntax), and **absence is preserved** for both: with neither key present the engine uses `auto` mode, where the direction follows the sign of `pointer.speed_ratio`, so materializing a `+1` would change what an untouched stream renders.

Stream `duration` is **optional** for the engine (PGE #205): absent or `null` means "as long as the sample". Editor state keeps `duration` a plain number for every reader (timeline width, envelope X axis, render extent), resolved from the media list (`parse(text, {samples})`, `parseStream(text, idx, {samples})` — both need the sample list or the length can't be known), and records the provenance in two flags: `durationImplicit` (serialization omits the key, so an implicit length is never materialized on save) and `durationUnresolved` (the sample's length is unknown — `file://`, server down, file missing — so the number is the `IMPLICIT_DURATION_FALLBACK` guess and the Inspector says so). `applyStreamPatch` clears `durationImplicit` when a patch sets `duration`, *unless* the patch carries its own flag — a whole re-parsed stream from the Raw tab must not materialize a key the author never wrote.

**Resolution is not only parse-time**, because both of its inputs move after the parse:

- *The media list arrives late.* At boot `GET /projects` and `GET /media` race (the latter opens every audio header), so a project can be parsed before the sample lengths are known. Two mechanisms cover it: `onProjectSelect` reads the list from `mediaFilesRef`, not from the render closure — the closure is captured before `await readFile(…)` and the list can land inside that await — and an effect keyed on `mediaList.path`/`files` calls `resolveImplicitDurations(data, files)` for the case where they land after the parse. That gate is `path !== null`, **not** `!loading`: the initial state is already "not loading" before the fetch starts. It goes through `_setDataRaw`, so a late arrival neither dirties the project nor becomes an undo step, and the function returns the same object when nothing changes so the effect can re-fire freely. It also refreshes `data.samples`, which `roundTripDiff` re-parses against.
- *The sample changes.* Picking another sample re-resolves an inherited duration, via `applyStreamPatch(stream, patch, {samples})` — `mergeStreamPatch` in `app.jsx` supplies the list. Skipped when the patch carries its own `durationImplicit` (Raw tab: already resolved) or when no `samples` is passed (a caller without the list would otherwise downgrade a good value to the fallback). `roundTripDiff(data)` returns the divergences; empty array means lossless.

### Audio playback (`audio-engine.js`)

`window.PGEAudio.engine` is the master clock once playing — visual playhead reads `engine.currentTime` from `audioCtx.currentTime`, not its own `requestAnimationFrame` counter. The clock is **latency-compensated** so the cursor sits on the *audible* sound rather than ahead of it: `scheduleStreams` anchors `startedAtCtx` a small **start lead** (`START_LEAD_SEC`) into the future — enough for the `<audio>` media elements to reach `canplay` before they must sound — and `currentTime` subtracts the device `outputLatency` (falling back to `baseLatency`), clamping to the start position during the lead so the playhead holds instead of jumping. The streaming path (`_scheduleStreaming`) preloads each element a lead before its onset, gates `play()` to the clip's ctx-clock start (`PGEAudioClock.playAt`, which clamps to "now" for a mid-playback reschedule whose anchor is in the past), and on residual lateness seeks the element forward so audio re-aligns with the playhead. A pure decoded-buffer schedule needs no lead (sample-accurate `source.start`), so the lead collapses to the output latency. The pure clock math (`audiblePosition`, `playAt`) is exposed as `window.PGEAudioClock` and node-tested in `test-audio-clock.js`. The render output format is a Settings preference (`tweaks.outputFormat`, **default `wav`**, also `aiff`/`flac`), forwarded to the engine as `--format`. `backend.js` `stemUrl` routes playback by format: `wav`/`flac` → `GET /output/<basename>__<sid>.<ext>` served **raw** (browsers decode these natively — no sox); `aiff` → `GET /audio/<basename>__<sid>.aif`, which `server.py` transcodes to WAV via sox because Firefox can't decode AIFF natively. So with the default WAV, playback needs no sox at all; the `/audio` transcode is only the AIFF path. Sample durations in `GET /media` come from `soundfile` (`sf.info`, header-only), with `soxi -D` as fallback. Streams without a rendered stem stay silent (no procedural fallback) — but never *silently*: a missing/undecodable stem is reported as `pge-audio-error` (once per stream per schedule), which `app.jsx` logs to the terminal and surfaces as one toast per playback. Without that, a 404 stem is indistinguishable from a quiet one, because `canplay` simply never fires. Teardown marks the node dead before clearing `el.src`, since clearing it fires `error` on the element.

### Stream identity (`allocStreamIds`, the stem index)

A stream's id is not a React key: it is the stem filename (`<basename>__<id>.<ext>`), the key of the engine's cache manifest and of the browser's stem index. So it must never be **recycled**. `allocStreamIds` in `yaml-bridge.js` (node-tested) is the single allocator for both call sites (paste, create) and takes an `isTaken` oracle — `app.jsx`'s `ownsStemFor` → `backend.render.ownsStem` — so an id whose stem is still on disk is skipped. The engine's GC can't cover this: it deletes only stems whose id is *absent* from the YAML, and a recycled id is present again.

That is also why `deleteStream` is a **data-only** mutation. `setData` is undoable; the per-id caches (`lastRenderedFps`, `waveforms`, `grainData`, the grain refs, the backend stem index) are not, so wiping them made a Ctrl+Z'd stream come back silent and marked "never rendered". With ids that never recycle, a leftover entry can never be picked up by a different stream — it is simply what that stream had, waiting for the undo.

The stem index is keyed by **filename, extension included**, because presence and playability are different questions. `hasStem(basename, id, format)` answers "playable now" — `stemUrl` requests the extension of `tweaks.outputFormat`, so a stem present only as `.aif` is not playable while the format is `wav`. `ownsStem(basename, id)` answers "some file still claims this id", format-agnostic, and is the one allocation must use: filtering by format there would recycle an id whose other-format stem survives. `GET /stems/<basename>` therefore returns one entry per **file** (with its `ext`), not one per stream id.

### History / undo (`app.jsx`)

`setData(updater)` wraps every mutation. `beginGesture()` / `endGesture()` bracket continuous interactions (drag, knob spin) so they collapse into a single undo step. Free-form mutations outside a gesture push to `historyRef.past` each call. Cap is 200 entries. Anything mutating `data` must go through `setData`, not `_setDataRaw`, or undo breaks.

The pure stack mechanics (the 200-cap, gesture collapse, undo/redo, redo-clearing) live in `history-core.js` (`window.PGEHistoryCore`, node-tested in `test-history-core.js`). `app.jsx` keeps the React glue — the `[data, _setDataRaw]` state, the `historyRef`, the `setHistVer` re-render bump, the `window.PGEHistory` publication, the keyboard shortcuts, and the freeze-on-resize confirm inside `endGesture` — and delegates the bookkeeping to it.

## File layout & load order (matters)

Sources live under `src/lib/` (the `.js` logic — `window.*` globals, no modules), `src/components/` (the `.jsx` UI), and `styles/` (the `.css`). `PGE Editor.html` and the Python bridge (`server.py` + helpers) stay in the repo root. `server.py` serves the editor and these subdirectories via its static catch-all, so the same relative paths work over `file://` and over the bridge. Node tests in `tests/node/` load the libs via relative paths (`../../src/lib/…`, `../../src/components/…`).

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `src/lib/yaml-bridge.js` → `src/lib/bounds.js` (needs `window.PGE_BOUNDS` from yaml-bridge) → `src/lib/envelope-loops.js` → `src/lib/deviation-probability.js` → `src/lib/envelope-utils.js` → `src/lib/backend.js` → `src/lib/audio-engine.js` → `src/lib/grain-map.js` → `src/lib/render-status.js` (needs `window.PGEBackend`) → `src/lib/history-core.js` → `src/lib/tweaks-store.js` → `src/lib/magnify-spec.js` → JSX files (`src/components/*.jsx`) → `src/components/app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`).

## Conventions

- Stem filenames: `<basename>__<streamId>.<ext>` (double underscore separator); `<ext>` follows the Settings output format (`tweaks.outputFormat`, default `wav` → `.wav`; `aiff` → `.aif`, `flac` → `.flac`).
- Cache manifests: `cache/<basename>.json`, one file per project. Keyed by the YAML basename — `/render` writes the editor state to the stable `configs/<basename>.yml` (never a temp file) so the manifest persists across renders and incremental caching works.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
