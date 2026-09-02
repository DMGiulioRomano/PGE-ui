"""Corpus dei config del motore, con le stesse regole della meta' node (#132).

`test_yaml_structure.py` legge i config veri di PythonGranularEngine, cercato
come repository fratello. Senza quel checkout la `parametrize` gira su una
lista vuota: pytest la segna `skipped` e il verde non dice nulla — e' lo skip
silenzioso della #132 nell'altro linguaggio, sullo stesso corpus.

Le tre situazioni sono distinte come in `tests/node/test-yaml-bridge.js`:

* checkout del motore assente        -> skip (sviluppo locale senza repo
                                        fratello, PR da un fork senza secret);
* directory dei config presente ma vuota -> errore: non e' piu' la directory
                                        dei config, il corpus girerebbe a vuoto;
* ``PGE_REQUIRE_ENGINE_FIXTURES=1``  -> errore anche sul checkout assente. La CI
                                        la passa quando lo step di checkout del
                                        motore ha riportato successo.

Qui non c'e' l'equivalente delle fixture nominate del lato node: i test girano
su tutti gli ``*.yml`` che trovano, nessun nome e' atteso, quindi una cancellata
a monte assottiglia il corpus senza far rosso. Il presidio sui nomi sta in
``tests/node/test-yaml-bridge.js`` e guarda la stessa directory: e' li' che una
config rinominata o rimossa si fa sentire, e vale per tutta la suite.
"""

import glob
import os

# `PGE_ENGINE_ROOT` prima del fratello calcolato da `__file__`: e' la stessa
# variabile che il Makefile passa alla meta' node e alla parita', e che il
# README documenta. Solo la meta' python la ignorava, quindi
# `make tests-python ROOT=/path/to/engine` — il ROOT= che il Makefile stesso
# suggerisce — non arrivava fin qui e il corpus spariva in uno skip verde.
ENGINE_ROOT = os.path.abspath(
    os.environ.get("PGE_ENGINE_ROOT")
    or os.path.join(os.path.dirname(__file__), "../../..", "PythonGranularEngine")
)
CONFIGS_DIR = os.path.join(ENGINE_ROOT, "configs")
ENGINE_PRESENT = os.path.isdir(CONFIGS_DIR)

# `== "1"` e non la verita' della stringa: `=0` e `=false` disattivano, come chi
# li scrive si aspetta. La CI passa `1` oppure la stringa vuota.
REQUIRE_ENGINE = os.environ.get("PGE_REQUIRE_ENGINE_FIXTURES") == "1"

CONFIGS = sorted(glob.glob(os.path.join(CONFIGS_DIR, "*.yml")))


def corpus_error():
    """Il motivo per cui il corpus non e' utilizzabile, o None se lo e'.

    Restituisce una stringa quando la situazione deve far fallire i test.
    """
    if ENGINE_PRESENT:
        if not CONFIGS:
            return (
                f"{CONFIGS_DIR} esiste ma non contiene nessun .yml: "
                "non e' piu' la directory dei config del motore"
            )
        return None
    if REQUIRE_ENGINE:
        return (
            f"atteso {CONFIGS_DIR} — il checkout del motore ha riportato "
            "successo ma i config non sono li' "
            "(PGE_REQUIRE_ENGINE_FIXTURES=1)"
        )
    return None


def skip_reason():
    """Perche' il corpus si salta, o None se non si salta."""
    if ENGINE_PRESENT or REQUIRE_ENGINE:
        return None
    return f"nessun checkout del motore in {ENGINE_ROOT}"


def status_line():
    """Riga di riepilogo: quanto verificheranno davvero i test sul corpus."""
    if ENGINE_PRESENT:
        return f"engine fixtures: corpus {len(CONFIGS)} config (motore in {ENGINE_ROOT})"
    if REQUIRE_ENGINE:
        # Proprio la configurazione della CI, ed e' l'unico momento in cui
        # qualcuno legge questa riga: prima diceva "skippato (None)" — la
        # parola sbagliata (il gate ha fatto rosso, non si e' saltato niente) e
        # `None` dove va il motivo, perche' `skip_reason()` torna None quando
        # e' REQUIRE_ENGINE a decidere.
        return (
            f"engine fixtures: nessun motore in {ENGINE_ROOT} — errore, non "
            "skip (PGE_REQUIRE_ENGINE_FIXTURES=1)"
        )
    return (
        f"engine fixtures: corpus skippato ({skip_reason()}); "
        "PGE_REQUIRE_ENGINE_FIXTURES=1 lo rende un errore"
    )
