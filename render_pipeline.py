"""render_pipeline.py — render orchestration for the PGE bridge.

Extracted from server.py (#43): stdout→NDJSON parsing, the single-render state
(spawn / cancel, serialized by a lock), command construction, and a process
watchdog. No Flask here — the /render and /render/cancel routes in server.py
own the HTTP/NDJSON concerns and delegate process mechanics to this module.
"""

import re
import shutil
import subprocess
import threading
from pathlib import Path


# Regexes for parsing main.py's stdout into structured UI events.
#
# Actual main.py output format (numpy renderer):
#   "[CACHE] stream1: clean"   → stream is cached, will be skipped
#   "[CACHE] stream1: DIRTY"   → stream will be rendered
#   " Generazione completata! 5 file generati:"
#   "    /abs/path/to/output/PGE_test__stream1.aif"
#
# Note: [CACHE] lines appear one per stream as each starts.
# The absolute path lines appear all together at the end (summary block).
#
# Ma non tutte le righe `[CACHE]` sono stream, e la forma non le distingue:
# il motore stampa `[CACHE] Manifest: <path>` a ogni render con --cache e
# `[CACHE] GC: rimossi N stream orfani: [...]` quando la GC rimuove qualcosa.
# Entrambe passano questo regex, e da sole valgono due stream inventati per
# giro — barra 3/2, un toast che dichiara una cache mai avvenuta, e due voci
# fantasma nell'indice stem persistito del browser, da cui `ownsStem` risponde
# `true` per un file mai esistito. A discriminare non e' quindi la riga ma
# l'insieme degli id che la richiesta dichiara (`state["ids"]`): una lista di
# prefissi riservati lascerebbe rientrare il prossimo `[CACHE] Qualcosa:` a
# monte dalla stessa porta. La sonda in tests/python/test_render_pipeline.py
# chiede le righe ai sorgenti del motore invece di trascriverle.
_RE_CACHE_LINE = re.compile(r"^\[CACHE\]\s+(\S+):\s+(.+)$")
# Matches absolute path ending in __<streamId>.<aif|wav|flac>.
#
# L'id NON e' vincolato a `\w`: il charset che `renameStream` (app.jsx)
# pubblicizza sono lettere, cifre, `.`, `_` e `-`, quindi `\w` escludeva `.` e
# `-`. Solo l'ULTIMO stream DIRTY del giro dipende da questa riga (gli altri li
# chiude la riga `[CACHE]` successiva), e per lui il `stream-done` non
# arrivava mai: pallino giallo dopo un render che aveva fatto esattamente cio'
# che il pallino chiedeva. Il confronto con lo stream in corso, sotto, e' la
# vera discriminante — qui basta riconoscere la riga.
_RE_STEM_PATH  = re.compile(r"^\s+(.+__.+)\.(?:aif|aiff|wav|flac)\s*$", re.IGNORECASE)


def parse_render_line(line: str, state: dict) -> list:
    """Turn a single stdout line into one or more browser-bound events."""
    events = [{"type": "log", "line": line}]

    # [CACHE] stream1: clean  → cached, emit start+done immediately
    # [CACHE] stream1: DIRTY  → about to render, emit start only
    m = _RE_CACHE_LINE.match(line)
    if m:
        sid   = m.group(1)
        # Un id che la richiesta non ha dichiarato non e' uno stream: e' una
        # riga di servizio del motore (Manifest, GC) che ha la stessa forma.
        # `ids` assente = richiesta che non dichiara gli stream: nessun
        # insieme, nessun filtro, comportamento storico.
        ids = state.get("ids")
        if ids is not None and sid not in ids:
            return events
        dirty = m.group(2).strip().upper() == "DIRTY"
        total = state.get("total", 0)
        idx   = state.get("index", 0)
        state["index"] = idx + 1
        # Previous DIRTY stream is done now that we're starting the next one
        prev = state.get("streamId")
        if prev:
            events.append({"type": "stream-done", "streamId": prev, "cached": False})
            state["streamId"] = None
        events.append({"type": "stream-start",
                        "streamId": sid, "index": idx, "total": total})
        if not dirty:
            events.append({"type": "stream-done", "streamId": sid, "cached": True})
        else:
            state["streamId"] = sid  # track: this stream is being rendered
        return events

    # Summary path lines: "    /abs/path/output/PGE_test__stream1.aif"
    # Extract stream_id from filename to emit stream-done for the last DIRTY stream.
    m2 = _RE_STEM_PATH.match(line)
    if m2:
        prev = state.get("streamId")
        # Il confronto e' sul suffisso e non su un gruppo catturato: sia il
        # basename sia l'id possono contenere `__`, quindi non c'e' una
        # posizione del separatore da indovinare — c'e' un solo id che questa
        # riga puo' chiudere, ed e' quello in corso.
        if prev and m2.group(1).endswith("__" + prev):
            events.append({"type": "stream-done",
                            "streamId": prev, "cached": False})
            state["streamId"] = None
    return events


