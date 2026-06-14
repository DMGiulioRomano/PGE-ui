# PGE Editor — operational deep-dive

Setup and quick start live in **[README.md](README.md)**. This document is the
operational reference for the bridge: how the local backend maps to HTTP, the
full endpoint list, the NDJSON render protocol, troubleshooting and security.

The bridge is `server.py` in this repo. It runs **from PGE-ui** and points at a
separately-cloned `PythonGranularEngine` via `--root` (default
`../PythonGranularEngine`) — it never copies itself into or mutates the engine
repo, only reading/writing inside that repo's `refs/`, `configs/`, `output/`,
`cache/`. It binds `127.0.0.1` only; CORS is open so the editor (a `file://`
page) can reach it.

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
# introspection / config
GET  /health                     — sanity check + resolved repo paths
GET  /config                     — resolved repo paths
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

The `kind` parameter is one of `media | projects | output | cache` and is
resolved against the repo's `refs / configs / output / cache` folders. Path
traversal is rejected; derived audio artifacts (WAV/peaks/spectrogram) are
cached under `cache/` and never written into `refs/`.

---

## NDJSON event protocol

`POST /render` streams one JSON object per line. Event types:

```jsonc
{ "type": "log",           "line": "..." }
{ "type": "stream-start",  "streamId": "stream3", "index": 2, "total": 5 }
{ "type": "stream-done",   "streamId": "stream3", "cached": false, "output": "output/PGE_test__stream3.aif" }
{ "type": "done", "ok": true, "generated": ["output/..."], "returncode": 0 }
```

The server parses `main.py`'s stdout (`[3/5] stream3  rendering…` and
`→ output/…`) into these structured events so the UI can highlight the
"currently rendering" clip without you having to change anything in the
python engine.

---

## Troubleshooting

- **"test connection" fails** — is `server.py` actually running? Check the
  terminal you launched it in for tracebacks. Also confirm the URL in the
  settings panel matches what the server printed.
- **CORS error in DevTools** — you're probably hitting a different origin.
  CORS is wide-open on the bridge; if you still see it, you've installed
  flask without `flask-cors`. Run `pip install flask-cors` again.
- **"can't find src/main.py"** — you ran `server.py` from the wrong folder.
  Either `cd` into the PGE repo root first, or pass
  `python server.py --root /path/to/PythonGranularEngine`.
- **Render hangs at "starting render"** — the subprocess might be waiting on
  csound or a missing dep. Open the log panel in the editor (`log` button in
  the topbar), or just look at the server's terminal for the full python
  output.
- **Save writes to the wrong folder** — the bridge ALWAYS writes inside the
  repo root passed to `--root`. There's no escaping that. If you want to
  point at a different project, restart the bridge with a different `--root`.

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
├── PythonGranularEngine/        ← --root points here
│   ├── src/main.py              ← bridge invokes this
│   ├── configs/*.yml            ← Projects panel
│   ├── refs/*.wav               ← Media panel
│   ├── output/                  ← rendered stems land here; /output/ serves from here
│   └── cache/                   ← /cache_manifest reads here
│
└── PGE-ui/                      ← THIS repo
    ├── server.py                ← the bridge
    ├── PGE Editor.html          ← open in browser
    └── …
```

The browser editor is opened as a `file://` URL and lives entirely in this repo. The engine repo is never modified — the bridge only reads + writes to it.
