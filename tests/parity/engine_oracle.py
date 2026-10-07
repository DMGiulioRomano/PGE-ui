#!/usr/bin/env python3
"""engine_oracle.py — chiede al motore vero le risposte che i mirror JS
promettono di replicare (issue #133).

## Perche' esiste

Il CLAUDE.md di questo repo documenta una mezza dozzina di "patti di parita'"
con PythonGranularEngine: il fingerprint degli stem, la grammatica di
`--magnify-at`, la classificazione di `deviation_probability`, le soglie di
overflow delle time distribution, la mappa dei bounds. Ogni mirror JS e'
testato — ma contro se stesso. Un mirror puo' essere internamente perfetto e
completamente divergente dall'originale: le soglie in `test-time-dist.js` sono
numeri che qualcuno ha ottenuto lanciando il motore una volta e ha trascritto,
e se il motore cambia restano verdi.

Questo script rende quelle domande eseguibili. Un test node lo avvia una volta,
gli passa righe JSON e riceve righe JSON: la risposta viene dal motore
importato, non da una sua descrizione.

## Regola non negoziabile

**L'oracolo importa dal motore, non ne riscrive la logica.** Una copia
sarebbe un terzo specchio da tenere allineato, cioe' il problema che questo
file esiste per chiudere. Ogni op qui sotto e' un adattatore: normalizza gli
argomenti, chiama il motore, serializza il risultato o l'eccezione.

Le deroghe erano due, e avevano la stessa forma: `parse_magnify_spec`, dove
`pge.cli` non e' importabile senza numpy/soundfile/matplotlib, e
`filter_solo_mute`, dove `pge.engine.generator` tira dentro numpy. Li'
l'oracolo estraeva dal file i soli nodi AST che servivano e li eseguiva: i byte
del motore, quindi la risposta era vera, ma la lettura pinnava nomi *privati* e
la loro posizione nel file, cosi' che una rinomina la' dentro rendeva rossa la
CI di qui su ogni PR aperta.

PGE #246 ha spostato entrambi in moduli che non importano niente —
`pge.shared.magnify_spec` e `pge.engine.solo_mute`, con nomi pubblici — e
`_load_magnify_from_source` e `_load_filter_solo_mute` adesso **importano**.
Il vecchio ast-slice resta come ripiego sui motori anteriori a quella issue:
la CI di qui fa il checkout del ramo di default del motore, e i due merge non
avvengono nello stesso istante.

## Il protocollo

Una richiesta per riga su stdin:

    {"id": 1, "op": "fingerprint", "args": {...}}

Una risposta per riga su stdout:

    {"id": 1, "ok": true,  "value": ...}
    {"id": 1, "ok": false, "error": "ClasseErrore: messaggio"}

Prima di tutto l'oracolo emette una riga di handshake (`id: 0`) con la radice
del motore, il suo commit git, le op disponibili e quelle non disponibili con
il motivo. Il commit serve a distinguere "abbiamo sbagliato noi" da "il motore
e' cambiato" quando una parita' fallisce.

Lo stdout e' riservato al protocollo. Il motore stampa di suo (il clip logger
annuncia il file di log appena si costruisce un EnvelopeGate): il vero stdout
viene duplicato su un fd privato all'avvio e `sys.stdout` dirottato su stderr,
cosi' nessun print del motore puo' corrompere una riga JSON.

## Uso

    python3 engine_oracle.py --root /path/to/PythonGranularEngine

Da node: `tests/parity/oracle.js`. A mano, per una domanda sola:

    echo '{"op":"constants","args":{}}' | python3 engine_oracle.py --root ../../../PythonGranularEngine
"""

import argparse
import atexit
import contextlib
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path


# =============================================================================
# STDOUT PRIVATO
# =============================================================================
# Il motore stampa. `configure_clip_logger` annuncia "Clip log file: ..." la
# prima volta che si costruisce un gate con envelope, e `parse_magnify_spec`
# stampa l'errore prima di uscire. Se quelle righe finissero nel canale del
# protocollo il client node leggerebbe JSON malformato — e il sintomo sarebbe
# un test di parita' rotto per un motivo che non c'entra niente con la parita'.
#
# Quindi: il vero stdout viene duplicato su `_PROTOCOL` e `sys.stdout` punta a
# stderr. Tutto cio' che il motore stampa resta visibile nell'output del test,
# dove e' informazione; il protocollo viaggia su un fd che il motore non
# conosce.
_PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
sys.stdout = sys.stderr


# Etichetta dei float non finiti sul filo (vedi _json_safe). Il gemello sta in
# oracle.js: cambiarla qui senza cambiarla li' fa arrivare il tag alle suite.
NON_FINITE_TAG = "__float__"


