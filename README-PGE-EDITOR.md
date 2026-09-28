# PGE Editor — operational deep-dive

Setup and quick start live in **[README.md](README.md)**. This document is the
operational reference for the bridge: how the local backend maps to HTTP, the
full endpoint list, the NDJSON render protocol, troubleshooting and security.

The bridge is `server.py` in this repo. It runs **from wherever your piece
lives** and points at a separately-cloned `PythonGranularEngine` — it never
copies itself into or mutates the engine source. It binds `127.0.0.1` only.
It also **serves the editor** (`GET /` → `PGE Editor.html`) and opens the
browser on it once the port is listening (#166), so the page and the bridge
share one origin. CORS stays open for the fallback of opening the HTML by hand
as a `file://` page.

Two directories, not one. `--root` is engine source (`src/main.py`, `.venv`,
`csound/`); `--workspace` is the folder holding `configs/`, `output/` and
`cache/` — the work itself, the samples included where the engine has
`--samples-dir`. Neither has a default written for someone standing inside this
checkout any more (#165): the engine is `--root`, else `$PGE_ENGINE_ROOT`, else
an `engine/` found walking up from the current folder, else an error naming the
three; the workspace is `--workspace`, else the current folder. See
**Workspace** below.

---

## Launching: which port, and the browser (#166)

The bridge's address *is* the editor's address, so the port is settled before
anything else happens — before the banner, and before `configs/ output/
cache/` are created in the workspace. The second launch used to print
`Open in browser: http://127.0.0.1:7878/` (the *first* bridge's editor, on the
other workspace), create the folders, and only then find the port taken:
five seconds of gunicorn's `Connection in use`, then exit 1.

`plan_port` in `server.py` decides, with three rules in this order:

1. **One workspace, one bridge.** It looks at the whole window 7878–7897 — not
   just the first port — for a bridge that already serves this folder (it asks
   each occupied port for `/health`, bypassing any HTTP proxy in the
   environment). Same engine: no second bridge; the browser opens on that one
   and the command exits 0. Another engine: it refuses and names both. Two
   bridges on one workspace would write the same config and stems without
   knowing about each other — the "one render at a time" guard is per process.
   This holds with `--port` too.
2. **An explicit `--port` that is busy is an error, not a search** — the same
   rule as `--root` (#165). The message names who holds it: a PGE bridge and
   its workspace, or "something that doesn't answer like a PGE bridge".
3. **Without `--port`, the first free port** of the window. The banner says who
   held the ones it skipped.

A bind that fails for another reason (a privileged port, a `--host` that isn't
this machine's) is reported as such, not as "busy".

**The browser** opens by default; `--no-open` (`make serve OPEN=0`) turns it
off. It is launched from gunicorn's `when_ready` hook, which runs in the master
*after* the sockets are bound: a browser that arrives before the worker is up
waits in the socket's queue and is served, instead of landing on "connection
refused". It runs in a detached child process — not a thread in a master that
is about to fork its worker — and that child always exits 0, because up to
gunicorn 25 the master read an unknown child's exit code 3 or 4 as "worker
failed to boot" and halted. With no graphical session (Linux without `DISPLAY`
/ `WAYLAND_DISPLAY`, and no `$BROWSER`) it doesn't try — `webbrowser` would
fall back to a text browser on the bridge's own terminal — and the banner says
so. A `$BROWSER` you set always wins. With `--host 0.0.0.0` the browser goes to
`127.0.0.1`.

**The page talks to its own origin.** `PGEBackend.defaultServerUrl()` is the
bridge the editor uses when Settings has no URL (always, at boot): the page's
`location.origin` when it was served over http, and `http://localhost:7878`
only on `file://`, where there is no origin. Before #166 it was that constant
everywhere, so an editor served from 7879 talked to the bridge on 7878 — the
other workspace.

---

## How the local backend maps to the server

|                   | local backend                                |
| ----------------- | -------------------------------------------- |
| Storage           | real filesystem via `server.py`              |
| Save              | `PUT /file?kind=projects&name=foo.yml`       |
| Save As…          | same, with new name                          |
| Render            | `POST /render` → spawns `python src/main.py` |
| Render cache      | real `cache/<basename>.json` on disk         |
| Media / Projects  | `GET /media` / `GET /projects`               |
| Play audio        | `GET /audio/<basename>__<sid>.wav` (sox transcode), scheduled to onsets |

---

## Endpoints exposed by `server.py`

```
# the editor itself
GET  /                           — PGE Editor.html (the address the bridge opens)
GET  /<path>                     — its scripts and styles (after every route below)

# introspection / config
GET  /health                     — sanity check + resolved paths (root, workspace, …)
GET  /config                     — the same resolved paths
GET  /workspace                  — current workspace + its project list
POST /workspace                  — switch it ({"path": …}; "" returns to --root)
GET  /diagnose                   — system checks (sox, soxi, numpy, venv, …)

# listing + file I/O
GET  /media                      — list refs/ ({ path, files:[{name,duration?}] })
GET  /projects                   — list configs/*.yml
GET  /file?kind=…&name=…         — read a file
PUT  /file?kind=…&name=…         — write a file
GET  /stems/<base>               — stream IDs with a rendered stem on disk
GET  /cache_manifest/<base>      — read cache/<base>.json

# render
POST /render                     — start a render, returns NDJSON stream of events
POST /render/cancel              — terminate the running subprocess
POST /setup                      — create the engine venv (NDJSON stream)

# rendered-stem audio / analysis (output/)
GET  /output/<file>              — serve a rendered stem (raw)
GET  /audio/<file>               — stem transcoded to WAV via sox (Firefox-friendly)
GET  /peaks/<file>               — waveform peaks (float32) for a stem
GET  /spectrogram/<file>?scale=  — STFT spectrogram (scale=linear|log) for a stem

# refs/ media preview
GET  /media_audio/<file>         — refs/ media as WAV (sox transcode)
GET  /media_peaks/<file>         — waveform peaks for a refs/ media file
GET  /media_spectrogram/<file>   — STFT spectrogram for a refs/ media file
```

The `kind` parameter is one of `media | projects | output | cache`. All four
resolve against the workspace — `media` against the engine's `refs/` instead,
when the engine has no `--samples-dir` (see **Workspace**).
Path traversal is rejected; derived audio artifacts (WAV/peaks/spectrogram) are
cached under `cache/` and never written into `refs/`.

---

## Workspace

Before #147 the four working directories were derived from `--root` and nothing
else, so every piece opened in the editor was a file *inside the engine
checkout* — and `/render`, which writes the editor state to the canonical
`configs/<basename>.yml` (see the NDJSON section), rewrote it there. Composing
dirtied the engine repo, and rollback meant the engine's `git`.

The engine was never the constraint: `src/main.py` takes absolute paths and
`--cache-dir` is arbitrary. So:

```bash
python server.py --root ../PythonGranularEngine --workspace ~/brani
make serve WORKSPACE=~/brani
cd ~/brani && python /path/to/PGE-ui/server.py   # #165: the workspace is here
cd ~/brani && pge-ui                             # the same, after make install-cli
```

The last form is the same bridge under a name on `$PATH` (#164): `server.py`
resolves its own folder, so it has never needed to be started from the
checkout — `bin/pge-ui` only supplies the name, and writes no flag of its own.
Since #165 there is no flag left to spell out in the common case: the workspace
is the folder you are standing in, and the engine comes from `$PGE_ENGINE_ROOT`
(a line of `.envrc` beside the piece) or from an `engine/` found walking up.

| | comes from |
| --- | --- |
| `src/main.py`, `.venv/`, `csound/`, `logs/` | `--root`, else `$PGE_ENGINE_ROOT`, else an `engine/` walking up (engine source) |
| `configs/`, `output/`, `cache/` | `--workspace`, else the current folder (`make serve` passes the engine root, the historical layout) |
| the samples | `--workspace` too, on an engine with `--samples-dir`; `--root` otherwise — see below |

The samples folder inside the workspace is `refs/`, **or the `samples/` the
folder already has**: the bridge adopts the one that exists (`refs/` first, it
is the canonical name) and creates `refs/` only when neither does. That name is
what goes out as `--samples-dir`, so the engine reads the folder the editor
lists, and `GET /workspace` carries `samplesDirAdopted` so Settings can say
"adopted" instead of promising an empty folder over a full one.

Missing **sub**directories are created on startup; the workspace folder itself
is not. A mistyped `--workspace` stops the bridge rather than fabricating an
empty folder and making the author's projects disappear from the list.

**Switching at runtime.** `POST /workspace {"path": …}` commutes the four paths
in place (they are process state, not closure constants — which is why the
gunicorn config runs `workers: 1`); an empty path returns to `--root` — to the
engine checkout, not "to the default": since #165 a hand-launched bridge starts
on the current folder, and this route is what is left of the historical layout
(the one `make serve` passes explicitly). The
response carries the new project list, because a switch invalidates what the
browser holds: it is a replacement, not a merge. In the editor: **⚙ → Workspace**.

Two refusals: a bad path (400 — missing, not a directory, or not a path at all:
an embedded NUL or a `~unknownuser` are answers with a message, not 500s) and a
render in flight (409). `/render` reads `configs`, `output` and `cache` while its
NDJSON stream is open, and it also pins them at the start of the route so a
switch can't split stems and cache manifest across two folders. The 409 covers
the render from the *first instant of the stream*, not from the spawn: between
the two sits the engine venv setup, minutes in which no subprocess exists yet
and the render is nonetheless under way, with its paths already pinned.

Browser-side, a successful switch drops the stem index, the on-disk stem
durations, the peaks, the spectrograms, the grain sidecars and the two
provenance records — engine-semantics version and rendering backend per stem —
then reloads the project list and reopens a project
(same name if the new folder has one). Keeping any of it would mean a clip with a
green dot and no audio behind it — the 404 an `<audio>` element reports by never
firing `canplay`. The per-stream fingerprints (`pge-local-fp`) are the one thing
that survives: they describe the YAML that was rendered, not the files on disk,
so a same-named project with different content reads stale — the safe direction.

**`refs/` moves with the other three, where the engine allows it** (#148). The
subprocess still runs with `cwd=root`, and without
[`--samples-dir`](https://github.com/DMGiulioRomano/PythonGranularEngine/issues/235)
the engine resolves samples against `./refs/` relative to that cwd — in both
renderers, since the sample's *duration* is resolved before a renderer exists and
`--ssdir` only covers csound's render-time lookup. `build_render_command` sends
`--samples-dir <refs>` for both renderers on every render (inert on an engine
that doesn't know the flag: unknown flags are ignored), and `_set_workspace` asks
`engine_supports_samples_dir(root)` before binding `refs` under the workspace —
on an older engine it stays at `root/refs`, because a samples folder the editor
lists and the render never reads is a disagreement that only shows up as a failed
render. `GET/POST /workspace` carry `samplesFollowWorkspace` so Settings can say
which of the two is in force. `_ensure_venv_events` and the csound paths
(`--orc-path`, `--incdir`, `--log-dir`) stay bound to `--root` on purpose: that
is engine code, not the author's work.

---

## NDJSON event protocol

`POST /render` streams one JSON object per line. Event types:

```jsonc
{ "type": "log",           "line": "..." }
{ "type": "stream-start",  "streamId": "stream3", "index": 2, "total": 5 }
{ "type": "stream-done",   "streamId": "stream3", "cached": false }
{ "type": "done", "ok": true, "generated": ["output/..."], "returncode": 0 }
```

The server derives them from `main.py`'s **stdout**, without anything changing
in the python engine. Two line shapes carry the whole protocol, and everything
else becomes a `log` the editor prints without reading:

| line | event |
| --- | --- |
| `[CACHE] <id>: DIRTY\|clean` (the cache triage, one per stream the engine builds) | `stream-start`, plus `stream-done` (`cached: true`) when clean |
| an indented path ending in `<basename>__<id>.<aif\|aiff\|wav\|flac>`, **inside the summary block** | `stream-done` (`cached: false`) of the DIRTY stream whose stem it names |

A `DIRTY` stream gets its `stream-done` only on the path line naming its stem,
which the engine prints after writing it — the numpy renderer triages every
stream before rendering any, so a `[CACHE]` line says nothing about the
previous stream being done. `stream-done` is what marks a stem as rendered by
this run, so it must not arrive before the file exists. Without `--cache` there
are no `[CACHE]` lines at all, and `done.generated` (the stems found on disk) is
what `backend.js` falls back on; `run()` also emits events of its own on top of
these — see the contract at the top of `backend.js`.

Three more rules are worth knowing, because each of them is a way the dots used
to lie (issue #162, engine issue PythonGranularEngine#178, whose
`docs/explanation/contratto-stdout.md` declares the engine's side of this
contract):

- **stderr is not protocol.** The two pipes are kept apart and reunited
  labelled, so a line written by `logging` — or by any third-party library
  inside the engine's process — can only ever become a `log`. Merged into
  stdout, as they used to be, a diagnostic record shaped like `[CACHE] x: y`
  opened and closed a stream that does not exist.
- **A line is a stream only if the request declared its id.** `POST /render`
  carries `streams`, and that set is what tells `[CACHE] stream1: clean` from
  `[CACHE] Manifest: <path>`, which the engine prints on every `--cache`
  render. A request that declares no streams derives no stream events; on a
  successful run its dots still resolve, from the `generated` list in `done`.
- **The path line only counts under `Generazione completata! N file
  generati:`**, and until the first unindented line. Outside that block the
  same shape belongs to the engine's prose — an error citing
  `refs/voce__streamA.wav` would otherwise close stream `streamA` on a stem
  nobody wrote.

There is no per-stream `stream-progress` event: the finest grain stdout can
carry is a whole stream.

---

## Troubleshooting

- **"test connection" fails** — is the bridge actually running? Check the
  terminal you launched it in for tracebacks. An editor opened from the address
  the bridge prints talks to that bridge by construction; if you opened
  `PGE Editor.html` by hand (`file://`) it looks for one on port 7878 only —
  use the printed address instead.
- **The browser didn't open** — the banner's `browser:` line says why:
  `--no-open`, or no graphical session (`DISPLAY` / `WAYLAND_DISPLAY` empty,
  e.g. over ssh). Open the `Editor:` address yourself, or set `$BROWSER`.
- **"La porta 7878 e' occupata"** — you passed `--port` and something holds
  it; the message names it. Drop `--port` and the bridge picks the next free
  one. A second launch from the *same* folder isn't an error: it reuses the
  bridge already serving it.
- **CORS error in DevTools** — you're probably hitting a different origin
  (an editor opened as `file://`). CORS is wide-open on the bridge; if you
  still see it, you've installed flask without `flask-cors`. Run
  `pip install flask-cors` again.
- **"can't find src/main.py"** — you ran `server.py` from the wrong folder.
  Either `cd` into the PGE repo root first, or pass
  `python server.py --root /path/to/PythonGranularEngine`.
- **Render hangs at "starting render"** — the subprocess might be waiting on
  csound or a missing dep. Open the log panel in the editor (`log` button in
  the topbar), or just look at the server's terminal for the full python
  output.
- **Save writes to the wrong folder** — projects are written inside the
  workspace: `--workspace` if given, otherwise `--root`. Check the `configs/`
  line the bridge prints at startup, or `GET /workspace`. To move, either
  restart with a different `--workspace` or switch it live from **⚙ →
  Workspace** in the editor.

---

## Security notes

- The bridge binds to `127.0.0.1` only by default; nothing on your LAN can
  reach it. If you need to expose it (e.g. to a remote user), pass
  `--host 0.0.0.0` — but understand you're letting anyone reach you spawn
  arbitrary `python src/main.py …` against your configs.
- Path traversal is rejected: `name=../../etc/passwd` returns 400.
- The bridge does not authenticate. It's a local dev tool, not a service.

---

## File layout reference

```
~/projects/
├── PythonGranularEngine/        ← --root points here (engine source)
│   ├── src/main.py              ← bridge invokes this
│   ├── refs/*.wav               ┐ the default workspace, when --workspace
│   ├── configs/*.yml            │ is omitted: pass one and these four
│   ├── output/                  ├ live in your own folder instead
│   └── cache/                   ┘ (refs/ only where the engine has
│                                  --samples-dir; otherwise it stays here)
│
├── brani/                       ← --workspace points here
│   ├── refs/*.wav               ← Media panel (--samples-dir)
│   ├── configs/*.yml            ← Projects panel
│   ├── output/                  ← rendered stems land here; /output/ serves from here
│   └── cache/                   ← /cache_manifest reads here
│
└── PGE-ui/                      ← THIS repo
    ├── server.py                ← the bridge
    ├── PGE Editor.html          ← served by the bridge at /
    └── …
```

The browser editor is served by the bridge (`GET /`) and lives entirely in this repo. Engine *source* is never modified — with a workspace of your own, the engine checkout isn't written to at all (and on an engine with `--samples-dir`, isn't read from either, beyond the engine's own code).
