"""render_pipeline.py — render orchestration for the PGE bridge.

Extracted from server.py (#43): stdout→NDJSON parsing, the single-render state
(spawn / cancel, serialized by a lock), command construction, and a process
watchdog. No Flask here — the /render and /render/cancel routes in server.py
own the HTTP/NDJSON concerns and delegate process mechanics to this module.
"""

import queue
import re
import subprocess
import threading


# I due canali del sottoprocesso del motore. Non sono un'etichetta di comodo:
# protocollo e' uno solo dei due, e tenerli distinti e' meta' della #162. Vedi
# `merged_output` e `render_events`.
STDOUT = "stdout"
STDERR = "stderr"


# Regexes for parsing main.py's stdout into structured UI events.
#
# Actual main.py output format (numpy renderer):
#   "[CACHE] stream1: clean"   → stream is cached, will be skipped
#   "[CACHE] stream1: DIRTY"   → stream will be rendered
#   " Generazione completata! 5 file generati:"
#   "    /abs/path/to/output/PGE_test__stream1.aif"
#
# The absolute path lines appear all together at the end (summary block), after
# every stem is written — and they are the ONLY line that says a DIRTY stem has
# been written. The [CACHE] lines don't: this parser used to read them as "one
# per stream as each starts" and closed the previous DIRTY stream on the next
# one, but the numpy renderer triages EVERY stream before writing any
# (`NumpyAudioRenderer.render_streams`, "Fase 1 — triage cache"), so they
# arrive in one burst. That claimed every DIRTY stream but the last before the
# engine had touched a sample — and a `stream-done` is a claim: the browser
# stamps this run's fingerprint, semantics and backend on it (PGE-ui #151).
# A run that died after the triage left them green on audio nobody rewrote.
# So a DIRTY stream waits for its own path line, whatever the renderer's order.
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
# `-`. Ogni stream DIRTY dipende da questa riga (vedi sopra), e con `-` o `.`
# il `stream-done` non arrivava mai: pallino giallo dopo un render che aveva
# fatto esattamente cio' che il pallino chiedeva. Il confronto con gli stream
# in attesa, sotto, e' la vera discriminante — qui basta riconoscere la riga.
_RE_STEM_PATH  = re.compile(r"^\s+(.+__.+)\.(?:aif|aiff|wav|flac)\s*$", re.IGNORECASE)
# La testa del blocco riassuntivo di `cli.py`, e con essa l'unico punto dello
# stdout in cui `_RE_STEM_PATH` vale qualcosa:
#
#     \n Generazione completata! {n} file generati:
#         {path}
#         {path}
#
# Serve perche' quella regex e' una forma che le righe umane condividono: le
# basta una riga INDENTATA che finisca per `__<qualcosa>.<aif|aiff|wav|flac>`,
# e i messaggi d'errore del motore citano i path dei sample con la stessa
# forma. Misurato (PGE #178):
#
#     '  Path cercato: refs/voce__streamA.wav'
#         → stream-done di `streamA`, su uno stem mai scritto
#
# Bastava cioe' un sample chiamato come lo stem di uno stream in attesa
# (`<basename>__<id>`, o col solo suffisso quando la richiesta non passa il
# basename) — il confronto sul nome file regge tutti gli altri casi, e' la
# coincidenza di nome che passa — e il pallino diventava verde con nessun
# audio dietro, che e' il solo errore che questo parser non puo' permettersi.
#
# Restringere la regex non era la strada: un path puo' contenere spazi
# (`/Users/me/My Music/proj__s1.wav`), e ogni stream DIRTY dipende da questa
# riga per il suo `stream-done` (vedi l'intestazione, #151). A discriminare non
# e' la forma ma la POSIZIONE: quei path il motore li stampa in un blocco solo,
# sotto la sua riga di testa, e li' dentro ogni riga indentata E' un path.
#
# Se un giorno la riga di testa cambiasse parole il blocco non si aprirebbe
# piu', e nessuna riga di path chiuderebbe uno stream. Su un giro riuscito i
# pallini non se ne accorgono — il fallback dell'evento `done` in backend.js
# reclama gli stream costruiti che nessuno `stream-done` ha chiuso — ma si
# perde l'avanzamento vivo; su un giro fallito non si reclama niente, che e'
# la direzione buona. Comunque non resta alla prosa: `test_render_pipeline.py`
# legge la riga dai sorgenti del motore e diventa rosso il giorno che si muove.
_RE_SUMMARY_HEAD = re.compile(r"^\s*Generazione completata!.*:\s*$")
# Riga indentata e non vuota: finche' escono cosi', il blocco e' ancora aperto.
_RE_INDENTED = re.compile(r"^\s+\S")