def _json_safe(o):
    """JSON stretto: i float non finiti viaggiano come sentinella etichettata.

    `json.dumps` di Python emette `Infinity` e `NaN`, che JSON non prevede e
    che `JSON.parse` di node rifiuta — una riga sola cosi' e il client muore
    con "riga non JSON" invece di rispondere alla domanda.

    La prima versione li mandava a `null`, "come farebbe JSON.stringify".
    Era vero e inutile: `JSON.stringify` fa lo stesso di la', quindi un
    confronto fra target diventava `null === null` e passava anche se i due
    lati dicessero uno `+inf` e l'altro `NaN`. Rendeva i due lati
    indistinguibili, non confrontabili — l'opposto di cio' che serve a una
    suite di parita', e proprio sui valori (`t=inf`, `t=nan`, `t=1e400`) su
    cui la grammatica di magnify-spec e' cambiata.

    La sentinella e' un dict etichettato e non una stringa nuda perche' un
    valore di stringa legittimo puo' benissimo essere "Infinity" (`stream=`
    prende testo libero): `{"__float__": "Infinity"}` non collide con niente.
    `oracle.js` la ridecodifica in un numero vero prima di consegnare la
    risposta, quindi le suite vedono `Infinity`, non un tag."""
    if isinstance(o, float):
        if math.isfinite(o):
            return o
        if o != o:
            return {NON_FINITE_TAG: "NaN"}
        return {NON_FINITE_TAG: "Infinity" if o > 0 else "-Infinity"}
    if isinstance(o, dict):
        return {k: _json_safe(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_json_safe(v) for v in o]
    return o


def _from_wire(o):
    """Il verso d'andata della sentinella: `oracle.js` etichetta i numeri non
    finiti degli argomenti come questo file etichetta quelli delle risposte.

    Senza, `JSON.stringify` di la' li manda a `null`, e una domanda su
    `end_time: .inf` arrivava qui come `end_time: None` — un'altra domanda,
    con un'altra risposta, e nessun modo di accorgersene."""
    if isinstance(o, dict):
        if len(o) == 1 and NON_FINITE_TAG in o:
            return float(o[NON_FINITE_TAG])   # "Infinity", "-Infinity", "NaN"
        return {k: _from_wire(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_from_wire(v) for v in o]
    return o


def _emit(payload: dict) -> None:
    _PROTOCOL.write(json.dumps(_json_safe(payload), allow_nan=False) + "\n")
    _PROTOCOL.flush()


# =============================================================================
# REGISTRO DELLE OP
# =============================================================================

_OPS = {}


def op(name):
    """Registra una funzione come operazione del protocollo."""
    def deco(fn):
        _OPS[name] = fn
        return fn
    return deco


class OracleError(Exception):
    """Errore attribuibile alla richiesta, non al motore (argomento mancante,
    op che richiede una capability assente). Viaggia come gli altri errori ma
    senza traceback: non c'e' niente da diagnosticare nel motore."""


def _fmt_exc(exc: BaseException) -> str:
    """`ClasseErrore: messaggio`, la forma che i test confrontano.

    Per SystemExit — cioe' per `parse_magnify_spec`, che stampa ed esce — il
    messaggio utile e' quello stampato, non il codice di uscita: chi chiama lo
    passa in `.oracle_stdout` e lo appende qui."""
    out = getattr(exc, "oracle_stdout", "")
    # Per SystemExit `str(exc)` e' il codice di uscita ("1"), che non dice
    # niente: se c'e' il testo stampato quello E' il messaggio.
    msg = out if out else str(exc)
    return f"{type(exc).__name__}: {msg}"


# =============================================================================
# IMPORT DEL MOTORE
# =============================================================================

class Engine:
    """Accesso pigro ai moduli del motore, con il motivo del fallimento.

    Nessun modulo viene importato prima di servire l'handshake: cosi'
    l'handshake stesso puo' dire quali op sono disponibili e perche' le altre
    non lo sono, invece di far morire il processo al primo import mancante.
    """

    def __init__(self, root: Path):
        self.root = root
        self._cache = {}
        self._errors = {}
        src = root / "src"
        if not src.is_dir():
            raise SystemExit(
                f"engine_oracle: nessun sorgente del motore in {src} "
                f"(--root deve puntare a un checkout di PythonGranularEngine)"
            )
        # In testa: un `pge` gia' installato altrove non deve vincere sul
        # checkout che il test sta effettivamente misurando.
        sys.path.insert(0, str(src))

    def module(self, dotted: str):
        if dotted in self._cache:
            return self._cache[dotted]
        if dotted in self._errors:
            raise OracleError(f"{dotted} non importabile: {self._errors[dotted]}")
        try:
            mod = __import__(dotted, fromlist=["_"])
        except BaseException as exc:  # ImportError, ma anche SystemExit
            self._errors[dotted] = _fmt_exc(exc)
            raise OracleError(f"{dotted} non importabile: {self._errors[dotted]}")
        self._cache[dotted] = mod
        return mod

    def probe(self, dotted: str):
        """None se il modulo si importa, altrimenti il motivo."""
        try:
            self.module(dotted)
            return None
        except OracleError as exc:
            return str(exc)

    def commit(self) -> dict:
        """Commit del checkout del motore: il dato che distingue una parita'
        rotta da noi da una rotta dal motore. `{}` se non e' un repo git."""
        def git(*args):
            try:
                out = subprocess.run(
                    ["git", "-C", str(self.root), *args],
                    capture_output=True, text=True, timeout=10,
                )
            except (OSError, subprocess.SubprocessError):
                return None
            return out.stdout.strip() if out.returncode == 0 else None

        sha = git("rev-parse", "HEAD")
        if sha is None:
            return {}
        return {
            "sha": sha,
            "short": sha[:9],
            "subject": git("log", "-1", "--pretty=%s") or "",
            "dirty": bool(git("status", "--porcelain")),
        }


ENGINE: Engine = None  # valorizzato in main()

# Il modulo del motore che serve a ciascuna op. Serve all'handshake per dire
# cosa e' disponibile prima che qualcuno lo chieda.
_OP_REQUIRES = {
    "fingerprint": "pge.rendering.stream_cache_manager",
    "classify_deviation_probability": "pge.parameters.gate_factory",
    "build_time_distribution": "pge.envelopes.time_distribution",
    "parameter_bounds": "pge.parameters.parameter_definitions",
    # Dalla PGE #246 sono import come gli altri, ma restano `None` qui: il
    # loro caricatore ha un ripiego sul motore anteriore a quella issue, quindi
    # "il modulo non si importa" non vuol dire "l'op non e' disponibile".
    # Dichiararne uno direbbe non disponibile un'op che risponde.
    "parse_magnify_spec": None,
    "filter_solo_mute": None,
    "constants": "pge.rendering.stream_cache_manager",
    "build_envelope": "pge.envelopes.envelope",
    "evaluate_envelope": "pge.envelopes.envelope",
}


# =============================================================================
# OP — fingerprint
# =============================================================================

@op("fingerprint")
def _op_fingerprint(args):
    """SHA-256 con cui il motore decide se uno stem e' dirty.

    args:
        stream       dict dello stream come appare nello YAML (snake_case)
        samples_dir  opzionale, per risolvere la durata di uno stream che
                     non dichiara `duration`
        renderer     opzionale, str|None: il backend che produce gli stem
                     ('numpy' | 'csound' | 'supercollider'). E' il TERZO asse
                     dentro l'hash del motore, accanto alla semantica: qualcosa
                     da cui lo stem dipende e che il testo YAML non dice.
                     Costruire il manager senza passarlo vuol dire chiedere
                     ogni fingerprint in una configurazione in cui il prodotto
                     non gira mai.
        semantics    opzionale, int: rimpiazza VARIATION_SEMANTICS_VERSION per
                     la durata della chiamata. Serve a una domanda sola —
                     "quel numero e' davvero dentro l'hash?" — che dal solo
                     esadecimale non si legge. Non e' logica riscritta: e' il
                     `compute_fingerprint` del motore eseguito con un valore
                     diverso della sua costante, la stessa cosa che fa il test
                     del motore (test_stream_cache_manager.py). Il patch e'
                     ripristinato sempre, cosi' le chiamate successive sullo
                     stesso processo non ereditano il valore finto.

    Nota sulla durata implicita: il motore risolve la lunghezza dal file
    audio, e quel path importa `pge.shared.utils`, che importa soundfile. Su
    un checkout senza venv l'import fallisce, e l'errore arriva al chiamante
    come errore dell'op invece di essere ingoiato — un caso di parita' che non
    puo' girare deve essere rumoroso, non verde.
    """
    scm = ENGINE.module("pge.rendering.stream_cache_manager")
    stream = args.get("stream")
    if not isinstance(stream, dict):
        raise OracleError("fingerprint: 'stream' deve essere un dict")
    mgr = scm.StreamCacheManager(
        cache_path=os.path.join(tempfile.gettempdir(), "pge-parity-unused.json"),
        samples_dir=args.get("samples_dir"),
        renderer_type=args.get("renderer", "numpy"),
    )
    semantics = args.get("semantics")
    if semantics is None:
        return {"hex": mgr.compute_fingerprint(stream)}
    if not isinstance(semantics, int) or isinstance(semantics, bool):
        raise OracleError("fingerprint: 'semantics' deve essere un int")
    previous = scm.VARIATION_SEMANTICS_VERSION
    try:
        scm.VARIATION_SEMANTICS_VERSION = semantics
        return {"hex": mgr.compute_fingerprint(stream), "semantics": semantics}
    finally:
        scm.VARIATION_SEMANTICS_VERSION = previous


# =============================================================================
# OP — parse_magnify_spec
# =============================================================================

_MAGNIFY_NAMESPACE = None

# I nomi che la grammatica di `--magnify-at` deve consegnare, qualunque strada
# l'oracolo prenda per procurarseli. UNA lista sola, e questo e' il punto: i
# rami hanno gia' divergiuto una volta — quello import popolava il solo
# parser, quindi `constants` leggeva None per le tre chiavi e la suite falliva
# con `null` come unico messaggio. Chi ha il venv del motore vedeva 8/3, chi
# non ce l'ha 11/0, sullo stesso commit.
#
# Sono i nomi PUBBLICI, che il motore ha dato alla grammatica spostandola in
# `pge.shared.magnify_spec` (PGE #246): un modulo che non importa niente, cioe'
# importabile col solo python del runner. Era la prima delle due deroghe alla
# regola non negoziabile di questo file, e non c'e' piu'.
_MAGNIFY_NAMES = ("MAGNIFY_NUMERIC_KEYS", "MAGNIFY_STR_KEYS", "MAGNIFY_KEYS",
                  "parse_magnify_spec")

# Come si chiamavano in `pge.cli`, prima di PGE #246. Il namespace che i rami
# consegnano e' sempre chiavato sui nomi pubblici — chi legge non deve sapere
# da quale annata di motore e' arrivata la risposta — e questa mappa e' cio'
# che traduce i rami storici.
#
# Il ripiego non e' prudenza: questo repository e il motore si mergiano quando
# capita, e la CI di qui fa il checkout del ramo di default del motore. Fra il
# merge di questa PR e quello della PGE #246 la parita' girerebbe contro un
# motore che i moduli nuovi non li ha — e un'op non disponibile, sotto
# PGE_PARITY_STRICT=1, e' un fallimento.
_MAGNIFY_NAMI_STORICI = {
    "MAGNIFY_NUMERIC_KEYS": "_MAGNIFY_NUMERIC_KEYS",
    "MAGNIFY_STR_KEYS": "_MAGNIFY_STR_KEYS",
    "MAGNIFY_KEYS": "_MAGNIFY_KEYS",
    "parse_magnify_spec": "_parse_magnify_spec",
}


class IncompleteNamespace(OracleError):
    """Un ramo ha consegnato un namespace incompleto.

    La usano le due op che hanno un ripiego su un motore piu' vecchio
    (`parse_magnify_spec`, `filter_solo_mute`): dice «il modulo c'e' e il nome
    no», che e' un guasto da dichiarare, mai una ragione per scendere al ramo
    successivo.

    Ha un tipo suo perche' e' l'unico errore che NON deve far ripiegare
    `_load_magnify_from_source` sull'altro ramo: se `pge.cli` si importa ma non
    ha piu' uno dei nomi, ripiegare nasconderebbe la rinomina dietro un
    ast-slice che riesce. Prima la distinzione era una substring del messaggio
    (`if "il ramo 'import'" in str(exc)`), cioe' flusso di controllo appeso al
    testo italiano di una frase che qualcuno riscrivera' — e la rottura sarebbe
    stata il ritorno al ripiego muto, cioe' proprio il difetto che quella riga
    chiudeva."""


def _check_magnify_namespace(ns, source, where):
    """Nessun ramo consegna un namespace incompleto in silenzio."""
    missing = [n for n in _MAGNIFY_NAMES if ns.get(n) is None]
    if missing:
        raise IncompleteNamespace(
            f"parse_magnify_spec: il ramo '{source}' non ha prodotto "
            f"{', '.join(missing)} ({where}). I due rami devono consegnare gli "
            f"stessi nomi: vedi _MAGNIFY_NAMES."
        )
    return ns


def _modulo_nel_checkout(dotted: str) -> bool:
    """Il file del modulo sta nel checkout del motore?

    E' la domanda che separa «motore anteriore a PGE #246» (il modulo non
    c'e', si ripiega sul ramo storico) da «il modulo c'e' e non si importa»
    (un guasto da dichiarare). Un import fallito da solo non le distingue: in
    tutti e due i casi `ENGINE.module` alza `OracleError`."""
    rel = Path(*dotted.split("."))
    src = ENGINE.root / "src"
    return ((src / rel.with_suffix(".py")).is_file()
            or (src / rel / "__init__.py").is_file())


def _import_rotto(op: str, dotted: str, exc: OracleError) -> OracleError:
    """L'errore per un modulo leggero che c'e' e non si importa.

    Non si ripiega sul ramo storico, per la stessa ragione di
    `IncompleteNamespace`: su un motore con PGE #246 `pge.cli` e `generator.py`
    leggono dal modulo nuovo, quindi i rami storici non possono riuscire — e
    il loro errore («la grammatica si e' spostata») mandava a cercare una
    rinomina dove c'era un import rotto. Il caso tipico e' proprio quello che
    #246 sorveglia: una dipendenza pesante scesa nel modulo che non doveva
    importare niente, che senza venv non si risolve."""
    return OracleError(
        f"{op}: {dotted} c'e' nel checkout ma non si importa — {exc}. Il "
        f"modulo dev'essere importabile senza il venv del motore (PGE #246)."
    )


def _load_magnify_from_source():
    """La grammatica di `--magnify-at`, dal modulo che il motore ha fatto
    apposta perche' si potesse importare.

    Dalla PGE #246 sta in `pge.shared.magnify_spec`, che non importa niente:
    l'import riesce col solo python del runner, e questa op non e' piu' una
    deroga alla regola non negoziabile di questo file. Prima stava in
    `pge.cli`, il cui import tira dentro `ScoreVisualizer` (matplotlib) e
    `Generator` (numpy): per chiedere al motore come si parsa uno SPEC
    bisognava cercarne i quattro nodi nell'AST di `cli.py`, compilarli ed
    eseguirli — i byte del motore, quindi la risposta era vera, ma la lettura
    pinnava quattro nomi *privati* e la loro posizione nel file.

    Tre rami, dal piu' recente al piu' vecchio, ed e' lo stesso ordine di
    candidati che tiene `engine_introspect.py`:

    1. `pge.shared.magnify_spec` importato — il caso di oggi, su qualunque
       interprete;
    2. `pge.cli` importato, coi nomi privati di prima — un motore anteriore a
       PGE #246, su chi ha il venv;
    3. l'ast-slice di `cli.py`, coi nomi privati — lo stesso motore, senza venv.
       E' il ramo che la CI di questo repository prendeva prima.

    I rami 2 e 3 non sono prudenza: la CI di qui fa il checkout del **ramo di
    default** del motore, e fra il merge di questa modifica e quello di PGE
    #246 la parita' girerebbe contro un motore che il modulo nuovo non ce
    l'ha. Un'op non disponibile, sotto `PGE_PARITY_STRICT=1`, e' un
    fallimento.

    Qualunque ramo risponda, il namespace e' chiavato sui **nomi pubblici**:
    chi legge non deve sapere da quale annata di motore e' arrivata la
    risposta. `_MAGNIFY_NAMI_STORICI` e' cio' che traduce i due rami storici.

    Tutti passano da `_check_magnify_namespace`: un nome mancante e' un errore
    parlante, non un `None` che scende fino all'assert. Un namespace
    incompleto **non** fa ripiegare sul ramo successivo — il modulo si e'
    importato, quindi quel nome manca davvero, e ripiegare nasconderebbe la
    rinomina dietro un ramo che riesce.
    """
    global _MAGNIFY_NAMESPACE
    if _MAGNIFY_NAMESPACE is not None:
        return _MAGNIFY_NAMESPACE

    # 1. Il modulo di PGE #246: nessuna dipendenza, nessun venv richiesto.
    try:
        mod = ENGINE.module("pge.shared.magnify_spec")
        ns = {n: getattr(mod, n, None) for n in _MAGNIFY_NAMES}
        ns["_source"] = "import"
        _MAGNIFY_NAMESPACE = _check_magnify_namespace(
            ns, "import", "pge.shared.magnify_spec")
        return _MAGNIFY_NAMESPACE
    except IncompleteNamespace:
        raise
    except OracleError as exc:
        # C'e' e non si importa: un guasto da dichiarare, non un motore vecchio.
        if _modulo_nel_checkout("pge.shared.magnify_spec"):
            raise _import_rotto(
                "parse_magnify_spec", "pge.shared.magnify_spec", exc) from exc
        # Il modulo non c'e': motore anteriore a PGE #246. Si prova `pge.cli`.

    # 2. `pge.cli` importato, coi nomi di prima dello spostamento. Qui un
    #    namespace incompleto NON e' un errore da dichiarare ma la prova che
    #    il motore e' ancora piu' vecchio (o che `cli.py` non ha mai avuto
    #    quei nomi), quindi si scende all'ast-slice come su un import fallito:
    #    e' il ramo storico, e la sua diagnosi la da' il punto 3.
    try:
        cli = ENGINE.module("pge.cli")
        ns = {n: getattr(cli, _MAGNIFY_NAMI_STORICI[n], None)
              for n in _MAGNIFY_NAMES}
        ns["_source"] = "import-storico"
        _MAGNIFY_NAMESPACE = _check_magnify_namespace(
            ns, "import-storico", "pge.cli")
        return _MAGNIFY_NAMESPACE
    except OracleError:
        pass

    # 3. L'ast-slice di `cli.py`, coi nomi privati: il ramo che questa CI
    #    prendeva prima di PGE #246.
    import ast

    path = ENGINE.root / "src" / "pge" / "cli.py"
    if not path.exists():
        raise OracleError(f"parse_magnify_spec: {path} non esiste")
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    storici = {v: k for k, v in _MAGNIFY_NAMI_STORICI.items()}
    picked, found = [], set()
    for node in tree.body:
        name = None
        if isinstance(node, ast.FunctionDef):
            name = node.name
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            name = names[0] if names else None
        if name in storici:
            picked.append(node)
            found.add(storici[name])

    missing = [w for w in _MAGNIFY_NAMES if w not in found]
    if missing:
        raise OracleError(
            f"parse_magnify_spec: ne' pge.shared.magnify_spec (PGE #246) ne' "
            f"{path.name} definiscono {', '.join(missing)} — la grammatica si "
            f"e' spostata un'altra volta, l'oracolo va aggiornato"
        )

    ns = {"__name__": "pge_cli_magnify_slice"}
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(path), "exec"), ns)
    ns = {pubblico: ns[storico]
          for pubblico, storico in _MAGNIFY_NAMI_STORICI.items()}
    ns["_source"] = "ast-slice-storico"
    _MAGNIFY_NAMESPACE = _check_magnify_namespace(
        ns, "ast-slice-storico", str(path))
    return _MAGNIFY_NAMESPACE


