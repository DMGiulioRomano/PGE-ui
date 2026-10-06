"""I caricatori dell'oracolo di parita' sulle due op che avevano la deroga.

`parse_magnify_spec` e `filter_solo_mute` hanno tre annate di motore da cui
procurarsi la risposta (PGE #246): il modulo leggero importato, `pge.cli`
importato coi nomi privati di prima, l'ast-slice di quei nomi. La suite di
parita' le vede solo contro il motore che ha davanti, cioe' una annata alla
volta; qui le si guida tutte, su motori finti, compresi i due modi di sbagliare
che non devono mai ripiegare in silenzio:

- il modulo c'e' e il nome no — `IncompleteNamespace`;
- il modulo c'e' e non si importa — l'errore dell'import, non «la grammatica si
  e' spostata».

Ogni caso gira in un processo suo: l'oracolo mette `src/` del motore in testa
a `sys.path` e i moduli `pge.*` restano in `sys.modules`, quindi due motori
finti nello stesso interprete si risponderebbero a vicenda.
"""
import json
import subprocess
import sys
import textwrap
from pathlib import Path

ORACLE = Path(__file__).resolve().parents[1] / "parity" / "engine_oracle.py"

PROBE = textwrap.dedent("""
    import importlib.util, json, sys
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("engine_oracle", sys.argv[1])
    eo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(eo)
    eo.ENGINE = eo.Engine(Path(sys.argv[2]))
    out = {}
    try:
        ns = eo._load_magnify_from_source()
        out["magnify"] = {"source": ns["_source"],
                          "keys": sorted(ns["MAGNIFY_KEYS"]),
                          "parsed": ns["parse_magnify_spec"]("t=1.5")}
    except eo.OracleError as exc:
        out["magnify"] = {"error": type(exc).__name__, "msg": str(exc)}
    try:
        fn = eo._load_filter_solo_mute()
        kept = fn([{"stream_id": "a"}, {"stream_id": "b", "mute": True}])
        out["solo_mute"] = {"kept": [s["stream_id"] for s in kept]}
    except eo.OracleError as exc:
        out["solo_mute"] = {"error": type(exc).__name__, "msg": str(exc)}
    # Non `print`: l'oracolo, caricato, ridirige `sys.stdout` sul suo canale
    # privato (vedi «STDOUT PRIVATO» la' dentro).
    Path(sys.argv[3]).write_text(json.dumps(out))
""")

MAGNIFY_BODY = """
MAGNIFY_NUMERIC_KEYS = frozenset({'t', 'y'})
MAGNIFY_STR_KEYS = frozenset({'stream'})
MAGNIFY_KEYS = MAGNIFY_NUMERIC_KEYS | MAGNIFY_STR_KEYS


def parse_magnify_spec(spec):
    return [{'t': float(spec.split('=')[1])}]
"""

SOLO_MUTE_BODY = """
def filter_solo_mute(stream_data_list):
    if any('solo' in s for s in stream_data_list):
        return [s for s in stream_data_list if 'solo' in s]
    return [s for s in stream_data_list if 'mute' not in s]
"""

# `cli.py` e `generator.py` come erano prima di PGE #246: nomi privati, e un
# import pesante in testa, che senza venv non si risolve — e' cio' che
# costringeva all'ast-slice.
OLD_CLI = """
import numpy_che_non_esiste

_MAGNIFY_NUMERIC_KEYS = frozenset({'t', 'y'})
_MAGNIFY_STR_KEYS = frozenset({'stream'})
_MAGNIFY_KEYS = _MAGNIFY_NUMERIC_KEYS | _MAGNIFY_STR_KEYS


def _parse_magnify_spec(spec):
    return [{'t': float(spec.split('=')[1])}]
"""

OLD_GENERATOR = """
import numpy_che_non_esiste


class Generator:
    def _filter_solo_mute(self, stream_data_list):
        return [s for s in stream_data_list if 'mute' not in s]
"""


