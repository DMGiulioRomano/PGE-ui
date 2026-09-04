import os
import pytest
import yaml

from engine_corpus import CONFIGS, CONFIGS_DIR, corpus_error, skip_reason, status_line

VALID_UNITS = {"semitones", "cents", "quarter_tone", "eighth_tone", "edo", "ratio"}


def test_engine_corpus_available():
    """Il corpus non sparisce in silenzio (#132).

    Le due `parametrize` qui sotto girano sui config veri del motore: senza
    quel checkout diventano una lista vuota, cioe' uno skip che non dice
    niente. Questo test rende visibile quale delle tre situazioni e' in
    corso, e fallisce nelle due che non sono legittime.
    """
    err = corpus_error()
    assert err is None, err
    reason = skip_reason()
    if reason is not None:
        pytest.skip(reason)
    assert CONFIGS, status_line()


@pytest.mark.parametrize("path", CONFIGS, ids=lambda p: os.path.basename(p))
def test_no_semitone_range_in_voices(path):
    with open(path) as f:
        data = yaml.safe_load(f)
    for s in data.get("streams") or []:
        vp = (s.get("voices") or {}).get("pitch") or {}
        assert "semitone_range" not in vp, (
            f"voices.pitch contiene ancora semitone_range in {os.path.basename(path)}: {vp}"
        )


@pytest.mark.parametrize("path", CONFIGS, ids=lambda p: os.path.basename(p))
def test_pitch_unit_keys_valid(path):
    with open(path) as f:
        data = yaml.safe_load(f)
    for s in data.get("streams") or []:
        p = s.get("pitch")
        if not p or not isinstance(p, dict):
            continue
        has_unit = any(k in VALID_UNITS for k in p)
        has_edo  = "edo" in p   # EDO blocks: {edo: N, value: X}
        # pitch block with only "range" is valid: bridge defaults unit to semitones
        range_only = set(p.keys()) <= {"range"}
        assert has_unit or has_edo or range_only, (
            f"blocco pitch senza chiave unità valida in {os.path.basename(path)}: {p}"
        )


# ---------------------------------------------------------------------------
# La riga di riepilogo e la root: due nit del giro.
#
# `status_line()` chiamava `skip_reason()`, che torna None quando e' REQUIRE a
# decidere: nell'UNICO momento in cui qualcuno legge quella riga — la CI col
# gate rosso — diceva "skippato (None)", la parola sbagliata e il motivo
# mancante. E `ENGINE_ROOT` ignorava `PGE_ENGINE_ROOT`, cioe' il `ROOT=` che il
# Makefile stesso suggerisce: solo qui, mentre la meta' node e la parita' lo
# onorano.
# ---------------------------------------------------------------------------

# Il modulo tiene i quattro dati in globals calcolate all'import — e deve:
# `CONFIGS` finisce dentro una `parametrize`, cioe' e' letta in raccolta. Chi
# vuole misurarne il comportamento sotto un altro ambiente non ha altra strada
# che `importlib.reload`, e li' sta la trappola: `monkeypatch` disfa
# `os.environ` nel PROPRIO teardown, quindi un `reload` scritto in un `finally`
# dentro il test gira mentre l'ambiente e' ancora falsato e lascia il modulo
# sporco per tutta la sessione. Nessun test se ne accorge — ma
# `pytest_terminal_summary` legge proprio quelle globals, e la riga del corpus
# comincia a mentire: misurato, con `PGE_ENGINE_ROOT` impostata la riga diceva
# «corpus skippato (nessun checkout del motore)» su un run in cui i 32 config
# erano appena girati, e sotto strict diceva «errore».
#
# Il ripristino non passa dall'ambiente: si riprende l'esatto contenuto che il
# modulo aveva all'import, cioe' quello su cui la `parametrize` ha davvero
# girato. Cosi' vale anche se nel frattempo cambia il filesystem, e non dipende
# dall'ordine in cui pytest smonta le fixture.


@pytest.fixture
def reloaded(monkeypatch):
    """`reloaded(**env)` ricarica engine_corpus con quell'ambiente, e lo rimette
    com'era prima di uscire dal test."""
    import importlib
    import engine_corpus as ec

    pristine = dict(ec.__dict__)

    def _load(**env):
        for k, v in env.items():
            if v is None:
                monkeypatch.delenv(k, raising=False)
            else:
                monkeypatch.setenv(k, v)
        return importlib.reload(ec)

    yield _load
    # clear + update e non il solo update: cosi' anche un nome che il reload
    # avesse aggiunto sparisce, e il ripristino resta esatto senza dover
    # elencare le globals una per una (un elenco invecchia).
    ec.__dict__.clear()
    ec.__dict__.update(pristine)


def test_status_line_says_error_not_skip_in_ci(reloaded, tmp_path):
    ec = reloaded(PGE_ENGINE_ROOT=str(tmp_path / "assente"),
                  PGE_REQUIRE_ENGINE_FIXTURES="1")
    line = ec.status_line()
    assert "None" not in line, line
    assert "skippato" not in line, line
    assert "errore" in line, line
    assert str(tmp_path / "assente") in line, line
    assert ec.corpus_error() is not None      # il gate fa rosso davvero


def test_status_line_still_explains_a_legitimate_skip(reloaded, tmp_path):
    ec = reloaded(PGE_ENGINE_ROOT=str(tmp_path / "assente"),
                  PGE_REQUIRE_ENGINE_FIXTURES=None)
    line = ec.status_line()
    assert "skippato" in line and "None" not in line, line
    assert ec.corpus_error() is None           # skip legittimo
    assert ec.skip_reason() is not None


def test_engine_root_honours_the_env_var(reloaded, tmp_path):
    """`make tests-python ROOT=…` passa PGE_ENGINE_ROOT: deve arrivare fin qui."""
    (tmp_path / "configs").mkdir()
    (tmp_path / "configs" / "x.yml").write_text("streams: []\n", encoding="utf-8")
    ec = reloaded(PGE_ENGINE_ROOT=str(tmp_path))
    assert ec.ENGINE_ROOT == str(tmp_path)
    assert ec.ENGINE_PRESENT is True
    assert [os.path.basename(p) for p in ec.CONFIGS] == ["x.yml"]


# Ultimo del file di proposito: e' la sentinella dei tre test qui sopra, e puo'
# vedere solo il residuo di cio' che ha gia' girato.
#
# Il confronto non e' con l'ambiente ma con i nomi importati in cima a QUESTO
# file: sono legati all'import di engine_corpus, cioe' allo stato su cui le due
# `parametrize` hanno girato, e un `reload` non li tocca. Se una fixture futura
# smettesse di ripristinare, qui si vede — invece di vedersi solo nella riga di
# riepilogo, che nessun test legge.
def test_reload_helpers_leave_no_residue():
    import engine_corpus as ec

    assert ec.CONFIGS_DIR == CONFIGS_DIR, (
        f"engine_corpus e' rimasto puntato su {ec.CONFIGS_DIR} invece di {CONFIGS_DIR}: "
        "un reload non ripristinato, e la riga del corpus ora mente"
    )
    assert ec.CONFIGS == CONFIGS
    assert ec.corpus_error() == corpus_error()
    assert ec.skip_reason() == skip_reason()
    assert CONFIGS_DIR in ec.status_line() or ec.ENGINE_ROOT in ec.status_line()