@op("parse_magnify_spec")
def _op_parse_magnify_spec(args):
    """I target di `--magnify-at SPEC`, o l'errore con cui il motore esce.

    Il motore non solleva: stampa e chiama `sys.exit(1)`. Qui lo stdout viene
    catturato e attaccato al SystemExit, cosi' il client legge il messaggio
    vero — che e' il dato che il mirror promette di anticipare.
    """
    if "spec" not in args:
        raise OracleError("parse_magnify_spec: manca 'spec'")
    spec = args["spec"]
    if not isinstance(spec, str):
        raise OracleError("parse_magnify_spec: 'spec' deve essere una stringa")
    ns = _load_magnify_from_source()
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            targets = ns["parse_magnify_spec"](spec)
    except SystemExit as exc:
        exc.oracle_stdout = buf.getvalue().strip()
        raise
    return {"targets": targets, "source": ns["_source"]}


# =============================================================================
# OP — filter_solo_mute
# =============================================================================

_SOLO_MUTE_FN = None


def _load_filter_solo_mute():
    """La regola solo/mute, dal modulo che il motore ha fatto apposta.

    Dalla PGE #246 e' `pge.engine.solo_mute.filter_solo_mute`, funzione libera
    di un modulo che non importa niente. Prima era `Generator._filter_solo_mute`
    e `import pge.engine.generator` tira dentro `Stream` e i renderer, cioe'
    numpy, che il job node di questa CI non ha: bisognava cercare il
    `FunctionDef` dentro il `ClassDef` di `Generator` nell'AST del file ed
    eseguirlo come funzione libera con `self` a None. Era la seconda delle due
    deroghe alla regola non negoziabile di questo file, e non c'e' piu'.

    Il ripiego sull'ast-slice resta per lo stesso motivo dell'altra op: fra il
    merge di questa modifica e quello di PGE #246, la CI di qui gira contro un
    motore che il modulo nuovo non ce l'ha.

    **Quello che torna prende un argomento solo**, qualunque ramo risponda: la
    funzione libera ha firma `(stream_data_list)`, il metodo estratto dall'AST
    `(self, stream_data_list)`. La differenza si chiude qui e non nell'op, che
    altrimenti dovrebbe sapere da quale annata di motore e' arrivata la
    risposta — e un `self` di troppo o di meno e' un `TypeError` che nel
    payload arriva come un errore qualunque.
    """
    global _SOLO_MUTE_FN
    if _SOLO_MUTE_FN is not None:
        return _SOLO_MUTE_FN

    try:
        mod = ENGINE.module("pge.engine.solo_mute")
        fn = getattr(mod, "filter_solo_mute", None)
        if fn is None:
            # Il modulo c'e' e il nome no: un guasto da dichiarare, non una
            # ragione per ripiegare sull'ast-slice e nasconderlo. Il tipo
            # dell'eccezione e' cio' che lo distingue -- `IncompleteNamespace`
            # esiste in questo file proprio perche' quella distinzione era
            # stata una substring del messaggio, cioe' flusso di controllo
            # appeso al testo italiano di una frase che qualcuno riscrivera'.
            raise IncompleteNamespace(
                "filter_solo_mute: pge.engine.solo_mute non espone "
                "filter_solo_mute. Il modulo c'e', quindi il nome e' cambiato: "
                "l'oracolo va aggiornato (PGE #246)."
            )
        _SOLO_MUTE_FN = fn
        return _SOLO_MUTE_FN
    except IncompleteNamespace:
        raise
    except OracleError as exc:
        if _modulo_nel_checkout("pge.engine.solo_mute"):
            raise _import_rotto(
                "filter_solo_mute", "pge.engine.solo_mute", exc) from exc
        # Il modulo non c'e': motore anteriore a PGE #246, si passa all'AST.

    import ast

    path = ENGINE.root / "src" / "pge" / "engine" / "generator.py"
    if not path.exists():
        raise OracleError(f"filter_solo_mute: {path} non esiste")
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    picked = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Generator":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "_filter_solo_mute":
                    picked = item
    if picked is None:
        raise OracleError(
            f"filter_solo_mute: ne' pge.engine.solo_mute (PGE #246) ne' "
            f"Generator._filter_solo_mute in {path.name} esistono — la regola "
            f"si e' spostata, l'oracolo va aggiornato"
        )
    ns = {"__name__": "pge_generator_solo_mute_slice"}
    exec(compile(ast.Module(body=[picked], type_ignores=[]), str(path), "exec"), ns)
    metodo = ns["_filter_solo_mute"]
    # `self` a None: il metodo non lo usa, e se un giorno lo usasse il None lo
    # fa esplodere invece di rispondere a caso.
    _SOLO_MUTE_FN = lambda streams: metodo(None, streams)   # noqa: E731
    return _SOLO_MUTE_FN


