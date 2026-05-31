---
title: "feat: Output format selection (aiff/wav/flac) across PGE-ui and PythonGranularEngine"
type: feat
status: active
date: 2026-05-31
---

# feat: Output format selection (aiff/wav/flac)

## Overview

`PythonGranularEngine` already has `--format aiff|wav|flac` fully implemented (CLI flag, `AudioFormat` dataclass, NumPy renderer, naming strategy, cache GC, tests). The gap is entirely on the PGE-ui side: the editor never passes a format preference to the render subprocess, always produces `.aif` stems, and the playback URL does not adapt to the chosen extension. Firefox cannot decode AIFF via Web Audio — choosing WAV eliminates the need for sox transcoding.

**Target repos:**
- Primary: `PGE-ui` (this repo)
- Minor fix: `PythonGranularEngine` (one Makefile line)

---

## Problem Frame

When the user renders from the browser editor, `server.py` calls `python src/main.py` without `--format`, so stems are always `.aif`. The playback path (`/output/`) serves raw files — AIFF works in Chrome/Safari but not Firefox. Selecting WAV at render time gives universal browser playback with no sox dependency. FLAC gives lossless + smaller files for archiving.

---

## Requirements Trace

- R1. User can select output audio format (aiff / wav / flac) from the Settings panel.
- R2. Selected format is forwarded as `--format <fmt>` to `python src/main.py` on each render.
- R3. Playback URLs use the correct file extension for the selected format.
- R4. Stems rendered in a different format are treated as stale (fingerprint invalidation).
- R5. Default format is `aiff` — existing projects without an explicit setting are unchanged.
- R6. `autopen_stems` Makefile macro in PythonGranularEngine uses `$(FORMAT_EXT)` instead of hardcoded `*.aif`.

---

## Scope Boundaries

- No sox transcoding path for WAV/FLAC — `/output/` serves raw files directly (already in place).
- No per-stream format override — format is project-level.
- No FLAC support check for older browsers — treat as user's responsibility.
- Mock backend ignores format (no real files); format only affects local/http backend.

---

## Context & Research

### Relevant Code and Patterns

**PythonGranularEngine:**
- `src/rendering/audio_format.py` — `FORMATS` dict: `aiff/.aif`, `wav/.wav`, `flac/.flac`; `DEFAULT_FORMAT = FORMATS['aiff']`
- `src/main.py:218-233` — `--format` CLI parsing (manual `sys.argv` scan)
- `make/build.mk:20` — `FORMAT_EXT` computation; line 108 hardcodes `*.aif` in `autopen_stems`

**PGE-ui:**
- `server.py:POST /render` — builds subprocess args list, calls `python src/main.py`
- `backend.js:stemUrl()` — constructs `/output/<basename>__<sid>.aif` URL (just changed to `/output/`)
- `backend.js:fingerprintStream()` — FNV-1a hash over sorted JSON keys (ignoring color/mute/solo)
- `app.jsx` — Settings panel state lives in `settings` object; other settings (backend, port) already stored in `localStorage`
- `app.jsx:EDITMODE-BEGIN/END` block — `TWEAK_DEFAULTS`; do not reformat

### External References

- `soundfile` format constants: `'AIFF'/'FLOAT'`, `'WAV'/'FLOAT'`, `'FLAC'/'PCM_24'` — already in `audio_format.py`
- Firefox Web Audio: supports WAV, MP3; does not support AIFF natively

---

## Key Technical Decisions

- **Format stored in Settings, not per-stream:** Format is a project-level render preference, mirrors how `--format` works in the CLI. Avoids per-stem fingerprint complexity.
- **Format included in cache fingerprint key:** The stem cache key is `basename__sid#fingerprint`. Format must be folded into what determines staleness — either extend the fingerprint or use a separate cache-key suffix. Simplest: append `|fmt:<format>` to the fingerprint string before hashing, matching the existing FNV pattern.
- **`/output/` serves raw files:** Already switched from `/audio/` (sox). No further server change needed for format-agnostic serving — the endpoint is format-neutral.
- **`server.py` receives format as a render param:** `POST /render` body already carries project/basename. Add `"format"` key; server appends `["--format", fmt]` to the subprocess args.

---

## Open Questions

### Resolved During Planning

- **Is `--format` already in PythonGranularEngine?** Yes — fully implemented, including `TestFormatFlag` tests.
- **Does `/output/` serve WAV/FLAC without changes?** Yes — `serve_output()` in `server.py` uses `send_file` with `mimetype` derived from extension; WAV gets correct MIME automatically.
- **Does the Csound renderer need explicit format flags?** No — Csound infers format from the output file extension via `-o`. Current behavior is correct for all three formats.

### Deferred to Implementation

- Exact shape of `fingerprintStream` modification — whether to extend the JS function signature or thread format through `scheduleStreams` → `ensureBuffer` → upstream call.
- Whether `mock` backend should log a warning when format ≠ aiff (since mock never writes real files).

---

## Implementation Units

- [ ] U1. **Fix `autopen_stems` macro in PythonGranularEngine Makefile**

**Goal:** `autopen_stems` opens stems of any format, not just `.aif`.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `make/build.mk` (in PythonGranularEngine repo)

**Approach:**
- Line 108: replace `$(SFDIR)/*.aif` with `$(SFDIR)/*$(FORMAT_EXT)` so the glob matches `.wav` and `.flac` stems when `FORMAT` is set.

