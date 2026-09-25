# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Browser-based visual editor for `PythonGranularEngine` (sibling repo) YAML compositions. **No build step, no bundler, no package.json** — React + Babel are loaded from CDN inside `PGE Editor.html`, and `.jsx` files are transpiled in-browser. Open `PGE Editor.html` as a `file://` URL.

The renderer itself lives in a separate repo (`PythonGranularEngine`). This repo only contains the UI plus a thin Flask bridge (`server.py`) that shells out to `python src/main.py …` in that other repo.

## Common commands

```bash
make install          # pip install -r requirements.txt  (flask, flask-cors, gunicorn, numpy, soundfile)
make serve            # python server.py --root $(ENGINE_ROOT) --workspace $(ENGINE_ROOT) --port 7878
python server.py --root /path/to/PythonGranularEngine    # explicit root
make serve WORKSPACE=~/brani                             # projects outside the engine repo
make install-cli      # symlinks bin/pge-ui into ~/.local/bin (BINDIR= to choose)
cd ~/un-brano && python /path/to/PGE-ui/server.py        # #165: workspace = $PWD,
                                                         # engine from $PGE_ENGINE_ROOT
cd ~/un-brano && pge-ui                                  # the same, after install-cli
make tests            # full suite: tests-node + tests-python + tests-parity (if the engine is there) + tests-e2e
make tests-parity     # only the JS↔engine parity suites
make tests-e2e        # headless boot of the editor (needs a playwright browser)
```

`make tests` runs four parts (the third only when the sibling engine checkout
exists, the fourth only when a browser is installed):

- **`make tests-node`** (node, no deps beyond npm) — `tests/node/test-yaml-bridge.js`
  (YAML round-trip fidelity incl. `serializeStream`/`parseStream`, with the real
  engine `configs/*.yml` as fixtures when present), `test-envelope-utils.js`
  (rescale/truncate/slice math — the last one is the split's tail half — plus
  the graphies the time walk used to miss, each asked by comparison against its
  own nested or array twin), `test-fingerprint.js` (fingerprint parity: which
  fields mark a stem stale), `test-render-status.js` (the stale/fresh/never
  classification + render summary, incl. the engine-semantics and renderer
  axes, source guards on the chain that carries the version from the engine to
  the dot and on the single read of the backend choice (`currentRenderer`)
  its readers share,
  a live two-overlapping-renders check that `run()` refuses re-entry, and the
  census — derived from the sources, never a list in the test — that every
  event type the editor branches on is one somebody emits),
  `test-history-core.js` (undo/redo stack
  mechanics: 200-cap, gesture collapse, redo-clearing), and `test-tweaks-store.js`
  (preferences `applyEdit` merge + a guard against the removed design-tool residue),
  and `test-audio-clock.js` (the playback clock's latency/lead compensation —
  `audiblePosition`/`playAt` in `window.PGEAudioClock`), and
  `test-stem-blobs.js` (the stem blob cache: when it reuses the bytes and when
  it must not — a re-render writes the same filename, so the key is the ETag —
  plus source guards on the element never receiving the http URL), and
  `test-magnify-spec.js` (the `--magnify-at` SPEC grammar in
  `window.PGEMagnifySpec`, plus source guards on the UI wiring), and
  `test-score-options.js` (the score switches that reach argv from the render
  popover — today `--bw`: source guards on the chain checkbox → tweak → POST
  body → argv, both halves of the `visualize` gate included, plus a canary that
  the engine's CLI still parses that token, since a flag it doesn't know is
  ignored in silence), and
  `test-time-dist.js` (the compact block's time-distribution registry mirror —
  `window.PGEEnv.timeDistError`, including the `(param, n_reps)` overflow whose
  thresholds are checked against the real engine, plus the no-longer-silent
  fallback in `computeCycleDurations` and the band where its warn may not speak
  for the engine), and `test-deviation-probability.js`
  (`window.PGEDeviationProb`: the off/implicit/global/perParam classifier,
  `error()` as the mirror of the bodies the engine rejects, the live/dead
  per-param keys tied to behaviour rather than to a copy of the list, and source
  guards on the UI wiring), and `test-envelope-catalog.js` (the two pure
  functions #140 pulled out of `EnvelopeEditor.jsx`: `wouldEmptyEnv`'s two
  historic false positives and the contract that it takes the *items*, plus
  `listEnvelopes` — its totality against the walk of `envelope-utils.js` **in
  both directions**, each side read out of its own module's source rather than
  transcribed, plus `streamWouldTruncate` asked by behaviour field by field,
  the loop/grain unit
  resolution and the inert `deviation_probability` keys — with source guards
  that the component keeps no copy), and `test-stream-id.js` (`allocStreamIds` never
  reuses an id that still owns a stem, plus source guards on its three call sites
  and on `deleteStream` staying a data-only mutation), and `test-stem-index.js`
  (the `hasStem`/`ownsStem` split over the format-keyed stem index, the
  format-aware `peaksUrl`/`spectrogramUrl`/`stemDur` of #153, plus source
  guards on the audio-error path and on the app.jsx wiring that passes the
  format; and a failed run re-reading from disk what isn't provenance — the
  durations, and the drawing through `stems-resync`, executed on the backend
  side and source-guarded on the three media effects), and
  `test-semantics-store.js` (where the two
  provenance records come from: `semanticsVersion` re-reading the
  bridge, and a whole `render.run()` writing/reading `pge-local-sem` and
  `pge-local-renderer` — the real
  backend driven with a fake `fetch` and `localStorage`; the renderer half
  lives beside the semantics one because both are written in the same block of
  `run()`, and a second copy of that harness would drift — plus the `done`
  fallback claiming only the streams the engine built, muted and solo cases
  included, and nothing at all on a failed run), and
  `test-renderer-axis.js` (the backend *choice* of #150, on top of that
  record: `backend.renderers()` reading `GET /renderers`,
  `PGERendererChoice.choices` deciding which backend buttons the popover
  lights and greys out, a whole `render.run()` recording the backend picked in
  the popover, plus source guards on the selector → tweak → POST body chain),
  and
  `test-oracle-client.js` (how the parity oracle's node client *dies*: a python
  killed between the `_dead` check and the write used to raise an unhandled
  `EPIPE`, replacing `_die`'s stderr-carrying diagnostic with a raw stack — the
  fake interpreter is `node -e`, so it needs no engine), and
  `test-suite-harness.js` (the suite's own
  exit contract: the verdict is an `exit` handler, verified by running it, plus
  a guard that every `tests/node/*.js` uses it and none went back to a
  positional exit gate — and a check on `source-guard.js` itself, the reading
  every other guard in the repo rests on; plus, since #164, the presidio on
  `bin/pge-ui`: it must stay a launcher — four code lines, one trailing `exec`,
  no bridge flag written inside — and it is *run* through a symlink against a
  stub `server.py`, which is the only way to show that `realpath` is doing its
  job; one of the forwarded arguments carries a space, which is the only way
  that half can tell `"$@"` from a bare `$@`, and a decoy `.venv` in the caller's
  folder is the only way the `realpath`-absent probe can tell a launcher that
  stops from one that resolves `REPO` onto `$PWD`; `make install-cli` is then run
  against temporary `BINDIR`s — with a space, with two, with a `~`, with one
  trailing slash, with three, with a slashed `HOME`, relative, empty, with no
  `HOME` at all and with no `realpath` on the `PATH`), and
  `test-tracks.js`
  (the track model: `deriveTracks`
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
  (`parse_render_line` events — including the summary-block gate and its
  canary, which reads the engine CLI's own head line by *position* rather than
  by words — the channel split measured by driving `RenderState.start` +
  `merged_output` + `render_events` over a real subprocess that writes protocol
  shapes to stderr, `build_render_command` flags, the kill/watchdog,
  and a Flask `make_app` smoke test via `test_client`), `test_cli_resolve.py`
  (the pure resolution of engine root and workspace — the precedence, the
  bounded walk up, the error text, the banner lines, plus the bridge launched
  as a real subprocess from an empty folder and a `make -n serve` that answers
  whether the Makefile still has the *same* precedence — that probe reads the
  **value of `--root`** on the recipe line, not "the path appears somewhere in
  the output", because `WS_FLAG` carries `$(ENGINE_ROOT)` too and would answer
  yes through `--workspace` while `--root` regressed; and it strips `MAKEFLAGS`
  from the child's environment, or a `make tests ROOT=/path` (the invocation
  this Makefile's own help suggests) would reach the nested make as a
  command-line `ROOT=` and turn the test red with the Makefile unchanged. It
  also asks **git** whether the four working folders are ignored at the repo
  root and *not* deeper, and launches the bridge over a folder holding a *file*
  named `output` — the third way an unusable workspace shows up, after "no
  engine" and "not a directory", and the one the `$PWD` default made easy to
  meet: `main()` catches the `OSError` from `_set_workspace`'s `mkdir` and names
  the folder, the same translation `POST /workspace` has always done with a
  400), `test_audio_pipeline.py`
  (path/security helpers, `_resolve_audio`, and the `/peaks` + `/spectrogram`
  routes serving the format that was asked for), `test_yaml_structure.py` (the engine config corpus,
  gated by `engine_corpus.py`), `test_renderers.py` (#150: the AST reads of the
  engine's backend list and SynthDef constants, `renderer_availability` against
  fake binaries on a temporary `PATH`, `GET /renderers`, the `renderers` row of
  `/diagnose`, `/render` refusing a backend the engine doesn't offer before the
  config write — plus three canaries on the real engine, the binary names among
  them), and `test_engine_render.py`
  (an engine render smoke test that skips when the sibling engine checkout/venv
  is absent).
- **`make tests-parity`** (node + python, needs the engine checkout) — the
  suites in `tests/parity/`, which ask the **engine itself** the questions the
  mirrors in `src/lib/` answer from memory. See "Parity harness" below and
  `tests/parity/README.md`. The parity suites don't own their
  verdict (`harness.js` does, for all five), but `test-suite-harness.js` still
  guards them against taking it back with a brutal exit.
- **`make tests-e2e`** (node + python + a browser, needs **neither** the engine
  checkout nor its venv) — `tests/e2e/test-boot.js`, the headless boot. See
  "Headless boot" below. It is the only suite that shows a component *works*
  rather than merely parsing, and the only one that runs the bridge over a real
  socket.

All four **accumulate** failures rather than stopping at the first red: with
twenty-odd suites, `|| exit 1` meant seeing one failure per run instead of the
whole census. That holds *between* the targets too — `tests: tests-node
tests-python` was a make dependency, so one red node suite made pytest **and**
parity disappear, and whoever ran `make tests` for the census got a third of
it. (`tests-e2e` joins that accumulation; it asks the engine nothing, so `ROOT=`
does not reach it.) **The three engine-facing targets forward `ROOT=` as
`PGE_ENGINE_ROOT`**, and all
three readers honour it (`tests/node/test-yaml-bridge.js`,
`tests/python/engine_corpus.py`, `tests/parity/harness.js`). Each half ignored
it in turn, and the symptom was never a red: `make tests-{python,node}
ROOT=/path` — the `ROOT=` this Makefile's own help suggests — skipped the corpus
and printed green, i.e. #132 through the back door. `test-suite-harness.js`
guards the three readers and the three recipes, and measures the node one by
running it against an invented root.

CI runs all of it on push and PR (`.github/workflows/ci.yml`), in three jobs:
`node`, `python` and `e2e`. The python job
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

**And the scanner that reads the source as code is itself guarded**, because
when it loses the thread every guard in the repo goes quiet at once. It is not
a parser: it recognizes comments, the three string spellings and regex
literals. An apostrophe inside JSX text (`each page's densest…`) used to open a
string that never closed, and from there down the file stopped being read as
code — in `RenderButton.jsx` that covered the whole of `buildCommand`, i.e.
exactly the lines `test-score-options.js` and `test-magnify-spec.js` watch:
commenting out `parts.push("--bw")` left the guard green, which is the one
failure `source-guard.js` exists to prevent. A quoted string cannot contain a
raw newline (only a template literal can), so a quote left unclosed at
end-of-line is text.

The other half is Python. `server.py` and `engine_introspect.py` go through
`codeOf` in three guards, and reading them with the JS scanner was a category
error — there `#` is not a comment and `"""` is three strings, so what came
back was a scramble that answered by luck. `codeOf` (and `maskOf`) now pick the
scanner from the extension. One consequence worth knowing: a Python **docstring
is a string**, so it survives like a JS string does — a guard meant to tell code
from prose needs a code-shaped needle (`opts.get("bw"`, not `bw`).

`test-suite-harness.js` pins all of it twice: minimal examples for both
scanners, and a census over `src/lib/`, `src/components/` and the bridge's
`.py` where no line that *starts* with its language's comment marker may
survive `codeOf`, and both readings must keep the file's length (the premise of
`depthAt`, which walks the mask at offsets found on the code).

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