@op("filter_solo_mute")
def _op_filter_solo_mute(args):
    """Gli `stream_id` degli stream che il motore costruisce, in ordine.

    args:
        streams  lista di dict come appaiono nello YAML (snake_case)

    Il print della regola (`⚡ SOLO MODE`, `🔇 N stream muted`) finirebbe
    comunque su stderr, ma una riga per caso seppellirebbe le asserzioni:
    si cattura e si butta.
    """
    streams = args.get("streams")
    if not isinstance(streams, list) or not all(isinstance(s, dict) for s in streams):
        raise OracleError("filter_solo_mute: 'streams' deve essere una lista di dict")
    fn = _load_filter_solo_mute()
    with contextlib.redirect_stdout(io.StringIO()):
        kept = fn(streams)
    return {"kept": [s.get("stream_id") for s in kept]}


# =============================================================================
# OP — classify_deviation_probability
# =============================================================================

@op("classify_deviation_probability")
def _op_classify_deviation_probability(args):
    """Il modo di `deviation_probability` secondo GateFactory, e — se si passa
    `param_key` — il gate che il motore ne costruisce.

    Due domande in una op perche' i mirror JS sono due facce dello stesso
    dato: `PGEDeviationProb.mode()` replica la classificazione,
    `PGEDeviationProb.error()` replica i corpi che il motore rifiuta. Il
    secondo si osserva solo costruendo il gate.

    args:
        value               il valore di deviation_probability
        param_key           opzionale: la chiave per cui costruire il gate
        has_explicit_range  opzionale (default False)
        duration            opzionale (default 1.0)
        time_mode           opzionale (default 'absolute')

    return:
        mode        'disabled'|'implicit'|'global'|'global_env'|'specific'
        mode_error  null, o l'errore se la classificazione stessa rifiuta
        gate        null, o il nome della classe di gate costruita
        gate_error  null, o l'errore con cui il motore rifiuta il corpo
    """
    gf = ENGINE.module("pge.parameters.gate_factory")
    if "value" not in args:
        raise OracleError("classify_deviation_probability: manca 'value'")
    value = args["value"]

    out = {"mode": None, "mode_error": None, "gate": None, "gate_error": None}

    # `mode_error` significa UNA cosa sola: il motore rifiuta questo corpo. Se
    # ci finisse anche il guasto dell'oracolo — il simbolo rinominato — la
    # suite leggerebbe l'assenza del giudice come un verdetto del giudice:
    # `mode: null` fa uscire in silenzio i due casi sulla classificazione (le
    # etichette continuano a dire «24 valori» mentre i valori confrontati sono
    # zero), e `mode_error != null` rende `engineRejects` vero per OGNI corpo,
    # quindi l'asserzione sui falsi positivi inverte il proprio significato.
    # Il simbolo e' privato ed e' fra i pinnati (PythonGranularEngine#246),
    # cioe' esattamente il genere che si rinomina senza pensarci: e' l'evento
    # che questa cartella esiste per intercettare, e non deve poter essere muto.
    classify = getattr(gf.GateFactory, "_classify_deviation_probability", None)
    if classify is None:
        raise OracleError(
            "GateFactory._classify_deviation_probability non esiste piu': "
            "il simbolo e' pinnato da questa op (vedi tests/parity/README.md)")
    try:
        mode = classify(value)
    except Exception as exc:
        out["mode_error"] = _fmt_exc(exc)
    else:
        if not hasattr(mode, "value"):
            raise OracleError(
                "_classify_deviation_probability non torna piu' un enum: "
                f"{type(mode).__name__}")
        out["mode"] = mode.value

    param_key = args.get("param_key")
    if param_key is not None:
        if not hasattr(gf.GateFactory, "create_gate"):
            raise OracleError("GateFactory.create_gate non esiste piu'")
        try:
            gate = gf.GateFactory.create_gate(
                deviation_probability=value,
                param_key=param_key,
                has_explicit_range=bool(args.get("has_explicit_range", False)),
                duration=float(args.get("duration", 1.0)),
                time_mode=args.get("time_mode", "absolute"),
            )
            out["gate"] = type(gate).__name__
        except Exception as exc:
            out["gate_error"] = _fmt_exc(exc)
    return out