**Test scenarios:**
- Test expectation: none — Makefile glob change; covered by manual `make` invocation with `FORMAT=wav`.

**Verification:**
- `make FORMAT=wav` produces `.wav` stems and `autopen_stems` opens them (if AUTOPEN=1).

---

- [ ] U2. **Add format selector to Settings panel**

**Goal:** User can pick `aiff`, `wav`, or `flac` in the Settings panel. Selection persists in `localStorage`.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `app.jsx`

**Approach:**
- Add `outputFormat` key to the settings state object, default `'aiff'`.
- Persist and restore from `localStorage` alongside existing settings (backend, port, etc.).
- Render a `<select>` with three `<option>` elements (`AIFF (default)`, `WAV`, `FLAC`) in the Settings panel.
- Changing the selector updates React state and writes to `localStorage`.

**Patterns to follow:**
- Existing `backend` and `port` settings in `app.jsx` Settings panel — same pattern for state + localStorage.

**Test scenarios:**
- Happy path: select WAV → `outputFormat` state = `'wav'`, persisted to localStorage.
- Happy path: reload page → selector shows previously saved format.
- Edge case: localStorage missing key → defaults to `'aiff'` without error.

**Verification:**
- Settings panel shows format selector. Selecting each option survives page reload.

---

- [ ] U3. **Forward format to server.py render endpoint**

**Goal:** Each render call passes the selected format; `server.py` appends `--format <fmt>` to the subprocess.

**Requirements:** R2

**Dependencies:** U2

**Files:**
- Modify: `backend.js` (local backend `runLocalRender` or equivalent render call)
- Modify: `server.py` (`POST /render` handler)

**Approach:**
- `backend.js`: include `"format": settings.outputFormat` in the `POST /render` JSON body.
- `server.py`: read `data.get("format", "aiff")` from request JSON; validate against whitelist `{"aiff", "wav", "flac"}`; append `["--format", fmt]` to the `cmd` list before subprocess call.
- Whitelist validation in server.py prevents arbitrary flag injection.

**Patterns to follow:**
- Existing `POST /render` body parsing in `server.py` (basename, sections, streams).

**Test scenarios:**
- Happy path: format=`'wav'` → subprocess receives `--format wav` → output files are `.wav`.
- Error path: format=`'exe'` (not in whitelist) → server returns HTTP 400.
- Edge case: format key absent from request body → defaults to `'aiff'`.

**Verification:**
- After render with WAV selected, `output/` contains `.wav` stems, not `.aif`.

---

- [ ] U4. **Update `stemUrl` and fingerprint to use selected format**

**Goal:** Playback URLs point to the correct extension; format change marks existing stems stale.

**Requirements:** R3, R4

**Dependencies:** U2, U3

**Files:**
- Modify: `backend.js` (`stemUrl`, `fingerprintStream` or cache-key construction)

**Approach:**
- `stemUrl(yamlBasename, streamId, format)`: derive extension from format (`aiff`→`.aif`, `wav`→`.wav`, `flac`→`.flac`); construct `/output/<basename>__<sid><ext>`.
- Thread `format` from wherever `stemUrl` is called (pass `settings.outputFormat` or read from shared state).
- Cache key / fingerprint: append `|fmt:<format>` to the input string before FNV-1a hashing so stems rendered in a different format are correctly flagged stale. Mirror this in any Python-side fingerprint if applicable (check `cache/<basename>.json` manifest).

**Patterns to follow:**
- Existing FNV-1a fingerprint in `backend.js` (`fingerprintStream`).
- JS/Python fingerprint parity described in `CLAUDE.md`.

**Test scenarios:**
- Happy path: format=`'wav'` → `stemUrl` returns URL ending in `.wav`.
- Happy path: render with WAV → green dot. Switch setting to FLAC without re-rendering → dot turns yellow (stale).
- Edge case: unknown format string → falls back to `.aif`.

**Verification:**
- Browser network tab shows requests to `.wav` / `.flac` URLs matching the selected format. Stale indicator appears after format change without re-render.

---

## System-Wide Impact

- **Interaction graph:** `app.jsx` settings → `backend.js` render call → `server.py` subprocess → `main.py` → stems on disk → `backend.js` stemUrl → `audio-engine.js` fetch.
- **Error propagation:** Invalid format rejected at `server.py` whitelist; JS side shows existing render error UI.
- **State lifecycle risks:** Stems from a previous format remain on disk — stale detection (U4) prevents playing wrong-format files. No automatic cleanup of old-format stems.
- **Unchanged invariants:** Mock backend behavior unchanged. Fingerprint parity between JS and Python must be maintained if `fmt` is added to Python-side hash.
- **Integration coverage:** Full render → playback cycle must be tested manually with WAV to confirm Firefox playback works without sox.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Old `.aif` stems remain on disk after switching to WAV | Stale detection marks them yellow; user re-renders. Document in UI tooltip. |
| Firefox FLAC support varies by version | Out of scope; WAV is the safe cross-browser choice. |
| Fingerprint parity drift (JS vs Python) | Confirm Python cache manifest does not include format in its own fingerprint before adding it on JS side only. |
| `server.py` format injection | Whitelist validation in U3 blocks arbitrary strings. |

---

## Sources & References

- Related issue: DMGiulioRomano/PythonGranularEngine#75 (closed — feature already implemented)
- `src/rendering/audio_format.py` in PythonGranularEngine — authoritative format definitions
- `CLAUDE.md` — fingerprint parity section, NDJSON render protocol, backend abstraction contract
