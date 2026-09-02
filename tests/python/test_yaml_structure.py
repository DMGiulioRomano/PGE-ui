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

def _reloaded(monkeypatch, **env):
    import importlib
    import engine_corpus as ec
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    return importlib.reload(ec)


def test_status_line_says_error_not_skip_in_ci(monkeypatch, tmp_path):
    ec = _reloaded(monkeypatch,
                   PGE_ENGINE_ROOT=str(tmp_path / "assente"),
                   PGE_REQUIRE_ENGINE_FIXTURES="1")
    try:
        line = ec.status_line()
        assert "None" not in line, line
        assert "skippato" not in line, line
        assert "errore" in line, line
        assert str(tmp_path / "assente") in line, line
        assert ec.corpus_error() is not None      # il gate fa rosso davvero
    finally:
        _reloaded(monkeypatch, PGE_ENGINE_ROOT=None, PGE_REQUIRE_ENGINE_FIXTURES=None)


def test_status_line_still_explains_a_legitimate_skip(monkeypatch, tmp_path):
    ec = _reloaded(monkeypatch,
                   PGE_ENGINE_ROOT=str(tmp_path / "assente"),
                   PGE_REQUIRE_ENGINE_FIXTURES=None)
    try:
        line = ec.status_line()
        assert "skippato" in line and "None" not in line, line
        assert ec.corpus_error() is None           # skip legittimo
        assert ec.skip_reason() is not None
    finally:
        _reloaded(monkeypatch, PGE_ENGINE_ROOT=None)


def test_engine_root_honours_the_env_var(monkeypatch, tmp_path):
    """`make tests-python ROOT=…` passa PGE_ENGINE_ROOT: deve arrivare fin qui."""
    (tmp_path / "configs").mkdir()
    (tmp_path / "configs" / "x.yml").write_text("streams: []\n", encoding="utf-8")
    ec = _reloaded(monkeypatch, PGE_ENGINE_ROOT=str(tmp_path))
    try:
        assert ec.ENGINE_ROOT == str(tmp_path)
        assert ec.ENGINE_PRESENT is True
        assert [os.path.basename(p) for p in ec.CONFIGS] == ["x.yml"]
    finally:
        _reloaded(monkeypatch, PGE_ENGINE_ROOT=None)