# =============================================================================
# OP — build_time_distribution
# =============================================================================

# Oltre questo numero di cicli le durate non tornano al client: servirebbero a
# niente e costerebbero megabyte di JSON. Il riassunto (somma, primo, ultimo)
# torna sempre, ed e' quello che i test confrontano sulle serie lunghe.
_DURATIONS_CAP = 4096


@op("build_time_distribution")
def _op_build_time_distribution(args):
    """Costruisce la distribuzione temporale e, se si passa `n_reps`, la
    calcola davvero.

    Costruzione e calcolo sono due fallimenti diversi e vanno distinti: i
    bound dei costruttori (`ratio > 0`, `base > 1`) cadono alla creazione, gli
    overflow della coppia (parametro, n_reps) solo quando la potenza si
    calcola. Il mirror JS (`timeDistError`) li segnala entrambi con `kind`
    diversi, quindi l'oracolo deve poterli distinguere.

    args:
        spec       str | dict | null, come nello YAML
        n_reps     opzionale: se presente, calcola la distribuzione
        total_time opzionale (default 1.0)
        durations  opzionale: true per riavere l'array intero (fino a
                   _DURATIONS_CAP cicli)

    return:
        name          il `name` della strategia costruita
        build_error   null, o l'errore del costruttore
        calc_error    null, o l'errore del calcolo (overflow)
        summary       null, o {n, sum, first, last, min, max}
        durations     presente solo se richiesto e sotto il cap
    """
    td = ENGINE.module("pge.envelopes.time_distribution")
    spec = args.get("spec", None)
    out = {"name": None, "build_error": None, "calc_error": None,
           "summary": None}

    try:
        strategy = td.TimeDistributionFactory.create(spec)
    except Exception as exc:
        out["build_error"] = _fmt_exc(exc)
        return out
    out["name"] = strategy.name

    if "n_reps" not in args or args["n_reps"] is None:
        return out

    n_reps = int(args["n_reps"])
    total_time = float(args.get("total_time", 1.0))
    try:
        starts, durations = strategy.calculate_distribution(total_time, n_reps)
    except Exception as exc:
        out["calc_error"] = _fmt_exc(exc)
        return out

    out["summary"] = {
        "n": len(durations),
        "sum": sum(durations),
        "first": durations[0] if durations else None,
        "last": durations[-1] if durations else None,
        "min": min(durations) if durations else None,
        "max": max(durations) if durations else None,
        "first_start": starts[0] if starts else None,
    }
    if args.get("durations") and len(durations) <= _DURATIONS_CAP:
        out["durations"] = durations
        out["starts"] = starts
    return out


# =============================================================================
# OP — build_envelope
# =============================================================================