class RenderState:
    """Mutable state for the single in-flight render (only one at a time).

    The lock serializes /render and /render/cancel exactly as the old
    dict-based state did, so cancel can't race the spawn."""

    def __init__(self):
        self.proc = None
        self.cancelled = False
        # Un render e' "in volo" da prima che il sottoprocesso esista: fra la
        # POST e lo spawn ci puo' stare la creazione del venv del motore. Vedi
        # enter() e is_running().
        self.streaming = False
        self.lock = threading.Lock()

    def start(self, cmd, cwd):
        """Spawn the subprocess under the lock and remember it. Returns proc."""
        with self.lock:
            self.cancelled = False
            self.proc = subprocess.Popen(
                cmd, cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
            return self.proc

    def cancel(self):
        """Mark cancelled and SIGTERM the running process (if any)."""
        with self.lock:
            self.cancelled = True
            proc = self.proc
            if proc and proc.poll() is None:
                proc.terminate()

    def is_cancelled(self) -> bool:
        return self.cancelled

    def enter(self):
        """Il generatore NDJSON di /render e' partito. Si prende qui e non allo
        spawn perche' fra i due c'e' la creazione del venv del motore: minuti in
        cui non esiste ancora un sottoprocesso e il render e' comunque in volo,
        coi path della cartella di lavoro gia' fissati. La rilascia clear()."""
        with self.lock:
            self.streaming = True

    def is_running(self) -> bool:
        """C'e' un render in volo. Serve a /workspace, che deve rifiutare il
        cambio di cartella mentre un render sta scrivendo stem e manifest
        (PGE-ui #147).

        Due meta': la pretesa presa da enter(), che copre tutta la vita del
        generatore — venv compreso — e il sottoprocesso vivo. La seconda non e'
        ridondante: dice la verita' anche a chi costruisce un RenderState a
        mano, e `poll()` e' piu' preciso di `self.proc`, che resta valorizzato
        finche' la route non chiama clear()."""
        if self.streaming:
            return True
        proc = self.proc
        return proc is not None and proc.poll() is None

    def clear(self):
        with self.lock:
            self.proc = None
            self.streaming = False


def build_render_command(venv_py, root, yml, output_stem, *, renderer, use_cache,
                         cache, visualize, page_duration, reaper, basename,
                         refs, output, fmt, plot_envelopes=None,
                         grain_json=True, show_voice_offsets=False,
                         magnify=False, magnify_at=None, bw=False) -> list:
    """Build the `python src/main.py …` argv. Pure (no spawning) so it is unit
    testable. `--show-static` is appended only with `--visualize` — it has no
    effect otherwise (engine docs/reference/cli.md). #43

    `plot_envelopes` (issue #31) is the selective score-envelope filter: an
    iterable of envelope names emitted as `--plot-envelopes a,b,c`. Like
    `--page-duration` it only makes sense with `--visualize`, so it is gated
    inside the visualize block; empty/None means "all envelopes" (flag omitted).
    Names are passed through verbatim — the caller (server.py) already filters
    to the engine's valid keys.

    `grain_json` (issue #68) toggles the per-stream `--grain-json` sidecar the
    UI uses to draw grains. Default True keeps the historical always-on behavior
    (#13); set False to skip the heavy JSON on dense compositions.

    `show_voice_offsets` (PGE #90 / PGE-ui #55) draws the per-voice offset
    curves (voice_pitch_offset/voice_pointer_offset per voice, plus the single
    voice_pointer_range spread) in the PDF score's envelope panel. Only
    meaningful with `--visualize`, so it is gated inside that block.

    `magnify` / `magnify_at` (PGE #214 / PGE-ui #120) are the score's lens: the
    first projects a zoomed circle on each page's densest grain cluster, the
    second takes an engine SPEC of explicit targets
    (`t=14,y=2.7,zoom=10;t=20,stream=texture2`) — and since PGE #214 every lens
    also reads out the envelope values at its instant. The two combine (auto
    lens plus explicit ones) and are gated on `--visualize` like the rest.

    `bw` (PGE #248 / PGE-ui #152) switches the score to the print-friendly
    black-and-white preset (achromatic pitch colormap, envelopes told apart by
    dash pattern instead of hue). It is a switch — no value to parse, so unlike
    `--plot-envelopes` and `--magnify-at` it cannot make the engine exit 1 —
    and it only means something with `--visualize`, so it rides inside that
    block like `--show-static`. Inert on an engine that predates it: the CLI
    parses sys.argv by hand and ignores unknown flags, and with no value of its
    own it can't be mistaken for a positional either.

    `refs` (PGE-ui #148) is the samples directory, and goes out as
    `--samples-dir` for **both** renderers — see the comment at the flag. The
    csound branch keeps its own `--ssdir` on top: on a current engine the two
    say the same thing (SSDIR falls back to samples_dir), but on an engine
    without `--samples-dir` the `--ssdir` is the only half that lands, and
    dropping it would turn a redundant flag into a regression.

    The SPEC is forwarded verbatim, like `--plot-envelopes` names: the engine
    is the one that parses it. What this function does refuse is the *blank*
    one — a whitespace-only field means "no explicit targets", while
    `--magnify-at ""` is an error that exits main.py with code 1 and would take
    the whole render, audio included, down with it. The UI checks the grammar
    before sending (`src/lib/magnify-spec.js`) so a typo doesn't get this far."""
    cmd = [
        str(venv_py), str(root / "src" / "main.py"),
        str(yml), str(output_stem),
        "--renderer", renderer,
        "--per-stream",
        "--format", fmt,
    ]
    if grain_json:
        cmd += ["--grain-json"]
    if use_cache:
        cmd += ["--cache", "--cache-dir", str(cache)]
    if visualize:
        cmd += ["--visualize", "--show-static"]
        if show_voice_offsets:
            cmd += ["--show-voice-offsets"]
        if page_duration is not None and float(page_duration) != 15.0:
            cmd += ["--page-duration", str(float(page_duration))]
        if plot_envelopes:
            names = [str(n).strip() for n in plot_envelopes if str(n).strip()]
            if names:
                cmd += ["--plot-envelopes", ",".join(names)]
        if bw:
            cmd += ["--bw"]
        if magnify:
            cmd += ["--magnify"]
        spec = str(magnify_at).strip() if magnify_at else ""
        if spec:
            cmd += ["--magnify-at", spec]
    if reaper:
        cmd += ["--reaper", "--reaper-path", str(output / f"{basename}.rpp")]
    # --samples-dir: dove stanno i file audio sorgente, per ENTRAMBI i
    # renderer (PythonGranularEngine#235 / PGE-ui #148). Senza, il motore li
    # risolve su `./refs/` RELATIVO AL PROPRIO CWD — cioe' i render di oggi
    # stanno in piedi per via del `cwd=root` dello spawn, non per il --ssdir
    # qui sotto: SSDIR dice a csound dove cercare i soundfile in fase di
    # render, ma la durata del sample la risolve il Generator prima che esista
    # un renderer, e quel passo leggeva il globale. Esplicito, la dipendenza
    # implicita dal cwd cade e la cartella dei sample puo' stare altrove.
    #
    # Inerte sui motori che il flag non ce l'hanno: il parsing della CLI e'
    # manuale su sys.argv, solo argv[1] e argv[2] sono posizionali e le flag
    # sconosciute vengono ignorate in silenzio (engine docs/reference/cli.md).
    # Per questo va mandato sempre, senza gate di versione — a essere gated e'
    # semmai dove il bridge fa puntare `refs` (server.py, _set_workspace).
    #
    # Lo slash finale non serve: il motore normalizza (`_with_trailing_sep` in
    # pge/api.py) prima dei due punti che concatenano il nome file.
    cmd += ["--samples-dir", str(refs)]
    if renderer == "csound":
        cmd += [
            "--orc-path", str(root / "csound" / "main.orc"),
            "--incdir",   str(root / "src"),
            "--ssdir",    str(refs),
            "--sfdir",    str(output),
            "--log-dir",  str(root / "logs"),
        ]
    return cmd


# --- Disponibilita' dei backend (PGE-ui #150) ---------------------------------
#
# Cosa serve nel PATH perche' un backend non muoia al primo grano. Il motore
# lancia i binari per nome (`['csound', ...]`, `sc_config.get('scsynth_bin',
# 'scsynth')`) e il sottoprocesso eredita l'ambiente del bridge, quindi il PATH
# che conta e' questo. Sono nomi trascritti, l'unica eccezione alla regola del
# repo in questo modulo, e per una ragione: il motore li scrive come default
# DENTRO una chiamata, non come costante di modulo, e una lettura AST di
# quell'argomento sarebbe piu' fragile della copia. A tenerla onesta e'
# `test_engine_binaries_on_the_real_engine`, che pretende ogni nome come
# costante di stringa nel modulo del renderer che lo lancia.
#
# numpy non e' qui: gira nel venv del motore, che /diagnose controlla gia'.
RENDERER_BINARIES = {
    "csound": ("csound",),
    "supercollider": ("scsynth",),
}
# sclang serve solo a compilare la SynthDef, e solo quando il compilato manca
# o e' piu' vecchio del sorgente: per questo non sta fra i binari sempre dovuti.
SC_COMPILER = "sclang"

_INSTALL_HINT = {
    "csound": "install csound, or render with numpy",
    "supercollider": ("install SuperCollider (apt install supercollider · "
                      "brew install --cask supercollider, then put scsynth "
                      "on the PATH)"),
}


def _sc_needs_compile(source: Path, compiled: Path) -> bool:
    """La regola del motore (`SuperColliderRenderer._needs_compile`), la stessa
    di un Makefile: si compila se il `.scsyndef` manca o e' piu' vecchio del
    sorgente; senza sorgente il compilato vale comunque."""
    if not compiled.exists():
        return True
    if not source.exists():
        return False
    return source.stat().st_mtime > compiled.stat().st_mtime


def _supercollider_row(root: Path, which, synthdef):
    scsynth = which("scsynth")
    if not scsynth:
        return False, f"scsynth not on PATH — {_INSTALL_HINT['supercollider']}"
    if synthdef is None:
        return True, (f"scsynth: {scsynth} · SynthDef not checked "
                      "(engine layout not recognised)")
    # Relativi al cwd del sottoprocesso, che e' il root: e' li' che il motore
    # li risolvera' (vedi `engine_sc_synthdef`).
    source = root / synthdef["source"]
    compiled = root / synthdef["dir"] / f"{synthdef['name']}.scsyndef"
    if not _sc_needs_compile(source, compiled):
        return True, f"scsynth: {scsynth} · SynthDef compiled"
    if not source.exists():
        return False, (f"SynthDef source {synthdef['source']} missing in the "
                       f"engine, and nothing compiled in {synthdef['dir']}/")
    sclang = which(SC_COMPILER)
    if not sclang:
        return False, ("sclang not on PATH, and the SynthDef isn't compiled "
                       "yet — run `make sc-synthdef` in the engine once, or "
                       "install sclang")
    return True, (f"scsynth: {scsynth} · SynthDef compiled on the first "
                  f"render (sclang: {sclang})")


def renderer_availability(root, names, *, which=shutil.which, synthdef=None) -> list:
    """Per ogni backend in `names` (l'elenco del motore, nel suo ordine):
    `{"name", "available", "detail"}`.

    `available` ha TRE valori, e la differenza conta: `True`/`False` quando il
    bridge sa cosa serve a quel backend, `None` per un backend che non conosce
    (un quarto aggiunto a monte) — "non lo so", che la UI non traduce in un
    bottone spento. Il rifiuto, se serve, lo dara' il motore col suo messaggio.

    Nessuna cache: `which` e qualche stat, e chi installa SuperCollider col
    bridge acceso deve vederlo alla prossima apertura del popover.

    Non e' un gate del render: `/render` non rifiuta un backend indisponibile,
    perche' il motore lo fa gia' con un messaggio che nomina il rimedio
    (`*NotFoundError`). Questa funzione serve a dirlo PRIMA, nel popover e in
    /diagnose — un render perso per saperlo e' quello che la issue chiude."""
    root = Path(root)
    rows = []
    for name in names:
        if name == "numpy":
            available, detail = True, "no external binary"
        elif name == "supercollider":
            available, detail = _supercollider_row(root, which, synthdef)
        elif name in RENDERER_BINARIES:
            missing = [b for b in RENDERER_BINARIES[name] if not which(b)]
            if missing:
                available = False
                detail = (f"{', '.join(missing)} not on PATH — "
                          f"{_INSTALL_HINT.get(name, 'install it')}")
            else:
                available = True
                detail = " · ".join(f"{b}: {which(b)}" for b in RENDERER_BINARIES[name])
        else:
            available, detail = None, "availability not checked by this bridge"
        rows.append({"name": name, "available": available, "detail": detail})
    return rows


def kill_process(proc, grace: float = 5.0):
    """Stop `proc`: SIGTERM, then SIGKILL if it doesn't exit within `grace`
    seconds. Safe on an already-dead or None process."""
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=grace)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def start_watchdog(proc, timeout: float, grace: float = 5.0):
    """Start a one-shot timer that hard-stops `proc` after `timeout` seconds, so
    a blocked main.py can't hold a worker thread forever. Killing it closes the
    pipe, the readline loop hits EOF and the render route finishes normally.
    Returns the started Timer (cancel it on normal completion) or None when
    `timeout` <= 0 (watchdog disabled)."""
    if not timeout or timeout <= 0:
        return None
    t = threading.Timer(timeout, lambda: kill_process(proc, grace))
    t.daemon = True
    t.start()
    return t
