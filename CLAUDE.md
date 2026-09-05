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
make serve WORKSPACE=~/brani                             # projects outside the engine repo
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
  classification + render summary, incl. the engine-semantics axis, source
  guards on the chain that carries the version from the engine to the dot, and
  a live two-overlapping-renders check that `run()` refuses re-entry),
  `test-history-core.js` (undo/redo stack
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
  (the `hasStem`/`ownsStem` split over the format-keyed stem index, the
  format-aware `peaksUrl`/`spectrogramUrl`/`stemDur` of #153, plus source
  guards on the audio-error path and on the app.jsx wiring that passes the
  format), and `test-semantics-store.js` (where the two
  numbers of the semantics axis come from: `semanticsVersion` re-reading the
  bridge, and a whole `render.run()` writing/reading `pge-local-sem` — the real
  backend driven with a fake `fetch` and `localStorage`), and
  `test-oracle-client.js` (how the parity oracle's node client *dies*: a python
  killed between the `_dead` check and the write used to raise an unhandled
  `EPIPE`, replacing `_die`'s stderr-carrying diagnostic with a raw stack — the
  fake interpreter is `node -e`, so it needs no engine), and
  `test-suite-harness.js` (the suite's own
  exit contract: the verdict is an `exit` handler, verified by running it, plus
  a guard that every `tests/node/*.js` uses it and none went back to a
  positional exit gate), and `test-tracks.js` (the track model: `deriveTracks`
  totality against hand-edited `ui_tracks`, `applyTracks` never rewriting a
  stream object, the key appearing only when it says something, plus source
  guards on the Timeline/app wiring), and `test-workspace.js` (the
  workspace switch: a successful one empties the stem index — it describes the
  previous `output/` — a refused one changes nothing, plus source guards on the
  server routes and the app/Settings wiring), and `test-sources.js` (the static
  gate on the editor's own sources: every `src/lib/*.js` and
  `src/components/*.jsx` parses in the dialect the browser gets, the census
  between `PGE Editor.html` and the filesystem closes in both directions, the
  load order has the documented shape, and no file reads a `window.*` global at
  load time that a *later* script defines — the last one derived from the
  sources, not from a table of declared dependencies).
- **`make tests-python`** (pytest) — `test_render_pipeline.py`
  (`parse_render_line` events, `build_render_command` flags, the kill/watchdog,
  and a Flask `make_app` smoke test via `test_client`), `test_audio_pipeline.py`
  (path/security helpers, `_resolve_audio`, and the `/peaks` + `/spectrogram`
  routes serving the format that was asked for), `test_yaml_structure.py` (the engine config corpus,
  gated by `engine_corpus.py`), and `test_engine_render.py`
  (an engine render smoke test that skips when the sibling engine checkout/venv
  is absent).
- **`make tests-parity`** (node + python, needs the engine checkout) — the
  suites in `tests/parity/`, which ask the **engine itself** the questions the
  mirrors in `src/lib/` answer from memory. See "Parity harness" below and
  `tests/parity/README.md`. The parity suites don't own their
  verdict (`harness.js` does, for all five), but `test-suite-harness.js` still
  guards them against taking it back with a brutal exit.

All three **accumulate** failures rather than stopping at the first red: with
twenty-odd suites, `|| exit 1` meant seeing one failure per run instead of the
whole census. That holds *between* the targets too — `tests: tests-node
tests-python` was a make dependency, so one red node suite made pytest **and**
parity disappear, and whoever ran `make tests` for the census got a third of
it. **All three targets now forward `ROOT=` as `PGE_ENGINE_ROOT`**, and all
three readers honour it (`tests/node/test-yaml-bridge.js`,
`tests/python/engine_corpus.py`, `tests/parity/harness.js`). Each half ignored
it in turn, and the symptom was never a red: `make tests-{python,node}
ROOT=/path` — the `ROOT=` this Makefile's own help suggests — skipped the corpus
and printed green, i.e. #132 through the back door. `test-suite-harness.js`
guards the three readers and the three recipes, and measures the node one by
running it against an invented root.

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

**The handler must be registered at module level, and that is checked
structurally.** A textual check can't tell a handler registered by the file
from one registered inside the async body it is supposed to watch: if that body
dies first, the handler doesn't exist and the file exits with neither the
summary nor `interrotto prima della fine` — the two lines that are the whole
contract. Three suites had it inside the IIFE. The guard now counts the
bracket depth of the `process.on("exit"` occurrence (`tests/node/source-guard.js`
reads the source as *code*: comments stripped, strings kept, and a masked copy
of the same length for the depth walk), because that depth is the only
difference between a healthy file and a broken one.

**And the verdict has to be delivered, not only printed.** `Oracle.close()`
kills the python if it doesn't leave on its own — `stdin.end()` + `unref()` was
a request, and `unref()` doesn't detach stdout/stderr, so a mute interpreter
left node alive long after the right verdict had been printed. Each parity case
runs under a time cap (`PGE_PARITY_CASE_TIMEOUT_MS`, 120 s) because with a live
oracle the loop never empties on its own, so a hanging case would be a job
timeout instead of a named failure. Both CI jobs carry `timeout-minutes` as the
net that doesn't depend on either fix. `test-suite-harness.js` has two probes
for it: one kills the runner *between* cases (no waiting), the other holds an
open handle the way a real oracle would — the earlier single probe closed the
fake oracle before hanging, i.e. it tested the branch in the one configuration
where the defect cannot exist.

There is no linter or typechecker — `test-sources.js` is the whole static net.
It answers four questions about the sources, and only those: every file parses,
every file is loaded by `PGE Editor.html` exactly once (and every `<script>`
points at a file that exists), the order has the documented shape (vendor →
`src/lib/` → `src/components/`, `app.jsx` last), and nothing reads a `window.*`
global at load time that a later script defines.

That last check is **derived from the sources**, not from a `{file: [deps]}`
table written in the test: a table is a second copy of the truth, and the
person adding a dependency is not the person who remembers to update it — it
would go mute exactly while the order was about to break. The scanner reads
`window.X` assignments as definitions and `window.X` reads as dependencies,
**both** restricted to what actually runs at load: the module body plus the
IIFE bodies inside it (the shape of every `src/lib/` file). The restriction has
to cover the two halves or it leaks: a `window.X = …` sitting in a function
somebody calls *later* has put nothing on `window` by the time the next script
reads `X`, and counting it as a definition made the guard green on an
`undefined` — the very case it exists to catch — while also inflating the
edge count with an arc that doesn't exist. `window.PGE.Timeline = …` counts as
a **read** of `PGE`: that is the arc every component has towards whoever
*creates* the namespace, which is `primitives.jsx` only because it loads first —
nine files write `window.PGE = window.PGE || {}`, so moving `primitives.jsx`
behind another of the nine stays green, and correctly (at load time what is
needed is the object, not the components that end up inside it). Property-level
dependencies (`PGE.Knob`) are not seen at all. Its other declared blind spot: a
function *declared* at load level and called immediately after is walked as
lazy, so a dependency hidden that way is missed — a false negative, the safe
direction.

What it does not do is prove a component *works*: for that there is no headless
boot. UI verification is manual (open `PGE Editor.html`, Settings → local
backend, test connection, render).

## Architecture

### Two-repo split (deliberate)

`PythonGranularEngine` stays a pure CLI (no Flask, no UI). `PGE-ui` (this repo) holds the editor + bridge. The bridge talks to the engine repo via `--root` and never mutates engine source — it works inside `configs/`, `output/`, `cache/` and `refs/`, all four of which can live in a workspace of their own (#147, and #148 for `refs/`; see below).

### Workspace: the project folder is not the engine checkout (#147, #148)

`--root` is engine **source** (`src/main.py`, `.venv/`, `csound/`, `logs/`).
`--workspace` is where the *work* lives: `configs/`, `output/`, `cache/` and —
since #148 — `refs/`. Omit it and they coincide — the historical behavior, where
every piece is a file inside the engine checkout and `/render` rewrites it there.
`_ensure_venv_events` and the csound paths stay on `--root` on purpose — engine
code, not the author's work.

**`refs/` follows the workspace only where the engine can be told about it.**
The subprocess runs with `cwd=root`, and without `--samples-dir` the engine
resolves samples against `./refs/` — relative to that cwd, in *both* renderers:
`--ssdir` covers csound's render-time lookup but not `Stream.__init__`, which
resolves the sample's duration before a renderer exists. `build_render_command`
therefore sends `--samples-dir <refs>` for both, always: the engine's CLI parses
`sys.argv` by hand and ignores unknown flags, so it is inert on an engine that
predates PythonGranularEngine#235.

What is *not* inert is moving the folder. On an engine without the flag, a
`refs/` inside the workspace is a folder the editor lists and the render never
reads — a disagreement that only surfaces as a failed render. So
`_set_workspace` asks first: `engine_supports_samples_dir(root)` (an AST read of
the engine's CLI, mtime-cached like the semantics version) decides whether
`refs` binds under the workspace or stays at `root/refs`. The browser can't
derive that from the paths (with `workspace == root` the two coincide anyway),
so `GET/POST /workspace` carry `samplesFollowWorkspace` and Settings words its
hint from it. The probe's criterion is the string constant `--samples-dir` as
the engine's own source spells it: comments don't survive the AST, and an engine
that merely mentions the flag in a TODO doesn't parse it.

The four paths are **not** closure constants any more: `_set_workspace` rebinds
them (`nonlocal`) and `_bases()` rebuilds the `kind`→folder map per request, so
a `BASES = {…}` built once would go on serving the previous folders. Two
consequences worth keeping in mind:

- **`workers: 1` in the gunicorn config is load-bearing.** The workspace is
  process state; with more workers a `POST /workspace` would switch one of them
  and the others would keep answering from the old folders.
- **`/render` pins the four paths at the top of the route**
  (`ws_dir, ws_refs, ws_output, ws_cache`), not inside the NDJSON generator,
  which outlives the request. A switch read mid-stream would put stems in one
  folder and the cache manifest in another — and the `done` line would name the
  stems under a folder that never held them.
- **`POST /workspace` refuses with 409 from the first instant of the render
  stream, not from the spawn.** `RenderState.enter()` is called at the top of
  the generator and released by its outermost `finally`; `is_running()` is that
  claim *or* a live subprocess. Watching only the subprocess left the switch
  open for the whole engine-venv setup — minutes in which `rs.proc` is `None`
  and the render is under way with its paths already pinned, so it would have
  written stems and manifest into the previous folder while the browser showed
  the new one. The release has to sit in the outermost `finally` for the two
  exits the inner one doesn't see: the early return of a failed venv setup, and
  the `GeneratorExit` of a client that leaves mid-stream. A claim left hanging
  would 409 every switch for the life of the bridge.

Creation rule: missing **sub**directories are created, the workspace folder
itself is not — on the CLI a mistyped `--workspace` exits, over HTTP it 400s.
Fabricating it would make an author's projects silently vanish from the list.

A switch is a **replacement of browser state, not a merge**, which is why
`POST /workspace` answers with the new project list in the same round trip.
`backend.setWorkspace` empties the stem index (and the on-disk-duration map) and
drops `cachedConfig`; `onWorkspaceChange` in `app.jsx` drops waveforms,
spectrograms, grain data, the grain refs, `stemRevRef` and `lastRenderedFps`,
reloads media + projects, then reopens a project and **calls `loadCache`
itself** — two folders can hold a project of the same name, and there
`activeProject` doesn't change, so the effect keyed on it never re-fires and
every clip would read ⚪ with stems sitting on disk. The engine-semantics
records (`pge-local-sem`) go with the index, and for the same reason: they are a
statement about the *files* — "an engine that read the YAML this way wrote this
stem" — i.e. about exactly what the index inventoried, the previous `output/`.
Inherited into a new folder they assert a reading nobody observed there, and
with identical YAML the fingerprint matches: 🟢 on stems an older engine wrote
differently, which is the case the axis was added for (#133). Without a record
the dot is 🟡 ("a stem whose reading I don't know") and clears itself on the
first pass, even an empty one. What deliberately survives is `pge-local-fp`: it
records what a stream looked like when it was rendered — a statement about the
YAML, not about the files — so a same-named project with different content
hashes differently (stale, the safe direction). Identical content, where the
hash matches, is safe for a different reason than the one written here before:
"the audio would be identical anyway" died with #148, since `refs/` follows the
workspace on an engine with `--samples-dir` and the same YAML over different
samples renders differently. What holds it up is that a fingerprint can only
*withhold* the green dot, never grant it — green needs a stem in the index, and
the index is exactly what the switch empties.

Settings shows the workspace field; the value comes from `GET /workspace` on
every panel open, never from a saved preference — the server is the single
authority, and a persisted copy would silently disagree with a bridge launched
with `--workspace`.

### Backend abstraction (`backend.js`)

UI never touches I/O directly. It calls `window.PGEBackend`, which has a single
implementation, `local`: real disk via `server.py`, `POST /render` spawns the
subprocess and streams NDJSON. The browser only does `fetch()`; the server holds
all disk access. Contract is documented at the top of `backend.js`. If
`server.py` isn't running the editor flags `serverDown` (there is no in-browser
fallback).

### NDJSON render protocol

`POST /render` returns one JSON object per line. Event types: `log`, `stream-start`, `stream-done`, `done`. `server.py` parses `main.py` stdout into these structured events. Adding a new render-time UI signal usually means: extend the parser in `server.py` AND the consumer in `backend.js` AND the React state in `app.jsx`.

**Not every `[CACHE]` line is a stream, and the shape doesn't say which.** The
engine prints `[CACHE] Manifest: <path>` on every `--cache` render and
`[CACHE] GC: rimossi N stream orfani` when the GC removes something; both match
the per-stream regex. What discriminates is therefore the **set of ids the
request declares** (`state["ids"]`, from `opts["streams"]`), not a list of
reserved prefixes — the next `[CACHE] Something:` upstream would come back in
through the same door. Absent/empty set = a request that doesn't declare its
streams: no filter, historical behaviour. The probe in
`tests/python/test_render_pipeline.py` reads the `[CACHE]` literals **out of
the engine sources** instead of transcribing them: the six older assertions ran
on lines copied from this module's docstring, which is exactly why `Manifest`
and `GC` slipped through for so long.

The stream id in the summary path line is **not** constrained to `\w`:
`renameStream` advertises letters, digits, `.`, `_` and `-`, and only the
*last* DIRTY stream of a round depends on that line (the others are closed by
the next `[CACHE]`), so an id with `-` or `.` never got its `stream-done` —
🟡 after a render that did exactly what the dot asked, and two renders needed
per edit. The comparison is on the `__<id>` suffix, so there is no separator
position to guess.

On the browser side the two writes have different rules, deliberately: the
`stream-done` handler marks the stem index **only for a declared stream** (the
event comes from a parsed log line, not from a file), while the `done` fallback
does not validate — `generated` is the list of files the server found on disk,
so even a deleted stream's stem exists and the index must know. That fallback's
"already handled" guard is a **per-run** Set, not `stemIndex`: `loadCache`
fills the index from `/stems` on every project open, so "already handled" used
to mean "was on disk", and from the second render on the fallback was dead.

**One `run()` at a time, and the guard lives on both sides.** `cancelAbort` in
`backend.js` is a single closure variable: two overlapping `run()`s and the
second overwrites the first's `AbortController`, so Cancel kills one and the
other keeps writing stems with no way to stop it — and both POSTs write the
same `configs/<basename>.yml` and the same stems. `renderingRef` in `app.jsx`
guards the *entrances* (the button and the `r` shortcut, which are app.jsx's
problem) and must be raised **before** any await — `runRender` awaits
`refreshEngineSem()` with `jget`'s 10 s timeout, a window wide enough for a
second entry. `run()` refuses re-entry on its own too, because the invariant
has to be enforced in the file that suffers it: the refusal *returns*
`{ok:false, configWritten:false}` rather than throwing (the caller has no
try/catch, and `run()` never throws) and emits no `done` event. That last
reason used to be written as "it would tear down the UI of the render still in
flight", and that was false: `runRender` clears log, progress and state
*before* calling `run()` and tears down unconditionally on return, so there is
no UI to tear down. The real reason is that `done` is the event of a render
that **finished**: emitting it here would make the caller record the outcome
(and the generated-stem count) of a round that never started, and would say so
to anyone else listening on the stream. The refusal is the return value's job.
`test-render-status.js` pins both sides — the caller by source guard, `run()`
by running two overlapping renders and pressing Cancel.

### Score options that can kill a render

Two options exit 1 (taking audio with them): unknown `--plot-envelopes` name, malformed `--magnify-at` SPEC. Both are filtered before reaching argv, but in different places:

- **Envelope names** → filtered *server-side* (`server.py` intersects them with `engine_envelope_keys(root)`) because the valid set lives in engine source. That AST read is the **only** bridge between `ENVELOPE_COLORS` and the UI — there is no static fallback list, `backend.envelopeKeys()` returns `[]` and the filter hides — so a rename upstream used to make the whole filter vanish silently instead of failing. `tests/parity/test-bounds-parity.js` now points it at the real file: the AST read must equal the imported keys *in source order* (the popover draws them in that order), and `PLOT_ENVELOPE_KEYS` — the set `cli.py` actually validates against — must still be `frozenset(ENVELOPE_COLORS)`, since the day the engine narrows one without the other the server filter becomes wider than the engine and a name gets through to `exit 1`.
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

`GET /bounds` in `server.py` **AST-parses** the engine's `parameter_definitions.py` (`GRANULAR_PARAMETERS`) and `pitch_unit.py` under `src/pge/parameters/` (falling back to pre-#162 flat `src/parameters/`). Returns `{}` for an engine without those files. `backend.js` `bounds()` fetches it; `app.jsx` wraps the fetch in `refreshEngineBounds()` and calls it from **three** sites — boot, project change, render start — the same three as `refreshEngineSem`, and for the same reason (see below). `bounds.js` (`mergeEngineBounds`, node-tested) folds the engine payload onto `window.PGE_BOUNDS` via `ENGINE_PARAM_MAP` — which says, per UI key, the engine param and whether it reads `min_val/max_val` or `min_range/max_range`. `window.PGE_BOUNDS` in `yaml-bridge.js` is the **static fallback** (used on `file://` / server down).

**The same payload carries `output_sr`** — the engine's `DEFAULT_OUTPUT_SR`
(`pge/shared/constants.py`), AST-read by `engine_introspect.engine_output_sr`
with the mtime-invalidated cache the semantics version uses, and for the same
reason (a `git pull` next door under a live `make serve`). It rides on `/bounds`
because it *is* a clamp question: the real `grain_duration` minimum is one
sample, `1/output_sr`, an override the bounds AST can't see. `apply()` installs
it on `window.PGE_OUTPUT_SR` — the impure half, deliberately, so
`mergeEngineBounds` stays pure — and the literal in `yaml-bridge.js` is the
**static fallback**, like `window.PGE_BOUNDS` beside it.

That number has four readers and only one of them is the clamp: `grainUnitFactor`
in `envelope-utils.js` uses `1/sr` as the `grain.duration_unit: samples` factor,
and `convertGrainDurationUnit` with that factor **rewrites** `duration` /
`duration_range` in the YAML. So a stale sample rate doesn't tighten a knob, it
writes wrong durations — and the direction is the bad one: engine at 44100 with
the UI on 48000 gives `1/48000 < 1/44100`, i.e. a grain shorter than a real
sample. `test-bounds-parity.js` pins all three links (imported constant, the
bridge's AST read, the static literal) and requires the literal to **equal** the
engine's, not merely be no wider: here the inequality has no safe direction. It
also pins the *premise* of the floor: `mergeEngineBounds` sets
`grainDur.min = 1/sr` flat, not `Math.min(base.min, 1/sr)`, because the engine
**replaces** the declared min (`get_parameter_bounds(..., output_sr=…)` returns
`min_val = 1.0/output_sr`); the two coincide only while the declared min stays
above one sample (today `0.001` s = 48 samples at 48 kHz), and that's an engine
fact the parity asserts rather than the comment transcribing it.

**Three call sites, not one.** `refreshEngineBounds()` runs at boot, on project
change and at render start. With the boot site alone — an effect with empty deps,
inside the `/health` `try`, and `serverDown` never going back to false without a
reload — the number entered the page once and never again: a `git checkout` next
door under a live `make serve` stayed invisible, though `engine_introspect`
invalidates on mtime precisely so it wouldn't. The render does **not** await it
(unlike the semantics version, which its own `stream-done`s consume): the render
doesn't read the clamps, the editor does, afterwards.
The floor is `1/sr` outright and not `Math.min(base.min, 1/sr)` — the two agree
only while the declared min sits above one sample, and with a payload carrying
`output_sr` and no params the `Math.min` kept the floor of the *old* sample rate.

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
`parameter_bounds`, `constants` — the last one carrying the name registries and
the constants the mirrors copy whole, `ENVELOPE_COLORS` included);
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
were written against — the datum that tells "we broke it" from "the engine
moved" — and that line is now **checked**: a parity case requires the recorded
SHA to be an ancestor of the commit the run actually compared against. Falling
behind is legitimate (the pacts still hold, and the run notes by how much);
not existing is not. It has no shallow-clone escape hatch — the first version
had one and a `deadbeef…` SHA sailed through it — so CI checks the engine out
with `fetch-depth: 300`.

Engine-source introspection (`engine_introspect.py`) was split out of
`server.py` for this: it AST-parses the engine with the stdlib alone, so both the
bridge and the oracle can use it. It reads the envelope keys, the parameter
bounds, `VARIATION_SEMANTICS_VERSION` and `DEFAULT_OUTPUT_SR`; each returns an
empty/`None` result for an engine that doesn't have the thing, and every caller
must treat that as "don't know", never as a value. For the sample rate that
extends to values that aren't sample rates: `0` or a negative reads as unknown,
because the UI divides by it and `1/0` is an `Infinity` that silently switches
off every clamp downstream.

**No engine constant is transcribed by hand in this repo any more**, and the
last one to go was the one nobody was watching: `OUTPUT_SR = 48000` in
`yaml-bridge.js`. It is still written there, but as a declared static fallback
that parity requires to equal the engine's — see the `/bounds` section above.

That was **false for the `pitch` half** until this round: three fallbacks
(`edoFactor`, the ratio record, the EDO preset table) returned today's engine
numbers transcribed here, so a plausible refactor upstream — two renamed
classes, an AST read that simply fails — produced a full payload with no sign
it was a fallback. And the direction is the wrong one: `mergeEngineBounds`
applies them *over* the static fallback because they arrive labelled as engine
truth, so a transcribed `ratio.min` against a stricter engine admits a value
the engine rejects — exactly what `test-bounds-parity.js` prevents for the
static fallback. Parity can't see it: with the real engine the two sides agree.
There is **one** place for static fallbacks and it is `yaml-bridge.js`.

**Every one of those readings goes through `_assigned_value`**, which recognizes
both `NAME = …` (`ast.Assign`) and `NAME: T = …` (`ast.AnnAssign`), because the
annotated spelling is house style upstream — the engine already annotates
`GRANULAR_PARAMETERS` and `PITCH_UNIT_PRESETS`. Two readings used to filter on
`Assign` alone, and for `VARIATION_SEMANTICS_VERSION` that was the worst place
for it: the fallback is `None` = "engine unknown", an unknown engine claims
nothing, so a bump shipped with a type annotation would switch the whole axis
off and turn every stem green exactly while the engine was about to rewrite
them.

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

The backend computes per-stream fingerprints to drive the `🟢 rendered / 🟡 stale / ⚪ never` dots. The JS side (`fingerprintStream` in `backend.js`, FNV-1a over canonical JSON with recursively sorted keys) has **two** exclusion lists, and they don't have the same reach:

- `FP_IGNORE_TOP` — per-stream fields, excluded at the **first YAML level only**: `color`, `mute`, `solo`, `onset`, `durationImplicit`, `durationUnresolved`, `deviationProbabilityLegacy`.
- `FP_IGNORE_DEEP` — excluded at **any** depth because it lives nested by construction: `_curveRaw` (under `grain.envelope`). It used to hold `statePositions` too; see below.

Key non-obvious exclusions:

- `onset`: moving a clip on the timeline doesn't change the rendered audio.
- `duration*` flags: provenance of the length, not the length itself.
- `deviationProbabilityLegacy`: provenance (which spelling), not content — reopening a pre-v7 project shouldn't mark every stem stale.
- `_curveRaw`: it cannot move on its own. `parseGrainEnvelope` **derives** `curve` from it (`rescaleCurveY`, a linear `*(n-1)`), so a drift too small for `curveMatchesRaw`'s 1e-9 to notice — and therefore re-emitted verbatim into the YAML, moving the engine's hash — still lands in `curve`, which is hashed. That premise is what makes the exclusion safe, and it is pinned by a parity case (a reparse whose curve drifts must move **both** hashes) rather than asserted in a comment.

**The criterion is not "editor-only field", it is "does it reach the YAML"** — which is a question for the *serializer*, not something a list of key names can answer, and getting it wrong cost a real green dot. `statePositions` was excluded on the same "they mirror the serialized states" reasoning, which is simply false for it: `serializeGrainEnvelope` splices it *into* `states` (`[[pos, name], …]`), so the engine hashes it, and its own comment in `yaml-bridge.js` says the positions are thresholds in value-space — i.e. they change the rendered audio. Edit them in the Raw tab (the only path that writes them; no component does) and `states` stays a list of the same names: the engine's hash moved, the UI's did not, 🟢 on a stem the engine was about to rewrite *differently*. It is hashed now. The cost is one extra render for every already-rendered multistate stem with non-uniform positions — the safe direction, self-clearing on the first pass, like the semantics axis. `tests/parity/test-fingerprint-parity.js` measures both halves against the engine; `tests/node/test-fingerprint.js` used to pin the wrong assumption (`ignores grain.envelope.statePositions`), which is exactly the internally-perfect-and-divergent mirror `tests/parity/` exists to close.

Taken literally, the criterion has a boundary the same key sits on both sides of, which is why the rule is a predicate and not a third list: `statePositions` reaches the YAML only while it is **aligned with `states`**. Stale after a structural edit (an added state leaves the array one short) `serializeGrainEnvelope` ignores it and writes uniform positions, so two streams differing only there serialize to byte-identical YAML — the engine cannot tell them apart, and neither may the UI, or it reads 🟡 on a stem the engine considers fresh. Safe direction, but it would be a *second* divergence from the engine's derivative, and that list is one element long (`onset`). So `statePositionsReachYaml` lives in `yaml-bridge.js` — the module that decides what comes out — and has two callers: the serializer that emits the positions, and `canonicalJSON` in `backend.js`, which drops the key exactly when the serializer would. Both directions are pinned, in node and against the engine: a guard that never fires puts #134 back, one that always fires makes an edited position silent.

**"First level" means the YAML's, not the JS object's**, and the two differ:
`serializeStream` splices `_extra` *into* the level of the block that holds it.
So `stream._extra.mute` comes out as a top-level `mute:` (excluded, like the
stream's own), while `grain._extra.mute` comes out as `grain: {mute: …}` —
which the engine hashes, because its own filter is a dict comprehension over
`stream_dict.items()`, i.e. the first level alone. One list filtering at every
depth was therefore a divergence in the **wrong** direction: a nested homonym
moved the engine's hash and not the UI's, and the dot stayed 🟢 on a stem the
engine was about to rewrite. `test-fingerprint.js` pins both halves and
`test-fingerprint-parity.js` asks the engine (the case needs an `_extra` that
already exists on both sides — merely appearing moves the hash via the key
itself, so it wouldn't discriminate). An `_extra` left empty by the filter
drops out entirely: in the YAML it isn't distinguishable from an absent one.

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
boot, project change, render start) asks `semanticsVersion({refresh: true})`.
It is the same decision `engine_introspect` takes one level down (mtime
invalidation, pinned by `test_engine_semantics_version_sees_a_live_bump`).

**And the number of one render is fixed by the caller, not read twice.**
`runRender` reads it once and hands it to both consumers: `run()` takes it as
`opts.semanticsVersion` and records it at the end, and the `stream-done`
handler uses the same constant. The `_semantics` cell used to be the shared
source for both, on the assumption that nobody would rewrite it mid-round — but
the three re-read sites are not mutually exclusive with a render in flight (the
project-change effect has no `renderStatus.running` guard). Clicking another
project mid-render, with the engine moved next door, recorded the **new**
number on stems the engine had just written reading the **old** one: 🟢 on
stems it will redo differently, the very failure the axis exists for. It needs
the conjunction, so it is narrow — but it is the one invariant the whole design
rests on, and it was written as guaranteed. `run()` still falls back to the
cell when the field is absent: absent would mean "don't know", and there it
would be a lie that deletes the entries of stems just rendered.

**The engine has a third axis in its own hash: `renderer_type`.** It sits
beside the semantics version and for the same reason — something a stem depends
on that the YAML text doesn't state. The UI has no axis for it, and that is
fine while the backend is *one*: `app.jsx` hardcodes `renderer: "numpy"` and
`server.py` defaults to the same (a source guard in `test-render-status.js`
pins the pair, and a parity case pins that three backends really give three
hashes). The day the choice reaches Settings — the engine has three — the dot
goes green on stems the engine will rewrite: PGE #222 again, on a different
axis. That guard is the reminder that the axis has to be built, not just an
option added.

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
(`audio_duration`, a header-only read), `backend.render.stemDur(basename, id,
format)` serves it **for the format asked**, like `hasStem` (see below), and
`ClipWaveform` / `ClipSpectrogram` take a `span` = stem duration / clip
duration: the excess
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

**Everything derived from a stem sits on the `hasStem` side of that split**
(#153) — peaks, spectrogram, and the duration behind `span`: whoever draws
wants to know what the file *it is drawing* sounds like, not who owns the id.
`peaksUrl(bn, id, format)` and `spectrogramUrl(bn, id, scale, format)` emit the
real extension, exactly like `stemUrl`, and `stemDur` tries the requested
format first (the others stay as fallback, because the drawing itself falls
back the same way). While those two hardcoded `.aif` and the bridge resolved
`.aif` first, a project rendered once in aiff and then in the default wav
**played the new audio and drew the old picture**, with no later render able to
clear it: the peaks cache was named without the source's extension, so both
formats shared one entry and `_is_fresh` compared it against the older `.aif`
— fresh forever. Only the clips with a leftover `.aif` froze, which is why it
looked intermittent. Two consequences to keep: the output format is among the
deps of the peaks/spectrogram effects in `app.jsx` (the URL is built from it),
and the cache file is `cache/peaks/<stem><ext>.<buckets>.f32` (same rule for
`cache/spec/` and the `*_media` twins).

Server-side, `_resolve_audio` in `audio_pipeline.py` is **the one spelling** of
"which file is this": it tries the requested extension first, then the historic
fallback list. `/peaks`, `/spectrogram` and `/audio` each had a copy of that
loop inline — three lists of extensions to keep aligned, and the `/audio` one
didn't even go through `safe_resolve`; they all call the helper now. `/audio`'s
transcoded copy moved with it, from `output/` to `cache/output_wav/`: inside
`output/` it was inventoried by `GET /stems` as a stem with the id
`<sid>.transcoded`, i.e. a phantom name burned for `allocStreamIds` — the same
choice `/media_audio` always made by never writing inside `refs/`.

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

That last sentence is not prose any more: `tests/node/test-sources.js` is its
executable form (#138). It reads the `<script>` list out of the HTML, requires a
bijection with the files on disk, and refuses a `window.*` read that a later
script satisfies. What it cannot say is *where* in the phase a new file goes —
only that the order it is given holds together.

## Security stance of `server.py`

Binds `127.0.0.1` by default. CORS wide-open (editor runs on `file://`). No auth. `--host 0.0.0.0` exposes arbitrary `python src/main.py` execution against attacker-controlled configs — only use on a trusted LAN. Path traversal in `name=` params is rejected; `kind=` is whitelisted (`projects|media|cache|output`). `POST /workspace` takes an unconstrained absolute path and creates `configs/output/cache` under it: with no auth that is a local-tool decision, and one more reason not to pass `--host 0.0.0.0`. What it does not do is answer a bad path with a 500: a NUL (`ValueError` from the filesystem) and a `~unknownuser` (`RuntimeError` from `expanduser`) are 400s with the message, like the missing folder — the same rule `/render` learned by going through `safe_resolve`.

**One spelling of the rule, `safe_resolve`.** `/render`'s basename is the trust
boundary of a route that *writes a file*, and it used to re-implement the check
inline — weaker, and already divergent: no `\`, no leading dot, and a NUL gave
500 (a `ValueError` from the filesystem) instead of 400. It goes through
`safe_resolve` like every other route, and `safe_resolve` rejects the NUL for
all of them. Both this and the `--plot-envelopes` name filter (whose valid set
lives in engine source, hence server-side) now have tests: sabotaging either
used to leave the suite green.

## Conventions

- Stem filenames: `<basename>__<streamId>.<ext>` (double underscore separator); `<ext>` follows the Settings output format (`tweaks.outputFormat`, default `wav` → `.wav`; `aiff` → `.aif`, `flac` → `.flac`).
- Cache manifests: `cache/<basename>.json`, one file per project. Keyed by the YAML basename — `/render` writes the editor state to the stable `configs/<basename>.yml` (never a temp file) so the manifest persists across renders and incremental caching works.
- Editor opened via `file://` — there is no dev server for the frontend.
- `requirements.txt` is for the bridge only. The engine has its own (and its own venv).