@op("build_envelope")
def _op_build_envelope(args):
    """Il verdetto del motore su un corpo di envelope: si costruisce un
    `Envelope` vero, lo stesso oggetto che ogni chiave costruisce dal proprio
    valore YAML.

    E' la domanda a cui risponde `PGEEnv.envShapeError`, e da PGE #211 la
    risposta sta nel builder: i guard di forma (arita' dei gruppi, gli slot del
    compatto, i punti del pattern, la distribuzione) valgono per ogni chiave e
    alzano InvalidFieldValueError. Si costruisce l'Envelope intero e non il
    solo `EnvelopeBuilder.parse` perche' "il motore rifiuta" vuol dire questo:
    su un motore precedente la `y` stringa di un pattern passava il builder e
    cadeva dopo, nell'interpolazione — rifiutata lo stesso.

    `pge.envelopes.envelope` si importa senza numpy (verificato: il builder,
    le strategie di interpolazione, i segmenti e le distribuzioni importano la
    sola stdlib), quindi l'op gira nel job node della CI come le altre.

    args:
        raw       il valore come sta nello YAML: una lista, o un dict con
                  `points`
        raw_json  in alternativa: lo stesso valore come TESTO JSON, letto qui.
                  Serve a una domanda sola, quella che dal lato node non si
                  puo' fare: `2.0` e `2` sono lo stesso Number, e
                  `JSON.stringify` scrive `2` per entrambi — mentre per il
                  motore `n_reps: 2.0` e' un float, cioe' non un compatto.

    return:
        ok     True se l'Envelope si costruisce
        error  null, o `Classe: messaggio`
        field  null, o il `field` dell'errore. Nessuna chiave viene passata al
               costruttore, quindi da PGE #211 e' la sotto-posizione che il
               builder sa da solo (`envelope.compact.n_reps`, …); prima gli
               errori di forma erano ValueError nudi, e qui c'e' null.
    """
    env_mod = ENGINE.module("pge.envelopes.envelope")
    if "raw_json" in args:
        if not isinstance(args["raw_json"], str):
            raise OracleError("build_envelope: 'raw_json' deve essere una stringa")
        raw = json.loads(args["raw_json"])
    elif "raw" in args:
        raw = args["raw"]
    else:
        raise OracleError("build_envelope: manca 'raw' (o 'raw_json')")
    out = {"ok": True, "error": None, "field": None}
    try:
        # Il clip logger annuncia il proprio file la prima volta: stdout e'
        # gia' dirottato su stderr, ma una riga per caso seppellirebbe le
        # asserzioni.
        with contextlib.redirect_stdout(io.StringIO()):
            env_mod.Envelope(raw)
    except Exception as exc:
        out["ok"] = False
        out["error"] = _fmt_exc(exc)
        field = getattr(exc, "field", None)
        out["field"] = field if isinstance(field, str) else None
    return out


# =============================================================================
# OP — evaluate_envelope
# =============================================================================

@op("evaluate_envelope")
def _op_evaluate_envelope(args):
    """Quanto vale un envelope ai tempi chiesti, secondo il motore: il
    `Envelope` vero costruito dal corpo come sta nello YAML, poi
    `Envelope.evaluate` tempo per tempo.

    `build_envelope` dice SE il motore costruisce un corpo; questa dice COSA ne
    suona. Serve alle domande di forma che lasciano il corpo valido e ne
    cambiano il senso — la prima e' #189: `wrapEnv` riscriveva un `{type,
    points}` come lista piatta, il motore la costruiva benissimo, e i segmenti
    che seguivano il `type` globale diventavano lineari. Due corpi si
    confrontano qui chiedendo gli stessi tempi a entrambi; nessun valore
    atteso e' scritto dal lato node.

    Stesso modulo di `build_envelope`, quindi niente numpy: gira nel job node
    della CI.

    Con `duration` e `time_mode` il corpo si costruisce come lo costruisce
    uno stream, `create_scaled_envelope` (stesso modulo): e' l'unica strada
    che legge `time_unit`, che `Envelope` da solo ignora — la domanda di
    `wrapEnv` che lo perdeva al primo commit.

    args:
        raw        il valore come sta nello YAML: una lista, o un dict con `points`
        times      lista di tempi (numeri), nell'unita' dei breakpoint; con
                   `duration` e `time_mode`, in secondi
        duration   facoltativo: la durata dello stream, in secondi
        time_mode  facoltativo, con `duration`: `absolute` o `normalized`

    return:
        ok      True se l'Envelope si costruisce e si valuta
        values  i valori, uno per tempo, o null
        error   null, o `Classe: messaggio`
    """
    env_mod = ENGINE.module("pge.envelopes.envelope")
    if "raw" not in args:
        raise OracleError("evaluate_envelope: manca 'raw'")
    times = args.get("times")
    if (not isinstance(times, list)
            or not all(isinstance(t, (int, float)) and not isinstance(t, bool)
                       for t in times)):
        raise OracleError("evaluate_envelope: 'times' deve essere una lista di numeri")
    scaled = "duration" in args or "time_mode" in args
    if scaled:
        duration, time_mode = args.get("duration"), args.get("time_mode")
        if (not isinstance(duration, (int, float)) or isinstance(duration, bool)
                or time_mode not in ("absolute", "normalized")):
            raise OracleError("evaluate_envelope: 'duration' numero e 'time_mode' "
                              "absolute|normalized, insieme")
    out = {"ok": True, "values": None, "error": None}
    try:
        # Il clip logger annuncia il proprio file la prima volta: vedi
        # build_envelope.
        with contextlib.redirect_stdout(io.StringIO()):
            env = (env_mod.create_scaled_envelope(args["raw"], duration, time_mode)
                   if scaled else env_mod.Envelope(args["raw"]))
            out["values"] = [float(env.evaluate(t)) for t in times]
    except Exception as exc:
        out["ok"] = False
        out["error"] = _fmt_exc(exc)
    return out


# =============================================================================
# OP — parameter_bounds
# =============================================================================

@op("parameter_bounds")
def _op_parameter_bounds(args):
    """I bound dei parametri, nelle due letture che devono coincidere.

    args:
        source  'import' (default) — i valori che il motore usa davvero,
                 letti importando GRANULAR_PARAMETERS e le PitchUnit;
                'ast' — quelli che la UI riceve, prodotti dal parser AST del
                 bridge (engine_introspect.engine_parameter_bounds).

    Le due letture hanno la stessa forma di `GET /bounds`, apposta: il test di
    parita' le confronta chiave per chiave. Finora nessuno le aveva mai messe
    una accanto all'altra — il test python del parser AST scrive un finto
    parameter_definitions.py in tmp_path, quindi verifica il parser, non la
    parita'.
    """
    source = args.get("source", "import")
    if source == "ast":
        return _bounds_from_ast()
    if source == "import":
        return _bounds_from_import()
    raise OracleError(f"parameter_bounds: 'source' sconosciuto: {source!r}")


def _bounds_from_import():
    from dataclasses import asdict

    pd = ENGINE.module("pge.parameters.parameter_definitions")
    params = {name: asdict(bounds)
              for name, bounds in pd.GRANULAR_PARAMETERS.items()}

    pitch = {}
    try:
        pu = ENGINE.module("pge.parameters.pitch_unit")
    except OracleError:
        return {"params": params, "pitch": pitch}

    # edoFactor: il ±N ottave di EdoUnit.value_bounds, ricavato dal motore
    # invece che riletto dal sorgente. Con divisions=1 il bound E' il fattore.
    pitch["edoFactor"] = float(pu.EdoUnit(1).value_bounds().max_val)
    for name, factory in pu.PITCH_UNIT_PRESETS.items():
        b = factory().value_bounds()
        pitch[name] = {"min": b.min_val, "max": b.max_val,
                       "rangeMax": b.max_range}
    return {"params": params, "pitch": pitch}


def _introspect(where):
    """Il modulo che il bridge usa per leggere il sorgente del motore.

    engine_introspect.py sta nella root di PGE-ui, due livelli sopra questo
    file. Importa solo ast e pathlib: nessun venv richiesto, che e' la ragione
    per cui e' stato estratto da server.py."""
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    try:
        import engine_introspect
    except ImportError as exc:
        raise OracleError(f"{where}: {exc}")
    return engine_introspect


