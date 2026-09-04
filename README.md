# PGE-ui

A browser-based visual editor for [`PythonGranularEngine`](https://github.com/DMGiulioRomano/PythonGranularEngine) YAML compositions. Edits `configs/*.yml` files graphically (timeline, envelopes, voices, inspector) and launches `python src/main.py …` for you via a tiny local HTTP bridge.

The editor itself is a single HTML file plus a handful of `.jsx` / `.css` / `.js` files — no build step, no bundler.

---

## Architecture (two repos, one bridge)

```
~/projects/
├── PythonGranularEngine/        ← the renderer (pure CLI, untouched)
│   ├── src/main.py
│   ├── refs/*.wav               ← samples (always from here, for now)
│   ├── configs/*.yml            ┐
│   ├── output/                  ├ default workspace: pass --workspace to
│   └── cache/                   ┘ keep these three next to your own work
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

(They can also be anywhere else — just pass `--root /path/to/engine` to `server.py`.)

Your own pieces don't have to live inside the engine checkout: `--workspace
/path/to/brani` puts `configs/ output/ cache/` wherever you keep your work, so
editing a composition stops dirtying the engine repo and `git` rollback becomes
your own. Sample files (`refs/`) still come from the engine — see
[Workspace](#workspace) below.

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
make serve
# or directly:
python server.py --root ../PythonGranularEngine
# with your own project folder:
make serve WORKSPACE=~/brani
python server.py --root ../PythonGranularEngine --workspace ~/brani
```

You'll see:

```
PGE bridge
  root:      /Users/you/projects/PythonGranularEngine
  workspace: /Users/you/brani
  refs/:     .../PythonGranularEngine/refs   (from the engine)
  configs/:  /Users/you/brani/configs
  output/:   /Users/you/brani/output
  cache/:    /Users/you/brani/cache
  listen:    http://127.0.0.1:7878
```

### 5) Open the editor

Open `PGE Editor.html` in any browser (Chrome, Firefox, Safari — all work, because the file system access goes through the bridge, not through `window.showDirectoryPicker`).

In the editor:

1. On launch the editor probes `server.py` (`http://localhost:7878` by default), lists the real contents of `refs/` and `configs/`, and auto-opens the last project (or the first on disk).
2. **⚙ gear icon** (top-right) → **Server** to change the URL or run **"test connection"**, → **Workspace** to point the editor at another project folder without restarting the bridge.
3. Hit **Render**. The split-button's progress bar, the per-clip status dots, and the **log** terminal all stream live output from `python src/main.py`.

If the server isn't running the editor shows a "start server.py" notice — there is no offline/in-browser mode.

---

## Workspace

`--root` is engine *source* (`src/main.py`, `.venv`, `csound/`). `--workspace` is
where the work lives: `configs/`, `output/`, `cache/`. Leave it out and the two
coincide, which is what the bridge always did — your pieces end up inside the
engine checkout, and `/render` rewrites them there.

- Missing **sub**directories are created; the workspace folder itself is not — a
  mistyped path is refused instead of scattered across the disk.
- It can also be switched while the bridge runs: **⚙ → Workspace**, type a path,
  *usa questa cartella*. The editor reloads the project list and everything that
  describes the previous `output/` — stem index, durations, peaks, grains, the
  engine-semantics versions — so unsaved edits to the open project are lost.
  Refused mid-render, from the first instant of the render stream.
- **`refs/` still comes from `--root`.** The render subprocess runs with its
  working directory on the engine repo, and the numpy renderer resolves samples
  against `./refs/` there. Samples will follow the workspace once the engine
  grows `--samples-dir`
  ([PythonGranularEngine#235](https://github.com/DMGiulioRomano/PythonGranularEngine/issues/235)).

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