def _engine(root: Path, files: dict) -> Path:
    pge = root / "src" / "pge"
    for sub in ("", "shared", "engine"):
        (pge / sub).mkdir(parents=True, exist_ok=True)
        (pge / sub / "__init__.py").write_text("")
    for rel, body in files.items():
        (pge / rel).write_text(body)
    return root


def _probe(root: Path) -> dict:
    result = root / "probe.json"
    res = subprocess.run(
        [sys.executable, "-I", "-c", PROBE, str(ORACLE), str(root), str(result)],
        capture_output=True, text=True, timeout=60,
    )
    assert res.returncode == 0, res.stderr
    return json.loads(result.read_text())


def test_new_engine_answers_from_the_light_modules(tmp_path):
    out = _probe(_engine(tmp_path, {
        "shared/magnify_spec.py": MAGNIFY_BODY,
        "engine/solo_mute.py": SOLO_MUTE_BODY,
        # Il `cli.py` nuovo legge dal modulo leggero: non ha piu' i nomi privati.
        "cli.py": "from pge.shared.magnify_spec import parse_magnify_spec\n",
    }))
    assert out["magnify"]["source"] == "import"
    assert out["magnify"]["keys"] == ["stream", "t", "y"]
    assert out["magnify"]["parsed"] == [{"t": 1.5}]
    assert out["solo_mute"] == {"kept": ["a"]}


def test_old_engine_falls_back_on_the_ast_slice(tmp_path):
    """Motore anteriore a PGE #246 e nessun venv: i moduli leggeri non ci
    sono, `pge.cli` non si importa, e risponde l'ast-slice coi nomi privati —
    tradotti in quelli pubblici, e con la firma a un argomento."""
    out = _probe(_engine(tmp_path, {
        "cli.py": OLD_CLI,
        "engine/generator.py": OLD_GENERATOR,
    }))
    assert out["magnify"]["source"] == "ast-slice-storico"
    assert out["magnify"]["keys"] == ["stream", "t", "y"]
    assert out["magnify"]["parsed"] == [{"t": 1.5}]
    assert out["solo_mute"] == {"kept": ["a"]}


def test_module_without_the_name_is_declared_not_skipped(tmp_path):
    out = _probe(_engine(tmp_path, {
        "shared/magnify_spec.py": "MAGNIFY_KEYS = frozenset()\n",
        "engine/solo_mute.py": "def altro_nome(x):\n    return x\n",
        "cli.py": OLD_CLI,
        "engine/generator.py": OLD_GENERATOR,
    }))
    # Anche con i rami storici capaci di rispondere: ripiegare nasconderebbe
    # la rinomina dietro un ramo che riesce.
    assert out["magnify"]["error"] == "IncompleteNamespace"
    assert "pge.shared.magnify_spec" in out["magnify"]["msg"]
    assert out["solo_mute"]["error"] == "IncompleteNamespace"
    assert "filter_solo_mute" in out["solo_mute"]["msg"]


def test_module_that_does_not_import_names_the_import_error(tmp_path):
    """Una dipendenza pesante scesa nel modulo leggero — la regressione che
    PGE #246 sorveglia. Il messaggio deve nominare l'import rotto: prima diceva
    «la grammatica si e' spostata», perche' l'errore scendeva fino all'ultimo
    ramo storico, che su un motore nuovo non puo' riuscire."""
    heavy = "import numpy_che_non_esiste\n"
    out = _probe(_engine(tmp_path, {
        "shared/magnify_spec.py": heavy + MAGNIFY_BODY,
        "engine/solo_mute.py": heavy + SOLO_MUTE_BODY,
        "cli.py": "from pge.shared.magnify_spec import parse_magnify_spec\n",
        "engine/generator.py": "from pge.engine.solo_mute import filter_solo_mute\n",
    }))
    for op, mod in (("magnify", "pge.shared.magnify_spec"),
                    ("solo_mute", "pge.engine.solo_mute")):
        msg = out[op]["msg"]
        assert mod in msg and "non si importa" in msg, msg
        assert "numpy_che_non_esiste" in msg, msg
        assert "spostat" not in msg, msg