def parse_render_line(line: str, state: dict) -> list:
    """Turn a single **stdout** line into one or more browser-bound events.

    Il canale lo sceglie `render_events`, che e' l'unico chiamante legittimo:
    da stderr non si deriva niente, e il perche' sta li'.
    """
    events = [{"type": "log", "line": line}]

    # Il blocco riassuntivo si apre sulla sua riga di testa...
    if _RE_SUMMARY_HEAD.match(line):
        state["summary"] = True
        return events
    # ...e si chiude alla prima riga che non e' indentata. Non serve un
    # terminatore dal motore: sotto il blocco escono `Reaper project:`,
    # `Grain JSON:`, `Log:` — tutte a colonna zero — e prima ancora la riga
    # vuota che `print("\nGenerazione partitura grafica...")` antepone.
    if state.get("summary") and not _RE_INDENTED.match(line):
        state["summary"] = False

    # [CACHE] stream1: clean  → cached, emit start+done immediately
    # [CACHE] stream1: DIRTY  → about to render, emit start only
    m = _RE_CACHE_LINE.match(line)
    if m:
        sid   = m.group(1)
        # Un id che la richiesta non ha dichiarato non e' uno stream: e' una
        # riga di servizio del motore (Manifest, GC) che ha la stessa forma,
        # o una riga che nel processo del motore ha scritto qualcun altro.
        #
        # Il filtro e' TOTALE (#162): `ids` assente o vuoto non significa piu'
        # "nessun filtro" ma "la richiesta non ha dichiarato nessuno stream",
        # e da una richiesta che non dichiara niente non si deriva niente.
        # Prima era l'inverso, e il prezzo era che l'unica cosa capace di
        # distinguere `[CACHE] stream1: clean` da `[CACHE] Manifest: <path>`
        # restava inerte proprio quando nessuno le aveva detto su cosa
        # lavorare: due stream inventati per giro, barra 3/2, un toast che
        # dichiara una cache mai avvenuta.
        #
        # Il browser gli id li dichiara sempre (`streams: data.streams` in
        # app.jsx), quindi a cambiare comportamento e' solo una richiesta che
        # non li dichiara — e li' c'e' una rete: su un giro riuscito il
        # fallback dell'evento `done` in backend.js emette uno `stream-done`
        # sintetico per ogni stem che il server ha trovato SU DISCO (senza una
        # lista non ha un insieme contro cui giudicare, e li' reclama tutto).
        # Perdere questi eventi costa la barra di avanzamento viva, mai un
        # pallino sbagliato.
        if sid not in (state.get("ids") or ()):
            return events
        dirty = m.group(2).strip().upper() == "DIRTY"
        total = state.get("total", 0)
        idx   = state.get("index", 0)
        state["index"] = idx + 1
        events.append({"type": "stream-start",
                        "streamId": sid, "index": idx, "total": total})
        if not dirty:
            events.append({"type": "stream-done", "streamId": sid, "cached": True})
        else:
            # Da rendere: resta in attesa della SUA riga di path, non della
            # prossima `[CACHE]` (vedi l'intestazione).
            state.setdefault("pending", []).append(sid)
        return events

    # Summary path lines: "    /abs/path/output/PGE_test__stream1.aif"
    # Each one closes the pending DIRTY stream whose stem it names.
    #
    # Solo DENTRO il blocco riassuntivo: fuori, questa forma e' condivisa con
    # le righe umane del motore — vedi `_RE_SUMMARY_HEAD`.
    m2 = _RE_STEM_PATH.match(line) if state.get("summary") else None
    if m2:
        pending = state.get("pending") or []
        fname = re.split(r"[\\/]", m2.group(1))[-1]
        base = state.get("basename")
        if base is not None:
            # Col basename noto il nome del file e' esattamente
            # `<basename>__<id>`: nessun separatore da indovinare. Il suffisso
            # non basta con piu' stream in attesa, perche' sia il basename sia
            # l'id possono contenere `__` — con basename `x__b`, il file di `a`
            # (`x__b__a`) finisce anche per `__b__a`.
            head = base + "__"
            sid = fname[len(head):] if fname.startswith(head) else None
            hit = sid if sid in pending else None
        else:
            # Senza basename (una richiesta che non lo passa) resta il
            # suffisso, e fra piu' candidati vince il piu' lungo.
            hits = [p for p in pending if fname.endswith("__" + p)]
            hit = max(hits, key=len) if hits else None
        if hit is not None:
            pending.remove(hit)
            events.append({"type": "stream-done",
                            "streamId": hit, "cached": False})
    return events