What it does not do is prove a component *works* — a file can parse perfectly
and explode on its first render. That half is `tests/e2e/`.

### Headless boot (`tests/e2e/`, #139)

`make tests-e2e` opens the real `PGE Editor.html` in a headless Chromium
(playwright) against the real bridge, and asserts the four things that were
previously checked by hand: the page boots with **zero unhandled exceptions and
zero console errors**, a project loads and reaches the timeline, the Inspector
and the EnvelopeEditor open on a stream and the envelope *draws its
breakpoints*, and one undo/redo round trip lands back where it started. The
assertions are structural (how many breakpoints, which stream, what the `onset`
row reads), never pixels: a pixel assert ages badly, a boot assert doesn't.

Three decisions hold it up, and each is the answer to a way the test could have
been green while proving nothing:

- **The engine is not needed — neither its checkout nor its venv.**
  `tests/e2e/bridge.py` calls `server.make_app` directly (`main()` would exit on
  a missing `src/main.py`, and rightly) over a **stub** engine root plus a
  temporary copy of `tests/e2e/fixtures/`. The project the editor opens is
  versioned in this repo, so a fork PR without the engine secret runs the whole
  suite. Three stub files are load-bearing: `src/main.py`, so `/diagnose` has one
  fewer red check to add noise with, `.venv/bin/python`, because the boot
  fires `POST /setup` in the background and without it the test would build a
  venv instead of booting, and `src/pge/rendering/renderer_factory.py` (#150),
  the backend list the render popover turns into buttons. It declares `numpy`
  and a made-up `stub` on purpose: the bridge doesn't know what `stub` needs, so
  its availability is "don't know" and the button is clickable on any machine —
  with `csound` or `supercollider` the test would depend on the `PATH` of
  whoever runs it. The suite opens the popover, checks the buttons, switches
  backend and reads it back in the command preview.
- **The network is the test's, not the internet's.** `tests/e2e/browser.js`
  routes every request: the four CDN vendor scripts are served from
  `tests/e2e/node_modules` (the npm packages the CDNs publish), the CSS's three
  remote `@font-face` files are blocked, the app's own `http://localhost:7878`
  is rewritten onto the bridge's ephemeral port, and **anything else fails the
  test by name**. So CI does not depend on unpkg/cdnjs being up, and a new
  remote asset can't slip in unnoticed. Both lists are *read from the sources* —
  the `<script>` tags of the HTML, the `@font-face` blocks of `styles/*.css` —
  never transcribed, for the usual reason: a hand-written copy goes mute exactly
  when the dependency changes.
- **The vendor bytes are the user's bytes.** `verifyVendor()` recomputes the SRI
  hash of each local file and requires it to equal the `integrity` written in
  `PGE Editor.html`. A version bumped on one side only is a named failure
  instead of a boot that dies on a blocked script — and, incidentally, it is the
  only check in the repo that the published SRI hashes are right.

Two consequences worth keeping in mind. The `http://localhost:7878` rewrite
rests on that literal still being app.jsx's default (`tweaks.serverUrl` has no
entry in `TWEAK_DEFAULTS`, and preferences don't live in localStorage, so
there is no way to tell the app otherwise from outside) — a source guard pins
the pair, because without it the app would silently go `serverDown` and the
test would keep passing on half an application. And the console-error count
attributes an error to the *test* only when the console message's own
`location().url` is one of the blocked fonts: "Failed to load resource" is also
what a broken app fetch prints, which is precisely the case this suite exists
to catch.

Skipping is loud and bounded: `playwright` uninstalled or its browser not
downloaded prints the command to fix it and exits 0 — a 150 MB download is not
something a test target should trigger on its own — while `PGE_REQUIRE_E2E=1`
turns that skip into a failure. That is what the CI job passes, the same rule
as `PGE_REQUIRE_ENGINE_FIXTURES`. The static half of the suite (vendor, SRI,
source guard) runs even when the browser is absent.

`test-boot.js` is in `test-suite-harness.js`'s presidio like the `tests/node/`
suites: its verdict is an `exit` handler registered at module level. It needs
that more than they do — it is the only suite whose body can die for a reason
that isn't an assert (a `page.click` that times out, a python that won't
start), and without the handler that death exits 1 with a stack and no census
of what didn't run.

## Architecture

### Two-repo split (deliberate)

