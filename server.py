#!/usr/bin/env python3
"""server.py — local HTTP bridge between the PGE browser editor and the
PythonGranularEngine renderer.

Lives in the PGE-ui repo. Talks to a separately-cloned PythonGranularEngine.

Default layout (clones side-by-side):
    ~/projects/PythonGranularEngine/
    ~/projects/PGE-ui/
                 ├── server.py        ← this file
                 ├── requirements.txt
                 ├── PGE Editor.html
                 └── ...

Run from PGE-ui:
    pip install -r requirements.txt
    python server.py
    # or, if PythonGranularEngine is elsewhere:
    python server.py --root /path/to/PythonGranularEngine --port 7878

Then in the browser:
    1) open PGE Editor.html
    2) click the gear icon (top-right)
    3) Backend → switch to "local"
    4) Backend → server URL → http://localhost:7878  (default)
    5) click "test connection" — should turn green
    6) hit Render — the browser POSTs to /render and streams the log back

The server speaks JSON-lines (NDJSON) for the /render endpoint so the browser
can read events incrementally. All other endpoints are plain JSON.

The engine checkout (--root) and the folder your pieces live in (--workspace)
are two different things: --root is engine source (src/main.py, .venv, csound/),
--workspace holds configs/ output/ cache/ and — since #148, on an engine that
has `--samples-dir` — refs/ too. Without --workspace they coincide, which is the
historical behavior. See #147/#148.

Endpoints:
    GET  /health                — sanity check + resolved paths
    GET  /config                — same payload as /health
    GET  /workspace             — current workspace + its projects
    POST /workspace             — switch workspace ({"path": …}; empty = --root)
    GET  /envelope-keys         — valid --plot-envelopes names (from engine src)
    GET  /media                 — list refs/ contents with durations
    GET  /projects              — list configs/*.yml
    GET  /file?kind=…&name=…    — read a file (kind: projects|media|cache|output)
    PUT  /file?kind=…&name=…    — write a file
    GET  /cache_manifest/<basename>  — read cache/<basename>.json
    POST /render                — run main.py, stream NDJSON events
    POST /render/cancel         — terminate the running render
    GET  /output/<fname>        — serve a rendered .aif for browser playback
    GET  /audio/<fname>         — same but transcoded to WAV (Firefox-friendly)
    GET  /spectrogram/<fname>   — STFT spectrogram for a rendered stem
    GET  /grains/<basename>/<streamId> — per-stream grain JSON sidecar
    GET  /media_audio/<fname>   — serve a refs/ media file as WAV for playback
    GET  /media_peaks/<fname>   — waveform peaks for a refs/ media file
    GET  /media_spectrogram/<fname> — STFT spectrogram for a refs/ media file
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from flask import Flask, jsonify, request, send_file, send_from_directory, Response, abort
    from flask_cors import CORS
except ImportError:
    sys.exit("Missing deps. Run:\n    pip install flask flask-cors")

# Audio + render machinery extracted from this module (#43).
from audio_pipeline import (
    safe_resolve, audio_duration, _resolve_audio, PEAK_BUCKETS,
    transcode_wav, peaks_file, spectrogram_file, SoxNotFound, SoxFailed,
)
from render_pipeline import (
    RenderState, parse_render_line, build_render_command, start_watchdog,
)


# -------------------------------------------------------------------------
# Helpers
#
# Audio (sox transcode / peaks / spectrogram, path resolution) lives in
# audio_pipeline.py, render orchestration (parse_render_line, RenderState,
# command build, watchdog) in render_pipeline.py, and the AST reads of the
# engine's own source in engine_introspect.py. Only the engine-venv bootstrap
# stays here — it's used by /setup and the render route and is a distinct
# concern. #43, #133
# -------------------------------------------------------------------------

# Engine-source introspection (envelope keys, parameter bounds, semantics
# version) lives in
# engine_introspect.py (#133): the parity oracle imports it with the standard
# library alone, which importing this module would not allow. Re-exported here
# because the routes below — and the python tests — call them as server.*.
from engine_introspect import (engine_envelope_keys, engine_output_sr,
                              engine_parameter_bounds, engine_semantics_version,
                              engine_supports_samples_dir)


def _ensure_venv_events(root: Path):
    """Generator: yields NDJSON event dicts while creating the engine venv.

    Creates {root}/.venv and runs pip install -r requirements.txt if the venv
    is missing. Safe to call when venv already exists (emits a skip line).
    Last event is always {"type": "venv-done", "ok": bool}."""
    venv_py = root / ".venv" / "bin" / "python"
    if venv_py.exists():
        yield {"type": "log", "line": "[VENV] engine venv already present — skipping"}
        yield {"type": "venv-done", "ok": True}
        return

    venv_dir = root / ".venv"
    req_file = root / "requirements.txt"

    # Find a suitable python to create the venv with.
    py_cmd = None
    for candidate in ["python3.12", "python3.11", "python3.10", "python3"]:
        try:
            subprocess.check_output([candidate, "--version"],
                                    stderr=subprocess.DEVNULL, timeout=2)
            py_cmd = candidate
            break
        except Exception:
            continue

    if not py_cmd:
        yield {"type": "log", "line": "[ERROR] no python3 found — install python3.12"}
        yield {"type": "venv-done", "ok": False}
        return

    yield {"type": "log", "line": f"[VENV] creating .venv with {py_cmd} …"}
    try:
        result = subprocess.run(
            [py_cmd, "-m", "venv", str(venv_dir)],
            capture_output=True, text=True, timeout=120,
        )
        for line in (result.stdout or "").splitlines():
            if line.strip():
                yield {"type": "log", "line": line}
        if result.returncode != 0:
            for line in (result.stderr or "").splitlines():
                yield {"type": "log", "line": line}
            yield {"type": "log",
                   "line": f"[ERROR] venv creation failed (exit {result.returncode})"}
            yield {"type": "venv-done", "ok": False}
            return
    except Exception as e:
        yield {"type": "log", "line": f"[ERROR] venv creation failed: {e}"}
        yield {"type": "venv-done", "ok": False}
        return

    yield {"type": "log", "line": "[VENV] venv created"}

    if not req_file.exists():
        yield {"type": "log",
               "line": f"[ERROR] requirements.txt not found at {req_file}"}
        yield {"type": "venv-done", "ok": False}
        return

    pip = venv_dir / "bin" / "pip"
    yield {"type": "log", "line": f"[VENV] pip install -r requirements.txt …"}
    try:
        proc = subprocess.Popen(
            [str(pip), "install", "-r", str(req_file)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        for raw in iter(proc.stdout.readline, ""):
            line = raw.rstrip()
            if line:
                yield {"type": "log", "line": line}
        proc.wait()
        if proc.returncode != 0:
            yield {"type": "log",
                   "line": f"[ERROR] pip install failed (exit {proc.returncode})"}
            yield {"type": "venv-done", "ok": False}
            return
    except Exception as e:
        yield {"type": "log", "line": f"[ERROR] pip install failed: {e}"}
        yield {"type": "venv-done", "ok": False}
        return

    yield {"type": "log", "line": "[VENV] engine venv ready ✓"}
    yield {"type": "venv-done", "ok": True}


# -------------------------------------------------------------------------
# App factory
# -------------------------------------------------------------------------

def make_app(root: Path, render_timeout: float = 600.0,
             workspace: Path = None) -> Flask:
    """`root` e' la sorgente del motore (src/main.py, .venv, csound/), il
    workspace e' la cartella di lavoro dell'autore: configs/ output/ cache/.

    Workspace assente = workspace sul root, cioe' il comportamento storico —
    un brano e' un file dentro il checkout del motore e /render lo riscrive
    li'. Passarne uno diverso disaccoppia le due cose: lavorare a un pezzo
    proprio non sporca piu' il repo del motore, e il rollback torna a essere
    il git della propria cartella. #147

    Anche refs/ segue il workspace, ma solo su un motore che ha
    `--samples-dir` (PythonGranularEngine#235, PGE-ui #148): il bridge glielo
    manda a ogni render, quindi i sample smettono di dover stare nel checkout
    del motore. Su un motore piu' vecchio il flag viene ignorato in silenzio e
    i sample si risolvono comunque su ./refs/ relativo al cwd del
    sottoprocesso, che e' root — li' refs/ resta quella del motore, perche' una
    cartella di sample che la UI elenca e il motore non legge sarebbe un
    disaccordo che si scopre solo quando un render fallisce."""
    ws       = None
    refs     = None
    configs  = None
    output   = None
    cache    = None
    # refs/ segue il workspace? Deciso dal motore, non da una preferenza: e'
    # la risposta di engine_supports_samples_dir sul checkout in --root.
    samples_follow_ws = False

    def _set_workspace(path):
        """Punta le directory di lavoro a `path`, creando le sottodirectory se
        mancano — un workspace nuovo e' una cartella vuota.

        Le cartelle prima dello stato: un mkdir che fallisce (permessi, disco)
        non deve lasciare il bridge su un workspace a meta', con configs/ nuova
        e output/ vecchia.

        La capacita' del motore si richiede QUI e non a ogni lettura di `refs`:
        cosi' le due meta' della risposta — dove punta la cartella e cosa il
        bridge dichiara al browser — vengono dalla stessa domanda fatta una
        volta. Un aggiornamento del motore sotto un `make serve` acceso cambia
        la risposta al prossimo cambio di workspace, non a meta' di una
        richiesta.

        Stato di processo, e regge perche' gunicorn qui gira con "workers": 1
        (vedi la config in fondo al file): con piu' worker la commutazione a
        caldo ne toccherebbe uno solo, e le richieste successive vedrebbero il
        workspace vecchio o quello nuovo a seconda di chi risponde."""
        nonlocal ws, refs, configs, output, cache, samples_follow_ws
        target = Path(path).expanduser().resolve()
        follow = engine_supports_samples_dir(root)
        names = ("configs", "output", "cache") + (("refs",) if follow else ())
        subs = {name: target / name for name in names}
        for p in subs.values():
            p.mkdir(parents=True, exist_ok=True)
        ws      = target
        configs = subs["configs"]
        output  = subs["output"]
        cache   = subs["cache"]
        # Su un motore senza il flag resta quella del motore: e' l'unica che
        # il render leggera' davvero (vedi il docstring di make_app).
        refs    = subs["refs"] if follow else root / "refs"
        samples_follow_ws = follow

    _set_workspace(workspace or root)

    app = Flask(__name__)
    # CORS open — the browser is on the same machine, no security risk.
    CORS(app, resources={r"/*": {"origins": "*"}})

    # State for the running render (only one at a time); the shared lock
    # serializes /render and /render/cancel. render_timeout is the hard cap
    # (seconds) after which a stuck subprocess is killed (0 disables). #43
    rs = RenderState()

    def _bases():
        # Ricalcolata a ogni richiesta invece di essere una costante della
        # closure: il workspace si commuta a caldo, e una mappa costruita una
        # volta sola continuerebbe a puntare alle cartelle di prima. #147
        return {"media": refs, "projects": configs, "output": output, "cache": cache}

    # --------- introspection / config ---------

    def _resolved_paths():
        return {
            "root":      str(root),
            "workspace": str(ws),
            "refs":      str(refs),
            "configs":   str(configs),
            "output":    str(output),
            "cache":     str(cache),
        }

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "version": "0.1", **_resolved_paths()})

    @app.get("/diagnose")
    def diagnose():
        """System-level checks. The browser surfaces these in the boot log
        and in the Settings → diagnose panel."""
        checks = []

        def add(label, ok, detail):
            checks.append({"label": label, "ok": bool(ok), "detail": detail})

        # main.py
        main_py = root / "src" / "main.py"
        add("main.py", main_py.exists(), str(main_py))

        # folders
        for label, p in (("refs/", refs), ("configs/", configs),
                         ("output/", output), ("cache/", cache)):
            if p.exists():
                try:
                    n = sum(1 for _ in p.iterdir())
                    add(label, True, f"{n} entries · {p}")
                except Exception as e:
                    add(label, False, f"{e}")
            else:
                add(label, False, f"missing: {p}")

        # sox (needed for AIF→WAV transcode for Firefox playback)
        try:
            v = subprocess.check_output(["sox", "--version"],
                                        stderr=subprocess.STDOUT,
                                        timeout=2).decode().splitlines()[0]
            add("sox", True, v)
        except FileNotFoundError:
            add("sox", False, "not installed — install via `brew install sox` "
                              "(needed for Firefox/Safari playback)")
        except Exception as e:
            add("sox", False, str(e))

        # soxi: now only a *fallback* for sample durations (soundfile is the
        # primary source) and still the binary behind the AIFF→WAV transcode.
        # soxi has no --version flag of its own (it exits non-zero), so probe by
        # running it bare: a missing binary raises FileNotFoundError.
        try:
            subprocess.run(["soxi"], capture_output=True, timeout=2)
            add("soxi", True, "available — duration fallback + AIFF→WAV transcode")
        except FileNotFoundError:
            add("soxi", False, "not installed — optional (durations come from "
                               "soundfile; sox/soxi only for AIFF→WAV playback)")
        except Exception as e:
            add("soxi", False, f"not available ({e}) — optional, durations use soundfile")

        # numpy + soundfile: server-side waveform peaks/spectrogram AND the
        # primary source of sample durations (sf.info, header-only).
        try:
            import numpy  # noqa: F401
            import soundfile  # noqa: F401
            add("waveform deps", True,
                f"numpy {numpy.__version__} · soundfile {soundfile.__version__} "
                f"— peaks, spectrogram & sample durations")
        except ImportError as e:
            add("waveform deps", False,
                f"{e} — `pip install -r requirements.txt` for /peaks waveforms "
                f"and sample durations (durations then fall back to soxi)")

        # engine venv
        venv_py = root / ".venv" / "bin" / "python"
        if venv_py.exists():
            add("engine venv", True, str(venv_py))
        else:
            add("engine venv", False,
                "not found — click 'Setup engine' in Settings ⚙ or POST /setup")

        # pyyaml available to the ENGINE venv that actually runs main.py
        # (not this server process — they can be different interpreters).
        if venv_py.exists():
            try:
                subprocess.check_output([str(venv_py), "-c", "import yaml"],
                                        stderr=subprocess.STDOUT, timeout=5)
                add("python yaml", True, "pyyaml present in engine venv")
            except subprocess.CalledProcessError:
                add("python yaml", False,
                    "pyyaml not in engine venv — main.py may fail; click "
                    "'Setup engine' in Settings ⚙ or pip install in .venv")
            except Exception as e:
                add("python yaml", False, f"could not check engine venv: {e}")
        else:
            add("python yaml", False,
                "engine venv missing — click 'Setup engine' in Settings ⚙")

        # stems present?
        stems = list(output.glob("*__*.aif")) + list(output.glob("*__*.wav"))
        add("rendered stems", True, f"{len(stems)} stem files in {output.name}/")

        return jsonify({"ok": all(c["ok"] for c in checks), "checks": checks})

    @app.get("/config")
    def config():
        return jsonify({"paths": _resolved_paths()})

    def _workspace_payload(ok=True, error=None):
        """Stato del workspace + elenco progetti. L'elenco viaggia con la
        risposta perche' cambiare workspace invalida quello che il browser ha
        in mano: e' un rimpiazzo, non un merge, e farlo in un giro solo evita
        la finestra in cui la UI mostra i progetti di una cartella e i path di
        un'altra."""
        d = {
            "ok": bool(ok),
            "workspace": str(ws),
            "isRoot": ws == root,
            # Se i sample seguono il workspace o restano al motore: il browser
            # non puo' dedurlo confrontando i path (con workspace == root le
            # due cartelle coincidono comunque), e Settings ne ha bisogno per
            # dire all'autore dove metterli. #148
            "samplesFollowWorkspace": bool(samples_follow_ws),
            "paths": _resolved_paths(),
            "projects": _project_entries(),
        }
        if error:
            d["error"] = error
        return d

    @app.get("/workspace")
    def get_workspace():
        return jsonify(_workspace_payload())

    @app.post("/workspace")
    def set_workspace():
        """Cambia la cartella di lavoro a caldo. Corpo: {"path": "..."};
        vuoto o assente riporta al root del motore, cioe' al default.

        La cartella deve esistere. Le *sotto*directory si creano, il workspace
        no: un percorso digitato male e' un refuso, e un refuso non deve
        seminare cartelle in giro per il disco. L'editor gira su file://,
        quindi non c'e' file picker nativo — il percorso si digita e la
        validazione sta qui.

        Rifiutato durante un render, che sta leggendo configs/output/cache
        mentre lo stream NDJSON e' in volo."""
        if rs.is_running():
            return jsonify(_workspace_payload(
                ok=False, error="render in corso — riprova a render finito")), 409
        body = request.get_json(force=True, silent=True) or {}
        raw = (body.get("path") or "").strip()
        try:
            target = (Path(raw).expanduser() if raw else root).resolve()
        except (OSError, ValueError, RuntimeError) as e:
            # Non solo OSError: un NUL nel testo alza ValueError dal filesystem
            # e `~utentechenonesiste` alza RuntimeError da expanduser(). Senza
            # gestione sono 500 al posto di 400 — cioe' una pagina HTML dove il
            # campo in Settings si aspetta il messaggio del server, e la stessa
            # svista che /render si e' gia' portata via passando da
            # safe_resolve (che il NUL lo rifiuta per lo stesso motivo).
            return jsonify(_workspace_payload(ok=False, error=str(e))), 400
        if not target.exists():
            return jsonify(_workspace_payload(
                ok=False,
                error=f"non esiste: {target} — crea la cartella e riprova")), 400
        if not target.is_dir():
            return jsonify(_workspace_payload(
                ok=False, error=f"non e' una directory: {target}")), 400
        try:
            _set_workspace(target)
        except OSError as e:
            return jsonify(_workspace_payload(
                ok=False,
                error=f"non posso creare le sottocartelle di lavoro "
                      f"in {target}: {e}")), 400
        return jsonify(_workspace_payload())

    @app.get("/envelope-keys")
    def envelope_keys():
        """Valid `--plot-envelopes` names, read from the engine source so the
        UI score-envelope filter isn't hardcoded (issue #31). Empty list = the
        engine predates the feature; the UI then hides the filter."""
        return jsonify({"ok": True, "keys": engine_envelope_keys(root)})

    @app.get("/bounds")
    def bounds():
        """Engine parameter clamps (min/max/range + pitch), parsed from the
        engine source so the UI's bounds aren't hardcoded. Empty dict = an
        engine without these files; the UI then keeps its static fallback.

        Porta anche `output_sr` (`DEFAULT_OUTPUT_SR`), che non e' un bound ma
        ne genera uno: il minimo di `grain_duration` e' 1 campione, cioe'
        `1/output_sr`, un override dinamico che l'AST dei bound non vede — e la
        stessa costante regge la conversione di `grain.duration_unit: samples`,
        che riscrive i valori nello YAML. Viaggia di qui invece che su una
        route sua perche' e' esattamente la domanda che questa route serve:
        i clamp che il motore impone.

        E' condizionato al proprio None, non alla presenza dei bound: un motore
        con `constants.py` e senza `parameter_definitions.py` e' strano, ma il
        sample rate lo sappiamo lo stesso e tacerlo lo farebbe ricadere sul
        letterale trascritto in yaml-bridge.js — cioe' proprio la cosa che
        questa lettura toglie di mezzo. La composizione sta qui e non dentro
        `engine_parameter_bounds` perche' le due letture hanno cache diverse:
        i bound a vita, il sample rate invalidato sull'mtime."""
        payload = dict(engine_parameter_bounds(root))
        sr = engine_output_sr(root)
        if sr is not None:
            payload["output_sr"] = sr
        return jsonify({"ok": True, "bounds": payload})

    @app.get("/semantics-version")
    def semantics_version():
        """`VARIATION_SEMANTICS_VERSION` del motore (stream_cache_manager.py).

        E' la versione della semantica con cui il motore legge lo YAML: entra
        nel SUO fingerprint, quindi un bump marca dirty ogni stem di ogni
        progetto anche a YAML fermo. L'editor la registra insieme ai propri
        fingerprint per non mostrare "renderizzato" su audio che il motore
        rifara' diverso. `null` = un motore senza la costante; la UI allora non
        pretende niente (mai staleness inventata da un dato che non c'e')."""
        return jsonify({"ok": True, "version": engine_semantics_version(root)})

    # --------- listing ---------

    @app.get("/media")
    def list_media():
        if not refs.exists():
            return jsonify({"path": str(refs), "files": [],
                            "error": "refs/ folder missing"})
        files = []
        for p in sorted(refs.iterdir()):
            if not p.is_file():
                continue
            if p.suffix.lower() not in {".wav", ".aif", ".aiff", ".flac", ".mp3"}:
                continue
            files.append({
                "name": p.name,
                "duration": audio_duration(p),
                "size": p.stat().st_size,
            })
        return jsonify({"path": str(refs), "files": files})

    def _project_entries():
        """I .yml del workspace. Condivisa fra /projects e /workspace: la
        risposta al cambio di cartella porta con se' l'elenco nuovo, e le due
        liste devono essere la stessa cosa."""
        if not configs.exists():
            return []
        return [{"name": p.name, "mtime": p.stat().st_mtime}
                for p in sorted(configs.iterdir())
                if p.is_file() and p.suffix == ".yml"]

    @app.get("/projects")
    def list_projects():
        if not configs.exists():
            return jsonify({"path": str(configs), "files": [],
                            "error": "configs/ folder missing"})
        return jsonify({"path": str(configs), "files": _project_entries()})

    # --------- file read / write ---------

    @app.get("/file")
    def get_file():
        kind = request.args.get("kind")
        name = request.args.get("name", "")
        base = _bases().get(kind)
        if not base: abort(400, "bad kind")
        path = safe_resolve(base, name)
        if not path or not path.exists():
            abort(404)
        return path.read_text(encoding="utf-8")

    @app.put("/file")
    def put_file():
        kind = request.args.get("kind")
        name = request.args.get("name", "")
        base = _bases().get(kind)
        if not base: abort(400, "bad kind")
        path = safe_resolve(base, name)
        if not path: abort(400, "bad name")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(request.get_data(as_text=True), encoding="utf-8")
        return jsonify({"ok": True, "path": str(path), "bytes": path.stat().st_size})

    # --------- rendered audio playback ---------

    @app.get("/output/<path:fname>")
    def serve_output(fname):
        path = safe_resolve(output, fname)
        if not path or not path.exists():
            abort(404)
        mt = "audio/aiff" if path.suffix.lower() in {".aif", ".aiff"} else None
        return send_file(str(path), mimetype=mt, conditional=True)

    @app.get("/audio/<path:fname>")
    def serve_audio_as_wav(fname):
        """Serve a rendered stem as WAV, transcoding from .aif via sox if
        needed. The transcoded WAV is cached under cache/output_wav/ so
        subsequent requests are instant.

        Sotto cache/ e non accanto allo stem come prima: `output/` e' quello
        che /stems inventaria, e un `<basename>__<sid>.transcoded.wav` li'
        dentro passava per uno stem con l'id `<sid>.transcoded` — un id
        fantasma nell'indice del browser, cioe' un nome bruciato per
        `allocStreamIds`. Stessa scelta di /media_audio, che non ha mai scritto
        dentro refs/.

        Firefox can't decode AIFF via Web Audio's decodeAudioData; this
        endpoint exists so the editor can play stems in any browser. The
        editor calls /audio/<basename>__<sid>.aif and gets back a WAV body
        without renaming on disk."""
        # Una sola scrittura della regola, `_resolve_audio`: prima
        # l'estensione chiesta, poi il fallback. La copia in linea qui non
        # passava nemmeno da `safe_resolve`, e ignorava il formato richiesto.
        source = _resolve_audio(output, fname)
        if source is None:
            abort(404)

        if source.suffix.lower() == ".wav":
            return send_file(str(source), mimetype="audio/wav", conditional=True)

        wav_cache = cache / "output_wav" / (source.name + ".wav")
        try:
            transcode_wav(source, wav_cache, timeout=30)
        except SoxNotFound:
            abort(500, "sox not found — needed to transcode AIFF→WAV "
                       "for browser playback")
        except SoxFailed as e:
            abort(500, f"sox failed: {e}")
        return send_file(str(wav_cache), mimetype="audio/wav", conditional=True)

    @app.get("/peaks/<path:fname>")
    def serve_peaks(fname):
        """Return a waveform peak array for a rendered stem as raw binary:
        `PEAK_BUCKETS` little-endian float32 values in 0..1 (max abs amplitude
        per bucket across channels). ~128 KB regardless of stem length.

        Computed server-side so the browser never decodes the full PCM just to
        draw a waveform (a 8-min stereo stem is ~160 MB decoded; this is 16 KB).
        Cached on disk under cache/peaks/, regenerated only when the source is
        newer than the cache (same staleness rule as the WAV transcode above)."""
        source = _resolve_audio(output, fname)
        if source is None:
            abort(404)

        peaks_dir = cache / "peaks"
        # Bucket count in the name so bumping PEAK_BUCKETS invalidates old
        # caches automatically (stale .f32 files just become orphaned).
        #
        # E il nome della SORGENTE, estensione compresa: senza suffisso i due
        # formati dello stesso stem condividevano una voce sola, e `_is_fresh`
        # la confrontava con la sorgente scelta. Bastava che l'altra fosse piu'
        # vecchia perche' la cache risultasse fresca per sempre: il disegno
        # restava quello di un render precedente e nessun render lo sbloccava.
        cache_file = peaks_dir / (source.name + f".{PEAK_BUCKETS}.f32")
        try:
            peaks_file(source, cache_file)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side waveforms")
        except Exception as e:
            abort(500, f"peak extraction failed: {e}")
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    @app.get("/spectrogram/<path:fname>")
    def serve_spectrogram(fname):
        """Log-magnitude STFT spectrogram for a rendered stem. Binary: uint32
        width + uint32 height header, then width*height uint8 values. Mirrors
        /peaks (same stem resolution + staleness rule) but spectrogram instead
        of waveform peaks. Cached under cache/spec/."""
        source = _resolve_audio(output, fname)
        if source is None:
            abort(404)

        scale = request.args.get("scale", "linear")
        if scale not in ("linear", "log"):
            scale = "linear"

        spec_dir = cache / "spec"
        # scale in the filename so linear/log cache side-by-side; il nome della
        # sorgente con la sua estensione per la stessa ragione di /peaks — due
        # formati, due voci, altrimenti si invalidano a vicenda.
        cache_file = spec_dir / (source.name + f".{scale}.spec")
        try:
            spectrogram_file(source, cache_file, scale)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side spectrograms")
        except Exception as e:
            abort(500, f"spectrogram failed: {e}")
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    # --------- media (refs/) preview: playback, waveform, spectrogram ---------
    # Same patterns as the output/ endpoints above but rooted at refs/, with
    # all derived artifacts cached under cache/ (never written into refs/).

    @app.get("/media_audio/<path:fname>")
    def media_audio(fname):
        """Serve a refs/ media file as WAV for browser playback (transcoding
        via sox if it isn't already WAV). Mirrors /audio but for refs/."""
        source = _resolve_audio(refs, fname)
        if source is None:
            abort(404)
        if source.suffix.lower() == ".wav":
            return send_file(str(source), mimetype="audio/wav", conditional=True)

        wav_dir = cache / "media_wav"
        wav_cache = wav_dir / (source.name + ".wav")
        try:
            transcode_wav(source, wav_cache, timeout=60)
        except SoxNotFound:
            abort(500, "sox not found — needed to transcode media for "
                       "browser playback")
        except SoxFailed as e:
            abort(500, f"sox failed: {e}")
        return send_file(str(wav_cache), mimetype="audio/wav", conditional=True)

    @app.get("/media_peaks/<path:fname>")
    def media_peaks(fname):
        """Waveform peak array for a refs/ media file. Mirrors /peaks but for
        refs/, cached under cache/peaks_media/."""
        source = _resolve_audio(refs, fname)
        if source is None:
            abort(404)
        peaks_dir = cache / "peaks_media"
        cache_file = peaks_dir / (source.name + f".{PEAK_BUCKETS}.f32")
        try:
            peaks_file(source, cache_file)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side waveforms")
        except Exception as e:
            abort(500, f"peak extraction failed: {e}")
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    @app.get("/media_spectrogram/<path:fname>")
    def media_spectrogram(fname):
        """Log-magnitude STFT spectrogram for a refs/ media file (numpy-only,
        computed server-side). Binary: uint32 width + uint32 height header,
        then width*height uint8 values. Cached under cache/spec_media/."""
        source = _resolve_audio(refs, fname)
        if source is None:
            abort(404)
        spec_dir = cache / "spec_media"
        cache_file = spec_dir / (source.name + ".spec")
        try:
            spectrogram_file(source, cache_file)
        except ImportError:
            abort(500, "numpy/soundfile not installed — `pip install -r "
                       "requirements.txt` for server-side spectrograms")
        except Exception as e:
            abort(500, f"spectrogram failed: {e}")
        return send_file(str(cache_file), mimetype="application/octet-stream",
                         conditional=True)

    @app.get("/cache_manifest/<basename>")
    def cache_manifest(basename):
        if "/" in basename or ".." in basename: abort(400)
        path = cache / f"{basename}.json"
        if not path.exists():
            return jsonify({})
        try:
            return jsonify(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return jsonify({})

    @app.get("/stems/<basename>")
    def list_stems(basename):
        """Return the rendered stems on disk, one entry per file.

        The browser populates its stem index from this on page load, so hasStem()
        works without a render in the current session. The extension is part of
        the answer, not a detail: playback requests the extension of the Settings
        output format, so a stem that exists only as .aif is *not* playable while
        the format is wav. Collapsing the formats to a bare id made that clip
        read as rendered and then go silent — a 404 the <audio> element reports
        by never firing `canplay`, with no error anywhere."""
        if "/" in basename or ".." in basename: abort(400)
        stems = []
        prefix = basename + "__"
        for p in sorted(output.glob(f"{basename}__*.*")):
            if p.suffix.lower() not in {".aif", ".aiff", ".wav", ".flac"}:
                continue
            sid = p.stem[len(prefix):]
            if sid:
                # `dur` e' la durata dello stem SUL DISCO, che non e' quella
                # dello stream nell'editor appena una modifica lo ha accorciato
                # (un taglio, un resize) senza un nuovo render. Serve a disegnare
                # il waveform nel tempo giusto invece di stirarlo sulla clip:
                # senza, una clip dimezzata mostra tutto lo stem compresso.
                # Lettura del solo header (audio_duration), None se illeggibile.
                stems.append({"streamId": sid, "ext": p.suffix,
                              "mtime": p.stat().st_mtime,
                              "dur": audio_duration(p)})
        return jsonify({"basename": basename, "stems": stems})

    @app.get("/grains/<basename>/<streamId>")
    def serve_grains(basename, streamId):
        """Serve the per-stream grain JSON sidecar produced by the engine's
        --grain-json flag: output/<basename>__<streamId>__grains.json.
        The editor draws these grains inside clips and in the score panel."""
        if "/" in basename or ".." in basename: abort(400)
        if "/" in streamId or ".." in streamId: abort(400)
        path = safe_resolve(output, f"{basename}__{streamId}__grains.json")
        if not path or not path.exists():
            abort(404)
        return send_file(str(path), mimetype="application/json", conditional=True)

    # --------- engine setup ---------

    @app.post("/setup")
    def setup_engine():
        """Create the engine venv and install requirements.txt if not present.
        Streams the same NDJSON format as /render so the UI can show it in the
        terminal. Safe to call repeatedly — skips if venv already exists."""
        def event_stream():
            overall_ok = True
            for ev in _ensure_venv_events(root):
                yield json.dumps(ev) + "\n"
                if ev.get("type") == "venv-done":
                    overall_ok = ev.get("ok", False)
            yield json.dumps({"type": "done", "ok": overall_ok}) + "\n"
        return Response(event_stream(), mimetype="application/x-ndjson")

    # --------- render ---------

    @app.post("/render/cancel")
    def cancel_render():
        rs.cancel()
        return jsonify({"ok": True})

    @app.post("/render")
    def render():
        opts = request.get_json(force=True) or {}
        basename = opts.get("yamlBasename") or opts.get("projectBasename")
        if not basename:
            abort(400, "yamlBasename required")
        # Il basename diventa un path E un file scritto: e' il confine di
        # fiducia di una route che scrive. Passa per `safe_resolve` come tutte
        # le altre route invece di riscriverne una versione piu' debole — la
        # regola scritta due volte divergeva gia': qui non erano rifiutati il
        # separatore di Windows, il punto iniziale, e il NUL faceva 500
        # (ValueError dal filesystem) invece di 400.
        yml = safe_resolve(configs, f"{basename}.yml")
        if yml is None:
            abort(400, "bad basename")

        renderer = opts.get("renderer", "numpy")
        use_cache = bool(opts.get("useCache", True))
        visualize = bool(opts.get("visualize", False))
        # Per-voice offset curves in the PDF score (PGE #90 / issue #55).
        # Off by default; engines that predate the flag parse argv manually
        # and ignore unknown flags, so forwarding it is always safe.
        show_voice_offsets = bool(opts.get("showVoiceOffsets", False))
        page_duration = opts.get("pageDuration")
        # Selective score-envelope filter (issue #31). Keep only names the engine
        # actually knows: an unknown name makes main.py exit 1 and aborts the
        # render. If the engine predates the feature (no valid keys) we drop the
        # list entirely so the legacy engine never sees the unsupported flag.
        plot_envelopes = opts.get("plotEnvelopes")
        if plot_envelopes:
            valid = set(engine_envelope_keys(root))
            plot_envelopes = [n for n in plot_envelopes if n in valid] or None
        else:
            plot_envelopes = None
        # Lente della partitura (PGE #214 / issue #120): automatica sul cluster
        # più denso e/o target espliciti come SPEC del motore. Lo SPEC viaggia
        # verbatim — a parsarlo è main.py — ma vuoto significa "nessun target"
        # e il flag non parte: `--magnify-at ""` farebbe uscire il motore con
        # codice 1, portandosi via anche l'audio. La UI controlla la grammatica
        # prima di inviare (src/lib/magnify-spec.js).
        magnify    = bool(opts.get("magnify", False))
        magnify_at = (opts.get("magnifyAt") or "").strip() or None
        reaper    = bool(opts.get("reaper", False))
        preclean  = bool(opts.get("preclean", False))
        # Per-stream grain sidecar (issue #68). Default True = historical
        # always-on behavior (#13); the UI can disable it to skip the heavy JSON.
        grain_json = bool(opts.get("grainJson", True))
        fmt       = opts.get("outputFormat", "aiff")
        if fmt not in {"aiff", "wav", "flac"}:
            abort(400, f"invalid format: {fmt!r}")
        _EXT = {"aiff": ".aif", "wav": ".wav", "flac": ".flac"}
        out_ext = _EXT[fmt]

        yaml_content = opts.get("yamlContent")
        # Write the editor state to the canonical config (never a temp file): the
        # engine's per-stream cache manifest is keyed by the YAML basename
        # (cache/<basename>.json), so a random temp name would orphan the manifest
        # every render and mark all streams DIRTY. Git is the versioning/rollback
        # mechanism for configs/ — see CLAUDE.md "NDJSON render protocol".
        if yaml_content:
            yml.write_text(yaml_content, encoding="utf-8")
        elif not yml.exists():
            return jsonify({"ok": False,
                            "error": f"configs/{basename}.yml not found"}), 404

        output_stem = output / f"{basename}{out_ext}"

        # Le quattro path si fissano QUI, non dentro il generatore: il
        # workspace e' commutabile a caldo, e lo stream NDJSON vive per tutta
        # la durata del render. Rilette a valle, un cambio a meta' manderebbe
        # gli stem in una cartella e il manifest di cache in un'altra. La
        # route /workspace rifiuta comunque il cambio a render in corso — qui
        # si chiude la finestra fra la POST e lo spawn. #147
        #
        # `ws` sta nella riga per la stessa ragione delle altre tre, anche se
        # a valle serve solo a scrivere un percorso relativo: la riga `done`
        # direbbe gli stem sotto una cartella che non li ha mai visti.
        ws_dir, ws_refs, ws_output, ws_cache = ws, refs, output, cache

        # Optional: wipe previous stems (current format only) if requested.
        if preclean:
            for p in ws_output.glob(f"{basename}__*{out_ext}"):
                try: p.unlink()
                except Exception: pass

        def event_stream():
            """Generator: yields one NDJSON line per UI event."""
            # La pretesa si prende QUI, al primo istante del generatore, e non
            # allo spawn: fra i due c'e' la creazione del venv del motore, che
            # e' minuti in cui `rs.proc` e' ancora None. Li' POST /workspace
            # passerebbe, e il render — che i path se li e' gia' fissati —
            # scriverebbe stem e manifest nella cartella di prima mentre il
            # browser mostra la nuova: pallino verde e nessun audio dietro,
            # cioe' esattamente cio' che il 409 esiste per impedire.
            #
            # Rilasciata dal finally piu' esterno, che copre anche le due
            # uscite che quello interno non vede: il ritorno anticipato del
            # venv fallito e il GeneratorExit di un client che se ne va a
            # meta' setup. Una pretesa appesa bloccherebbe /workspace per
            # tutta la vita del bridge. #147
            rs.enter()
            try:
                # Ensure engine venv exists before running main.py.
                venv_py = root / ".venv" / "bin" / "python"
                if not venv_py.exists():
                    yield json.dumps({"type": "log",
                                      "line": "[VENV] engine venv missing — setting up…"}) + "\n"
                    setup_ok = True
                    for ev in _ensure_venv_events(root):
                        yield json.dumps(ev) + "\n"
                        if ev.get("type") == "venv-done":
                            setup_ok = ev.get("ok", False)
                    if not setup_ok or not venv_py.exists():
                        yield json.dumps({"type": "log",
                                          "line": "[ERROR] venv setup failed — render aborted"}) + "\n"
                        yield json.dumps({"type": "done", "ok": False,
                                          "error": "venv setup failed"}) + "\n"
                        return

                # Build the command using the engine venv python.
                cmd = build_render_command(
                    venv_py, root, yml, output_stem,
                    renderer=renderer, use_cache=use_cache, cache=ws_cache,
                    visualize=visualize, page_duration=page_duration, reaper=reaper,
                    basename=basename, refs=ws_refs, output=ws_output, fmt=fmt,
                    plot_envelopes=plot_envelopes, grain_json=grain_json,
                    show_voice_offsets=show_voice_offsets,
                    magnify=magnify, magnify_at=magnify_at,
                )

                yield json.dumps({"type": "log",
                                  "line": "$ " + " ".join(cmd)}) + "\n"
                watchdog = None
                try:
                    proc = rs.start(cmd, root)
                    # Hard cap: kill a stuck main.py so it can't hold a worker
                    # thread forever (workers=1, threads=4). The kill closes the
                    # pipe → readline hits EOF → this loop ends normally. #43
                    watchdog = start_watchdog(proc, render_timeout)
                    # Gli id dichiarati dalla richiesta: e' l'unica cosa che
                    # distingue `[CACHE] stream1: clean` da `[CACHE] Manifest: …`,
                    # che il motore stampa a ogni render con --cache. Vuoto (o
                    # assente) significa "richiesta che non dichiara gli stream":
                    # nessun filtro, comportamento storico. Vedi render_pipeline.
                    req_streams = opts.get("streams") or []
                    stream_ids  = {str(s.get("id")) for s in req_streams
                                   if isinstance(s, dict) and s.get("id") is not None}
                    state = {"streamId": None, "total": len(req_streams), "index": 0,
                             "ids": stream_ids or None}
                    # Read line-by-line and stream to client.
                    for raw in iter(proc.stdout.readline, ""):
                        line = raw.rstrip("\n")
                        if rs.is_cancelled():
                            proc.terminate()
                            yield json.dumps({"type": "log",
                                              "line": "[ABORT] cancelled"}) + "\n"
                            yield json.dumps({"type": "done", "ok": False}) + "\n"
                            return
                        for ev in parse_render_line(line, state):
                            yield json.dumps(ev) + "\n"
                    proc.wait()
                    ok = (proc.returncode == 0)
                    # `generated` e' relativo al workspace quando gli stem ci
                    # vivono dentro; altrimenti resta assoluto (relative_to alza
                    # ValueError su un percorso fuori dal ramo). Il browser legge
                    # solo il basename di queste voci, ma il log del terminale le
                    # mostra: un percorso di comodo non deve diventare una bugia.
                    generated = []
                    for p in sorted(ws_output.glob(f"{basename}__*{out_ext}")):
                        try:
                            generated.append(str(p.relative_to(ws_dir)))
                        except ValueError:
                            generated.append(str(p))
                    yield json.dumps({
                        "type": "done", "ok": ok,
                        "generated": generated,
                        "returncode": proc.returncode,
                    }) + "\n"
                except FileNotFoundError as e:
                    yield json.dumps({"type": "log",
                                      "line": f"[ERROR] {e}"}) + "\n"
                    yield json.dumps({"type": "done", "ok": False,
                                      "error": str(e)}) + "\n"
                except Exception as e:
                    yield json.dumps({"type": "log",
                                      "line": f"[ERROR] {type(e).__name__}: {e}"}) + "\n"
                    yield json.dumps({"type": "done", "ok": False,
                                      "error": str(e)}) + "\n"
                finally:
                    if watchdog is not None:
                        watchdog.cancel()
            finally:
                rs.clear()

        # mimetype "application/x-ndjson" is what the browser LocalBackend reads.
        return Response(event_stream(), mimetype="application/x-ndjson")

    # --------- static UI file serving ---------
    # Serves the PGE-ui directory so no separate http.server is needed.
    # API routes above take priority over this catch-all.
    ui_dir = str(Path(__file__).parent)

    @app.get("/")
    def ui_index():
        return send_from_directory(ui_dir, "PGE Editor.html")

    @app.get("/<path:filename>")
    def ui_static(filename):
        return send_from_directory(ui_dir, filename)

    # Le path risolte e la risposta del motore, esposte sull'app perche' il
    # banner di main() le STAMPI invece di riderivarle. Dove punta refs/ e' una
    # regola sola — quella di _set_workspace, tenuta ferma da una guardia di
    # sorgente in test-workspace.js — e una seconda scrittura sarebbe una copia
    # che nessuna guardia tiene attaccata all'originale. Il banner e' proprio il
    # posto dove una divergenza si legge come verita': e' la riga da cui
    # l'autore impara dove mettere i sample. #148
    app.pge_paths = _resolved_paths
    app.pge_samples_follow = lambda: samples_follow_ws

    return app


# -------------------------------------------------------------------------
# CLI entry point
# -------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Local HTTP bridge for the PGE browser editor.",
    )
    ap.add_argument("--port", type=int, default=7878,
                    help="port to listen on (default: 7878)")
    ap.add_argument("--root", default="../PythonGranularEngine",
                    help="path to the PythonGranularEngine repo root "
                         "(default: ../PythonGranularEngine, "
                         "i.e. cloned side-by-side with PGE-ui)")
    ap.add_argument("--workspace", default=None,
                    help="folder holding configs/ output/ cache/ — and refs/ "
                         "too, on an engine with --samples-dir — your own "
                         "pieces, outside the engine checkout. Subdirectories "
                         "are created if missing. Default: same as --root "
                         "(historical behavior)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address (default: 127.0.0.1, localhost only)")
    ap.add_argument("--render-timeout", type=float, default=600.0,
                    help="hard cap in seconds on a single render before the "
                         "subprocess is killed; 0 disables (default: 600)")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    main_py = root / "src" / "main.py"
    if not main_py.exists():
        sys.exit(
            f"Can't find src/main.py under {root}.\n"
            f"\n"
            f"Pass --root to point at your PythonGranularEngine clone:\n"
            f"    python server.py --root /path/to/PythonGranularEngine\n"
            f"\n"
            f"Or clone the engine side-by-side with PGE-ui:\n"
            f"    cd ..\n"
            f"    git clone https://github.com/DMGiulioRomano/PythonGranularEngine\n"
            f"    cd PGE-ui && python server.py\n"
        )

    workspace = None
    if args.workspace:
        workspace = Path(args.workspace).expanduser().resolve()
        # Stessa regola della route POST /workspace: le sottodirectory si
        # creano, il workspace no. Un refuso sulla riga di comando deve
        # fermare il bridge, non fabbricare una cartella vuota e far sparire
        # i progetti dell'autore.
        if not workspace.is_dir():
            sys.exit(
                f"--workspace {workspace} non esiste (o non e' una directory).\n"
                f"\n"
                f"Crea la cartella e riprova: le sottodirectory (configs/, "
                f"output/, cache/ e — su un motore con --samples-dir — refs/) "
                f"le crea il bridge.\n"
            )

    app = make_app(root, render_timeout=args.render_timeout, workspace=workspace)

    def _check_cmd(cmd):
        try:
            subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=2)
            return True
        except Exception:
            return False
    def _binary_present(name):
        # soxi has no --version flag (exits non-zero); treat only a missing
        # binary (FileNotFoundError) as absent.
        try:
            subprocess.run([name], capture_output=True, timeout=2)
            return True
        except FileNotFoundError:
            return False
        except Exception:
            return True
    sox_ok  = _check_cmd(["sox", "--version"])
    soxi_ok = _binary_present("soxi")
    try:
        import soundfile  # noqa: F401
        sf_ok = True
    except Exception:
        sf_ok = False

    # Le path del banner sono quelle che make_app ha gia' risolto, non una
    # seconda derivazione: il banner deve dire la cartella che il render
    # leggera' davvero, e l'unico che lo sa e' _set_workspace. Riscriverne la
    # regola qui la sdoppierebbe, e il banner e' la riga da cui l'autore impara
    # dove mettere i sample — una copia divergente si leggerebbe come verita'.
    _paths  = app.pge_paths()
    _follow = app.pge_samples_follow()
    print(f"PGE bridge")
    print(f"  root:      {root}")
    print(f"  workspace: {_paths['workspace']}"
          + ("" if workspace else "  (= root, default)"))
    print(f"  refs/:     {_paths['refs']}" + ("" if _follow else
          "   (dal motore: --samples-dir non c'e' — PythonGranularEngine#235)"))
    print(f"  configs/:  {_paths['configs']}")
    print(f"  output/:   {_paths['output']}")
    print(f"  cache/:    {_paths['cache']}")
    print(f"  sox:     {'ok' if sox_ok else 'MISSING (brew install sox — needed for browser playback)'}")
    print(f"  soundfile:{' ok — sample durations' if sf_ok else ' MISSING (durations fall back to soxi)'}")
    print(f"  soxi:    {'ok' if soxi_ok else 'optional (durations via soundfile; sox/soxi for AIFF→WAV transcode)'}")
    print(f"  listen:  http://{args.host}:{args.port}")
    print(f"")
    print(f"Open in browser:  http://{args.host}:{args.port}/")
    print(f"  (gear → Backend → local → server URL http://{args.host}:{args.port})")
    print(f"")
    from gunicorn.app.base import BaseApplication

    class _StandaloneApp(BaseApplication):
        def __init__(self, wsgi_app, options=None):
            self.options = options or {}
            self.application = wsgi_app
            super().__init__()

        def load_config(self):
            for key, value in self.options.items():
                self.cfg.set(key, value)

        def load(self):
            return self.application

    _StandaloneApp(app, {
        "bind": f"{args.host}:{args.port}",
        # Uno solo, e non e' un dettaglio di prestazioni: il workspace
        # commutabile a caldo (#147) e' stato di processo, e con piu' worker
        # una POST /workspace ne cambierebbe uno mentre gli altri continuano a
        # servire le cartelle di prima.
        "workers": 1,
        "worker_class": "gthread",
        # Ogni <audio> in riproduzione tiene occupato un thread per tutta la
        # durata dello stem (il browser scarica a rate reale, non in un colpo).
        # Con 4 thread bastavano 4 stream sovrapposti per affamare il server: il
        # 5° stream restava muto finche' non si liberava un thread, poi partiva a
        # meta' clip (il seek di recupero in _scheduleStreaming). I thread qui
        # sono I/O-bound, costano poco.
        # ponytail: numero fisso; oltre i ~200 stream simultanei passare a piu'
        # worker o a un worker async.
        "threads": 200,
        "accesslog": "-",
        "loglevel": "warning",
    }).run()


if __name__ == "__main__":
    main()