def render_events(channel: str, line: str, state: dict) -> list:
    """Gli eventi di una riga, decisi dal CANALE da cui arriva.

    Protocollo e' stdout e basta. stderr e' log, e non e' pignoleria: il
    bridge lanciava il motore con `stderr=subprocess.STDOUT`, quindi i due
    flussi finivano nello stesso `readline` e OGNI riga di stderr passava per
    `parse_render_line`.

    Il motore si e' dato la regola «nessuno, su nessun canale, scrive righe
    con la forma del protocollo» e la sorveglia
    (`tests/shared/test_stdout_contract.py`, PGE #178). Ma quella regola
    vincola il motore, non i suoi host: `logging` scrive su stderr, e
    qualunque libreria di terze parti dentro quel processo puo' ancora
    stampare una riga di quella forma. Misurato con la diagnostica del motore
    accesa come la accenderebbe chiunque —
    `logging.basicConfig(level=DEBUG, format="%(message)s")` — un record
    `[CACHE] %s: registrata` produceva `stream-start` piu' `stream-done` per
    uno stream di nome `gaussian`, che non esiste. Nel formato di default a
    salvarlo era solo il prefisso `DEBUG:pge.diagnostics:` che il formatter
    antepone: una scelta di chi lancia, non una garanzia.

    Il descrittore di file non separava niente perche' a unirli eravamo noi.
    Separati (`merged_output`), separa — ed e' l'unica meta' del problema che
    il motore non puo' riparare da solo.
    """
    if channel != STDOUT:
        return [{"type": "log", "line": line}]
    return parse_render_line(line, state)


def _pump(stream, channel, q):
    """Legge un pipe riga per riga e lo versa nella coda. `None` = EOF."""
    try:
        for raw in iter(stream.readline, ""):
            q.put((channel, raw.rstrip("\n")))
    finally:
        q.put((channel, None))


def merged_output(proc):
    """Yield `(canale, riga)` dai due pipe del processo, in ordine d'arrivo.

    Due pompe daemon su una coda. I pipe vanno drenati ENTRAMBI e sempre, o il
    figlio si blocca appena quello non letto si riempie — che e' la ragione
    per cui `stderr=subprocess.STDOUT` era comodo, e l'unica.

    L'ordine FRA i due canali resta approssimato, esattamente come lo era
    prima: li' a decidere era il buffering dei due flussi dentro il processo
    del motore (stdout di protocollo e' flushato, il resto no), qui e' la
    coda. L'ordine DENTRO ciascun canale invece e' esatto, ed e' l'unico da
    cui `parse_render_line` dipende: lo stato per stream si muove sulle sole
    righe di stdout.

    `proc.stderr` a None (un processo aperto senza quel pipe, o un doppio
    costruito a mano nei test) vale una pompa in meno, non un errore.
    """
    q = queue.Queue()
    live = 0
    for channel, stream in ((STDOUT, proc.stdout), (STDERR, proc.stderr)):
        if stream is None:
            continue
        live += 1
        threading.Thread(target=_pump, args=(stream, channel, q),
                         daemon=True).start()
    while live:
        channel, line = q.get()
        if line is None:
            live -= 1
            continue
        yield channel, line


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
        """Spawn the subprocess under the lock and remember it. Returns proc.

        I due flussi restano DUE (#162). Erano uno — `stderr=subprocess.STDOUT`
        — e quella fusione e' l'intera prima meta' della issue: il parser di
        protocollo leggeva anche cio' che il motore non aveva scelto di
        stampare. Chi legge e' `merged_output`, che li riunisce etichettati:
        due pompe, una coda, e il canale arriva fino a `render_events`.
        """
        with self.lock:
            self.cancelled = False
            self.proc = subprocess.Popen(
                cmd, cwd=str(cwd),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
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