def _bounds_from_ast():
    return _introspect("parameter_bounds(ast)").engine_parameter_bounds(ENGINE.root)


# =============================================================================
# OP — constants
# =============================================================================

@op("constants")
def _op_constants(args):
    """Le costanti del motore che i mirror JS ricopiano per intero.

    Non e' fra le cinque op della issue ma e' la stessa domanda in forma
    degenere: un registro di nomi o un insieme di chiavi non ha argomenti, e
    confrontarlo un elemento alla volta sarebbe solo piu' lento. Ogni voce e'
    letta dal motore, mai scritta qui.
    """
    out = {}

    scm = ENGINE.module("pge.rendering.stream_cache_manager")
    out["fingerprint_ignore_keys"] = sorted(scm.FINGERPRINT_IGNORE_KEYS)
    out["variation_semantics_version"] = scm.VARIATION_SEMANTICS_VERSION

    # Lo stesso numero, ma letto come lo legge il bridge: AST del sorgente,
    # senza importare niente del motore. E' l'unica via per cui quel numero
    # arriva alla UI, quindi e' quella che va confrontata con la costante vera.
    # Prima era trascritto a mano in test-fingerprint-parity.js.
    try:
        out["variation_semantics_version_ast"] = (
            _introspect("constants").engine_semantics_version(ENGINE.root))
    except OracleError as exc:
        out["variation_semantics_version_ast"] = None
        out["variation_semantics_version_ast_error"] = str(exc)

    # Il sample rate di output, importato e letto dall'AST come sopra. E' la
    # costante che restava ricopiata a mano in yaml-bridge.js dopo che la
    # versione di semantica ha smesso di esserlo: `grainDur.min = 1/sr`, e
    # soprattutto `grainUnitFactor` converte `duration_unit: samples` con lo
    # stesso `1/sr` e RISCRIVE i valori nello YAML. La UI ora la legge da
    # /bounds; il letterale resta come fallback statico, e questa op e' cio'
    # che pretende che i due coincidano.
    try:
        const = ENGINE.module("pge.shared.constants")
        out["default_output_sr"] = const.DEFAULT_OUTPUT_SR
    except OracleError as exc:
        out["default_output_sr"] = None
        out["default_output_sr_error"] = str(exc)
    try:
        out["default_output_sr_ast"] = (
            _introspect("constants").engine_output_sr(ENGINE.root))
    except OracleError as exc:
        out["default_output_sr_ast"] = None
        out["default_output_sr_ast_error"] = str(exc)

    # Le interpolazioni che il builder ammette (per l'interp di un BP group,
    # PGE #64): `PGEEnv.INTERP_TYPES` le ricopia per `envShapeError`. Il
    # modulo importa la sola stdlib.
    try:
        eb = ENGINE.module("pge.envelopes.envelope_builder")
        out["envelope_interp_types"] = list(eb.EnvelopeBuilder.VALID_INTERP_TYPES)
    except (OracleError, AttributeError) as exc:
        out["envelope_interp_types"] = None
        out["envelope_interp_types_error"] = str(exc)

    try:
        td = ENGINE.module("pge.envelopes.time_distribution")
        out["time_distribution_names"] = td.TimeDistributionFactory.list_available()
    except OracleError as exc:
        out["time_distribution_names"] = None
        out["time_distribution_error"] = str(exc)

    try:
        gf = ENGINE.module("pge.parameters.gate_factory")
        out["deviation_probability_modes"] = [
            m.value for m in gf.DeviationProbabilityMode]
        out["deviation_probability_field"] = gf.DEVIATION_PROBABILITY_FIELD
    except OracleError as exc:
        out["deviation_probability_modes"] = None
        out["deviation_probability_error"] = str(exc)

    try:
        pd = ENGINE.module("pge.parameters.parameter_definitions")
        out["default_prob"] = pd.DEFAULT_PROB
    except OracleError:
        out["default_prob"] = None

    # Le chiavi che gli spec del motore DICHIARANO dentro deviation_probability,
    # con il loro is_smart. Non coincidono con le PARAM_KEYS della UI — `envelope`
    # e' dichiarata ma inerte (is_smart=False), `pitch` e `pc_rand_envelope` sono
    # costruite a runtime fuori dallo schema — ma sono cio' che permette di
    # verificare la COMPLETEZZA di quelle liste invece del solo contenuto: senza,
    # svuotare PARAM_KEYS lasciava la suite verde.
    try:
        psch = ENGINE.module("pge.parameters.parameter_schema")
        declared = []
        for schema_name, specs in psch.ALL_SCHEMAS.items():
            for sp in specs:
                key = getattr(sp, "deviation_probability_key", None)
                if key:
                    declared.append({"key": key,
                                     "is_smart": bool(sp.is_smart),
                                     "schema": schema_name})
        out["deviation_probability_keys"] = declared
        # Il default di `grain_duration`, in secondi. La UI lo ricopia
        # (`GRAIN_DEFAULT_DURATION_SEC` in envelope-utils.js) per seminare la
        # chiave quando l'utente accende la durata, e lo converte nell'unita' in
        # vigore: e' un valore del motore come i bound, non una scelta
        # dell'editor, quindi va confrontato e non creduto sulla parola.
        out["grain_duration_default"] = next(
            (sp.default for specs in psch.ALL_SCHEMAS.values() for sp in specs
             if getattr(sp, "name", None) == "grain_duration"), None)
    except OracleError as exc:
        out["deviation_probability_keys"] = None
        out["deviation_probability_keys_error"] = str(exc)
        out["grain_duration_default"] = None

    # I nomi validi per --plot-envelopes. Il motore li valida in cli.py contro
    # PLOT_ENVELOPE_KEYS, che e' frozenset(ENVELOPE_COLORS); il bridge li legge
    # dall'AST (engine_introspect.engine_envelope_keys) e li serve su
    # GET /envelope-keys, e con quelli server.py filtra i nomi prima di argv —
    # uno sconosciuto fa uscire il motore con 1, portandosi via l'audio.
    # `envelope_extractor` e' matplotlib-free e importa solo stdlib (e' stato
    # estratto da score_visualizer proprio per questo), quindi qui si puo'
    # importare per davvero: nessuna deroga in stile magnify, nessun venv.
    #
    # L'import nomina un solo modulo, mentre `engine_envelope_keys` prova tre
    # candidati (src/pge/rendering/, il vecchio src/rendering/, e prima ancora
    # score_visualizer). L'asimmetria e' voluta e va nella direzione giusta: il
    # bridge deve funzionare su ogni annata del motore, la parita' deve dire la
    # verita' su QUESTO checkout. Su un motore di layout vecchio il caso cade
    # nominando "il motore dichiara ENVELOPE_COLORS" invece di confrontare due
    # letture di cui una ha ripiegato — che e' il fallimento informativo, non
    # un falso rosso.
    try:
        ee = ENGINE.module("pge.rendering.envelope_extractor")
        out["envelope_colors_keys"] = list(ee.ENVELOPE_COLORS)
        out["plot_envelope_keys"] = sorted(ee.PLOT_ENVELOPE_KEYS)
    except OracleError as exc:
        out["envelope_colors_keys"] = None
        out["plot_envelope_keys"] = None
        out["envelope_keys_error"] = str(exc)
    try:
        out["envelope_colors_keys_ast"] = (
            _introspect("constants").engine_envelope_keys(ENGINE.root))
    except OracleError as exc:
        out["envelope_colors_keys_ast"] = None
        out["envelope_colors_keys_ast_error"] = str(exc)

    # Il vocabolario di `pointer.loop_unit` (PGE #222), letto DUE volte come
    # `RANGE_UNITS` qui sotto: dall'AST del bridge (cio' che la UI riceve) e
    # importato (cio' che il motore usa). L'import e' possibile da PGE #246,
    # che ha spostato la costante in `pge.parameters.loop_unit`, un modulo che
    # non importa niente; prima stava in `pointer_controller`, e la lettura era
    # solo AST. L'ordine conta: la prima grafia e' quella canonica, ed e'
    # quella che il selettore dell'Inspector scrive.
    #
    # Su un motore anteriore il modulo non c'e', e quello e' l'unico caso in
    # cui l'import manca senza che sia un guasto: `loop_units_module_absent`
    # lo dice, e la suite lo tratta come un'annata, non come un'op saltata.
    try:
        out["loop_units_ast"] = _introspect("constants").engine_loop_units(ENGINE.root)
    except OracleError as exc:
        out["loop_units_ast"] = None
        out["loop_units_ast_error"] = str(exc)
    out["loop_units_module_absent"] = not _modulo_nel_checkout(
        "pge.parameters.loop_unit")
    try:
        lu = ENGINE.module("pge.parameters.loop_unit")
        out["loop_units"] = list(lu.LOOP_UNITS)
    except (OracleError, AttributeError, TypeError) as exc:
        out["loop_units"] = None
        out["loop_units_error"] = str(exc)

    # La banda relativa di `grain.duration_range` (PGE #267, PGE-ui #163): il
    # vocabolario di `<param>_range_unit` e il dominio della frazione. Stanno in
    # `parameter_definitions.py`, lo stesso modulo che l'op `parameter_bounds`
    # importa gia' senza numpy, quindi qui si leggono DUE volte: importati (i
    # valori che il motore usa) e dall'AST del bridge (quelli che la UI riceve),
    # perche' la parita' pretenda che coincidano — il motore scrive la tupla del
    # vocabolario per NOME, e una lettura che si fermasse ai letterali sarebbe
    # muta sul checkout vero.
    try:
        pd = ENGINE.module("pge.parameters.parameter_definitions")
        out["range_units"] = list(pd.RANGE_UNITS)
        out["range_unit_default"] = pd.RANGE_UNIT_DEFAULT
        out["range_unit_relative"] = pd.RANGE_UNIT_RELATIVE
        out["relative_range_bounds"] = list(pd.RELATIVE_RANGE_BOUNDS)
    except (OracleError, AttributeError) as exc:
        out["range_units"] = None
        out["relative_range_bounds"] = None
        out["range_units_error"] = str(exc)
    try:
        intro = _introspect("constants")
        out["range_units_ast"] = intro.engine_range_units(ENGINE.root)
        out["relative_range_bounds_ast"] = intro.engine_relative_range_bounds(ENGINE.root)
    except OracleError as exc:
        out["range_units_ast"] = None
        out["relative_range_bounds_ast"] = None
        out["range_units_ast_error"] = str(exc)

    # I backend audio (PGE-ui #150): l'elenco che `pge.api.renderer_types()`
    # restituisce — e' l'API che il motore ha messo li' apposta perche' un
    # selettore lo chieda invece di tenerne una copia — e lo stesso letto come
    # lo legge il bridge, dall'AST di `RendererFactory._VALID_TYPES`, che e'
    # l'unica strada per cui arriva al popover. `pge.api` e `renderer_factory`
    # si importano senza numpy (verificato: nessun import pesante a livello di
    # modulo), quindi niente deroga e niente venv.
    try:
        api = ENGINE.module("pge.api")
        out["renderer_types"] = list(api.renderer_types())
    except OracleError as exc:
        out["renderer_types"] = None
        out["renderer_types_error"] = str(exc)
    try:
        out["renderer_types_ast"] = (
            _introspect("constants").engine_renderer_types(ENGINE.root))
    except OracleError as exc:
        out["renderer_types_ast"] = None
        out["renderer_types_ast_error"] = str(exc)

    try:
        ns = _load_magnify_from_source()
        out["magnify_source"] = ns["_source"]
        out["magnify_keys"] = sorted(ns["MAGNIFY_KEYS"]) if "MAGNIFY_KEYS" in ns else None
        out["magnify_numeric_keys"] = (
            sorted(ns["MAGNIFY_NUMERIC_KEYS"]) if "MAGNIFY_NUMERIC_KEYS" in ns else None)
        out["magnify_str_keys"] = (
            sorted(ns["MAGNIFY_STR_KEYS"]) if "MAGNIFY_STR_KEYS" in ns else None)
    except OracleError as exc:
        out["magnify_source"] = None
        out["magnify_keys"] = None
        out["magnify_error"] = str(exc)

    return out


