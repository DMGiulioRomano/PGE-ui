# PGE-ui

A browser-based visual editor for [`PythonGranularEngine`](https://github.com/DMGiulioRomano/PythonGranularEngine) YAML compositions. Edits `configs/*.yml` files graphically (timeline, envelopes, voices, inspector) and launches `python src/main.py …` for you via a tiny local HTTP bridge.

The editor itself is a single HTML file plus a handful of `.jsx` / `.css` / `.js` files — no build step, no bundler.

---

## Architecture (two repos, one bridge)

```
~/projects/
├── PythonGranularEngine/        ← the renderer (pure CLI, untouched)
│   ├── src/main.py
│   ├── configs/*.yml
│   ├── refs/*.wav
│   ├── output/                  ← rendered .aif files land here
│   └── cache/                   ← per-stream fingerprints
│
└── PGE-ui/                      ← this repo
    ├── PGE Editor.html          ← open this in a browser
    ├── server.py                ← local HTTP bridge to the renderer
    ├── requirements.txt         ← flask + flask-cors
    ├── Makefile                 ← convenience targets
    ├── backend.js               ← mock + http adapters (browser side)
    ├── app.jsx, TopBar.jsx, …   ← editor UI (React + Babel-in-browser)
    └── README-PGE-EDITOR.md     ← detailed setup + troubleshooting
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
```

You'll see:

```
PGE bridge
  root:    /Users/you/projects/PythonGranularEngine
  refs/:   .../refs
  configs/:.../configs
  output/: .../output
  cache/:  .../cache
  listen:  http://127.0.0.1:7878
```

### 5) Open the editor

Open `PGE Editor.html` in any browser (Chrome, Firefox, Safari — all work, because the file system access goes through the bridge, not through `window.showDirectoryPicker`).

In the editor:

1. **⚙ gear icon** (top-right)
2. Backend → switch from **mock** to **local**
3. Server URL: `http://localhost:7878` (default)
4. **"test connection"** → green dot
5. The Media and Projects panels now show the real contents of `refs/` and `configs/`
6. Hit **Render**. The split-button's progress bar, the per-clip status dots, and the **log** terminal all stream live output from `python src/main.py`.

---

## Backends

The editor speaks to a `PGEBackend` abstraction. Two implementations are bundled:

| Backend | Storage         | Render                              | Use it for                                                         |
|---------|-----------------|-------------------------------------|--------------------------------------------------------------------|
| `mock`  | `localStorage`  | timers + fake `main.py`-shaped logs | Evaluating the UI without any server. Default at first launch.     |
| `local` | real disk via `server.py` | `subprocess.Popen(python src/main.py …)` streaming NDJSON | Real composition work. Requires `python server.py` running.       |

Switch in the gear (⚙) panel. The default is `mock` so the editor opens cleanly without setup.

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
├── app.jsx                      root React component, glue + history + render orchestration
├── backend.js                   PGEBackend abstraction (mock + local HTTP)
├── data.js                      bundled sample data (used by mock backend)
├── envelope-loops.js            envelope math + gesture-bracketed undo
│
├── primitives.jsx               Button, Icon, Switch, Tag, Section, SplitPane, …
├── TopBar.jsx                   topbar with split-button render
├── RenderButton.jsx             split-button + popover + progress
├── Terminal.jsx                 embedded log panel + toast surface
├── SettingsPanel.jsx            gear-icon dialog
├── SampleBrowser.jsx            Media / Projects panels with folder picker
├── Timeline.jsx                 lanes, clips, per-clip render-status dots
├── EnvelopeEditor.jsx           envelope + loop sub-language
├── VoicesSection.jsx            voices section in Inspector
├── Inspector.jsx                Preview / Raw tabs
├── YamlEditor.jsx               Raw tab text editor
├── tweaks-panel.jsx             host's Tweaks panel (only visible in the design tool)
│
├── editor.css                   core layout + tokens
├── colors_and_type.css          design system tokens (accent, accent-2, fg, bg, …)
├── envelope_editor.css          envelope pane scoped styles
└── render-ui.css                styles for render button / settings / terminal / toasts
```

---

## Further reading

- **`README-PGE-EDITOR.md`** — endpoint reference, NDJSON event protocol, troubleshooting, security notes.
- **`PythonGranularEngine/README.md`** — the renderer itself: YAML DSL, voices, graphic score.
- **`PythonGranularEngine/docs/`** — architecture, multi-voice, workflows, yaml-reference.

---

## Status

Active development. The mock backend is feature-complete for evaluating the UI. The local backend is feature-complete for rendering; **audio playback during Play is still silent** (the timeline advances visually but the rendered `.aif` stems aren't loaded yet). Wiring `<audio>` elements to `GET /output/<basename>__<sid>.aif` per stream, aligned to onsets, is the next planned step.
