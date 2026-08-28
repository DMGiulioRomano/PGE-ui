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

L'unica deroga e' `parse_magnify_spec`, dove `pge.cli` non e' importabile
senza numpy/soundfile/matplotlib: li' l'oracolo estrae dal file `cli.py` i
soli nodi AST della grammatica e li esegue. Sono comunque i byte del motore,
non una parafrasi — vedi `_load_magnify_from_source`.

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
# prima volta che si costruisce un gate con envelope, e `_parse_magnify_spec`
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

    Per SystemExit — cioe' per `_parse_magnify_spec`, che stampa ed esce — il
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
    "parse_magnify_spec": None,   # sorgente, non import (vedi sotto)
    "constants": "pge.rendering.stream_cache_manager",
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
    )
    return {"hex": mgr.compute_fingerprint(stream)}


# =============================================================================
# OP — parse_magnify_spec
# =============================================================================

_MAGNIFY_NAMESPACE = None

# I nomi che la grammatica di `--magnify-at` deve consegnare, qualunque strada
# l'oracolo prenda per procurarseli. UNA lista sola, e questo e' il punto: i
# due rami (import e ast-slice) hanno gia' divergiuto una volta — il ramo
# import popolava il solo `_parse_magnify_spec`, quindi `constants` leggeva
# None per le tre chiavi e la suite falliva con `null` come unico messaggio.
# Chi ha il venv del motore vedeva 8/3, chi non ce l'ha 11/0, sullo stesso
# commit.
_MAGNIFY_NAMES = ("_MAGNIFY_NUMERIC_KEYS", "_MAGNIFY_STR_KEYS", "_MAGNIFY_KEYS",
                  "_parse_magnify_spec")


def _check_magnify_namespace(ns, source, where):
    """Nessun ramo consegna un namespace incompleto in silenzio."""
    missing = [n for n in _MAGNIFY_NAMES if ns.get(n) is None]
    if missing:
        raise OracleError(
            f"parse_magnify_spec: il ramo '{source}' non ha prodotto "
            f"{', '.join(missing)} ({where}). I due rami devono consegnare gli "
            f"stessi nomi: vedi _MAGNIFY_NAMES."
        )
    return ns


def _load_magnify_from_source():
    """La grammatica di `--magnify-at` presa dai byte di `cli.py`.

    `import pge.cli` tira dentro Generator e ScoreVisualizer, cioe' numpy,
    soundfile e matplotlib: in CI il job node ha il checkout del motore e
    nessun venv, quindi quell'import non c'e'. Ma la grammatica sta in tre
    costanti e una funzione che non dipendono da niente di tutto cio'.

    Si estraggono quei nodi dall'AST di cli.py e si esegue il loro codice —
    non una parafrasi, gli stessi byte. Se domani la grammatica cambia, questa
    estrazione la segue senza modifiche; se cambia il NOME dei nodi, l'op
    fallisce dicendo quale manca, che e' il fallimento giusto.

    Entrambi i rami passano da `_check_magnify_namespace`: un nome mancante e'
    un errore parlante su QUALUNQUE interprete, non un `None` che scende fino
    all'assert. Che i due rami diano poi le stesse risposte lo verifica la CI,
    che gira la parita' due volte — job node senza venv (ast-slice) e job
    python col venv del motore (import).
    """
    global _MAGNIFY_NAMESPACE
    if _MAGNIFY_NAMESPACE is not None:
        return _MAGNIFY_NAMESPACE

    # Prima il vero import: quando il venv del motore c'e', la fedelta' e'
    # totale e non c'e' ragione di estrarre niente.
    try:
        cli = ENGINE.module("pge.cli")
        ns = {n: getattr(cli, n, None) for n in _MAGNIFY_NAMES}
        ns["_source"] = "import"
        _MAGNIFY_NAMESPACE = _check_magnify_namespace(ns, "import", "pge.cli")
        return _MAGNIFY_NAMESPACE
    except OracleError as exc:
        # Un namespace incompleto e' un guasto da dichiarare, non una ragione
        # per ripiegare sull'altro ramo e nasconderlo.
        if "il ramo 'import'" in str(exc):
            raise

    import ast

    path = ENGINE.root / "src" / "pge" / "cli.py"
    if not path.exists():
        raise OracleError(f"parse_magnify_spec: {path} non esiste")
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    picked, found = [], set()
    for node in tree.body:
        name = None
        if isinstance(node, ast.FunctionDef):
            name = node.name
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            name = names[0] if names else None
        if name in _MAGNIFY_NAMES:
            picked.append(node)
            found.add(name)

    missing = [w for w in _MAGNIFY_NAMES if w not in found]
    if missing:
        raise OracleError(
            f"parse_magnify_spec: {path.name} non definisce {', '.join(missing)} "
            f"— la grammatica si e' spostata, l'oracolo va aggiornato"
        )

    ns = {"__name__": "pge_cli_magnify_slice"}
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(path), "exec"), ns)
    ns["_source"] = "ast-slice"
    _MAGNIFY_NAMESPACE = _check_magnify_namespace(ns, "ast-slice", str(path))
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
            targets = ns["_parse_magnify_spec"](spec)
    except SystemExit as exc:
        exc.oracle_stdout = buf.getvalue().strip()
        raise
    return {"targets": targets, "source": ns["_source"]}


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
    try:
        out["mode"] = gf.GateFactory._classify_deviation_probability(value).value
    except Exception as exc:
        out["mode_error"] = _fmt_exc(exc)

    param_key = args.get("param_key")
    if param_key is not None:
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


def _bounds_from_ast():
    # engine_introspect.py sta nella root di PGE-ui, due livelli sopra questo
    # file. Importa solo ast e pathlib: nessun venv richiesto, che e' la
    # ragione per cui e' stato estratto da server.py.
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    try:
        import engine_introspect
    except ImportError as exc:
        raise OracleError(f"parameter_bounds(ast): {exc}")
    return engine_introspect.engine_parameter_bounds(ENGINE.root)


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

    try:
        ns = _load_magnify_from_source()
        out["magnify_source"] = ns["_source"]
        out["magnify_keys"] = sorted(ns["_MAGNIFY_KEYS"]) if "_MAGNIFY_KEYS" in ns else None
        out["magnify_numeric_keys"] = (
            sorted(ns["_MAGNIFY_NUMERIC_KEYS"]) if "_MAGNIFY_NUMERIC_KEYS" in ns else None)
        out["magnify_str_keys"] = (
            sorted(ns["_MAGNIFY_STR_KEYS"]) if "_MAGNIFY_STR_KEYS" in ns else None)
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
    args = req.get("args") or {}
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