`PythonGranularEngine` stays a pure CLI (no Flask, no UI). `PGE-ui` (this repo) holds the editor + bridge. The bridge talks to the engine repo via `--root` and never mutates engine source — it works inside `configs/`, `output/`, `cache/` and `refs/`, all four of which can live in a workspace of their own (#147, and #148 for `refs/`; see below).

### Workspace: the project folder is not the engine checkout (#147, #148, #165)

`--root` is engine **source** (`src/main.py`, `.venv/`, `csound/`, `logs/`).
`--workspace` is where the *work* lives: `configs/`, `output/`, `cache/` and —
since #148 — the samples. `_ensure_venv_events` and the csound paths stay on
`--root` on purpose — engine code, not the author's work.

**Neither has a default written for someone standing inside this checkout any
more** (#165). The bridge is launched from the folder holding the piece, so:

- the **workspace** is `--workspace`, else the current folder. (`make serve`
  passes it explicitly — it runs from inside PGE-ui, where inheriting that
  default would create `configs/ output/ cache/` in the editor's own repo and
  make the author's projects vanish from the list.) `make_app(root)` with no
  workspace still means "= root": that is the *factory's* default, the one the
  tests and `tests/e2e/bridge.py` lean on, and `main()` always passes one.
- the **engine** is `--root`, else `$PGE_ENGINE_ROOT`, else an `engine/`
  containing `src/main.py` found walking up from the current folder, else an
  `EngineRootError` naming those three. `resolve_engine_root` returns the
  *source* along with the path, and the banner prints it: with three ways to
  declare an engine, "which one" is no longer enough to debug a launch.

Three properties of that resolution are load-bearing, and each is a test:

- **The precedence is the Makefile's** (explicit flag > environment > default).
  Kept identical on purpose — two precedences for one variable in one repo only
  show up when one of them is wrong. `make serve` used to pass `--root $(ROOT)`
  raw, i.e. ignore `PGE_ENGINE_ROOT` while `make tests` honoured it: it passes
  `$(ENGINE_ROOT)` now, and `test_cli_resolve.py` asks `make -n serve` rather
  than transcribing what it does.
- **A declaration that is wrong is an error, not a search.** A `--root` or
  `$PGE_ENGINE_ROOT` pointing at a folder without `src/main.py` stops the
  bridge naming it; falling through to the walk-up would run a *different*
  engine than the one asked for, which is exactly how an editor and a piece's
  own `make` end up on two engines without anyone writing it down.
- **The walk up is bounded** — it stops after looking at the first of: the git
  root, the home directory, the filesystem root. It is the fallback for a repo
  that has the submodule but not the `.envrc`; an `engine/` five folders up was
  declared by nobody. The home sentinel is an *equality*, so it never fires for
  a folder that isn't under `$HOME` (a piece on an external drive, `/srv`): there
  the bound is the filesystem root, i.e. a wider rule than `~/brani` gets for
  the same layout. Declared rather than accidental — `test_cli_resolve.py` pins
  it, and it is the case that speaks first if the bound is ever tightened.

Empty is absent, in both readings (`_declared`): `PGE_ENGINE_ROOT=` is the
commonest way to cancel an inherited one, and make's `$(if …)` reads it the same
way.

**The samples folder is `refs/`, or the `samples/` the workspace already has**
(#165). With the workspace on the current folder the name the bridge creates and
the name a piece already uses (`samples/`, matching the `--samples-dir samples`
of its own Makefile) meet for the first time, and an empty `refs/` beside a full
`samples/` is the worst outcome: two names for one thing, with the editor
listing the empty one. `resolve_media_dir` adopts the one that **exists** —
`refs/` first, it is the canonical name — and creates `refs/` only when neither
does; nothing is renamed. It is one rule in one place, so the hot switch goes
through it too. The chosen folder is what goes out as `--samples-dir`, so the
engine reads the folder the editor lists; `GET /workspace` carries
`samplesDirAdopted` because from a path the browser would see only a name, and
"the bridge creates it empty" said over a full folder sends the author looking
for samples that aren't missing.

`samplesDirAdopted` answers **which name won**, not "was it already there": a
`refs/` the workspace already had, full, is adopted just as much and reports
`false`. That is the right question for the sentence it drives (*why* the line
says `samples/`), so the other sentence must not promise emptiness — Settings
says "the bridge creates it if it's missing", true in all four cases, and
`tests/node/test-workspace.js` guards that none of the three phrases promises a
void the server never declared, and that the key is listed in the payload
contract at the top of `backend.js` — the one place that shape is written down,
so a key the panel reads and the contract omits is how the next backend forgets
it. For the same reason the name is printed wherever the folder is named: the
banner line, the `/diagnose` label and `/media`'s "folder missing" all read
`refs.name`, never the literal `refs/`. That last one is shown next to the
`path` it reports, so a fixed name sends the author looking in a folder the
bridge isn't watching.

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
every clip would read ⚪ with stems sitting on disk. The two provenance
records (`pge-local-sem` for the engine's reading, `pge-local-renderer` for the
backend that wrote the file) go with the index, and for the same reason: they
are statements about the *files* — "an engine that read the YAML this way wrote
this stem", "that backend produced it" — i.e. about exactly what the index
inventoried, the previous `output/`.
Inherited into a new folder they assert a reading nobody observed there, and
with identical YAML the fingerprint matches: 🟢 on stems an older engine wrote
differently, which is the case the axis was added for (#133). Without a record
the dot is 🟡 ("a stem whose reading I don't know") and clears itself on the
first pass, even an empty one. The backend records (`pge-local-renderer`, #150)
go with them for the identical reason — "supercollider wrote this stem" is a
statement about the previous `output/` — and `onWorkspaceChange` drops their
in-memory half too. What deliberately survives is `pge-local-fp`: it
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
through the same door. The probe in
`tests/python/test_render_pipeline.py` reads the `[CACHE]` literals **out of
the engine sources** instead of transcribing them: the six older assertions ran
on lines copied from this module's docstring, which is exactly why `Manifest`
and `GC` slipped through for so long.

**That filter is total** (#162). An absent or empty `state["ids"]` no longer
means "no filter, historical behaviour" — it means "the request declared no
streams", and from a request that declares nothing no event is derived. The old
reading left the only thing able to tell `[CACHE] stream1: clean` from
`[CACHE] Manifest: <path>` inert exactly when nobody had armed it. The browser
always declares them (`streams: data.streams`), so what changes is a request
that doesn't — and there the dots are safe anyway: on a successful run the
`done` fallback in `backend.js` emits a synthetic `stream-done` for every stem
the server found **on disk** (with no list it has no set to judge against, and
claims them all). What such a request loses is the live progress bar, never a
dot.

**Protocol is stdout, and only stdout** (#162, PGE #178). `RenderState.start`
used to spawn the engine with `stderr=subprocess.STDOUT`, so both streams
landed in one `readline` and **every** stderr line went through
`parse_render_line`. The engine gave itself the rule "nobody, on any channel,
writes lines shaped like the protocol" and guards it
(`tests/shared/test_stdout_contract.py`), but that rule binds the engine, not
its hosts: `logging` writes to stderr, and any third-party library inside that
process can still print a line of that shape. Measured with the engine's own
diagnostics switched on the way anyone would switch them on
(`logging.basicConfig(level=DEBUG, format="%(message)s")`): one
`[CACHE] %s: registrata` record produced `stream-start` + `stream-done` for a
stream named `gaussian`, which does not exist. In the default format the only
thing saving it was the `DEBUG:pge.diagnostics:` prefix the formatter
prepends — a choice of whoever launches, not a guarantee from the engine.

The file descriptor separated nothing because *we* were the ones merging it.
The two pipes stay two now, and `merged_output(proc)` reunites them
**labelled**: two daemon pumps onto one queue — both pipes have to be drained
always, or the child blocks the moment the unread one fills, which is the only
thing `stderr=STDOUT` ever bought — and the channel travels as far as
`render_events(channel, line, state)`, the one place where "protocol is stdout"
is written down. Order *between* the channels stays approximate, exactly as it
was (there the two streams' buffering decided, here the queue); order *within*
a channel is exact, and that is the only one the parser depends on, since the
per-stream state moves on stdout lines alone. One consequence worth keeping:
stderr cannot open the summary block either, so an indented error line citing a
sample can't re-enter through that door.

**The pipes decode with `errors="replace"`, and that is what keeps the pumps
alive.** With strict decoding a byte that isn't UTF-8 — csound, a C library, a
filename in another encoding: the bridge doesn't choose who writes inside the
engine's process — raised `UnicodeDecodeError` inside a pump's thread; the pump
died, stopped draining its pipe, the child stopped the moment that pipe filled,
and the render hung silent until the watchdog. The single reader of before had
turned the same byte into an `[ERROR]` and a `done`: separating the channels
made it a hang. Replaced, it is a `\ufffd` in a log line.
`test_render_pipeline.py` drives it, and `_drive` runs under a time cap so a
pipe nobody drains is a named red rather than a hung pytest.

**A DIRTY stream is closed by its own summary path line, and by nothing
else.** The `[CACHE] <id>: DIRTY` line says the stream *will* be rendered, not
that the previous one *was*: the parser used to close the previous DIRTY stream
on the next `[CACHE]`, reading them as "one per stream as each starts", but the
numpy renderer triages **every** stream before writing any
(`NumpyAudioRenderer.render_streams`, "Fase 1 — triage cache"), so they arrive
in one burst. Every DIRTY stream but the last got its `stream-done` before the
engine had touched a sample — and that event is a claim (fingerprint,
semantics, backend). On a successful run the cost was the drawing: the peaks
were fetched from the old file and never re-read. On a run that died after the
triage it was 🟢 on audio nobody rewrote, the very outcome the `done` fallback
below refuses on a failed run. So `parse_render_line` keeps the DIRTY ids in
`state["pending"]` and closes each on the path line that names its stem, which
the engine prints only after the render; a death before the summary block
closes none. The cost is progress granularity — the DIRTY dots turn together at
the end — and it is the truthful one. `tests/python/test_render_pipeline.py`
replays the triage-first order, the summary and a death in between.

The stream id in the summary path line is **not** constrained to `\w`:
`renameStream` advertises letters, digits, `.`, `_` and `-`, so an id with `-`
or `.` never got its `stream-done` — 🟡 after a render that did exactly what the
dot asked, and two renders needed per edit. With several ids pending a suffix is
not enough (both a basename and an id may contain `__`: with basename `x__b`,
`a`'s stem `x__b__a` also ends in `__b__a`), so `/render` passes the basename
and the line is matched on the **whole filename**, `<basename>__<id>`; without
one the longest pending suffix wins.

**And that line only counts inside the summary block** (#162). `_RE_STEM_PATH`
accepts any *indented* line ending in `__<something>.<aif|aiff|wav|flac>`, and
the engine's error messages cite sample paths in the same shape. Measured
(PGE #178): `  Path cercato: refs/voce__streamA.wav` closed stream `streamA` —
🟢 on a stem never written, which is the one mistake this parser cannot afford.
It takes a sample named like a pending stem — `<basename>__<id>` with the whole
filename matched, a mere suffix without the basename — the filename match
holding every other case; but that is a coincidence, not a defence. Narrowing
the regex was not the way out: a path can contain spaces
(`/Users/me/My Music/proj__s1.wav`), so every tightening on the *shape* of the
line would be paid with the lost `stream-done` of DIRTY streams, **every one**
of which depends on it (see above). What discriminates
is the **position**: the engine prints those paths in one block, under its own
head line, and inside that block every indented line *is* a path.
`_RE_SUMMARY_HEAD` opens it and the first unindented line closes it — no
declared terminator is needed, since what follows the paths is `Reaper
project:`, `Grain JSON:`, `Log:`, all at column zero, and before them the blank
line `print("\nGenerazione partitura grafica…")` prepends.

The gate opens on a line of Italian prose, so its one weakness is that prose
moving: then the block never opens and no path line closes a stream. On a
successful run the dots don't notice — the `done` fallback claims the built
streams no `stream-done` closed, through its per-run Set — but the live
progress goes; on a failed run nothing is claimed, the safe direction. It does
not stay in prose, though.
`test_render_pipeline.py` reads the head **out of the engine's CLI** and
recognizes it by *position* rather than by words: the `print` that precedes the
`for` whose body is a single `print` of indentation-plus-interpolation, i.e.
the very block `_RE_STEM_PATH` feeds on. A rename upstream is a named failure
here, like the `configs/` canary.

**`stream-progress` is gone** (#162). `app.jsx` had an
`e.type === "stream-progress"` branch writing state and drawing a bar inside
the clip's status dot, and nobody emitted that event — not `server.py`, not
`render_pipeline.py`, and the engine has no line to derive it from: the
progress a line-shaped protocol can carry is per *whole stream*
(`[CACHE] <id>: …`), not inside one. So the bar read 0% for the entire render
and 100% for the instant between a `stream-done` and the next `stream-start`,
on the stream that had just finished — residue, not information. The consumer,
the `streamProgress` state (both the per-stream map and the `renderStatus`
scalar), the `progress` field of `statusForStream` and the `.crs-bar` rules
went with it. The day the event really exists it will be because the protocol
went explicit — condition 2 of the three PGE #178 lists in the engine's
`docs/explanation/contratto-stdout.md` — and then the state comes back *with*
its emitter, not before.

`tests/node/test-render-status.js` holds that shape as a **census derived from
the sources**, never a list written in the test (a list is a second copy of the
truth, and the person adding an event is not the person who remembers to update
it): the event types `app.jsx` and `backend.js` branch on must be a subset of
those `server.py`, `render_pipeline.py` and `backend.js` emit. A consumer
without an emitter is the defect above; an emitter without a consumer is
legitimate and stays green (`venv-done`).

On the browser side the two writes have different rules, deliberately: the
`stream-done` handler marks the stem index **only for a declared stream** (the
event comes from a parsed log line, not from a file), while the `done` fallback
does not validate — `generated` is the list of files the server found on disk,
so even a deleted stream's stem exists and the index must know. What it must
not do is **claim** a file this run didn't write: a declared stream the engine
doesn't build — muted, or outside the solo set (`Generator._filter_solo_mute`)
— has an earlier run's stem on disk, perhaps another backend's or another
semantics', and the synthetic `stream-done` would stamp this run's fingerprint,
version and backend on it (🟢 once unmuted, on a stem the engine will redo).
So such a stream is indexed and nothing more; `PGEBackend.streamsEngineBuilds`
is the mirror of that filter, and `test-fingerprint-parity.js` runs it against
the engine's own method over every mute/solo combination of three streams.
An id the request doesn't declare at all — a deleted stream, or the old name of
a renamed one, whose stem survives a render without `--cache` because the
engine's GC runs only with it — is the same case one step further: the engine
didn't even read it. Claimed, its synthetic `stream-done` wrote `currentFps`
of a stream that isn't there (`undefined`) into the in-memory fingerprints, so
a Ctrl+Z brought it back ⚪ with its stem on disk, and another colour after a
reload. The set is authoritative only when the request carries it
(`Array.isArray(opts.streams)`); without a list the fallback claims as it always
did. That is *not* quite the bridge's rule for `state["ids"]`, which reads an
empty list as absent (both derive no event, #162): here `[]` is a list, and a YAML with no streams builds
nothing, so every file on disk is an earlier run's (`test-semantics-store.js`
pins the difference).
A **failed** run (`done` with `ok: false`) gets the same treatment for every
file, built streams included: the bridge lists the disk whatever the exit code,
and an engine that dies at parse time (a missing sample, a misspelled
`loop_unit`) has written nothing — claiming the list stamped this run's
records on every old stem and turned the whole timeline green under a "Render
failed" toast. Which stems were rewritten before a later death is unknown, and
unknown reads yellow. The **durations** are not provenance, though — they are a
measure of the file, and the disk knows it: without `--cache` every
`stream-done` comes from this fallback, so a run that dies *after* the audio
(grain JSON, score, Reaper export all come after the stems in `cli.py`) has
rewritten every stem and claimed none, and with `localFps` empty the
`loadCache` at the end of `run()` — the only re-read — never ran, leaving the
waveform cropped to the previous length. So a failed run that listed files
re-reads `/stems`; dropping the durations instead would have stretched the
waveform of an untouched file, on the commonest failure.
The **drawing** is a measure of the file too, and re-reading the duration alone
was half of it: the synthetic `stream-done` carried both the provenance records
*and* the media refresh (in `app.jsx` it is what raises `stemRevRef` /
`grainRegenRef` and, by moving `lastRenderedFps`, re-runs the three media
effects), so a failed run that gave up the first lost the second — on the
engine that died after the audio the clip played the new stem while drawing the
old one's peaks spread over the new length, #153 through another door. So after
the durations `run()` emits `stems-resync` with the ids the engine may have
rewritten (built streams only: a muted or undeclared one it certainly didn't
touch), and `app.jsx` does the media half of a `cached: false` — revision and
grain refetch — plus `setStemResync`, the signal the three effects list in
their deps, since here `lastRenderedFps` doesn't move. On an engine that died at
parse time it re-reads an untouched file and the bridge answers from its
mtime-keyed peaks cache: one request too many, never a wrong drawing.
`test-semantics-store.js` and `test-stem-index.js` drive it. That fallback's
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

### Choosing the backend (#150)

The engine renders with three backends — `--renderer numpy|csound|supercollider`
(PGE #228) — and keeps their list in one place, `RendererFactory._VALID_TYPES`,
exposed as `pge.api.renderer_types()` precisely so that a selector asks instead
of keeping a copy. The popover used to show `numpy` lit and `csound` disabled,
hardcoded, and no third button at all. Now:

- **`GET /renderers`** answers `[{name, available, detail}]` in the engine's
  order. The list is `engine_introspect.engine_renderer_types` (AST, mtime
  cache, `[]` = don't know); `test-fingerprint-parity.js` requires it to equal
  `renderer_types()` imported, order included. The availability is
  `render_pipeline.renderer_availability`, re-measured on every request (no
  cache: whoever installs SuperCollider with the bridge up sees it on the next
  popover open). `available` has **three** values: `false` greys the button out,
  `null` — a backend the bridge doesn't know the needs of, e.g. a fourth one
  added upstream — does not, and the engine gets to refuse it with its own
  message.
- **What each backend needs** is the one transcription in that module:
  `RENDERER_BINARIES` (`csound`; `scsynth`) and `SC_COMPILER` (`sclang`). The
  engine writes those names as defaults *inside a call*
  (`sc_config.get('scsynth_bin', 'scsynth')`), not as module constants, and an
  AST read of that argument would be more fragile than the copy —
  `test_engine_binaries_on_the_real_engine` requires each name as a string
  constant in the renderer module that spawns it. The `PATH` that counts is the
  bridge's: `Popen` inherits it. SuperCollider also needs its SynthDef compiled,
  or compilable: with `supercollider/pgeGrain.scsyndef` missing or older than
  its `.scd` (the engine's `_needs_compile`, a Makefile rule) the first render
  runs `sclang`, and without it the engine exits with
  `SuperColliderNotFoundError` — the Debian `supercollider-server`-only case.
  Where the SynthDef lives is read, not written: `engine_sc_synthdef` (AST on
  `DEFAULT_SYNTHDEF_SOURCE` / `DEFAULT_SYNTHDEF_DIR` / `SYNTH_NAME`), resolved
  against `root` because those defaults are relative to the subprocess's cwd,
  which is `root`. The bridge sends **no** `--sc-synthdef-*` flag for the same
  reason: a copy of the engine's defaults in argv would be a second place to
  keep aligned.
- **`/diagnose` has one `renderers` row**, green whenever the list is read: an
  optional backend that is missing is not a system fault (csound isn't even in
  the Fedora repos), and a red row per missing backend would raise the
  "Diagnostic issues" toast on every boot for nearly everyone. The detail still
  names who is missing and why. Red only when the list is unreadable.
- **`/render` refuses a name the engine doesn't offer** — a JSON 400 before the
  config write, like the format — and always refuses a non-name (`null` in argv
  is a `TypeError` from `Popen` inside the generator). With the list unreadable
  the name passes verbatim, which is the pre-#150 behaviour. It does **not**
  refuse an *unavailable* backend: the engine already does, with a message that
  names the remedy; the popover's job is to say it before.

On the browser side the choice is the tweak `renderRenderer` (default `numpy`,
the bridge's own default — a source guard pins the pair), and which buttons are
lit and clickable is `PGERendererChoice.choices` (`src/lib/renderer-choice.js`,
pure, node-tested). No backend name is written in `RenderButton.jsx`. Two edges,
and neither hides the lit button: with the list unknown only the current backend
is shown, lit and locked (the old single-button behaviour); a current backend
the engine no longer offers is shown lit and disabled at the end, so the render
the bridge would refuse is visible before it is sent. The list is fetched at
boot and on every popover open (`onOpen` → `refreshRenderers`). A click on the
already-lit backend writes nothing — `Seg`'s lesson, on hand-written buttons.

Switching backend marks every stem rendered by another one stale — the renderer
axis described under "Fingerprint parity". Two engine flags are deliberately not
exposed: `--keep-osc` is a debugging aid, and `--sc-block-size` (1 = sample-
accurate onsets, higher = faster with quantized onsets) is **not in the engine's
fingerprint**, so changing it would leave the engine calling every stem clean
while the onsets it would produce moved — it needs an axis first, and the engine
to own it.

### Score options that can kill a render

Two options exit 1 (taking audio with them): unknown `--plot-envelopes` name, malformed `--magnify-at` SPEC. Both are filtered before reaching argv, but in different places:

- **Envelope names** → filtered *server-side* (`server.py` intersects them with `engine_envelope_keys(root)`) because the valid set lives in engine source. That AST read is the **only** bridge between `ENVELOPE_COLORS` and the UI — there is no static fallback list, `backend.envelopeKeys()` returns `[]` and the filter hides — so a rename upstream used to make the whole filter vanish silently instead of failing. `tests/parity/test-bounds-parity.js` now points it at the real file: the AST read must equal the imported keys *in source order* (the popover draws them in that order), and `PLOT_ENVELOPE_KEYS` — the set `cli.py` actually validates against — must still be `frozenset(ENVELOPE_COLORS)`, since the day the engine narrows one without the other the server filter becomes wider than the engine and a name gets through to `exit 1`.
- **Lens SPEC** → filtered *client-side* (`src/lib/magnify-spec.js`, node-tested) because it's free text typed in the render popover and the useful error moment is while typing. The grammar mirrors Python's `float()`, not JS's `Number()` — they disagree on `0x10`, `1_000`, `inf` — and the strip is ASCII-only, a subset of Python's `str.strip()`, so the residual divergence is guaranteed safe-direction (JS `trim()` eats U+FEFF, `str.strip()` doesn't — that one killed renders). `tests/parity/test-magnify-parity.js` checks the whole corpus against the engine.

  **`error()` and `sendable()` answer different questions, and both live in the module.** `error(spec)` is the red text under the field; `sendable(spec)` returns *the bytes that reach argv*, or `null` when the flag must not be sent at all (empty SPEC, separators only, bad grammar). `app.jsx` and `RenderButton.buildCommand` both call `sendable` — when the gate was a copy in `app.jsx` it stayed on `.trim()` while the module moved to the ASCII strip, and the popover showed red on a SPEC that then went out cleaned. The tests call it too, so removing the empty-SPEC guard is red instead of silent.

**The third score option is not on that list, and that is the whole point.**
`--bw` (PGE #248 / #152) is a switch: no value to parse, nothing to spell
wrong, so it cannot exit 1 and needs no filter on either side. What it needs is
the chain — the popover checkbox, `renderBw` in the tweaks, `bw` in the POST
body, `--bw` in `build_render_command`, all gated on `visualize` like
`--show-static` — because its way of failing is the opposite one: on an engine
that doesn't know the flag (CLI parsed by hand over `sys.argv`, unknown flags
ignored, exactly like `--samples-dir`) the render succeeds, just in colour. So
the flag goes out with no version gate, and what watches it is
`tests/node/test-score-options.js`: the chain by source guard, the engine's
spelling by canary, the body → argv half in `tests/python/test_render_pipeline.py`.

The request body carries `yamlContent`. `server.py` writes it **to the canonical `configs/<basename>.yml`** before invoking the engine — *not* a throwaway temp file. A temp name like `tmpXXXX.yml` would produce a fresh `cache/tmpXXXX.json` every run and mark **all** streams DIRTY, defeating incremental caching. Writing the stable basename keeps the manifest persistent. Consequence: a render persists the editor state to the source config even if the user never hit Save. **Git is the rollback mechanism** (`git checkout -- configs/<basename>.yml`).

### YAML bodies that can kill a render

Two engine rejections the UI mirrors client-side (PGE #209/#212, PGE-ui #123):

**`deviation_probability`** with a body that can't build as an envelope exits 1. `window.PGEDeviationProb.error` (`src/lib/deviation-probability.js`, node-tested) is the mirror — deliberately the *conservative half*: it flags only bodies that can't be an envelope in any reading, so mixed forms pass here and are caught by the engine. The Inspector shows the error below the mode selector.

Per-param key lists — important distinction:
- `PARAM_KEYS` (5): keys the engine consults **always** (`volume`, `pan`, `duration`, `pitch`, `pointer`).
- `liveParamKeys(stream)` (adds 3 conditional on the `grain` block): `reverse`/`read_direction` (exclusive group, engine reads exactly one) and `pc_rand_envelope` (live unless `grain.envelope` is transition/multistate).
- `ALL_PARAM_KEYS` (8 + dead `envelope`): every key the editor may find written — used by the envelope walk (`envelope-utils.js`) and `listEnvelopes` (`envelope-catalog.js`), which need format-agnostic coverage regardless of liveness.

`isEnvValue` — which decides global-vs-per-param — is the engine's dict rule verbatim: **`'points' in obj`**, nothing more.

The `envelope` per-param key is always inert (its spec is `is_smart=False`). The Inspector shows rows for it so it's visible and removable; the EnvelopeEditor's selector marks it the same way via `window.PGEDeviationProb.inertReason` (one function, shared). It sat on `window.PGE` — i.e. in `Inspector.jsx` — until #140 made the catalog a lib, at which point reading it there would have been a `src/lib/` module depending on a component.

**`wouldEmptyEnv` and `listEnvelopes` live in `src/lib/`, not in the component** (#140), for the reason `history-core.js`, `render-status.js` and `tweaks-store.js` do: they are pure, they decide in the component's stead, and an error in either is *silent* — `wouldEmptyEnv` either lets through a body the engine rejects or refuses a full envelope it doesn't recognize, and a missing `listEnvelopes` entry makes a written envelope unreachable while the Inspector opens a different one. `wouldEmptyEnv` sits in `envelope-loops.js`, beside the three predicates its answer is the sum of; `listEnvelopes` has its own `envelope-catalog.js` (`window.PGEEnvCatalog`), since it pulls in `loopEnvMax`/`loopUnitSuffix`, `grainUnitBounds` and the inert-key reason. `EnvelopeEditor.jsx` binds both by name at the top of the file and keeps the glue.

The catalog owns no table of its own, and the last one to go was the pitch unit's
**symbol**: the two `stream.pitch` rows spelled the six cases out again in a
ternary chain, while the two `voices.pitch` rows beside them (and the Inspector,
on the same curve's row) ask `PGEEnv.pitchUnitSymbol`. On the five presets the
copies agreed; on `edo` they did not — `°edo` against the module's `°/N` — so the
same curve carried two labels in one panel, and the catalog's one lost the
divisions count, which is the only thing that symbol has to say.

Their only coverage before that was **by extraction** — `extractFn` + `new Function` over the JSX, inside a `try` that fell back to `() => []` — so a broken extraction left half the assertions green (`{}.inert === undefined` is true of an empty list). `tests/node/test-envelope-catalog.js` runs them instead.

**The catalog and the resize walk are one list written three times, and the three must agree.** `listEnvelopes` says what can be opened and drawn; `_applyEnvFields` (`envelope-utils.js`) is what `rescaleStreamEnvelopes` / `truncateStreamEnvelopes` / `sliceStreamEnvelopes` rewrite on every resize and every split; `streamWouldTruncate` is the third, and it is the one that decides whether to ask before a resize eats breakpoints. A field the walk rewrites and the catalog can't open is an envelope the editor moves and nobody can see. The other direction is quieter and was live: `voices.pan.stepEnv` was in the catalog and in neither of the other two, so that curve — which the engine resolves against stream time, `StepPanStrategy.get_pan_offset` → `resolve_param(self.step, time)`, exactly like its `pitch` and `pointer` namesakes — stayed in the old time frame while every other curve moved, with no error and not even the "you'll lose breakpoints" confirm. `test-envelope-catalog.js` pins all three, and the two lists it compares are **read from two different files** (the `wf(…)` calls out of `envelope-utils.js`, the `path:` literals out of `envelope-catalog.js`): the first version built its fat stream out of the walk, so a field dropped from the walk vanished from both sides at once and the check stayed green on the very defect it was written for. `streamWouldTruncate` is asked by *behaviour*, field by field, never by reading its list — that would be a fourth copy. `deviationProbability` is the one exemption, since the walk reaches it through `_applyDeviationProb` rather than `wf`, and the exemption has its own executed case.

`wouldEmptyEnv` guards all five delete/paste paths in the EnvelopeEditor. It takes the **desugared items** (not wrapped). A caller holding a wrapped value must `unwrapEnv` first. Two forms the item count can't see on its own: a bare compact block, answered inside the function without wrapping it (a count question — a block already counts as one; whoever needs to *index* the items goes through `desugarBPGroups`, which wraps both bare graphies alike), and a dict breakpoint `{t, v}` — that one through `PGEEnv.isDictBreakpoint`, shared with `PGEEnv.firstBreakpointY`, which reads the same point's y.

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

A `null` engine `max_val` keeps the static fallback cap — except the `loop_*` trio, whose `max_val` is `null` because the real cap is the **chosen sample's duration**. `loopEnvMax` in `envelope-utils.js` drives the EnvelopeEditor `hardMax` + Inspector scalar clamp from that duration, unit-aware (`loop_unit` alone — seconds → `sample_dur`, normalized → `1`), falling back to the static cap only when the duration is unknown.

Loop-window semantics: with a loop active the engine confines the grain read position to `[loop_start, loop_end)` via modular wrap. A loop straddling the file end is expressible **only** via `loop_dur` (`loop_start + loop_dur > sample_dur`); `loop_end` stays bound to `[0, sample_dur]`. `loopBoundsError` in `envelope-utils.js` mirrors the static degenerate-window check (`loop_end <= loop_start`).

**`loop_unit` inherits nothing** (PGE #222, PGE-ui #149). It used to fall back to
the stream's `time_mode`; the engine cut that — the two keys govern different
axes with different references (`time_mode` scales the envelopes' *x* on the
stream duration, `loop_unit` scales the *y* — a position in the sample — on
`sample_dur_sec`) — and the default is now `seconds`, a constant. The vocabulary
became explicit too: `('seconds', 'absolute', 'normalized')`, where `seconds` is
canonical and `absolute` the historical alias for the same reading; anything else
is `InvalidFieldValueError` instead of the old silent "not normalized, therefore
absolute".

`loopUnitInfo` in `envelope-utils.js` returns the reading (`unit`: `normalized` /
`absolute`), the spelling as written, and the provenance — now two-valued,
`loop_unit` / `default`. `loopUnitError` is the mirror of the engine's refusal,
shown under the Inspector's selector. Picking the **default** deletes the key
rather than materializing a redundant one; that rule survives #222 only because
"redundant" is finally a property of the key and not of the stream hosting it.
Switching the unit re-clamps scalar endpoints; envelope endpoints are per-grain
and exempt.

`loopUnitError` existing pulls two neighbours into line, both of the same shape
as `grain.duration_unit` one section down. `loopUnitSuffix` (same module, read by
both the Inspector and the EnvelopeEditor) is the single source of the `s` on
`pointer.start` and the three loop rows, and it goes **quiet** on a spelling
outside the vocabulary — labelling seconds beside the red row that declares the
unit unrecognized would be two opposite statements, which is exactly what
`grainUnitSuffix` already says in its own comment. And `loopUnitError` judges
only spellings the engine will actually see: a *falsy* one (`loop_unit: 0`,
`false`, `""`) is dropped by the serializer (`ptr.loopUnit || undefined`) and
`/render` writes the editor's state to the config before launching, so the key
never reaches the parser — accusing it would be a red on a render that succeeds,
and would contradict `loopUnitInfo`, which reports those as absent
(`source: "default"`).

**The Raw tab is on that list too**, and it was the last place still measuring
the loop window in seconds flat. `computeAnnotations` (`YamlEditor.jsx`)
compared `loop_end` / `loop_dur` against `sampleRec.duration`, which is only
the cap when the unit *is* seconds; under `normalized` the coordinates live in
`[0,1]` and the cap is `1`, the file's length not entering the comparison at
all. So it was wrong in both directions, and the loud one hit the commonest
population: `loop_end: 0.9` normalized on a 0.4 s sample is 0.36 s, inside the
file, and it drew a red naming seconds — on a stream the engine accepts, three
rows away from the unit-aware suffix of the Preview tab saying the opposite.
The quiet one is `loop_end: 5` normalized on an 8 s sample: five times past the
file end, and `5 > 8` is false. The cap comes from `loopEnvMax` now, the same
single source the Inspector and the EnvelopeEditor read, and a `null` cap
(seconds with the duration unknown) makes the check say nothing rather than
compare against `undefined`. Its node coverage lives in `test-yaml-bridge.js`,
which therefore loads `envelope-loops` / `deviation-probability` /
`envelope-utils` beside the bridge, in the editor's own order.

**The unit's spelling comes before the cap**, because the cap depends on it.
Outside the vocabulary (`normalised`) the engine raises on the unit and never
looks at the window, while `loopUnitInfo` still reads that spelling as absolute
*by exclusion* — its fallback — so measuring the window would draw a red naming
an unit that is not the one written, three rows from a Preview tab that puts no
`s` on those same rows (`loopUnitSuffix` goes quiet on purpose). So the red is
the true one — `loop_unit` itself, named and with the vocabulary — and the
window check says nothing, the same rule as the unknown cap. A *falsy* spelling
is not a typo but an absent key (the serializer drops it), so there the seconds
check stands, exactly as `loopUnitInfo` reports it.

Two consequences the editor had to be taught, both of which turned a healthy
stream into an exposed one. `Seg` calls `onChange` on the already-active button,
so a click on the lit "normalized" used to delete the explicit key of every clip
the editor creates — and `loopUnitInfo` then still answered "normalized" by
inheritance, so nothing on screen moved while the engine started reading seconds.
The handler now returns early when the reading doesn't change. And the ×
"Remove loop" deleted `loop_unit` along with the six loop keys, though the unit
also governs `pointer.start`, which outlives the loop: the loop rows
(`loopWindowShown`) and the unit control (`loopUnitShown`) are separate blocks
now, so removing the loop leaves the unit standing.

The **AddParamMenu is the other half of that lesson**, and it was written for one
unit. It is the widest door `loop_start` / `loop_end` / `loop_dur` come through
— not the only one, see below — and its three entries stated the seconds domain flat — `(s)`,
`∈ [0, sample_dur]`, `loop_start+loop_dur > sample_dur` — under a control whose
whole point is that the unit varies; the very rows those entries create have had
a unit-aware suffix since `loopUnitSuffix`, so the menu contradicted the row it
opened. They read the unit now (`loopDomain` / `loopEndDomain` / `loopEndRange` /
`loopFileEnd`, one `loopNormalized` behind them), as does the `loop_end` hint
under the loop rows.

And on a spelling outside the vocabulary they **declare no domain at all**, for
the same reason `loopUnitSuffix` drops the `s`: `loopUnitInfo` reads such a
spelling as absolute by exclusion, so without the filter the three entries said
`(s)` beside the red row declaring the unit unrecognized and above rows left
deliberately unlabelled — the two opposite statements this whole change removes,
put back from the menu's side. Hence `loopUnitKnown` (`!loopUnitErr`) in front
of the four strings, and `loopClause` around each: they are *optional* clauses
that disappear rather than lie, leaving no double space or orphan comma.

The **seed** moved for a sharper reason than prose. `def: 1` could not be wrong
under inheritance: `time_mode: normalized` made the key normalized, and there `1`
*is* the end of the file. Post-#222 that same population reads seconds, where `1`
is one second — past the cap on any sample shorter than that, i.e. the menu
writing a value a typed edit would have clamped. The seed is `loopSeedWhole` now,
"the whole file in the unit in force", which is the cap itself (`loopEnvMax`,
already computed as `loopMax`): `1` normalized, `sample_dur` in seconds, and `1`
again when the sample duration is unknown — the only number available there, and
what the menu wrote before. `loop_start` keeps its `0`: zero is zero under any
scale factor, the same reason the migration warning filters on
`loopUnitRescaleKeys`. The truncation has a floor (`|| loopMax`): on a sample
shorter than a tenth of a millisecond `Math.floor(cap * 1e4)` is `0`, and a
zero-length seed is degenerate for `loopBoundsError` and under `loop_dur`'s
static minimum — overshooting the cap by digits below the truncation threshold
is the smaller evil. Same fix as #114's `grainSecondsToUnit(0.01, grainUnit)`
one section down, one level over.

The menu is not the only door, and the others don't go through a menu at all.
The `loop_end ↔ loop_dur` toggle, with `loop_start` standing alone, had no
length to start from and fell back to a bare `1` — and did not clamp at all.
The **scalar↔env toggle of the two rows** is the next one: with `loop_start`
alone the `loop_dur` row is already there and the key is not, so that branch
*seeds* (and the row is the third, since the number it shows while the key is
absent is where a `NumberField` drag starts from — it was a bare `1` too). Its
other half was `|| 1` on the way back: an envelope opening on `0` — a
legitimate `loop_end` — collapsed onto a value the curve never had, so the
first breakpoint's y is read as it is. Every one of them is `loopSeedWhole`
now; `loop_start` keeps its `0` everywhere.

And the `loop_end ↔ loop_dur` Seg needed #149's other lesson, the one the unit
selector learned one block down: **`Seg` calls `onChange` on the already-lit
button**, and both branches write the scalar and null the envelope — so a click
that asked for nothing replaced a `loop_end` curve with a seed, or a `loop_dur`
curve with `0.01`. It returns early now, on `loopEndSel`: the condition that
recognizes the no-op is *the same one* that lights the button, not a second
copy of it, because two copies is how such a guard stops covering the case it
exists for. From the scalar side that click was an `onChange` for nothing — an
undo step and a stem marked dirty. (The scalar↔env Seg has the same defect one
level up, in `toggleMode`, where it costs the envelope of *any* parameter: a
guard there belongs to its own change, not to this one.) The row under it picks
its key from `loopEndMode` for the same reason — a third copy of that condition
would be the row free to disagree with the selector that chooses it.

A **real** click on that Seg converts between two mutually exclusive keys, so
the curve cannot survive either way — but the number replacing it has to be the
one the curve stated. Both branches used to ignore the envelope outright
(`stream.pointer.loopEnd || 0`), so a `loop_endEnv` sitting at `6` came back as
`loop_dur: 0.01`, the floor, and a `loop_durEnv` at `3` came back as the end of
the file. That is the `|| 1` of `toggleMode` one level over, on the same panel,
which is why `loopSeedFrom` is declared **once** in the component body and read
by all three loop handlers rather than living inside the one that found it
first. The `loop_dur` branch got the cap too, for the symmetry the `loop_end`
branch had just been given — a length longer than the file is exactly what the
row clamps when the number is typed.

**"The first breakpoint" is not `env[0]`**, and reading it that way put the
constant straight back. It is the same rule `wouldEmptyEnv` states one section
up — a caller holding a wrapped value must `unwrapEnv` first — and the wrapped
spelling here is not exotic: `wrapEnv` produces `{type, points}` the moment a
pure-BP curve's global interp stops being linear, so the EnvelopeEditor writes
it by itself. Indexed at `[0]` that dict has nothing, and a `loop_end` curve
sitting at `6` came back as the whole file. A **compact block** as the first
item was the other half and worse than the fallback: there `env[0][1]` is the
block's *end time* (the module header spells the shape out:
`[pattern, end_time, n_reps, interp?, dist?]`), so a `typeof … === "number"`
guard meant to reject the shape let it through and wrote an absolute time as a
position in the sample.
`firstBreakpointY` desugars the BP groups and asks the module's own predicates,
not a third copy of the rule, so every spelling that states a y gives it up — and
there are **two** predicates because a point has two spellings. The dict
`{t, v}` is one of them: the engine's builder normalizes it to `[t, v]` before
looking at it (`envelope_builder.py:132`) and `wouldEmptyEnv` already counts it
as a real point, so a y it has, and it is `v`. `isBreakpoint` alone cannot see
it (it demands `Array.isArray`) and must not be widened — it also says what the
canvas can drag, and a dict is not drawn — hence `isDictBreakpoint` beside it in
`envelope-loops.js`, the one predicate shared by the two readers of that
spelling (`wouldEmptyEnv` counting points, `firstBreakpointY` reading one).
Counting it among the shapes without a y put the constant back on exactly that
spelling. Only the compact block falls back, which genuinely has none. The
fallback belongs to the **caller**, because it is the default of its parameter
and the module knows none of them: `loopSeedFrom` is the loop's thin wrapper
that supplies `loopSeedWhole`, `loop_start` passes `0` — the same seed the menu
gives it — and reads through the shared reader instead of the `|| 0` that could
not tell a curve worth zero from a curve it could not read; that is also true of
the `loop_start` the Seg's own conversion needs, since the length it computes is
the distance *from* there: a `loop_startEnv` sitting at `3` under a `loop_end` of
`6` produced a window of `6` instead of `3`, doubled by one click.

**That reading is not a loop question, and leaving it in one handler is what
kept twelve others broken.** `env[0][1] || default` was the spelling of every
env→scalar branch in `toggleMode` and of both `deviation_probability` Segs, so
the three failures above were live on `pan`, `density`, `pitch`, `speed_ratio`,
the `_range` keys and the probability alike — and on a BP group the worst of
them is worse still, since `env[0][1]` there is the interp's **string**: a
`|| default` waves it through and writes `pan: "cubic"` into the YAML. So the
reader lives in `envelope-loops.js` as `firstBreakpointY(env, fallback)` and all
fifteen sites call it — the twelve `toggleMode` branches directly, the three
loop keys through `loopSeedFrom`, the two Segs by their own name — with its own
coverage in `test-bp-groups.js`, beside the predicates it rests on.

**And `Seg` fires on the already-lit button — that is a property of the
control, so every one of its `onChange`s owes a guard.** `loop_unit` learned it
in #149 and `loop_end ↔ loop_dur` here, but the widest one is the scalar↔env
`Seg` of every `ParamRow`: it goes through `toggleMode`, whose `env` branch does
not look at the envelope at all — it reads the scalar, which in env mode is
`null`, and seeds a flat ramp on the default. A click on the lit "env" therefore
replaced *any* parameter's curve with a straight line, and the two
`deviation_probability` Segs did the same thing by their own route (there the
per-param branch seeds from `val`, which is the envelope itself, so the flat
line reads `1`). All three return early now, each on the expression that is
literally its Seg's `value` — never on a second copy of it, for the reason
`loopEndSel` states. From the scalar side the same click was already a write for
nothing: an undo step and a stem marked dirty.

**But "asks for nothing" is not "the button is already lit" — it is "the mode
the button picks is already written"**, and the two diverge exactly on the rows
whose parameter is *absent*. The engine has a default and the key is missing, so
the caller passes a `value` that is not a number (`—`) and the row draws no
`NumberField`: there the click on the lit button is the only way in, because the
scalar branch materializes the key on the parameter's default. Refusing it left
those rows with no way to write at all — the `density` of the streams that
declare neither `density` nor `fill_factor` (eight in the engine's own config
corpus) and the twelve strategy rows of `VoicesSection`, where a hand-written
YAML may name the strategy without its parameter. So the guard stands down where
the row offers no other entrance, and the row itself says so: a non-numeric
`value` means no field, an absent `envValue` means no curve. Which is why the
condition cannot live downstream: `toggleMode` has only the first half —
"scritta?" is a per-key question across sixteen branches — and a copy there with
that half alone refused the materializing click, i.e. precisely the case where
the two questions differ. `ParamRow.handleMode` has both halves, so it is the
single place, and `toggleMode` and the global `deviation_probability` row keep
**no** copy of it. The per-param `deviation_probability` Seg keeps its own
because it builds its own `Seg`, and there the row is filtered on
`d[p.key] != null`, so the value is always written.

**The guard belongs to `ParamRow`, and the Inspector is not where its rows
end.** Sixteen of them go through `toggleMode`; the other **fourteen** live in
`VoicesSection.jsx` — `num_voices`, `scatter`, and the twelve strategy
parameters through `toggleStratParam` — and no `ParamRow` calls
`toggleMode("voicesNum")` or `toggleMode("scatter")`, so those two branches of
it are not the live rows. The live ones carried the whole defect, both halves:
the flat ramp on the lit "env", and `env[0][1]` on the way back — worse there
than a wrong number, since a compact block gives up its *end time* under that
index when it sits inside an array, and the pattern's *second point* — an array
— in the direct spelling: neither of them a number of voices, and `|| default`
waves both through because both are truthy. So the
no-op guard sits in `ParamRow.handleMode` (`primitives.jsx`), the one place
where the condition **is** the Seg's `value` by construction *and* where the
"already written" half is readable (`value`, `envValue`), for every row of the
editor and for the next one added. The three readers in `VoicesSection` call
`firstBreakpointY` like the twelve in `toggleMode`.

**`density ↔ fill_factor` is the third mutually exclusive pair** — the shape of
`loop_end ↔ loop_dur` one panel over, and the most expensive no-op of the
family: both branches write their constant *and* null the envelope, so a click
on the already-lit button took a `fill_factor` the author had chosen back to
`2.0` and replaced a `density` curve with `8`. It returns early on
`densityUnitSel`, which is also the Seg's `value` — and on `densityUnitWritten`,
the same second half as `ParamRow`: neither key is mandatory, so the `density`
button is also lit *by exclusion*, and on the eight corpus streams that declare
neither, that click was the only way to give the stream a density. The one
declaration serves four readers now — the Seg's `value`, its guard, the row
below it and the section badge — where the last two used to re-derive the
condition, i.e. the third and fourth copies free to disagree with the selector
that governs them (the reason `loopEndMode` exists for the loop pair). What it
deliberately does not do is carry the number across on a **real** click: grains per second and an
overlap factor are different quantities, and converting one into the other
(`fill = density × grain_dur`) is a modelling decision, not the curve-reading
fix above.

**Four more `Seg`s in the Inspector owed the same guard**, and the rule really
is the control's: `distribution_mode` and `clip_strategy` materialized their own
default on the lit button — a redundant key, an undo step and a moved
fingerprint on a stream that sounds identical — while the other two *deleted*,
which is the case #149 found on `loop_unit`. `range_anchor` writes `undefined`
on the default ("picking the default drops the redundant key", right on a
change, wrong on a click that asks for nothing: an explicit `range_anchor:
center` vanished from the YAML), and `duration_unit` goes through
`convertGrainDurationUnit`, whose tail does `delete ng.durationUnit` for
`seconds` regardless of the conversion. Each returns early on the expression
that is its own Seg's `value`.

**Two more owed it too, and the census could not see them**, because their
`onChange` is a *named* function rather than an arrow inside the element: the
guard has to live in the declaration, where a regex over the `<Seg …/>` finds
nothing. They were the two the census exempted by name, so the exemption was
doing the hiding.

- The `deviation_probability` **mode** Seg (off / implicit / global / per-param)
  writes on all four branches. `deviation_probability: true` is a valid global —
  the engine reads `float(True)` = 1% — so "global" is lit, and that click
  rewrote the key as `1`: exactly the migration the `dScalar` line three rows up
  exists *not* to perform ("without rewriting the YAML until it is touched"),
  i.e. a moved fingerprint and a yellow dot on a stream that sounds identical.
  It returns early on `mode`, its Seg's `value`; normalizing `true` into `1`
  stays available through the row's own `NumberField`, which is drawn precisely
  because `dScalar` is a number.
- `read_direction`'s. Its exemption was real but **wider than its reason**: the
  lit button is the remedy for an inherited `reverse` / `read_direction`
  conflict, and only then. With no conflict — a lone `reverse:`, which the
  engine reads perfectly well — that same click deleted the key and wrote
  `read_direction: -1`: a silent migration that moves the fingerprint and
  yellows the stem on a direction that did not change, while the row's own hint
  says the migration happens when you *pick another one*. On `read_direction: 1`
  or on `auto` it re-emitted an identical `grain`, an undo step for nothing. So
  the guard is `next === state && !err`, with `err` the `readDirectionError`
  already computed for the message below: it stands down exactly where there is
  something to repair, and the other three buttons stay open on every state.

So one Seg is left deliberately unguarded — the tab selector, whose `onTab` is a
React `setState` and not a write to the stream. `test-envelope-utils.js` still
censuses the file so a new one cannot join quietly, and pins the two named
handlers' guard as the *first statement* of their declaration, besides executing
both.

**And the Seg can be lit on a mode the stream does not hold**, which is the one
way a click that passes every guard above still costs a value. `getMode` reads
`paramModes` — the panel's memory of which button was pressed — *before* the
stream, and the Inspector has no `key` in `app.jsx`, so it does not remount when
the selection changes: the choice made on one stream stayed lit on the next.
There "env" over a row showing a scalar makes the click on "scalar" a **real**
change, which no guard may refuse, and `toggleMode` then collapses the row onto
the parameter's default — `pan: 30` rewritten `pan: 0`. The memory is therefore
reset with the selection (a `modesOwner` reconciliation in the render body, so
React discards that render and no frame is ever drawn with the previous
stream's memory). Nothing is lost by resetting: after any toggle `paramModes` is
redundant with the stream — `getMode` derives "env" from the `*Env` twin of each
of the sixteen keys — and it only keeps the button lit in the frame between the
click and the new stream arriving.

The unit control's own visibility must not go through `time_mode` either, and
that is a third way the same dependency crept back. `loopUnitShown` shows the
selector wherever the unit *governs a value that moves*
(`loopUnitScaledKeys`, below), never on the migration warning's condition, which
carries `time_mode` inside it. With the warning's condition the control erased
itself: on `time_mode: absolute` + `loop_unit: normalized` + `start: 0.5` — the
coexistence of the two axes that #222 made legitimate — a click on "seconds"
deletes the key, the selector disappears (`loop_unit` is not in the
AddParamMenu, so the selector *is* the only way to write it) and `start` is left
reading `0.5` s where it read `0.5 × sample_dur`, with no way back short of the
Raw tab. The live condition is strictly wider than the old one — a migrated
stream always has keys that move — so the population #222 displaced still sees
the control together with its warning, and `start: 0` with no loop still shows
nothing, exactly where the engine is also silent.

The Inspector also warns the population #222 moved under the feet — `time_mode:
normalized` with no `loop_unit`, which the engine reads as seconds now — but
only where the numbers actually move. `loopUnitRescaleKeys` in
`envelope-utils.js` is the mirror of the engine's `_rescaling_would_change` over
its `_LOOP_UNIT_SCOPE` (`start`, `loop_start`, `loop_end`, `loop_dur`): a zero
stays a zero under any scale factor, and `start: 0` with no loop is both the
commonest shape in the config corpus and the one every clip the editor creates
is born with. The engine filters its own `[LOOP_UNIT]` warning on exactly that,
and the Inspector's hint *is* that warning, so it carries the same filter and
names the same keys — otherwise the editor shouts where the engine is silent,
and taking its advice writes a key that doesn't move a sample while moving the
fingerprint: one render too many on a stem that was right. No parity pact for
this one, unlike `LOOP_UNITS`: the engine method it mirrors is marked
`# ponytail` (PGE #242) and goes away after a release, and it leans on
`Envelope.is_envelope_like`, unreachable without numpy — which is what the CI
node job running parity does not have. The residual divergences are all on the
loud side (`isEnvValue` says yes to an empty list, `is_envelope_like` says no).

`grain.duration_unit` (`seconds | samples | milliseconds`, PGE #158 then #171) is the same shape of problem one level down: the engine's `grain_duration` bounds are in **seconds**, the YAML values are in the declared unit. `grainUnitFactor` / `grainUnitBounds` / `grainDefaultDuration` / `grainUnitSuffix` in `envelope-utils.js` are the single source — bounds, the `0.05` s default and the row suffix expressed in the unit in force (in ms the cap is `10000`, not `10`); they drive the EnvelopeEditor `hardMin/hardMax` + vis window and the seed of the scalar↔env toggle. Changing the unit goes through `convertGrainDurationUnit`, which **converts** `duration`/`duration_range` — scalars and envelopes, every form `Envelope._scale_raw_values_y` scales — instead of letting the old number be reinterpreted in the new scale, then re-clamps the scalars (envelope points need no clamp: bounds scale by the same factor). An unknown unit converts nothing and gets no suffix. The key is deleted only for `seconds` — absence *is* seconds. One asymmetry is deliberate: changing the unit **does** mark the stem stale even though the rendered audio is identical, because `fingerprintStream` sees `0.05` become `50` — the safe direction (one render too many, never one too few), and normalizing the hash to seconds would cost more than it's worth.

**`grain.duration_range_unit` (`absolute | relative`, PGE #267, PGE-ui #163) is the unit of the *band*, not of the base.** Under `relative`, `duration_range` stops being a duration and becomes a **fraction of the grain duration**, read instant by instant — and a fraction has no unit. Everything above about `duration_unit` therefore stops at the base: `convertGrainDurationUnit` leaves a relative `duration_range` out of its fields (no conversion, no re-clamp — `0.5` towards `samples` used to become `0.5/48000`, the variation gone with nothing left in the file to notice), exactly as `Stream._pre_normalize_grain_params` does engine-side, with the same *pure* reading of the unit (`grainRangeIsRelative`, mirror of `range_unit_is_relative`: a misspelling reads as absolute, and saying it is misspelt is `grainRangeUnitError`'s job). The band's domain is `grainRangeBounds`: absolute → `grainUnitBounds(PB.durationRange, unit)` as before; relative → `PB.relativeRange`, the engine's `RELATIVE_RANGE_BOUNDS`, never converted. The two maxima are both `1` today, which is why the clamp *looked* right: in seconds it was right by coincidence, in milliseconds it was `[0, 1000]` on a fraction. `grainRangeSuffix` is silent in relative (and on a rejected spelling, the `grainUnitSuffix` rule), `grainRangeBadge` gives the duration row `±25%` instead of `±0.25` next to `50 ms`, and `grainRangeSeed` seeds the AddParamMenu with `0.2` in relative (0.01 s over the 0.05 s default: the same band). The Inspector's `duration_range` row now **clamps** through `clampGrainRange` — `NumberField` clamps nothing, and the engine's validation is strict, so a `3` typed in relative was a dead render.

The key's absence and its emptiness are **not** the same, and this is where it parts from its siblings. `duration_unit:` and `loop_unit:` left empty are dropped by the serializer (`|| undefined`); `duration_range_unit:` is kept verbatim as `null` with the key present, because the engine distinguishes absent from empty on purpose (`_KEY_ABSENT` in the orchestrator) and rejects the empty one — dropping it would be the editor performing the silent reading the engine refused to. `grainRangeUnitError` mirrors both refusals in the orchestrator's order: `unknown` (any spelling outside `RANGE_UNITS`, empty included) before `missing-range` (`relative` without a `duration_range`: without a band the implicit jitter kicks in, and that one is *absolute*).

The Inspector's `Seg` sits under the `duration_range` row and shows whenever the band exists **or** the key is written (a hand-written `relative` without a band must show control and error together). Its guard is `rangeUnitSel`, its own `value`, `null` on a rejected spelling so every click is the remedy (the `loopUnitSel` shape). A **real** click does *not* convert the number (`convertGrainRangeUnit`): a duration and a fraction of the duration are different quantities, converting one into the other goes through the base — an envelope in the case that motivates PGE #267 — and the precedent is `density ↔ fill_factor`. The number stays and is re-read, clamped into the destination domain (`10` ms → `1`), envelope points included: here, unlike `duration_unit`, the bounds don't scale with the values. `absolute` deletes the key.

`RANGE_UNITS` (with `RANGE_UNIT_DEFAULT` / `RANGE_UNIT_RELATIVE`) is a copy held honest the way `LOOP_UNITS` is: `engine_range_units` reads it by AST — resolving the module-level names the engine writes the tuple with (`(RANGE_UNIT_ABSOLUTE, RANGE_UNIT_RELATIVE)`), since a literal-only read answers `[]` on the real checkout; a name counts by its *last* assignment before the tuple, so one rebound to an expression reads as "don't know" rather than as the stale literal before it — and `test-bounds-parity.js` compares UI copy, AST read and import. `RELATIVE_RANGE_BOUNDS` travels on `/bounds` as `relative_range` (`engine_relative_range_bounds`, mtime cache, `None` on anything that isn't a two-number domain with `min <= max`), `mergeEngineBounds` folds it onto `relativeRange` and leaves `durationRange` alone, and the static `PGE_BOUNDS.relativeRange` is the declared fallback parity requires to equal the engine's. `relativeRange` is exempt from the "every clamp has an `ENGINE_PARAM_MAP` entry" guard for the reason `pitch` is: it has a route of its own, and the same parity case proves it from a wrong base.

One cost of promoting the key: the **engine's** hash doesn't move (`sort_keys`, and the key was already hashed from `grain._extra`), but the UI's does — `fingerprintStream` hashes the JS object, where `grain._extra.duration_range_unit` became `grain.durationRangeUnit`. One yellow dot, once, only on streams that declare the key; the safe direction, cleared by the first render.

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
`parameter_bounds`, `filter_solo_mute`, `constants` — the last one carrying the
name registries and the constants the mirrors copy whole, `ENVELOPE_COLORS`
included);
`tests/parity/oracle.js` is the node client (one python process per suite);
`tests/parity/harness.js` runs the suites and, crucially, **counts and names the
cases that did not run** when the engine is absent — a skipped parity case is a
failure under `PGE_PARITY_STRICT=1` and in CI when the engine is present.

Two rules when touching it:

- **The oracle imports from the engine, it never reimplements it.** A copy would
  be a third mirror to keep aligned. The two exceptions have one shape: the
  `--magnify-at` grammar, which lives in `pge.cli` (unimportable without
  numpy/soundfile/matplotlib), and `Generator._filter_solo_mute`, whose module
  drags in numpy. The oracle extracts those AST nodes from `cli.py` /
  `generator.py` and executes them — the engine's own bytes.
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
bounds, `VARIATION_SEMANTICS_VERSION`, `DEFAULT_OUTPUT_SR`, `LOOP_UNITS`,
`RANGE_UNITS` and `RELATIVE_RANGE_BOUNDS` (#163), the
backend list (`RendererFactory._VALID_TYPES`, #150) and where the SuperCollider
SynthDef lives (`DEFAULT_SYNTHDEF_SOURCE` / `_DIR`, `SYNTH_NAME`);
each returns an empty/`None` result for an engine that doesn't have the thing,
and every caller must treat that as "don't know", never as a value. For the sample rate that
extends to values that aren't sample rates: `0` or a negative reads as unknown,
because the UI divides by it and `1/0` is an `Infinity` that silently switches
off every clamp downstream.

**No engine constant is transcribed by hand in this repo any more**, and the
last one to go was the one nobody was watching: `OUTPUT_SR = 48000` in
`yaml-bridge.js`. It is still written there, but as a declared static fallback
that parity requires to equal the engine's — see the `/bounds` section above.

The rule has one more subject since #149: `LOOP_UNITS` in `envelope-utils.js`,
the vocabulary of `pointer.loop_unit`. Before PGE #222 there was nothing to
mirror — the key had no declared set — and now a spelling outside it kills the
render, so the UI has to name it while you type. `engine_loop_units` reads it
from `pointer_controller.py` by AST (importing that module drags in numpy, which
the CI node job doesn't have), and `test-bounds-parity.js` requires the UI's copy
to equal the engine's **in order** — the first spelling is the canonical one, and
`LOOP_UNIT_DEFAULT` is what the Inspector's selector writes.

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

`pointer.start` is written in the unit in force, which is `pointer.loop_unit` and
nothing else (`loopUnitInfo`; PGE #222 cut the `time_mode` fallback). Every stream
the editor creates declares `loop_unit: normalized`, where `start` lives in
`[0,1]` of the sample — writing seconds there would send it off the end of the
file. The risk is symmetric on a hand-written YAML carrying `time_mode:
normalized` **without** `loop_unit`: there the engine reads seconds, and the
normalized branch would write a position 8× off. That is why the unit is asked of
`loopUnitInfo` rather than deduced from the stream. Normalized with an unknown
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
half isn't defined, so `sliceEnvArray` returns `null` on an array holding one —
and on a **bare** one, the value that *is* the block — the field is left
verbatim, and the count comes back as `skipped` for the toast.

**The time walk reads every graphy, because the y walk already does.** An
envelope has more than one spelling and the engine reads them all (PGE #234): a
point is `[t, v]` *or* the dict `{t, v, type?}`, and a BP group or a compact
block can be the **whole value** instead of an item inside a list — the two bare
forms neither `unwrapEnv` nor `desugarBPGroups` touch, which is why
`wouldEmptyEnv` normalizes the bare block by itself and says so. `_mapGrainEnvY`
— the *y* walk of this same module, the one a `duration_unit` change drives —
has handled all of them since #234. The *x* walk (`rescaleEnvArray`,
`truncateEnvArray`, `envArrayWouldTruncate`, `sliceEnvArray`) read only the
nested array forms, so those three graphies stayed in the old time frame while
every other curve on the stream moved: no error, no marker, and not even the
"you'll lose breakpoints" confirm, because `envArrayWouldTruncate` was looking
the same way. In the engine's own config corpus that was **31 envelopes across
7 files** — `PGE_wrap_test.yml`'s densities, `PGE_read_direction_demo.yml`'s
directions, the `offset_range` of the two `pino`s. One spot was worse than
frozen: `rescaleEnvArray`'s `{type, points}` branch was the only one that
didn't recurse into the item mapper, so it read `p[0]`/`p[1]` off a dict and
wrote `[NaN, undefined]` — the envelope *destroyed* by a resize — while
silently dropping a 3-tuple's per-point interp.

The reading rule is one function, `PGEEnv.bpAt` (with `bpAtX` / `bpMake`), in
`envelope-loops.js` beside the predicates it is made of — the third reader of
the dict spelling, after `wouldEmptyEnv` counting points and `firstBreakpointY`
reading one. **It never migrates a spelling**: a dict comes back a dict, and the
two y's the cut *computes* (truncate's closing point, slice's opening one) take
the spelling of the point beside them. Rewriting `{t, v}` as `[t, v]` would be
the cure worse than the disease — a fingerprint moved, and a yellow dot, on
every resize of a stream nobody edited. The bare forms are normalized in one
line per function (wrap in a list, hand back as found, `PGEEnv.isBareEnv` +
`_asBare`), the single exception being the bare compact block in
`sliceEnvArray`, refused like its nested twin. `test-envelope-utils.js` pins it
as a **comparison**, not as numbers: the bare graphy must behave like the
identical graphy inside a list, the dict like its array namesake, and both
walks — x and y — must see all four.

**And the editor reaches those two graphies through one door, `desugarBPGroups`.**
`isBareEnv` (`isBPGroup || isCompactBlock`) is one rule in `envelope-loops.js`
with two readers — the walk above, and that function's `// forma diretta` line —
because a second copy is how one of the two graphies stops being seen by half
the repo. It used to know only the group, and the gap showed in exactly one
place, the one that matters: `unwrapEnv` of a bare *block* hands back its three
elements (`pattern`, `end_time`, `n_reps`), none of which is an item, and
`EnvelopeEditor.jsx` builds `rawEnv` **and** `expandMixed` on top of that pair
(`desugarBPGroups(unwrapEnv(v).items)`). So a full envelope opened on an **empty
canvas** — 26 streams in the engine's own config corpus, `PGE_envelope_syntax_test.yml`
first among them — and the one gesture an empty canvas offers, a double click,
appended a breakpoint to that list: `[pattern, end, n_reps, [x, y]]`, which the
engine no longer reads as compact (`item[3]` is not a string) and from which
only the breakpoint survives. The block gone, with no error. Wrapping it here
also keeps `rawEnv`'s indices aligned with `expandMixed`'s `originalIdx`, which
is the editor's invariant — normalizing in `expandMixed` alone would have
desynchronized them. `wouldEmptyEnv` still answers on the bare block without
wrapping it, because its question is a count and a block already counts as one;
`test-bp-groups.js` asks the rest by **comparison**, the bare graphy against the
identical one inside a list, up to the double click that used to eat it.

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

**Staleness has two more axes, and neither is in the hash.** The first: the engine's
`VARIATION_SEMANTICS_VERSION` (`stream_cache_manager.py`) says *how* it reads
the YAML; it sits inside the engine's fingerprint, so a bump marks every stem of
every project dirty at rest. The UI hash deliberately has no counterpart — the
two hashes answer different questions ("did the user edit this" vs "must the
engine redo this stem") — but the *dot* answers the engine's, and at the 2→3 bump
(PGE #222) it showed 🟢 on stems the engine was about to rewrite. So the version
is a second axis beside the hash, never a field inside it: `staleReason` in
`render-status.js` returns `"yaml"`, `"semantics"` or `"renderer"` (the third
axis, below), the version is recorded
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
nothing downstream needs a new case — and the same holds for the third axis
below: `statusForStream` indexes the reason into a tooltip table
(`STALE_TOOLTIP`) rather than branching per axis. The table alone does not stop
a fourth reason from wearing the YAML text — a missing entry falls back to it,
there and again in `ClipRenderStatus` — so `test-render-status.js` collects the
reasons from the `return` literals of `staleReason` (a non-literal return is
itself a red) and requires each to have an entry that isn't the YAML one.

**There is a third axis, and it is the backend that wrote the stem** (#151).
`renderer_type` sits inside the engine's fingerprint beside the semantics
version (PGE #228), for the same reason — something a stem depends on that the
YAML text doesn't state — and with three backends that exist to be compared,
rendering with one and relaunching with another is the use case, not the edge.
So the UI mirrors it the same way the version is mirrored: `staleReason`
returns `"renderer"` too, the name is recorded per stream beside the
fingerprints (`loadRenderers` / `_persistRenderers`, localStorage key
`pge-local-renderer`), and `statusForStream` has its own tooltip for it.

**The reason it is not in the hash is not the one the issue gave.** #151 said
the UI's hash would stop matching the engine's manifest and every stem would
read 🟡 forever. The two hashes are never compared: `loadCache` keeps its own
per-browser manifest (FNV-1a against the engine's SHA-256) and nothing in
`src/` reads `GET /cache_manifest`. The real reason is #134's criterion —
*does it reach the YAML?* — and the answer is no: the UI hash answers "did the
user edit this stream", which a change of backend doesn't move. Folded in, the
dot would read `stale` with reason `yaml` on a YAML nobody touched, and the
reason is the whole point of having reasons.

**The two unknowns follow the semantics rule, and the "absent" branch is the
one that earns its keep later.** A *current* backend that isn't known claims
nothing; a *stem* with no recorded backend and a known current one reads
`stale`. On a stem rendered before #151 that costs one empty pass per project,
which clears itself on the first `stream-done`, `cached: true` included —
except on a muted stream, which the engine doesn't build and so keeps its
yellow until it sounds again: nobody has vouched for that file, and the `done`
fallback no longer pretends to (see the NDJSON section). Staying silent instead
would mean that once the choice reached the popover (#150), the numpy stems
written before it stayed 🟢 under csound: one render too few, in exactly the
case the axis exists for. The tooltip is worded for **both** branches — "no
record that the current backend rendered this stem" — because the absent one
fires on every stem rendered before #151: "another backend rendered this stem"
was false every time it was read there, and sent the author looking for a
backend change nobody made.
The workspace switch drops this record in memory too (`setRenderedRenderer({})`
in `onWorkspaceChange`, beside `setRenderedSem({})`): on a same-named project
the `[activeProject]` effect doesn't re-fire, and with the engine unknown the
previous folder's names would keep its stems green until a reload.

**The name goes out from one read.** Since #150 the backend is the popover's
choice, the tweak `renderRenderer` (default `numpy`, the one `"numpy"` literal in
`app.jsx`); it was the module constant `RENDERER` in #151, and the rule it
carried survived the change: the tweak is read **once**, into
`currentRenderer` at the top of `App`, and that is what's read by
`rendererOfThisRun` (the POST body *and* the `stream-done` handler, the same
"fix the value for this run" rule as the semantics version), by `rendererCtx`
(the live side of the axis) and by `renderOptions.renderer`, which is what the
render popover's command preview prints (`buildCommand` in `RenderButton.jsx`
used to hold a `"numpy"` of its own — a declaration in another file, invisible to
a guard that counts the literals of `app.jsx` alone). Two literals would be two
declarations, and the disagreement between the name that reaches argv and the
name that reaches the record is invisible — it shows up as a green dot.
`server.py` defaults to the same string, and a source guard in
`test-render-status.js` pins the single read, the preview reading it and
the bridge's default; a parity case pins the two halves of the
pact — the backends the engine declares give it as many hashes, and the UI's
axis discriminates the same pairs while its hash stays blind to them.
`currentRenderer` sits at the top of `App` rather than beside `renderOptions`
because `rendererCtx` is declared far above it, where `renderOptions` would
still be in its TDZ.

**And what counts as a name is one rule too, `PGEBackend.rendererName`** (a
non-empty string, else `null`). It has three readers — the persisted record in
`run()`, the in-memory record in the `stream-done` handler, and the live side
`rendererCtx.current` — and it used to be written three times, differently:
non-empty string, bare truthiness, no filter at all. Harmless while the name
was the constant `"numpy"`; since #150 it comes from a preference, and an empty
name on the live side
is a *known* `current` (`"" != null`) against records `run()` never writes, i.e.
every stem yellow forever, and a truthy non-string stays in memory and vanishes
from localStorage — one colour until the reload, another after.
`test-semantics-store.js` runs the rule and requires the three sites to call it.

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

Streams without a rendered stem stay silent but **never silently**: a missing/undecodable stem fires `pge-audio-error` (once per stream per schedule), logged and surfaced as a toast. Without that, a 404 stem is indistinguishable from a quiet one because `canplay` simply never fires. Teardown marks the node dead **before** detaching `el.src` (detaching it fires `error` on the element).

**The stem bytes come through `fetch()`, never straight into `el.src`** — and
that is not a preference, it is the ceiling the previous design hit. An
`<audio>` pointed at the http URL keeps its connection busy for the whole clip
(the browser downloads at roughly playback rate, not in one go), so past the
browser's **six connections per origin** the seventh stem never reaches
`canplay` — and an element that is merely *queued* fires no `error` either, so
the clip is silent with nothing to log, i.e. exactly the hole the paragraph
above exists to close. Measured on a nine-stem project: six elements start in
10 ms, the seventh at 8.3 s, the last two never (readyState 0 after 15 s).
Which six won the race varied per run, which is what made it read as "some
tracks suddenly don't play" after a stop/seek/play round rather than as a
broken stem. The server's `threads: 200` (see the gunicorn options in
`server.py`) had already fixed the same symptom on *its* side; this is the
browser's half of it, and the two are independent.

`_stemObjectUrl(url)` downloads the bytes once and hands out a `blob:` URL: the
fetch gives the connection back as soon as it is done (95 MB from the local
bridge in ~30 ms) and a blob URL costs no slot at all. `_scheduleStreaming`
warms it at **schedule** time, not in `build()` — `build` fires `startLead`
(90 ms) before the clip sounds, nowhere near enough to download a stem, while
the element itself is instant once the blob is there.

The cache entry is keyed on the file's **ETag**, not on the URL alone, and that
is the one thing that can fail quietly: a re-render writes the same filename,
so a blob cached under the URL would keep playing the previous audio under a
green dot. Each call does a HEAD first and re-downloads unless the tag matches;
an *unknown* tag (HEAD unavailable) counts as "don't know" and re-downloads —
the safe direction, one wasted round trip instead of audio the author never
rendered. The blob is what makes a seek free: a seek reschedules every clip,
and without the cache that would be the whole project downloaded again per
click. `_capStemBlobs` bounds the set but never drops a URL the current project
still lists (`streamUrls`), so the cap is soft by design.

Teardown does **not** revoke the blob (it is shared with the next schedule) and
does **not** write `el.src = ""`: the empty string resolves against the
document URL, so the element goes and fetches the editor page as media — one
bogus request per clip per stop, on the very connection pool this design exists
to spare. It is `removeAttribute("src")` + `load()`.

`tests/node/test-stem-blobs.js` covers the cache (reuse, re-download on a moved
ETag, revoke of the superseded blob, a failed fetch not cached as a success,
the soft cap) plus source guards on the three links that don't run in node.

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

`bin/pge-ui` (#164) is the one thing in the repo that is neither editor nor
bridge: a four-line `sh` launcher that `make install-cli` symlinks onto `$PATH`,
so the bridge can be started from the folder you are working in. It resolves its
own path with `realpath` — it is reached *through* a symlink, so a plain
`dirname` would name `~/.local/bin` — and execs `server.py` with the repo's
`.venv/bin/python` when there is one (that is where `make install` puts flask;
with a bare `python3` the documented setup dies on the import).

**And it stops when `realpath` doesn't answer, rather than guessing.**
`realpath` is not POSIX — on macOS it only arrives with 12.3 — and `dirname` of
an empty string is `.`, so the missing binary didn't fail: it resolved `REPO`
onto the *current* folder. Inside the checkout the command then worked by
accident, and from anywhere else it died naming a `server.py` in the folder you
were standing in, which is an error nobody gets out of on their own. Hence the
`|| exit 1` on the resolution line (and, on the install side, the `command -v
realpath` guard, so the name never reaches the `PATH` on a machine where it
could only stop) — it costs no line, so the four-line rule
below is untouched. The probe for it needs a **decoy**: with the PATH stripped
of `realpath` the broken launcher dies anyway (no `python3` there either), so
"exit != 0" stayed green on the defect; a fake `.venv` in the folder the command
is called from is what makes the two outcomes different.

**Nothing else may go in there.** The engine root, the workspace default, the
flags — every decision stays in `server.py`, where pytest and the source guards
see it; a script in `bin/` is looked at by nobody, and its natural tendency is
to grow into a second, untested copy of those decisions. That is a rule with
teeth: `test-suite-harness.js` requires the file to stay at most four code
lines with a single trailing `exec`, refuses any bridge flag written inside it,
and *runs* it — through a symlink, from a third folder, against a stub
`server.py` — to check that the path resolution and the argument forwarding
really work. That last half needs neither flask nor the sibling engine, so it
runs in the node CI job too.

**Which flags those are is read from `server.py`, never transcribed.** The
guard collects the `add_argument("--…")` names out of the bridge's own source,
so the sixth flag added tomorrow is refused the day it is declared. A list
written into the test would be a second copy of the truth, and the person
adding a flag is not the person who remembers to update it — it would go mute
exactly while the launcher was about to grow the decision. That is not a
hypothesis: the same list, transcribed into the prose of the PR that
introduced it, named four of the five. The read has its own assert (it must
find a plausible number of flags, `--root` among them), because an empty list
builds a regex that accuses nothing — the silent way to disappear this repo
already knows from `backend.envelopeKeys()` returning `[]` and the filter
hiding.

**The install side has its own rules, and every one of them had the same
failure mode: a `pge-ui` on the `PATH` that doesn't run, announced as
installed.** The link's source is `CLI_SRC`, resolved on the *Makefile's* folder
(`$(dir $(lastword $(MAKEFILE_LIST)))`) and not on `$PWD` — with
`$(abspath bin/pge-ui)` a `make -f /path/PGE-ui/Makefile install-cli` given from
elsewhere linked a `bin/pge-ui` that doesn't exist there, and `ln -s` doesn't
look at its target, so the dangling link was born under the success line. And
every expansion in the recipe is quoted, because a space in the checkout's path
or in `BINDIR` (`~/Documents/…`) made the unquoted `mkdir -p` fabricate a
relative folder *inside the repo* and then `ln` fail naming the destination,
which existed. `make` itself can't carry a space through
`$(lastword $(MAKEFILE_LIST))`, so that one residual case (`make -f` on a
checkout whose path has a space) is covered by the `test -f "$(CLI_SRC)"` guard
at the top of the recipe: it fails the install instead of writing the wrong
link.

**The last spellings of that same failure are stopped now, not announced.**
A `BINDIR` carrying a `~` is not a path: `make` does no tilde expansion, and
the recipe quotes every expansion (it has to — the spaces above), so the shell
doesn't expand it either. `BINDIR=~/.local/bin` — the spelling the target's own
`help` line suggests — therefore fabricated a folder literally named `~` inside
the checkout, put the link in it, printed the success line, and closed with an
`export PATH="~/…"` that expands to nothing either: two announcements of an
install nothing can reach. The `~/` head is expanded in the Makefile now, under
`override`, which is not ornamental — a plain assignment loses against the
command line, and the command line is exactly where `BINDIR` comes from.

**That expansion brought the same lie back in through `patsubst`, which works
on words.** `BINDIR=/tmp/a  b` came back `/tmp/a b`: the link in a folder that
is not the one asked for, under the success line — the exact failure the tilde
expansion had just been added to remove. One space hides it (the words rejoin
identically, which is why the space probe stayed green), two don't, and a tab
doesn't either. So the rewrite only applies to a **one-word** `BINDIR`, where
`patsubst` has nothing to split; every other spelling passes through verbatim
and the spaces are carried by the recipe, which quotes. What is left
unresolvable — `~user/`, a bare `~`, `~/with  spaces` — fails the target instead
of inventing a folder.

**A relative `BINDIR` was the last spelling of the family still announced as
installed.** `mybin` doesn't name a folder until you say what it is relative
to, and make resolves it against its own working directory — which `make -C
/path/PGE-ui` puts inside the checkout and `make -f /path/PGE-ui/Makefile`
puts wherever you were standing: the very ambiguity `CLI_SRC` removes on the
link's *source*, left open on its destination. It succeeded, the success line
announced it, and the `PATH` warning closed by advising `export
PATH="mybin:$PATH"` — a relative `PATH` entry, i.e. a command that answers from
one folder only. A `case` beside the `~` one stops it; the probe runs both
spellings of `make`, because it is their disagreement that makes the path
meaningless.

**And a trailing slash made the warning itself lie.** It does not change where
the link lands, but the `PATH` comparison is textual and `$PATH` lists
`/home/you/.local/bin`, not `/home/you/.local/bin/` — so `BINDIR=~/.local/bin/`,
which is what the shell's own tab-completion writes, printed «not in your
PATH» about a folder that was, and advised adding an entry already there. That
warning is the only thing here that explains a `command not found` after an
install, and one that cries where there is nothing is the first one people
learn to skip. And the trailing slash was not the only spelling: `HOME=/root/`
— what a container hands you — made the target's *own default* come out
`/root//.local/bin`, so the warning cried about the folder it had just found,
on a `BINDIR` nobody typed.

The normalization is `$(abspath …)`, beside the tilde expansion, in the same
one-word branch and for the same reason (make's functions work on words, and
would rejoin `/tmp/a  b`). It is the one already in the file for `CLI_SRC`, and
it takes the whole family at once: trailing slashes however many, doubled
slashes in the middle, `.` and `..`. Two `patsubst` passes took two slashes and
only at the end — `BINDIR=/x//` came back `/x/`, and the default's middle slash
was invisible to it. The `/%` filter in front is **not** ornamental: `abspath`
of a relative path resolves it against make's own working directory, i.e. it
would choose exactly the folder the recipe refuses to choose, and the
relative-`BINDIR` guard below would go mute — no relative path would ever reach
it again. Outside the filter everything passes verbatim, and `/` stays `/`,
which `abspath` does not empty. Both directions of the warning are measured,
with the slash on and with the slashed `HOME`, or a normalization that went too
far would read green on the half that matters.

**An unset `HOME` was the one spelling the prose here already claimed was
stopped, and wasn't.** `$(HOME)/.local/bin` simply became `/.local/bin`: it
doesn't start with a `~`, so no guard looked at it, and wherever `/` is writable
(a container, a CI runner) the install *succeeded* — announced, under the root,
reachable by no `PATH`. The default is `$(if $(HOME),…)` now, so no `HOME` means
no default, and an empty `BINDIR` (that one, or one typed by hand) is stopped by
a `test -n` beside the other two guards, naming what is missing instead of
dying on `mkdir: cannot create directory ''`. The probe reads the *message*, not
only the exit code: where `/` isn't writable that `mkdir` failed anyway, which
is a green for the wrong reason. The other spelling is the executable bit: the
source guard defends *this* repo's index, not the checkout of whoever installs,
so `test -x` sits beside the `test -f` — linking a file without it is a name on
the `PATH` that answers `Permission denied`, which is the same lie one layer
further on. All of it is measured by running `make install-cli` against
temporary `BINDIR`s and a temporary `HOME`, in the same section of the harness.

**And the last one isn't a `BINDIR` at all: it is `realpath`.** The launcher
needs it to cross the very symlink this target creates, and stops without it —
correctly, per the paragraph above. But the *recipe* doesn't use `realpath`, so
the install succeeded anyway, printed its success line, and left on the `PATH`
a `pge-ui` that exits 1 forever: the same lie as all the others, reached from
the one direction that isn't a mistyped variable but a whole platform
(`realpath` is not POSIX; macOS ships it only from 12.3). A `command -v` sits
with the other guards now, and refuses rather than warns, because a command
that cannot run is not a degraded install. Its probe runs `make install-cli`
under a `PATH` carrying only what the recipe uses (`make`, `mkdir`, `ln`), and
needs its control: with a `PATH` that narrow, *any* failure would keep a
`status !== 0` assert green, so the same `PATH` with `realpath` back in it must
succeed.

`PGE Editor.html` loads scripts in a fixed order: vendor (React/Babel/js-yaml) → `src/lib/yaml-bridge.js` → `src/lib/bounds.js` → `src/lib/envelope-loops.js` → `src/lib/deviation-probability.js` → `src/lib/envelope-utils.js` → `src/lib/envelope-catalog.js` → `src/lib/backend.js` → `src/lib/audio-engine.js` → `src/lib/grain-map.js` → `src/lib/render-status.js` → `src/lib/renderer-choice.js` → `src/lib/history-core.js` → `src/lib/tracks.js` → `src/lib/tweaks-store.js` → `src/lib/magnify-spec.js` → JSX files (`src/components/*.jsx`) → `src/components/app.jsx` last. Everything attaches to `window.*` (no modules). A new JSX file must be added to `PGE Editor.html` AND must not depend on later-loaded siblings at parse time.

That last sentence is not prose any more: `tests/node/test-sources.js` is its
executable form (#138). It reads the `<script>` list out of the HTML, requires a
bijection with the files on disk, and refuses a `window.*` read that a later
script satisfies. What it cannot say is *where* in the phase a new file goes —
only that the order it is given holds together. The other half — that the file
so ordered actually *renders* — is `tests/e2e/test-boot.js` (#139), which boots
the page for real; a new component that parses and then throws is caught there,
nowhere else.

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