# =============================================================================
# LOOP
# =============================================================================

def _handle(req: dict) -> dict:
    rid = req.get("id")
    name = req.get("op")
    if name == "ping":
        return {"id": rid, "ok": True, "value": "pong"}
    fn = _OPS.get(name)
    if fn is None:
        return {"id": rid, "ok": False,
                "error": f"OracleError: op sconosciuta {name!r} "
                         f"(disponibili: {', '.join(sorted(_OPS))})"}
    args = _from_wire(req.get("args") or {})
    if not isinstance(args, dict):
        return {"id": rid, "ok": False,
                "error": "OracleError: 'args' deve essere un oggetto"}
    try:
        return {"id": rid, "ok": True, "value": fn(args)}
    except OracleError as exc:
        return {"id": rid, "ok": False, "error": f"OracleError: {exc}"}
    except SystemExit as exc:
        # Non e' un guasto: e' come il motore rifiuta uno SPEC di
        # --magnify-at. Niente traceback, o ogni corpus di parita' seppellirebbe
        # le asserzioni sotto uno stack per ogni caso negativo.
        return {"id": rid, "ok": False, "error": _fmt_exc(exc)}
    except BaseException as exc:
        # Il traceback va su stderr, non nella risposta: al test serve la
        # forma `Classe: messaggio` per confrontarla, a chi debugga serve lo
        # stack, e sono due canali diversi.
        traceback.print_exc(file=sys.stderr)
        return {"id": rid, "ok": False, "error": _fmt_exc(exc)}


def main() -> int:
    global ENGINE

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", required=True,
                    help="checkout di PythonGranularEngine")
    ns = ap.parse_args()

    ENGINE = Engine(Path(ns.root).resolve())

    # Il motore scrive di suo nella cwd (il clip logger crea ./logs/). In una
    # dir temporanea non sporca il repo, e sparisce all'uscita.
    workdir = tempfile.mkdtemp(prefix="pge-parity-")
    atexit.register(shutil.rmtree, workdir, ignore_errors=True)
    os.chdir(workdir)

    unavailable = {}
    for op_name, dotted in _OP_REQUIRES.items():
        if dotted is None:
            continue
        why = ENGINE.probe(dotted)
        if why:
            unavailable[op_name] = why

    _emit({
        "id": 0,
        "ok": True,
        "value": {
            "hello": "pge-parity-oracle",
            "protocol": 1,
            "engine_root": str(ENGINE.root),
            "engine_commit": ENGINE.commit(),
            "python": sys.version.split()[0],
            "ops": sorted(_OPS),
            "unavailable": unavailable,
        },
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"id": None, "ok": False,
                   "error": f"OracleError: richiesta non JSON: {exc}"})
            continue
        _emit(_handle(req))
    return 0


if __name__ == "__main__":
    sys.exit(main())
