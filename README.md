# PGE-ui

A browser-based visual editor for [`PythonGranularEngine`](https://github.com/DMGiulioRomano/PythonGranularEngine) YAML compositions. Edits `configs/*.yml` files graphically (timeline, envelopes, voices, inspector) and launches `python src/main.py …` for you via a tiny local HTTP bridge.

The editor itself is a single HTML file plus a handful of `.jsx` / `.css` / `.js` files — no build step, no bundler.

---

## Architecture (two repos, one bridge)

```
~/projects/
├── PythonGranularEngine/        ← the renderer (pure CLI, untouched)
│   ├── src/main.py
│   ├── refs/*.wav               ┐
│   ├── configs/*.yml            ├ where `make serve` keeps them; the bridge
│   ├── output/                  │ launched by hand uses the current folder
│   └── cache/                   ┘ (--workspace to choose)
│
└── PGE-ui/                      ← this repo
    ├── PGE Editor.html          ← open this in a browser
    ├── server.py                ← local HTTP bridge to the renderer
    ├── requirements.txt         ← flask + flask-cors
    ├── Makefile                 ← convenience targets
    ├── src/lib/                 ← browser-side logic (backend.js, yaml-bridge.js, …)
    ├── src/components/          ← editor UI (app.jsx, TopBar.jsx, … — React + Babel)
    ├── styles/                  ← css (editor.css, colors_and_type.css, …)
    └── README-PGE-EDITOR.md     ← operational deep-dive (endpoints, NDJSON, troubleshooting)
```

**Why two repos?** `PythonGranularEngine` is a pure compositional CLI in the spirit of Truax's DMX-1000. The web UI and its bridge are deliberately kept out of it, alongside the existing sibling tool [`PGE-ls`](https://github.com/DMGiulioRomano/PGE-ls). The engine has no flask dependency, no UI assumptions, no opinions about JSON event formats.

---

## Quick start

### 1) Clone both repos side-by-side

```bash
cd ~/projects
git clone https://github.com/DMGiulioRomano/PythonGranularEngine
git clone https://github.com/DMGiulioRomano/PGE-ui
```

(They can also be anywhere else — the engine is resolved by `--root`, then
`$PGE_ENGINE_ROOT`, then an `engine/` next to your work: see
[Which engine, which folder](#which-engine-which-folder).)

Your own pieces don't have to live inside the engine checkout — and by default
they don't: the bridge works in the folder you launch it from. `--workspace
/path/to/brani` picks another one. Either way `configs/ output/ cache/` live
where you keep your work, so editing a composition stops dirtying the engine
repo and `git` rollback becomes your own. Sample files come along too, on an
engine that has `--samples-dir` — see [Workspace](#workspace) below.

### 2) Set up the engine

Follow `PythonGranularEngine/README.md`: install system deps (csound, sox, python ≥ 3.12) and run `make setup` inside that repo to create its venv.

### 3) Install the bridge dependencies

You can put them in the engine's venv (simplest) or any python ≥ 3.10 environment:

```bash
cd ~/projects/PGE-ui
pip install -r requirements.txt
```

### 4) Start the bridge

```bash
# from your own piece: the current folder is the workspace, and the engine
# comes from $PGE_ENGINE_ROOT (one line of .envrc) or from an engine/ beside it
cd ~/brani/mare-nostrum && python ~/projects/PGE-ui/server.py

# from this checkout: make serve keeps the historical layout (workspace = the
# engine repo), unless you say otherwise
make serve
make serve WORKSPACE=~/brani

# or spell both out
python server.py --root ../PythonGranularEngine --workspace ~/brani
```

You'll see:

```
PGE bridge
  root:      /Users/you/projects/PythonGranularEngine  (PGE_ENGINE_ROOT)
  workspace: /Users/you/brani/mare-nostrum  (= $PWD)
  refs/:     /Users/you/brani/mare-nostrum/refs
  configs/:  /Users/you/brani/mare-nostrum/configs
  output/:   /Users/you/brani/mare-nostrum/output
  cache/:    /Users/you/brani/mare-nostrum/cache
  listen:    http://127.0.0.1:7878
```

The first two lines carry **who said so** next to the path — `--root`,
`PGE_ENGINE_ROOT`, `engine/` for the engine; `= $PWD` or `--workspace` for the
folder. With three ways to declare an engine, *which one* is not enough.

### 4b) (optional) One name on your `PATH`

The bridge doesn't care where you start it from — `server.py` resolves its own
folder — so the only thing missing to launch it from anywhere is a name:

```bash
make install-cli                 # symlinks bin/pge-ui into ~/.local/bin
make install-cli BINDIR=/usr/local/bin   # …or wherever you keep your commands
```

Then:

```bash
cd ~/brani/pezzo-nuovo
pge-ui
```

It is a symlink, not a copy, so `git pull` updates the command too; running the
target twice is not an error. If `BINDIR` isn't on your `PATH` the target says
so — that is the usual reason `pge-ui` looks broken right after installing it.
A `BINDIR` written as `~/.local/bin` works (`make` doesn't expand a `~`, so the
target does it), one with spaces in it lands exactly where you wrote it, and the
way a path is spelled — a trailing slash from tab-completion, a doubled slash
from a `HOME` that ends in one — doesn't make the warning above mistake it for a
different folder. Anything the target cannot resolve — a `~user/…`, a relative
`BINDIR` (there is no such thing as a relative `PATH` entry worth having), an
empty one or no `HOME` to build the default from, a `bin/pge-ui` that lost its
executable bit, or no `realpath` on your `PATH` for the launcher to resolve
itself with — stops the install instead of leaving behind a name that doesn't
run.

The name carries no flags, and since #165 it no longer needs any: the workspace
is the folder you ran it from, and the engine comes from `$PGE_ENGINE_ROOT` —
one line of `.envrc` beside the piece — or from an `engine/` found walking up.
Spell `--root` / `--workspace` out when you want something else; see
[Which engine, which folder](#which-engine-which-folder).

`bin/pge-ui` deliberately holds no logic of its own: it resolves its path
through the symlink (`realpath`) and hands over to `server.py`, preferring the
repo's `.venv/bin/python` when `make install` has created one. Every decision —
engine root, workspace, flags — stays in `server.py`, where the tests see it.
If `realpath` isn't there to answer (it is not POSIX; macOS only ships it from
12.3) the command stops and says so, rather than resolving the repo onto the
folder you happen to be standing in — and `make install-cli` refuses to install
it in the first place, so you get one explanation instead of a name on the
`PATH` that never runs. On such a system, `brew install coreutils` and a
`realpath` reachable as an executable (a shell alias won't do — the launcher is
a script) is what the target is waiting for.

### 5) Open the editor

Open `PGE Editor.html` in any browser (Chrome, Firefox, Safari — all work, because the file system access goes through the bridge, not through `window.showDirectoryPicker`).

In the editor:

1. On launch the editor probes `server.py` (`http://localhost:7878` by default), lists the real contents of `refs/` and `configs/`, and auto-opens the last project (or the first on disk).
2. **⚙ gear icon** (top-right) → **Server** to change the URL or run **"test connection"**, → **Workspace** to point the editor at another project folder without restarting the bridge.
3. Hit **Render**. The split-button's progress bar, the per-clip status dots, and the **log** terminal all stream live output from `python src/main.py`.

If the server isn't running the editor shows a "start server.py" notice — there is no offline/in-browser mode.

---

## Which engine, which folder

The bridge is launched from wherever your piece lives, so neither of the two
answers can come from a default written for someone standing inside this
checkout. **Which engine** is resolved in this order:

1. `--root /path/to/PythonGranularEngine` on the command line
2. `$PGE_ENGINE_ROOT`
3. an `engine/` containing `src/main.py`, walking up from the current folder
   and stopping at the git root — or, with no repo above you, at your home
   directory (at the filesystem root, for work kept outside it)
4. otherwise an error naming those three — not a traceback

It is the precedence the Makefile already implements for `ROOT=` /
`PGE_ENGINE_ROOT`, kept identical on purpose: two precedences for one variable
in one repo only show up when one of them is wrong.

The first two are *declarations*: if they point at a folder without
`src/main.py` the bridge stops and says so, instead of quietly searching
elsewhere and running a different engine than the one you asked for.

So a piece declares its engine once, next to the work, in a line of `.envrc`:

```sh
export PGE_ENGINE_ROOT=$PWD/engine
```

and `cd mare-nostrum && pge-ui` opens the editor on that piece using the pinned
submodule — the same code its `make` uses, by construction rather than by
coincidence. Step 3 is the fallback for a repo that has the submodule but not
the `.envrc`.

**Which folder** is simpler: `--workspace`, else the current one. (`make serve`
is the exception — it runs from inside this checkout, where "the current folder"
would mean creating `configs/ output/ cache/` in the editor's repo, so it passes
`--workspace` explicitly and keeps the historical layout.)

---

## Workspace

`--root` is engine *source* (`src/main.py`, `.venv`, `csound/`). `--workspace` is
where the work lives: `configs/`, `output/`, `cache/`. Leave it out and it is the
folder you launched the bridge from; pass `--workspace <engine root>` (what
`make serve` does) for the historical layout, where your pieces live inside the
engine checkout and `/render` rewrites them there.

- Missing **sub**directories are created; the workspace folder itself is not — a
  mistyped path is refused instead of scattered across the disk.
- It can also be switched while the bridge runs: **⚙ → Workspace**, type a path,
  *usa questa cartella*. The editor reloads the project list and everything that
  describes the previous `output/` — stem index, durations, peaks, grains, the
  engine-semantics versions — so unsaved edits to the open project are lost.
  Refused mid-render, from the first instant of the render stream.
- **The samples folder follows too**, on an engine that has `--samples-dir`
  ([PythonGranularEngine#235](https://github.com/DMGiulioRomano/PythonGranularEngine/issues/235)):
  the bridge sends it on every render, so the samples are yours as well. On an
  older engine the flag is ignored and samples are resolved against the engine's
  own `./refs/`, so the bridge leaves them there rather than listing a folder no
  render would read; Settings says which of the two you are on.
- **It is `refs/`, or the `samples/` the folder already has.** With the
  workspace on the current folder the bridge's name for that folder (`refs/`)
  and the one a piece may already use (`samples/`, matching the `--samples-dir
  samples` of its own Makefile) finally meet. The rule is to **adopt the one
  that exists** and rename nothing: `refs/` wins if it is there, `samples/`
  takes over when it isn't, and if neither exists `refs/` is created. An empty
  `refs/` next to a full `samples/` would be the worst outcome — two names for
  one thing, and the editor listing the empty one. Whichever is chosen is what
  goes out as `--samples-dir`, so the engine reads the folder the editor lists.

---

## Backend

The editor speaks to a `PGEBackend` abstraction with a single implementation, `local`:

| Backend | Storage                   | Render                                                    | Notes                                          |
|---------|---------------------------|-----------------------------------------------------------|------------------------------------------------|
| `local` | real disk via `server.py` | `subprocess.Popen(python src/main.py …)` streaming NDJSON | Requires `python server.py` running (`make serve`). |

The browser only does `fetch()`; the server holds all disk access, so the editor works in any browser. There is no offline mode — without the server, the editor can't list or load anything.

---

## Editor surfaces (current state)

**Topbar.** Project name + unsaved indicator, undo/redo, transport (skip-back / play / stop), playhead readout, renderer tag (`numpy`), play-readiness pill (`stems ready` / `N stale · playing old audio` / `no stems · render first`), log toggle, **Save** / **Save As…**, settings ⚙, and the **Render** split-button (corpo + caret popover).

**Render popover.** Renderer choice (`numpy`; `csound` reserved), per-stream stems (forced on, required for playback), incremental cache, pdf score, reaper project, preclean output, output folder, and a live preview of the python command.

**Render in flight.** The button collapses into a progress bar (`rendering 3/5 · stream4`) with a cancel `⨯`. The clip currently being rendered gets a pulsing `rendering…` pill; finished clips get `✓ rendered`. Cached clips (incremental build) flash through as `✓ rendered` without the progress phase.

**Per-clip render status.** Bottom-left of each clip:

- 🟢 `✓ rendered` — fingerprint matches the on-disk stem
- 🟡 `⚠ stale` — yaml changed since last render
- ⚪ `· never rendered`
- 🟠 `rendering…` (with mini bar)

**Status bar.** Stream count, sample rate, project filename, render summary chip (`✓ 5 stems · all fresh` / `3 fresh · 2 stale` / `— never rendered` / `⟳ rendering 3/5`), unsaved indicator, gesture cheatsheet.

**Embedded terminal.** Bottom panel, toggled from the topbar's `log` button. Streams the real (or simulated) stdout, color-coded for `[CACHE]`, `[ERROR]`, completion lines, etc. Auto-scrolls. Copy-all + clear available.

**Toasts.** Used when the terminal is collapsed, for non-blocking notices (render started, render done, save confirmed). Click to dismiss; auto-dismiss after 2–4s unless they carry an error or an action button.

**Settings panel (⚙).** Backend mode, server URL + ping test, paths (media / projects / output), render defaults, appearance (accent color, density, footer toggle).

---

## Project structure

```
PGE-ui/
├── PGE Editor.html              entry point — load with file://
├── server.py                    Flask bridge (this repo's only python)
├── requirements.txt
├── Makefile
├── bin/pge-ui                   launcher on $PATH (make install-cli) — no logic, just exec
├── README.md                    this file
├── README-PGE-EDITOR.md         deep dive: endpoints, NDJSON protocol, troubleshooting
│
├── src/
│   ├── lib/                     browser-side logic (window.* globals, no modules)
│   │   ├── backend.js             PGEBackend abstraction (local HTTP to server.py)
│   │   ├── yaml-bridge.js         YAML ⇄ editor-shape round-trip
│   │   ├── envelope-loops.js      envelope math + gesture-bracketed undo
│   │   ├── envelope-utils.js      envelope rescale / truncate helpers
│   │   ├── audio-engine.js        master clock + stem playback
│   │   ├── grain-map.js           grain colouring / LUT
│   │   ├── render-status.js       fresh/stale/never classification + summary
│   │   └── history-core.js        undo/redo stack mechanics (200-cap, gestures)
│   │
│   └── components/              React UI (Babel-in-browser .jsx)
│       ├── app.jsx                root component, glue + history + render orchestration
│       ├── primitives.jsx         Button, Icon, Switch, Tag, Section, SplitPane, …
│       ├── TopBar.jsx             topbar with split-button render
│       ├── RenderButton.jsx       split-button + popover + progress
│       ├── Terminal.jsx           embedded log panel + toast surface
│       ├── SettingsPanel.jsx      gear-icon dialog
│       ├── SampleBrowser.jsx      Media / Projects panels with folder picker
│       ├── MediaPreview.jsx       sample waveform preview
│       ├── Timeline.jsx           lanes, clips, per-clip render-status dots
│       ├── GrainScore.jsx         grain score view
│       ├── Stereoscope.jsx        stereo field view
│       ├── VUMeter.jsx            output level meter
│       ├── EnvelopeEditor.jsx     envelope + loop sub-language
│       ├── EnvelopeSelector.jsx   envelope preset picker
│       ├── VoicesSection.jsx      voices section in Inspector
│       ├── Inspector.jsx          Preview / Raw tabs
│       ├── YamlEditor.jsx         Raw tab text editor
│       └── ErrorBoundary.jsx      React error boundary
│
└── styles/
    ├── editor.css                core layout + tokens
    ├── colors_and_type.css       design system tokens (accent, accent-2, fg, bg, …)
    ├── envelope_editor.css       envelope pane scoped styles
    ├── envelope-selector.css     envelope selector scoped styles
    └── render-ui.css             styles for render button / settings / terminal / toasts
```

---

## Further reading

- **`README-PGE-EDITOR.md`** — endpoint reference, NDJSON event protocol, troubleshooting, security notes.
- **`PythonGranularEngine/README.md`** — the renderer itself: YAML DSL, voices, graphic score.
- **`PythonGranularEngine/docs/`** — architecture, multi-voice, workflows, yaml-reference.

---

## Status

Active development. The local backend is feature-complete for rendering and playback: rendered `.aif` stems are fetched from `server.py` (transcoded to WAV via sox) and scheduled against the timeline.
