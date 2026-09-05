"""Tests for render_pipeline.py — the stdout→NDJSON parser, command builder,
and process watchdog extracted from server.py (#43), plus a Flask smoke test
that the split didn't break route registration (#46).

These don't need the engine repo (no main.py is spawned). The kill/watchdog
tests spawn a short-lived python sleeper. Run: pytest tests/python/ -v
"""

import glob
import json
import os
import signal
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

import engine_corpus
import render_pipeline as rp


# ---------------------------------------------------------------------------
# parse_render_line — the NDJSON event sequencing the UI depends on
# ---------------------------------------------------------------------------

def _types(events):
    return [e["type"] for e in events]


def test_parse_render_line_always_logs():
    state = {"streamId": None, "total": 0, "index": 0}
    evs = rp.parse_render_line("hello world", state)
    assert evs == [{"type": "log", "line": "hello world"}]


def test_parse_render_line_dirty_emits_start_only():
    state = {"streamId": None, "total": 3, "index": 0}
    evs = rp.parse_render_line("[CACHE] stream1: DIRTY", state)
    assert _types(evs) == ["log", "stream-start"]
    start = evs[1]
    assert start == {"type": "stream-start", "streamId": "stream1", "index": 0, "total": 3}
    # DIRTY stream is now tracked as "in progress"
    assert state["streamId"] == "stream1"
    assert state["index"] == 1


def test_parse_render_line_clean_emits_start_and_done():
    state = {"streamId": None, "total": 3, "index": 0}
    evs = rp.parse_render_line("[CACHE] stream1: clean", state)
    assert _types(evs) == ["log", "stream-start", "stream-done"]
    assert evs[2] == {"type": "stream-done", "streamId": "stream1", "cached": True}
    assert state["streamId"] is None        # clean stream isn't left pending
    assert state["index"] == 1


def test_parse_render_line_next_cache_closes_previous_dirty():
    state = {"streamId": None, "total": 2, "index": 0}
    rp.parse_render_line("[CACHE] stream1: DIRTY", state)   # s1 pending
    evs = rp.parse_render_line("[CACHE] stream2: clean", state)
    # prev dirty s1 done, then s2 start + done (cached)
    assert _types(evs) == ["log", "stream-done", "stream-start", "stream-done"]
    assert evs[1] == {"type": "stream-done", "streamId": "stream1", "cached": False}
    assert evs[2]["streamId"] == "stream2"
    assert evs[3] == {"type": "stream-done", "streamId": "stream2", "cached": True}


def test_parse_render_line_stem_path_closes_dangling_dirty():
    state = {"streamId": None, "total": 1, "index": 0}
    rp.parse_render_line("[CACHE] stream1: DIRTY", state)   # s1 pending
    evs = rp.parse_render_line("    /abs/path/output/PGE_test__stream1.aif", state)
    assert _types(evs) == ["log", "stream-done"]
    assert evs[1] == {"type": "stream-done", "streamId": "stream1", "cached": False}
    assert state["streamId"] is None


def test_parse_render_line_stem_path_other_stream_no_done():
    state = {"streamId": "stream1", "total": 1, "index": 1}
    evs = rp.parse_render_line("    /abs/output/PGE_test__streamX.aif", state)
    assert _types(evs) == ["log"]            # path is for a different stream
    assert state["streamId"] == "stream1"


# ---------------------------------------------------------------------------
# Il corpus non e' piu' trascritto da un docstring: le righe le stampa il
# motore, e l'insieme degli id lo dichiara la richiesta.
#
# `[CACHE] Manifest: <path>` esce a OGNI render con --cache (pge/cli.py), e
# `[CACHE] GC: rimossi N stream orfani` quando la GC rimuove qualcosa: due
# righe che non sono stream e che `_RE_CACHE_LINE` leggeva come tali,
# inventando stream `Manifest` e `GC` in ogni giro.
# ---------------------------------------------------------------------------

def _ids_state(ids, total=None, **over):
    """Lo `state` che costruisce /render: gli id dichiarati dalla richiesta."""
    st = {"streamId": None, "index": 0,
          "total": len(ids) if total is None else total,
          "ids": set(ids)}
    st.update(over)
    return st


def test_parse_render_line_ignores_manifest_line():
    state = _ids_state({"stream1"})
    evs = rp.parse_render_line("[CACHE] Manifest: /engine/cache/proj.json", state)
    assert _types(evs) == ["log"]
    assert state["index"] == 0            # non consuma un posto nella barra
    assert state["streamId"] is None


def test_parse_render_line_ignores_gc_line():
    state = _ids_state({"stream1"})
    evs = rp.parse_render_line(
        "[CACHE] GC: rimossi 2 stream orfani: ['proj__old1', 'proj__old2']", state)
    assert _types(evs) == ["log"]
    assert state["index"] == 0


def test_parse_render_line_ghost_does_not_close_pending_dirty():
    """Un fantasma non deve nemmeno chiudere lo stream in corso."""
    state = _ids_state({"stream1"})
    rp.parse_render_line("[CACHE] stream1: DIRTY", state)
    evs = rp.parse_render_line("[CACHE] Manifest: /engine/cache/proj.json", state)
    assert _types(evs) == ["log"]
    assert state["streamId"] == "stream1"   # ancora in corso


def test_parse_render_line_without_ids_keeps_legacy_behaviour():
    """Richiesta che non dichiara gli stream: nessun insieme, nessun filtro."""
    state = {"streamId": None, "total": 0, "index": 0}
    evs = rp.parse_render_line("[CACHE] stream1: clean", state)
    assert _types(evs) == ["log", "stream-start", "stream-done"]


@pytest.mark.parametrize("sid", ["bass-1", "voce.2", "a_b", "S1", "x.y-z_1"])
def test_parse_render_line_stem_path_closes_ids_outside_word_charset(sid):
    r"""Il charset degli id e' quello di `renameStream` (app.jsx: lettere,
    cifre, `.`, `_`, `-`), non `\w`: con `-` o `.` l'ultimo stream DIRTY del
    giro non riceveva mai il suo `stream-done`."""
    state = _ids_state({sid})
    rp.parse_render_line(f"[CACHE] {sid}: DIRTY", state)
    evs = rp.parse_render_line(f"    /abs/output/PGE_test__{sid}.wav", state)
    assert _types(evs) == ["log", "stream-done"]
    assert evs[1] == {"type": "stream-done", "streamId": sid, "cached": False}
    assert state["streamId"] is None


def test_parse_render_line_stem_path_still_discriminates():
    """Allargare la regex non deve chiudere lo stream sbagliato."""
    state = _ids_state({"bass-1", "voce.2"})
    rp.parse_render_line("[CACHE] bass-1: DIRTY", state)
    evs = rp.parse_render_line("    /abs/output/PGE_test__voce.2.wav", state)
    assert _types(evs) == ["log"]
    assert state["streamId"] == "bass-1"


# --- la sonda: le righe [CACHE] chieste al motore, non trascritte -----------

_RE_CACHE_LITERAL = re.compile(r"""(?P<q>["'])\[CACHE\](?P<body>.*?)(?P=q)""")
_RE_INTERP = re.compile(r"\{[^{}]*\}")


def _engine_cache_literals():
    """Ogni literal `[CACHE] …` nei sorgenti del motore, con il suo file."""
    src = os.path.join(engine_corpus.ENGINE_ROOT, "src")
    out = []
    for path in sorted(glob.glob(os.path.join(src, "**", "*.py"), recursive=True)):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for m in _RE_CACHE_LITERAL.finditer(text):
            out.append((os.path.relpath(path, engine_corpus.ENGINE_ROOT),
                        m.group("body")))
    return out


def test_no_engine_cache_line_invents_a_stream():
    """Nessuna riga `[CACHE]` del motore deve produrre uno stream che la
    richiesta non ha dichiarato.

    Il corpus lo sceglie il motore: le sei asserzioni sopra girano su righe
    scritte a mano (la trascrizione del docstring di questo modulo), ed e'
    esattamente per questo che `Manifest` e `GC` ci passavano in mezzo. Qui le
    righe si leggono dai sorgenti del motore e ogni interpolazione diventa un
    nome che la richiesta non conosce: se il parser ne ricava uno stream, la
    riga sta inventando.
    """
    err = engine_corpus.corpus_error()
    assert err is None, err
    reason = engine_corpus.skip_reason()
    if reason is not None:
        pytest.skip(reason)

    lines = _engine_cache_literals()
    assert lines, (
        "nessun literal [CACHE] nei sorgenti del motore: la sonda gira a vuoto "
        f"(cercato in {engine_corpus.ENGINE_ROOT}/src)"
    )
    literal_prefixed = [b for _, b in lines if not b.lstrip().startswith("{")]
    assert literal_prefixed, (
        "nessuna riga [CACHE] con prefisso letterale nel corpus: il caso "
        "interessante (Manifest:, GC:) non c'e', la sonda non discrimina"
    )

    for path, body in lines:
        rendered = "[CACHE]" + _RE_INTERP.sub("zzGHOSTzz", body)
        state = _ids_state({"stream1", "bass-1"})
        evs = rp.parse_render_line(rendered, state)
        assert _types(evs) == ["log"], (
            f"{path} stampa {rendered!r}, che il parser legge come uno stream: "
            f"{evs[1:]}"
        )


# ---------------------------------------------------------------------------
# build_render_command — flag construction (incl. the --show-static fix)
# ---------------------------------------------------------------------------

def _cmd(**over):
    root = Path("/engine")
    opts = dict(
        renderer="numpy", use_cache=False, cache=root / "cache",
        visualize=False, page_duration=None, reaper=False, basename="proj",
        refs=root / "refs", output=root / "output", fmt="aiff",
    )
    opts.update(over)
    return rp.build_render_command(Path("/venv/python"), root, root / "configs/proj.yml",
                                   root / "output/proj.aif", **opts)


def test_build_cmd_base_shape():
    cmd = _cmd()
    assert cmd[:2] == ["/venv/python", str(Path("/engine/src/main.py"))]
    assert "--per-stream" in cmd
    assert "--grain-json" in cmd          # grain JSON sidecar (merged from main)
    assert cmd[cmd.index("--renderer") + 1] == "numpy"
    assert cmd[cmd.index("--format") + 1] == "aiff"


def test_build_cmd_grain_json_default_on_and_toggleable():
    # default ON preserves the historical always-on behavior (issue #68 / #13)
    assert "--grain-json" in _cmd()
    assert "--grain-json" in _cmd(grain_json=True)
    # can now be disabled to skip the heavy per-stream sidecar
    assert "--grain-json" not in _cmd(grain_json=False)


def test_build_cmd_show_static_only_with_visualize():
    assert "--show-static" not in _cmd(visualize=False)
    vis = _cmd(visualize=True)
    assert "--visualize" in vis and "--show-static" in vis


def test_build_cmd_page_duration_omitted_at_default():
    assert "--page-duration" not in _cmd(visualize=True, page_duration=15.0)
    cmd = _cmd(visualize=True, page_duration=20.0)
    assert cmd[cmd.index("--page-duration") + 1] == "20.0"
    # page-duration has no effect without visualize → not emitted
    assert "--page-duration" not in _cmd(visualize=False, page_duration=20.0)


def test_build_cmd_cache_flags_gated():
    assert "--cache" not in _cmd(use_cache=False)
    cmd = _cmd(use_cache=True)
    assert "--cache" in cmd
    assert cmd[cmd.index("--cache-dir") + 1] == str(Path("/engine/cache"))


def test_build_cmd_csound_extra_args():
    assert "--orc-path" not in _cmd(renderer="numpy")
    cmd = _cmd(renderer="csound")
    for flag in ("--orc-path", "--incdir", "--ssdir", "--sfdir", "--log-dir"):
        assert flag in cmd


@pytest.mark.parametrize("renderer", ["numpy", "csound"])
def test_build_cmd_samples_dir_for_both_renderers(renderer):
    """`--samples-dir` esce per entrambi i renderer (PGE-ui #148).

    Era il ramo csound l'unico a ricevere path del motore (`--ssdir`), e da
    quello si poteva credere che il caso csound fosse coperto: non lo era. La
    durata del sample la risolve il Generator prima che esista un renderer, e
    quel passo leggeva `./refs/` relativo al cwd — cioe' a tenere in piedi i
    render era `cwd=root`, non questa lista."""
    cmd = _cmd(renderer=renderer, refs=Path("/altrove/refs"))
    assert "--samples-dir" in cmd
    assert cmd[cmd.index("--samples-dir") + 1] == str(Path("/altrove/refs"))


def test_build_cmd_csound_keeps_ssdir_beside_samples_dir():
    """Il ramo csound tiene il suo `--ssdir` accanto a `--samples-dir`.

    Sul motore di oggi i due dicono la stessa cosa (SSDIR ricade su
    samples_dir), ma su un motore senza `--samples-dir` `--ssdir` e' l'unica
    meta' che atterra: toglierlo trasformerebbe una ridondanza in una
    regressione."""
    cmd = _cmd(renderer="csound", refs=Path("/altrove/refs"))
    assert cmd[cmd.index("--ssdir") + 1] == str(Path("/altrove/refs"))
    assert cmd[cmd.index("--samples-dir") + 1] == str(Path("/altrove/refs"))


def test_build_cmd_reaper():
    assert "--reaper" not in _cmd(reaper=False)
    cmd = _cmd(reaper=True)
    assert "--reaper" in cmd
    assert cmd[cmd.index("--reaper-path") + 1].endswith("proj.rpp")


def test_build_cmd_plot_envelopes_only_with_visualize():
    # gated on --visualize: names without visualize emit nothing (issue #31)
    assert "--plot-envelopes" not in _cmd(visualize=False, plot_envelopes=["pitch"])
    # empty / None means "all envelopes" → flag omitted
    assert "--plot-envelopes" not in _cmd(visualize=True, plot_envelopes=None)
    assert "--plot-envelopes" not in _cmd(visualize=True, plot_envelopes=[])
    cmd = _cmd(visualize=True, plot_envelopes=["pitch", "density"])
    assert cmd[cmd.index("--plot-envelopes") + 1] == "pitch,density"


def test_build_cmd_plot_envelopes_strips_blanks():
    cmd = _cmd(visualize=True, plot_envelopes=[" pitch ", "", "  ", "pan"])
    assert cmd[cmd.index("--plot-envelopes") + 1] == "pitch,pan"


def test_build_cmd_show_voice_offsets_only_with_visualize():
    # per-voice offset curves in the PDF score (PGE #90 / PGE-ui #55): gated
    # on --visualize like --show-static, default off
    assert "--show-voice-offsets" not in _cmd()
    assert "--show-voice-offsets" not in _cmd(visualize=True)
    assert "--show-voice-offsets" not in _cmd(visualize=False,
                                              show_voice_offsets=True)
    cmd = _cmd(visualize=True, show_voice_offsets=True)
    assert "--visualize" in cmd and "--show-voice-offsets" in cmd


# --- lente della partitura (PGE #214 / issue #120) -------------------------

def test_build_cmd_magnify_only_with_visualize():
    """Lente automatica: default off, e senza --visualize non ha effetto —
    stessa regola di --show-static e --show-voice-offsets."""
    assert "--magnify" not in _cmd()
    assert "--magnify" not in _cmd(visualize=True)
    assert "--magnify" not in _cmd(visualize=False, magnify=True)
    cmd = _cmd(visualize=True, magnify=True)
    assert "--visualize" in cmd and "--magnify" in cmd


def test_build_cmd_magnify_at_spec_forwarded_verbatim():
    """Lo SPEC dei target espliciti passa così com'è (lo riparsa il motore),
    a meno degli spazi ai bordi. Vuoto/None = nessun target → flag omesso, che
    è la ragione per cui il motore non vede mai `--magnify-at ""` (che
    rifiuterebbe con exit 1)."""
    assert "--magnify-at" not in _cmd(visualize=True, magnify_at=None)
    assert "--magnify-at" not in _cmd(visualize=True, magnify_at="")
    assert "--magnify-at" not in _cmd(visualize=True, magnify_at="   ")
    assert "--magnify-at" not in _cmd(visualize=False, magnify_at="t=14")
    cmd = _cmd(visualize=True, magnify_at="  t=14,zoom=10  ")
    assert cmd[cmd.index("--magnify-at") + 1] == "t=14,zoom=10"


def test_build_cmd_magnify_at_is_a_single_argv_token():
    """Niente shell di mezzo: ';' e ',' restano dentro un token solo, quindi
    più target arrivano interi al motore."""
    cmd = _cmd(visualize=True, magnify_at="t=4;t=12,zoom=6")
    assert cmd[cmd.index("--magnify-at") + 1] == "t=4;t=12,zoom=6"


def test_build_cmd_magnify_modes_combine():
    """Automatica ed esplicite non si escludono: il motore le somma (la prima
    è la lente sul cluster più denso, le altre i punti chiesti)."""
    cmd = _cmd(visualize=True, magnify=True, magnify_at="t=14")
    assert "--magnify" in cmd and "--magnify-at" in cmd
    # solo target espliciti, senza lente automatica
    only_at = _cmd(visualize=True, magnify_at="t=14")
    assert "--magnify" not in only_at and "--magnify-at" in only_at


# ---------------------------------------------------------------------------
# kill_process / watchdog
# ---------------------------------------------------------------------------

def _sleeper(seconds=30):
    return subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({seconds})"])


def test_kill_process_terminates():
    proc = _sleeper()
    assert proc.poll() is None
    rp.kill_process(proc, grace=3.0)
    assert proc.poll() is not None           # dead


def _sigterm_ignorer(seconds=30):
    """Un processo che IGNORA SIGTERM: e' l'unico che distingue `terminate()`
    dall'escalation a SIGKILL. Tutti i test qui sopra usano un processo che
    muore al primo terminate, quindi togliendo l'escalation la suite restava
    verde — mentre nel bridge vivo un main.py bloccato in una syscall terrebbe
    un thread del worker (workers=1, threads=4) fino alla fine dei tempi."""
    proc = subprocess.Popen([sys.executable, "-c",
        "import signal, sys, time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        f"time.sleep({seconds})\n"], stdout=subprocess.PIPE, text=True)
    # Si aspetta che l'handler sia INSTALLATO: un terminate() spedito nella
    # finestra di avvio dell'interprete lo ucciderebbe davvero, e il test
    # misurerebbe l'escalation che non e' avvenuta.
    assert proc.stdout.readline().strip() == "ready"
    return proc


def test_kill_process_escalates_to_sigkill():
    proc = _sigterm_ignorer()
    t0 = time.monotonic()
    rp.kill_process(proc, grace=1.0)
    # `kill_process` spedisce SIGKILL e torna: la raccolta del figlio la fa
    # chi chiama (il ciclo di /render fa `proc.wait()`), quindi qui si attende
    # come farebbe lui. Il segnale e' gia' partito — se non fosse partito,
    # questa `wait` scadrebbe.
    proc.wait(timeout=5)
    assert proc.returncode == -signal.SIGKILL, proc.returncode
    # La grazia si aspetta davvero, non si salta: e' l'uscita pulita a essere
    # preferita quando il processo la concede.
    assert 1.0 <= time.monotonic() - t0 < 6.0


def test_watchdog_escalates_too():
    """Il watchdog passa la stessa `grace` a kill_process: un main.py che
    ignora SIGTERM non deve poter tenere il thread oltre il tetto."""
    proc = _sigterm_ignorer()
    rp.start_watchdog(proc, timeout=0.3, grace=1.0)
    proc.wait(timeout=15)
    assert proc.returncode == -signal.SIGKILL, proc.returncode


def test_kill_process_safe_on_dead():
    proc = _sleeper(0)
    proc.wait()
    rp.kill_process(proc, grace=1.0)         # must not raise
    rp.kill_process(None, grace=1.0)         # None is fine too


def test_watchdog_kills_stuck_process():
    proc = _sleeper(30)
    t0 = time.monotonic()
    wd = rp.start_watchdog(proc, timeout=0.5, grace=2.0)
    assert wd is not None
    proc.wait(timeout=10)                     # watchdog should free it
    assert proc.poll() is not None
    assert time.monotonic() - t0 < 8.0
    wd.cancel()


def test_watchdog_disabled_when_timeout_zero():
    proc = _sleeper(0)
    assert rp.start_watchdog(proc, timeout=0) is None
    proc.wait()


# ---------------------------------------------------------------------------
# RenderState
# ---------------------------------------------------------------------------

def test_render_state_lifecycle():
    st = rp.RenderState()
    assert st.proc is None and not st.is_cancelled()
    proc = st.start([sys.executable, "-c", "pass"], Path("."))
    assert st.proc is proc
    proc.wait()
    st.clear()
    assert st.proc is None


def test_render_state_cancel_sets_flag():
    st = rp.RenderState()
    st.start([sys.executable, "-c", "import time; time.sleep(30)"], Path("."))
    st.cancel()
    assert st.is_cancelled()
    st.proc.wait(timeout=5)
    st.clear()


# ---------------------------------------------------------------------------
# Flask smoke test — the split didn't break route registration (#46)
# ---------------------------------------------------------------------------

def test_make_app_smoke(tmp_path):
    import server                              # imported here so the pure tests
                                               # above don't require flask
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()

    app = server.make_app(tmp_path, render_timeout=600.0)
    client = app.test_client()

    assert client.get("/health").status_code == 200
    assert client.get("/health").get_json()["ok"] is True
    assert client.get("/config").status_code == 200
    assert client.get("/projects").get_json()["files"] == []
    assert client.get("/media").get_json()["files"] == []
    # bad kind / traversal rejected
    assert client.get("/file?kind=bogus&name=x").status_code == 400
    assert client.get("/file?kind=projects&name=../escape").status_code == 404
    assert client.get("/stems/proj").get_json()["stems"] == []
    # no score_visualizer in this stub root → envelope filter unavailable
    assert client.get("/envelope-keys").get_json() == {"ok": True, "keys": []}


# ---------------------------------------------------------------------------
# Score-envelope filter source — engine_envelope_keys + /envelope-keys (#31)
# ---------------------------------------------------------------------------

def _stub_score_visualizer(root):
    """Write a minimal score_visualizer.py so engine_envelope_keys has an
    ENVELOPE_COLORS literal to AST-parse (no matplotlib import needed)."""
    sv = root / "src" / "rendering"
    sv.mkdir(parents=True)
    (sv / "score_visualizer.py").write_text(
        "import matplotlib.pyplot as plt  # never imported by the parser\n"
        "ENVELOPE_COLORS = {\n"
        "    'volume': '#e41a1c',\n"
        "    'pan': '#4daf4a',\n"
        "    'pitch': '#984ea3',\n"
        "}\n"
        "PLOT_ENVELOPE_KEYS = frozenset(ENVELOPE_COLORS)\n",
        encoding="utf-8",
    )


def _stub_envelope_extractor_pge(root, keys=("volume", "pan", "pitch",
                                             "voice_pitch_offset")):
    """Write a minimal envelope_extractor.py in the current engine layout
    (src/pge/rendering/, post PGE #150+#162) with the ENVELOPE_COLORS literal.
    In this layout score_visualizer.py only re-imports the dict, so the parser
    must find it here."""
    d = root / "src" / "pge" / "rendering"
    d.mkdir(parents=True, exist_ok=True)
    body = "".join(f"    '{k}': '#000000',\n" for k in keys)
    (d / "envelope_extractor.py").write_text(
        "import numpy as np  # never imported by the parser\n"
        "ENVELOPE_COLORS = {\n" + body + "}\n"
        "PLOT_ENVELOPE_KEYS = frozenset(ENVELOPE_COLORS)\n",
        encoding="utf-8",
    )


def test_engine_envelope_keys_parses_source_in_order(tmp_path):
    import server
    _stub_score_visualizer(tmp_path)
    assert server.engine_envelope_keys(tmp_path) == ["volume", "pan", "pitch"]


def test_engine_envelope_keys_annotated(tmp_path):
    """`ENVELOPE_COLORS: Dict[str, str] = {...}` e' un AnnAssign, non un Assign.
    Il motore ANNOTA gia' due costanti di modulo (GRANULAR_PARAMETERS,
    PITCH_UNIT_PRESETS): una terza annotazione a monte non e' un'ipotesi di
    stile, e qui costerebbe il filtro degli envelope name."""
    import server
    d = tmp_path / "src" / "pge" / "rendering"
    d.mkdir(parents=True, exist_ok=True)
    (d / "envelope_extractor.py").write_text(
        "from typing import Dict\n"
        "ENVELOPE_COLORS: Dict[str, str] = {\n"
        "    'volume': '#000000',\n"
        "    'pan': '#111111',\n"
        "}\n",
        encoding="utf-8",
    )
    assert server.engine_envelope_keys(tmp_path) == ["volume", "pan"]


def test_engine_envelope_keys_pge_layout(tmp_path):
    # current engine layout (PGE #162): the literal lives in
    # src/pge/rendering/envelope_extractor.py (issue #109)
    import server
    _stub_envelope_extractor_pge(tmp_path)
    assert server.engine_envelope_keys(tmp_path) == [
        "volume", "pan", "pitch", "voice_pitch_offset"]


def test_engine_envelope_keys_prefers_current_layout(tmp_path):
    # both layouts present (e.g. stale build dirs): the current one wins
    import server
    _stub_score_visualizer(tmp_path)
    _stub_envelope_extractor_pge(tmp_path, keys=("density",))
    assert server.engine_envelope_keys(tmp_path) == ["density"]


def test_engine_envelope_keys_missing_returns_empty(tmp_path):
    import server
    assert server.engine_envelope_keys(tmp_path / "nope") == []


def test_envelope_keys_endpoint(tmp_path):
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    _stub_score_visualizer(tmp_path)

    app = server.make_app(tmp_path, render_timeout=600.0)
    client = app.test_client()
    body = client.get("/envelope-keys").get_json()
    assert body["ok"] is True
    assert body["keys"] == ["volume", "pan", "pitch"]


# ---------------------------------------------------------------------------
# Dynamic parameter bounds — engine_parameter_bounds + /bounds (PGE-ui)
# ---------------------------------------------------------------------------

def _stub_parameter_files(root):
    """Write minimal parameter_definitions.py + pitch_unit.py so
    engine_parameter_bounds has the GRANULAR_PARAMETERS dict + the pitch
    classes/presets to AST-parse. The `import` lines would explode if the
    parser ever executed the module instead of parsing it (mirrors the
    score_visualizer stub trick)."""
    p = root / "src" / "parameters"
    p.mkdir(parents=True, exist_ok=True)
    (p / "parameter_definitions.py").write_text(
        "import definitely_not_a_real_module_zzz  # never imported by the parser\n"
        "from dataclasses import dataclass\n"
        "\n"
        "@dataclass(frozen=True)\n"
        "class ParameterBounds:\n"
        "    min_val: float\n"
        "    max_val: float | None\n"
        "    min_range: float = 0.0\n"
        "    max_range: float = 0.0\n"
        "    default_jitter: float = 0.0\n"
        "    variation_mode: str = 'additive'\n"
        "\n"
        "GRANULAR_PARAMETERS: dict = {\n"
        "    'density': ParameterBounds(min_val=0.01, max_val=4000.0),\n"
        "    'grain_duration': ParameterBounds(min_val=0.001, max_val=10.0,\n"
        "        min_range=0.0, max_range=1.0, default_jitter=0.01,\n"
        "        variation_mode='additive'),\n"
        "    'pointer_speed_ratio': ParameterBounds(min_val=-100.0, max_val=100.0),\n"
        "    'loop_dur': ParameterBounds(min_val=0.005, max_val=None),\n"
        "    'volume': ParameterBounds(min_val=-120.0, max_val=12.0,\n"
        "        min_range=0.0, max_range=24.0, default_jitter=3),\n"
        "    'reverse': ParameterBounds(min_val=0, max_val=1, min_range=0,\n"
        "        max_range=1, variation_mode='invert'),\n"
        "}\n",
        encoding="utf-8",
    )
    (p / "pitch_unit.py").write_text(
        "import definitely_not_a_real_module_zzz  # never imported by the parser\n"
        "\n"
        "class EdoUnit:\n"
        "    def value_bounds(self):\n"
        "        bound = 3.0 * self.divisions\n"
        "        return ParameterBounds(min_val=-bound, max_val=bound,\n"
        "            min_range=0.0, max_range=bound, variation_mode='quantized')\n"
        "\n"
        "class RatioUnit:\n"
        "    def value_bounds(self):\n"
        "        return ParameterBounds(min_val=0.001, max_val=8.0,\n"
        "            min_range=0.0, max_range=2.0, default_jitter=0.005)\n"
        "\n"
        "PITCH_UNIT_PRESETS: dict = {\n"
        "    'semitones':    lambda: EdoUnit(12, name='semitones', symbol='st'),\n"
        "    'cents':        lambda: EdoUnit(1200, name='cents', symbol='c'),\n"
        "    'quarter_tone': lambda: EdoUnit(24, name='quarter_tone', symbol='qt'),\n"
        "    'eighth_tone':  lambda: EdoUnit(48, name='eighth_tone', symbol='et'),\n"
        "    'ratio':        lambda: RatioUnit(),\n"
        "}\n",
        encoding="utf-8",
    )


def test_engine_parameter_bounds_pge_layout(tmp_path):
    # current engine layout (PGE #162): parameters live under
    # src/pge/parameters/ (issue #109). Reuse the legacy stub then relocate it.
    import server
    _stub_parameter_files(tmp_path)
    legacy = tmp_path / "src" / "parameters"
    new = tmp_path / "src" / "pge" / "parameters"
    new.parent.mkdir(parents=True, exist_ok=True)
    legacy.rename(new)
    params = server.engine_parameter_bounds(tmp_path)["params"]
    assert params["density"]["max_val"] == 4000.0
    pitch = server.engine_parameter_bounds(tmp_path)["pitch"]
    assert pitch["semitones"] == {"min": -36.0, "max": 36.0, "rangeMax": 36.0}


def test_engine_parameter_bounds_parses_registry(tmp_path):
    import server
    _stub_parameter_files(tmp_path)
    params = server.engine_parameter_bounds(tmp_path)["params"]
    # full record with dataclass defaults applied for unspecified fields
    assert params["density"] == {
        "min_val": 0.01, "max_val": 4000.0, "min_range": 0.0,
        "max_range": 0.0, "default_jitter": 0.0, "variation_mode": "additive",
    }
    assert params["grain_duration"]["max_range"] == 1.0
    assert params["grain_duration"]["default_jitter"] == 0.01
    # negative literal (ast UnaryOp) survives
    assert params["pointer_speed_ratio"]["min_val"] == -100.0
    # max_val=None stays None (loop bound is sample-driven, dynamic)
    assert params["loop_dur"]["max_val"] is None
    assert params["volume"]["max_range"] == 24.0
    assert params["reverse"]["variation_mode"] == "invert"


def test_engine_parameter_bounds_pitch(tmp_path):
    import server
    _stub_parameter_files(tmp_path)
    pitch = server.engine_parameter_bounds(tmp_path)["pitch"]
    assert pitch["edoFactor"] == 3.0
    assert pitch["semitones"] == {"min": -36.0, "max": 36.0, "rangeMax": 36.0}
    assert pitch["cents"] == {"min": -3600.0, "max": 3600.0, "rangeMax": 3600.0}
    assert pitch["quarter_tone"] == {"min": -72.0, "max": 72.0, "rangeMax": 72.0}
    assert pitch["eighth_tone"] == {"min": -144.0, "max": 144.0, "rangeMax": 144.0}
    assert pitch["ratio"] == {"min": 0.001, "max": 8.0, "rangeMax": 2.0}


def test_engine_parameter_bounds_missing_returns_empty(tmp_path):
    import server
    assert server.engine_parameter_bounds(tmp_path / "nope") == {}


def test_engine_parameter_bounds_pitch_unknown_says_so(tmp_path):
    """Una lettura fallita non deve diventare un numero.

    CLAUDE.md dichiara di questo modulo che ogni lettura torna vuoto/None per
    un motore che non ha la cosa, e che ogni chiamante deve leggerlo come "non
    lo so", mai come un valore. Per la meta' `pitch` era falso: tre ripieghi
    (`return 3.0`, il record ratio, la tabella dei preset) restituivano i
    numeri del motore di oggi trascritti qui, e `mergeEngineBounds` li applica
    SOPRA il fallback statico perche' arrivano etichettati come verita' del
    motore. Il verso e' quello sbagliato: un `ratio.min` trascritto contro un
    motore che ne pretendesse un altro ammette un valore che il motore
    rifiuta.

    Il sabotaggio qui e' un refactor plausibile — due classi rinominate — che
    per l'AST e' semplicemente una lettura fallita.
    """
    import server
    _stub_parameter_files(tmp_path)
    pu = tmp_path / "src" / "parameters" / "pitch_unit.py"
    src = pu.read_text(encoding="utf-8")
    src = src.replace("class EdoUnit:", "class EdoPitchUnit:")
    src = src.replace("class RatioUnit:", "class FrequencyRatioUnit:")
    src = src.replace("EdoUnit(", "EdoPitchUnit(").replace("RatioUnit()", "FrequencyRatioUnit()")
    pu.write_text(src, encoding="utf-8")

    pitch = server.engine_parameter_bounds(tmp_path)["pitch"]
    assert "edoFactor" not in pitch, pitch
    assert "ratio" not in pitch, pitch
    for name in ("semitones", "cents", "quarter_tone", "eighth_tone"):
        assert name not in pitch, pitch


def test_engine_parameter_bounds_pitch_partial_reads(tmp_path):
    """Le letture sono indipendenti: cio' che si sa resta, il resto sparisce."""
    import server
    _stub_parameter_files(tmp_path)
    pu = tmp_path / "src" / "parameters" / "pitch_unit.py"
    src = pu.read_text(encoding="utf-8")
    src = src.replace("class RatioUnit:", "class FrequencyRatioUnit:")
    pu.write_text(src, encoding="utf-8")

    pitch = server.engine_parameter_bounds(tmp_path)["pitch"]
    assert "ratio" not in pitch, pitch
    assert pitch["edoFactor"] == 3.0
    assert pitch["semitones"] == {"min": -36.0, "max": 36.0, "rangeMax": 36.0}


def test_engine_introspect_has_no_transcribed_engine_numbers():
    """Il fallback dichiarato sta in un posto solo, e non e' questo modulo.

    CLAUDE.md nomina `yaml-bridge.js` come l'unico posto dei fallback statici
    ("If you add a UI clamp, add its fallback in yaml-bridge.js"), e
    `test-bounds-parity.js` verifica che quello non ammetta valori che il
    motore rifiuta. Un secondo insieme di numeri qui sarebbe invisibile a
    quella verifica — col motore vero i due lati coincidono — e sopravvivrebbe
    proprio al caso in cui serve accorgersene: il motore che si muove.
    """
    import engine_introspect
    assert not hasattr(engine_introspect, "_PITCH_PRESET_DIVISIONS")


def test_bounds_endpoint(tmp_path):
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    _stub_parameter_files(tmp_path)

    app = server.make_app(tmp_path, render_timeout=600.0)
    client = app.test_client()
    body = client.get("/bounds").get_json()
    assert body["ok"] is True
    assert body["bounds"]["params"]["density"]["max_val"] == 4000.0
    assert body["bounds"]["pitch"]["edoFactor"] == 3.0


def test_bounds_endpoint_empty_when_engine_absent(tmp_path):
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    # no parameters/ stubs → empty bounds, UI falls back to static defaults
    app = server.make_app(tmp_path, render_timeout=600.0)
    client = app.test_client()
    body = client.get("/bounds").get_json()
    assert body == {"ok": True, "bounds": {}}


# ---------------------------------------------------------------------------
# /stems reports the extension, not just the id
# ---------------------------------------------------------------------------

def test_list_stems_reports_each_format_separately(tmp_path):
    """A stem is playable only in the format the editor is about to request.

    The browser builds its stem index from this payload and looks it up by
    filename (basename__id + ext), so /stems must say which extensions exist.
    Collapsing them to a bare id made a project rendered as .aif read as
    "rendered" while the editor asked for .wav — a 404 the <audio> element
    reports by never firing `canplay`, i.e. a clip that goes silent with no
    error anywhere.
    """
    import server
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    out = tmp_path / "output"
    out.mkdir()
    (out / "proj__stream1.wav").write_bytes(b"x")
    (out / "proj__stream2.aif").write_bytes(b"x")
    (out / "proj__stream3.wav").write_bytes(b"x")
    (out / "proj__stream3.aif").write_bytes(b"x")
    (out / "proj__stream1__grains.json").write_text("{}")   # not a stem
    (out / "proj__stream1.wav.reapeaks").write_bytes(b"x")  # not a stem

    client = server.make_app(tmp_path, render_timeout=600.0).test_client()
    stems = client.get("/stems/proj").get_json()["stems"]
    got = sorted((s["streamId"], s["ext"]) for s in stems)

    assert got == [
        ("stream1", ".wav"),
        ("stream2", ".aif"),
        ("stream3", ".aif"),
        ("stream3", ".wav"),
    ]
    # La durata dello stem SUL DISCO viaggia con l'elenco: e' quella che
    # permette di disegnare il waveform nel tempo invece di stirarlo sulla
    # clip, che dopo un taglio o un resize non e' piu' lunga uguale. Qui i
    # file sono finti, quindi il valore e' None — la chiave, no.
    assert all("dur" in s for s in stems)


def test_gunicorn_has_enough_threads_for_concurrent_stems():
    """Ogni <audio> in playback occupa un thread per tutta la durata dello stem.
    Con pochi thread gli stream oltre il limite restano muti e poi partono a
    meta' clip. Guard sul sorgente: la costante non deve tornare a un valore
    dell'ordine del numero di stream di un progetto."""
    src = (Path(__file__).resolve().parents[2] / "server.py").read_text()
    m = re.search(r'"threads":\s*(\d+)', src)
    assert m, '"threads" non trovato nella config gunicorn di server.py'
    assert int(m.group(1)) >= 32


# ---------------------------------------------------------------------------
# Semantica del motore — engine_semantics_version + /semantics-version (#133)
#
# VARIATION_SEMANTICS_VERSION e' il numero con cui il motore dichiara COME
# legge lo YAML. Entra nel suo fingerprint: quando cambia, ogni stem gia' su
# disco e' stato scritto con una lettura diversa dello stesso testo. L'editor
# lo legge di qui per non mostrare "renderizzato" su audio che il motore
# rifara' diverso — e questa e' l'unica strada per cui quel numero lo
# raggiunge, quindi None non e' un dettaglio: e' l'asse spento.
# ---------------------------------------------------------------------------

def _stub_stream_cache_manager(root, body, layout="pge"):
    d = (root / "src" / "pge" / "rendering") if layout == "pge" \
        else (root / "src" / "rendering")
    d.mkdir(parents=True, exist_ok=True)
    (d / "stream_cache_manager.py").write_text(
        "import numpy as np  # mai importato dal parser\n" + body)


def test_engine_semantics_version_parses_source(tmp_path):
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 7\n")
    assert server.engine_semantics_version(tmp_path) == 7


def test_engine_semantics_version_annotated(tmp_path):
    """`VARIATION_SEMANTICS_VERSION: int = 7` e' un AnnAssign.

    Il ripiego su None sarebbe MUTO e nel verso peggiore: None vuol dire
    "motore ignoto", e per la regola di questo asse un motore ignoto non
    pretende niente — cioe' l'asse si spegne e ogni stem torna verde proprio
    mentre il motore sta per riscriverli. E l'innesco sarebbe l'evento che
    l'asse sorveglia: un bump accompagnato da un'annotazione di tipo."""
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION: int = 7\n")
    assert server.engine_semantics_version(tmp_path) == 7


def test_engine_semantics_version_annotation_without_value(tmp_path):
    """`VARIATION_SEMANTICS_VERSION: int` senza valore: non c'e' niente da
    leggere, e None e' la risposta giusta (non un'eccezione)."""
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION: int\n")
    assert server.engine_semantics_version(tmp_path) is None


def test_engine_semantics_version_legacy_layout(tmp_path):
    """Layout piatto pre-PGE #162: src/rendering/ invece di src/pge/rendering/."""
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 2\n",
                               layout="flat")
    assert server.engine_semantics_version(tmp_path) == 2


def test_engine_semantics_version_prefers_current_layout(tmp_path):
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 2\n",
                               layout="flat")
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 5\n")
    assert server.engine_semantics_version(tmp_path) == 5


def test_engine_semantics_version_missing_is_none(tmp_path):
    """Un motore senza la costante, o senza il file. None e non 0: chi legge
    deve poter distinguere "non lo so" da una versione, o marchierebbe stale
    ogni stem di ogni progetto."""
    import server
    assert server.engine_semantics_version(tmp_path / "nope") is None
    _stub_stream_cache_manager(tmp_path, "FINGERPRINT_IGNORE_KEYS = {'solo'}\n")
    assert server.engine_semantics_version(tmp_path) is None


def test_engine_semantics_version_non_literal_is_none(tmp_path):
    """Se la costante smette di essere un letterale (calcolata, importata), il
    parser AST non deve inventare: None, e l'editor non pretende niente."""
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 1 + int(x)\n")
    assert server.engine_semantics_version(tmp_path) is None


def test_engine_semantics_version_rejects_bool(tmp_path):
    """`True` e' un int in Python. Non e' una versione."""
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = True\n")
    assert server.engine_semantics_version(tmp_path) is None


def test_engine_semantics_version_sees_a_live_bump(tmp_path):
    """La cache si invalida sul mtime, e non e' pedanteria: il caso e' il motore
    aggiornato sotto un `make serve` in corso. Con una cache a vita il bridge
    continuerebbe a servire il numero vecchio fino al restart — cioe' proprio
    l'evento che questa lettura esiste per intercettare resterebbe invisibile."""
    import os
    import server
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 2\n")
    assert server.engine_semantics_version(tmp_path) == 2

    src = tmp_path / "src" / "pge" / "rendering" / "stream_cache_manager.py"
    src.write_text("VARIATION_SEMANTICS_VERSION = 3\n")
    # mtime esplicito: su un filesystem a bassa risoluzione due scritture nello
    # stesso istante sarebbero indistinguibili, e il test misurerebbe l'orologio
    # invece della cache.
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert server.engine_semantics_version(tmp_path) == 3


def test_engine_semantics_cache_keeps_one_entry_per_root(tmp_path):
    """Il timbro sta nel valore, non nella chiave: altrimenti ogni salvataggio
    del motore aggiungerebbe una voce invece di sostituirla, e sotto un
    `make serve` durante lo sviluppo il dizionario crescerebbe a ogni Ctrl-S."""
    import os
    import engine_introspect as ei
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 1\n")
    src = tmp_path / "src" / "pge" / "rendering" / "stream_cache_manager.py"
    for i, v in enumerate((1, 2, 3, 4)):
        src.write_text(f"VARIATION_SEMANTICS_VERSION = {v}\n")
        st = src.stat()
        os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + (i + 1) * 1_000_000_000))
        assert ei.engine_semantics_version(tmp_path) == v
    mine = [k for k in ei._SEMANTICS_CACHE if str(tmp_path) in str(k)]
    assert len(mine) == 1, f"{len(mine)} voci per una sola root: {mine}"


# ---------------------------------------------------------------------------
# engine_supports_samples_dir — la capacita' del motore, non un valore
#
# E' l'unica lettura di engine_introspect che serve a decidere DOVE stanno i
# sample invece di leggere un numero: il flag si manda comunque (inerte sui
# motori che non l'hanno), ma spostare refs/ dentro il workspace su un motore
# che non lo legge darebbe una cartella che la UI elenca e il render ignora.
# PGE-ui #148 / PythonGranularEngine#235
# ---------------------------------------------------------------------------

def _stub_cli(root: Path, text: str, where=("pge", "cli.py")):
    d = root / "src"
    for part in where[:-1]:
        d = d / part
    d.mkdir(parents=True, exist_ok=True)
    (d / where[-1]).write_text(text)
    return root / "src" / Path(*where)


def test_engine_supports_samples_dir_current_layout(tmp_path):
    import engine_introspect as ei
    _stub_cli(tmp_path, "import sys\nif '--samples-dir' in sys.argv:\n    pass\n")
    assert ei.engine_supports_samples_dir(tmp_path) is True


@pytest.mark.parametrize("where", [("cli.py",), ("main.py",)])
def test_engine_supports_samples_dir_older_layouts(tmp_path, where):
    """La CLI e' nata in src/main.py, e' passata per src/cli.py e vive in
    src/pge/cli.py (PGE #162): i candidati coprono le tre vintage, altrimenti
    un motore aggiornato ma con la CLI dove stava prima verrebbe letto come
    un motore senza il flag."""
    import engine_introspect as ei
    _stub_cli(tmp_path, "import sys\nif '--samples-dir' in sys.argv:\n    pass\n",
              where=where)
    assert ei.engine_supports_samples_dir(tmp_path) is True


def test_engine_supports_samples_dir_absent(tmp_path):
    import engine_introspect as ei
    _stub_cli(tmp_path, "import sys\nif '--ssdir' in sys.argv:\n    pass\n")
    assert ei.engine_supports_samples_dir(tmp_path) is False


def test_engine_supports_samples_dir_missing_engine(tmp_path):
    """Nessun sorgente = nessuna capacita'. Vale come "non lo so" e porta al
    comportamento storico, che e' la direzione sicura."""
    import engine_introspect as ei
    assert ei.engine_supports_samples_dir(tmp_path) is False


def test_engine_supports_samples_dir_ignores_a_mention(tmp_path):
    """Il criterio e' il letterale, ed e' per questo che si passa dall'AST: un
    motore che il flag lo nomina in un commento o in un TODO (`#235` era una
    issue aperta prima di essere un flag) non lo parsa, e leggere il testo
    grezzo lo direbbe pronto."""
    import engine_introspect as ei
    _stub_cli(tmp_path,
              "import sys\n"
              "# TODO: --samples-dir, quando ci arriviamo (issue #235)\n"
              "USAGE = '[--samples-dir DIR] '\n")
    assert ei.engine_supports_samples_dir(tmp_path) is False


def test_engine_supports_samples_dir_sees_a_live_update(tmp_path):
    """Cache invalidata sull'mtime, come la versione di semantica: il caso e'
    un `git pull` nel checkout del motore sotto un `make serve` acceso."""
    import os
    import engine_introspect as ei
    src = _stub_cli(tmp_path, "import sys\n")
    assert ei.engine_supports_samples_dir(tmp_path) is False

    src.write_text("import sys\nif '--samples-dir' in sys.argv:\n    pass\n")
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert ei.engine_supports_samples_dir(tmp_path) is True


def test_engine_supports_samples_dir_on_the_real_engine():
    """Il motore vero ce l'ha (PGE #236). E' la canarina della #132 su questa
    lettura: il giorno che il flag venisse rinominato a monte, refs/ tornerebbe
    in silenzio dentro il checkout del motore per tutti — un workspace che
    smette di essere una cartella di lavoro senza che nulla diventi rosso."""
    err = engine_corpus.corpus_error()
    assert err is None, err
    reason = engine_corpus.skip_reason()
    if reason is not None:
        pytest.skip(reason)

    import engine_introspect as ei
    root = Path(engine_corpus.ENGINE_ROOT)
    assert ei.engine_supports_samples_dir(root) is True, (
        f"il motore in {root} non nomina --samples-dir nella sua CLI: "
        "o e' precedente a PGE #236, o il flag ha cambiato nome e il bridge "
        "ha smesso di spostare refs/ senza dirlo"
    )


def test_semantics_version_endpoint(tmp_path):
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    _stub_stream_cache_manager(tmp_path, "VARIATION_SEMANTICS_VERSION = 4\n")

    client = server.make_app(tmp_path, render_timeout=600.0).test_client()
    body = client.get("/semantics-version").get_json()
    assert body["ok"] is True
    assert body["version"] == 4


# ---------------------------------------------------------------------------
# Sample rate del motore — engine_output_sr + /bounds (#133)
#
# DEFAULT_OUTPUT_SR e' l'ultima costante del motore che questo repo teneva
# ricopiata a mano (`OUTPUT_SR` in yaml-bridge.js). Non e' un bound ma ne
# genera uno — il minimo di grain_duration e' 1 campione, cioe' 1/output_sr
# (PGE #158) — e soprattutto e' il fattore con cui la UI converte
# `grain.duration_unit: samples`, conversione che RISCRIVE i valori nello YAML.
# Un numero sbagliato qui non stringe una manopola: scrive durate sbagliate.
# ---------------------------------------------------------------------------

def _stub_constants(root, body, layout="pge"):
    d = (root / "src" / "pge" / "shared") if layout == "pge" \
        else (root / "src" / "shared")
    d.mkdir(parents=True, exist_ok=True)
    # L'import pesante e' li' apposta: il parser non deve eseguire niente.
    (d / "constants.py").write_text(
        "import numpy as np  # mai importato dal parser\n" + body)


def test_engine_output_sr_parses_source(tmp_path):
    import server
    _stub_constants(tmp_path, "DEFAULT_OUTPUT_SR = 44100\n")
    assert server.engine_output_sr(tmp_path) == 44100


def test_engine_output_sr_annotated(tmp_path):
    """Grafia annotata, come per la versione di semantica: e' house style nel
    motore, e filtrare su `ast.Assign` la perderebbe in silenzio."""
    import server
    _stub_constants(tmp_path, "DEFAULT_OUTPUT_SR: int = 96000\n")
    assert server.engine_output_sr(tmp_path) == 96000


def test_engine_output_sr_legacy_layout(tmp_path):
    import server
    _stub_constants(tmp_path, "DEFAULT_OUTPUT_SR = 22050\n", layout="flat")
    assert server.engine_output_sr(tmp_path) == 22050


def test_engine_output_sr_missing_is_none(tmp_path):
    """Assente = "non lo so", e chi chiama tiene il proprio fallback statico.
    Mai un numero inventato: sarebbe indistinguibile da una lettura riuscita."""
    import server
    assert server.engine_output_sr(tmp_path / "nope") is None
    _stub_constants(tmp_path, "SECONDS_PER_MILLISECOND = 1e-3\n")
    assert server.engine_output_sr(tmp_path) is None


@pytest.mark.parametrize("body", [
    "DEFAULT_OUTPUT_SR = 0\n",
    "DEFAULT_OUTPUT_SR = -48000\n",
    "DEFAULT_OUTPUT_SR = True\n",
    "DEFAULT_OUTPUT_SR = 48000.0\n",
    "DEFAULT_OUTPUT_SR = SOMETHING\n",
    "DEFAULT_OUTPUT_SR = None\n",
])
def test_engine_output_sr_rejects_nonsense(tmp_path, body):
    """Un sample rate non positivo non e' "sconosciuto", e' assurdo, e va
    trattato come assente invece di viaggiare: la UI ci fa `1/sr`, quindi uno
    zero diventa Infinity e un negativo un fattore col segno sbagliato — un min
    che nessun confronto fa piu' scattare, cioe' ogni clamp a valle spento in
    silenzio. Il bool e' escluso perche' in Python e' un int."""
    import server
    _stub_constants(tmp_path, body)
    assert server.engine_output_sr(tmp_path) is None


def test_engine_output_sr_sees_a_live_bump(tmp_path):
    """Cache invalidata sull'mtime, come la versione di semantica: il caso e' un
    `git pull` nel repo fratello sotto un `make serve` acceso. Con una cache a
    vita una pagina appena aperta riceverebbe il sample rate vecchio."""
    import os
    import server
    _stub_constants(tmp_path, "DEFAULT_OUTPUT_SR = 48000\n")
    assert server.engine_output_sr(tmp_path) == 48000

    src = tmp_path / "src" / "pge" / "shared" / "constants.py"
    src.write_text("DEFAULT_OUTPUT_SR = 44100\n")
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert server.engine_output_sr(tmp_path) == 44100


def test_bounds_endpoint_carries_output_sr(tmp_path):
    """La route che la UI interroga davvero. `output_sr` viaggia su /bounds e
    non su una route sua perche' e' la stessa domanda: i clamp che il motore
    impone."""
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    _stub_constants(tmp_path, "DEFAULT_OUTPUT_SR = 44100\n")

    body = server.make_app(tmp_path, render_timeout=600.0).test_client() \
        .get("/bounds").get_json()
    assert body["ok"] is True
    assert body["bounds"]["output_sr"] == 44100


def test_bounds_endpoint_omits_unknown_output_sr(tmp_path):
    """Chiave assente, non `null`: `resolveOutputSr` scarta i non-numeri e
    ricade sul fallback statico, ma la differenza fra "non lo so" e "zero" deve
    essere visibile gia' nel payload."""
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()

    body = server.make_app(tmp_path, render_timeout=600.0).test_client() \
        .get("/bounds").get_json()
    assert body["ok"] is True
    assert "output_sr" not in body["bounds"]


def test_bounds_endpoint_reports_sr_without_parameter_definitions(tmp_path):
    """Il sample rate non e' condizionato alla presenza dei bound: un motore con
    `constants.py` e senza `parameter_definitions.py` e' strano, ma il numero lo
    sappiamo lo stesso e tacerlo rimanderebbe la UI al letterale trascritto —
    cioe' proprio la cosa che questa lettura toglie di mezzo."""
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()
    _stub_constants(tmp_path, "DEFAULT_OUTPUT_SR = 96000\n")

    body = server.make_app(tmp_path, render_timeout=600.0).test_client() \
        .get("/bounds").get_json()
    assert body["bounds"]["output_sr"] == 96000
    assert not body["bounds"].get("params")


# ---------------------------------------------------------------------------
# Le due difese di /render: il confine di fiducia di una route che SCRIVE un
# file, e il filtro dei nomi envelope.
#
# Nessuna delle due aveva un'asserzione: sabotandole la suite restava verde
# (136 passed), mentre sul bridge vivo la prima dava HTTP 200 e un file scritto
# fuori da configs/, e la seconda mandava in argv un `--plot-envelopes` con un
# nome ignoto, che fa uscire il motore con 1 portandosi via l'audio.
# ---------------------------------------------------------------------------

def _render_root(tmp_path, fake_python=False):
    """Una root minima per make_app; con `fake_python` anche un finto
    `.venv/bin/python` che esce subito, cosi' /render costruisce e stampa la
    argv senza avere il motore."""
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    for d in ("configs", "refs", "output", "cache"):
        (tmp_path / d).mkdir(exist_ok=True)
    if fake_python:
        vb = tmp_path / ".venv" / "bin"
        vb.mkdir(parents=True, exist_ok=True)
        py = vb / "python"
        py.write_text("#!/bin/sh\nexit 0\n")
        py.chmod(0o755)
    return tmp_path


@pytest.mark.parametrize("basename", [
    "../evil",           # traversal esplicito
    "..",                # la directory sopra
    "a/b",               # separatore
    "a\\b",              # separatore di Windows: `\` non e' `/`
    ".hidden",           # punto iniziale
    "",                  # vuoto
    "\x00nul",           # NUL: ValueError dal filesystem, non un 500
])
def test_render_rejects_bad_basename(tmp_path, basename):
    """Il basename di /render diventa un path e un file scritto: e' un confine
    di fiducia, e passa per `safe_resolve` come tutte le altre route invece di
    riscrivere la regola piu' debole."""
    import server
    root = _render_root(tmp_path)
    client = server.make_app(root, render_timeout=600.0).test_client()

    before = sorted(p.name for p in (root / "configs").iterdir())
    r = client.post("/render", json={"yamlBasename": basename,
                                     "yamlContent": "streams: []\n"})
    assert r.status_code == 400, f"{basename!r} → {r.status_code}"
    assert sorted(p.name for p in (root / "configs").iterdir()) == before
    # e niente scritto fuori da configs/
    assert not (root / "evil.yml").exists()
    assert not (root.parent / "evil.yml").exists()


def test_render_accepts_an_ordinary_basename(tmp_path):
    """La guardia non deve essere cosi' stretta da rifiutare i nomi veri: senza
    questo, `abort(400)` incondizionato passerebbe il test qui sopra."""
    import server
    root = _render_root(tmp_path, fake_python=True)
    client = server.make_app(root, render_timeout=600.0).test_client()
    r = client.post("/render", json={"yamlBasename": "PGE_test",
                                     "yamlContent": "streams: []\n"})
    assert r.status_code == 200
    r.get_data()                      # consuma lo stream NDJSON
    assert (root / "configs" / "PGE_test.yml").exists()


def _argv_line(client, payload):
    """La riga `$ …` che /render stampa: e' la argv che parte davvero."""
    r = client.post("/render", json=payload)
    assert r.status_code == 200
    for raw in r.get_data(as_text=True).splitlines():
        ev = json.loads(raw)
        if ev.get("type") == "log" and str(ev.get("line", "")).startswith("$ "):
            return ev["line"]
    raise AssertionError("nessuna riga argv nello stream NDJSON")


def test_render_filters_unknown_envelope_names(tmp_path):
    """Un nome ignoto in `--plot-envelopes` fa `sys.exit(1)` nel motore e si
    porta via l'audio gia' reso. L'insieme valido vive nei sorgenti del motore,
    quindi il filtro e' qui e non nella UI — ed e' meta' della sezione "Score
    options that can kill a render", finora senza un'asserzione."""
    import server
    root = _render_root(tmp_path, fake_python=True)
    _stub_envelope_extractor_pge(root)          # volume, pan, pitch, voice_pitch_offset
    client = server.make_app(root, render_timeout=600.0).test_client()

    line = _argv_line(client, {
        "yamlBasename": "PGE_test", "yamlContent": "streams: []\n",
        "visualize": True, "plotEnvelopes": ["volume", "nome_che_non_esiste"],
    })
    assert "--plot-envelopes" in line, line
    assert "nome_che_non_esiste" not in line, line
    assert "volume" in line.split("--plot-envelopes", 1)[1], line


def test_render_drops_the_flag_when_nothing_survives(tmp_path):
    """Tutti i nomi ignoti: il flag non parte affatto. `--plot-envelopes` senza
    valore, o con una lista vuota, e' l'altro modo di far uscire il motore."""
    import server
    root = _render_root(tmp_path, fake_python=True)
    _stub_envelope_extractor_pge(root)
    client = server.make_app(root, render_timeout=600.0).test_client()

    line = _argv_line(client, {
        "yamlBasename": "PGE_test", "yamlContent": "streams: []\n",
        "visualize": True, "plotEnvelopes": ["boh", "nemmeno"],
    })
    assert "--plot-envelopes" not in line, line


def test_render_without_engine_keys_drops_the_flag(tmp_path):
    """Motore che precede la feature: nessuna chiave valida, quindi il flag non
    si manda — un motore vecchio non deve vedere un'opzione che non conosce."""
    import server
    root = _render_root(tmp_path, fake_python=True)
    client = server.make_app(root, render_timeout=600.0).test_client()

    line = _argv_line(client, {
        "yamlBasename": "PGE_test", "yamlContent": "streams: []\n",
        "visualize": True, "plotEnvelopes": ["volume"],
    })
    assert "--plot-envelopes" not in line, line


def test_semantics_version_endpoint_without_engine(tmp_path):
    """Nessun motore sotto --root: la route risponde comunque, con null. La UI
    la tratta come "non lo so" e i pallini restano quelli di prima."""
    import server
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    (tmp_path / "configs").mkdir()
    (tmp_path / "refs").mkdir()

    client = server.make_app(tmp_path, render_timeout=600.0).test_client()
    body = client.get("/semantics-version").get_json()
    assert body["ok"] is True
    assert body["version"] is None


# ---------------------------------------------------------------------------
# Workspace — la cartella dei progetti e' scollegata dal checkout del motore
#
# `--root` resta la sorgente del motore (src/main.py, .venv, csound/); il
# workspace e' dove vivono configs/ output/ cache/, cioe' il lavoro dell'autore.
# Senza workspace le due cose coincidono, che e' il comportamento storico.
# Anche refs/ segue, ma solo dove il motore ha --samples-dir: il bridge glielo
# manda a ogni render (PythonGranularEngine#235), e senza quel flag i sample si
# risolvono comunque su ./refs/ del cwd del sottoprocesso, che e' root.
# PGE-ui #147, #148
# ---------------------------------------------------------------------------

def _engine_stub(root: Path, samples_dir: bool = True):
    """Il minimo che make_app si aspetta da un checkout del motore.

    `samples_dir` sceglie la vintage: con la CLI che parsa `--samples-dir`
    (motore corrente) o senza (motore precedente a PGE #235). Non e' un
    dettaglio del fixture — e' cio' che decide dove punta refs/."""
    (root / "src").mkdir(parents=True, exist_ok=True)
    (root / "src" / "main.py").write_text("# stub\n")
    (root / "src" / "pge").mkdir(parents=True, exist_ok=True)
    (root / "src" / "pge" / "cli.py").write_text(
        "import sys\n"
        + ("if '--samples-dir' in sys.argv:\n    pass\n" if samples_dir else "")
    )
    (root / "refs").mkdir(exist_ok=True)
    return root


def test_workspace_absent_means_root(tmp_path):
    """Il default non cambia: senza workspace tutto resta dentro il motore."""
    import server
    _engine_stub(tmp_path)
    client = server.make_app(tmp_path, render_timeout=600.0).test_client()

    h = client.get("/health").get_json()
    assert h["workspace"] == str(tmp_path)
    assert h["configs"] == str(tmp_path / "configs")
    assert h["output"] == str(tmp_path / "output")
    assert h["cache"] == str(tmp_path / "cache")
    assert client.get("/workspace").get_json()["isRoot"] is True


def test_workspace_moves_all_four_folders(tmp_path):
    """Con un motore che ha --samples-dir seguono tutte e quattro, refs/
    compresa: e' l'ultima che teneva la cartella di lavoro dentro il checkout
    del motore (PGE-ui #148)."""
    import server
    root = _engine_stub(tmp_path / "engine")
    ws = tmp_path / "brani"
    ws.mkdir()

    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()
    h = client.get("/health").get_json()

    assert h["root"] == str(root)
    assert h["workspace"] == str(ws)
    assert h["configs"] == str(ws / "configs")
    assert h["output"] == str(ws / "output")
    assert h["cache"] == str(ws / "cache")
    assert h["refs"] == str(ws / "refs")
    w = client.get("/workspace").get_json()
    assert w["isRoot"] is False
    assert w["samplesFollowWorkspace"] is True


def test_workspace_leaves_refs_to_an_engine_without_the_flag(tmp_path):
    """Su un motore senza --samples-dir refs/ resta quella del motore.

    Il flag viene mandato lo stesso (e' inerte), ma il render risolve i sample
    su ./refs/ relativo al proprio cwd, che e' root. Puntare la UI altrove
    darebbe una cartella di sample che l'editor elenca e il motore non legge:
    un disaccordo che si scopre solo quando un render fallisce."""
    import server
    root = _engine_stub(tmp_path / "engine", samples_dir=False)
    ws = tmp_path / "brani"
    ws.mkdir()

    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()
    h = client.get("/health").get_json()

    assert h["refs"] == str(root / "refs")
    assert h["configs"] == str(ws / "configs")      # le altre tre seguono lo stesso
    assert client.get("/workspace").get_json()["samplesFollowWorkspace"] is False
    assert not (ws / "refs").exists(), (
        "una refs/ creata nel workspace di un motore che non la leggera' mai "
        "e' un invito a metterci i sample sbagliati"
    )


def test_workspace_switch_moves_refs_too(tmp_path):
    """La commutazione a caldo porta con se' anche refs/: `_bases()` e
    `_resolved_paths()` la rileggono, non e' una costante della closure."""
    import server
    root = _engine_stub(tmp_path / "engine")
    uno = tmp_path / "uno"; uno.mkdir()
    due = tmp_path / "due"; due.mkdir()

    client = server.make_app(root, render_timeout=600.0, workspace=uno).test_client()
    assert client.get("/health").get_json()["refs"] == str(uno / "refs")

    r = client.post("/workspace", json={"path": str(due)})
    assert r.status_code == 200
    assert r.get_json()["paths"]["refs"] == str(due / "refs")
    assert client.get("/health").get_json()["refs"] == str(due / "refs")
    assert (due / "refs").is_dir()


@pytest.mark.parametrize("samples_dir", [True, False])
def test_app_exposes_the_paths_the_banner_prints(tmp_path, samples_dir):
    """`app.pge_paths()` / `app.pge_samples_follow()` sono cio' che il banner
    d'avvio stampa, e vengono da _set_workspace.

    Il banner riderivava la regola per conto suo (`(ws / "refs") if follow else
    root / "refs"`): due scritture della stessa cosa, con la guardia di
    sorgente attaccata a una sola. Ed e' la riga da cui l'autore impara dove
    mettere i sample — una copia divergente li' si legge come verita'. Il test
    tiene gli accessor allineati alle route su entrambe le vintage del motore.
    """
    import server
    root = _engine_stub(tmp_path / "engine", samples_dir=samples_dir)
    ws = tmp_path / "brani"
    ws.mkdir()

    app = server.make_app(root, render_timeout=600.0, workspace=ws)
    client = app.test_client()

    assert app.pge_samples_follow() is samples_dir
    assert (client.get("/workspace").get_json()["samplesFollowWorkspace"]
            is samples_dir)
    health = client.get("/health").get_json()
    for key, value in app.pge_paths().items():
        assert health[key] == value, key
    assert app.pge_paths()["refs"] == str(
        (ws if samples_dir else root) / "refs")


def test_app_paths_follow_a_hot_switch(tmp_path):
    """E seguono la commutazione a caldo: sono la closure, non una copia presa
    all'avvio (il banner li legge una volta, ma le route no)."""
    import server
    root = _engine_stub(tmp_path / "engine")
    uno = tmp_path / "uno"; uno.mkdir()
    due = tmp_path / "due"; due.mkdir()

    app = server.make_app(root, render_timeout=600.0, workspace=uno)
    client = app.test_client()
    assert app.pge_paths()["refs"] == str(uno / "refs")

    assert client.post("/workspace", json={"path": str(due)}).status_code == 200
    assert app.pge_paths()["refs"] == str(due / "refs")
    assert app.pge_paths()["workspace"] == str(due)


def test_workspace_creates_its_subdirs(tmp_path):
    """Un workspace nuovo e' una cartella vuota: le sottodirectory le fa il
    bridge, altrimenti il primo salvataggio fallirebbe su una cartella che non
    c'e'."""
    import server
    root = _engine_stub(tmp_path / "engine")
    ws = tmp_path / "brani"
    ws.mkdir()

    server.make_app(root, render_timeout=600.0, workspace=ws)

    assert (ws / "configs").is_dir()
    assert (ws / "output").is_dir()
    assert (ws / "cache").is_dir()
    # E refs/ con loro, dove il motore sa leggerla: una cartella dei sample da
    # riempire e' meglio di un errore "refs/ folder missing" al primo /media.
    assert (ws / "refs").is_dir()
    # E il motore non guadagna una configs/ che non gli serve piu'.
    assert not (root / "configs").exists()


def test_projects_and_file_io_read_the_workspace(tmp_path):
    """L'elenco progetti e la lettura/scrittura dei file passano dal workspace,
    non dal motore. E' il punto dell'issue: un brano proprio non deve piu'
    finire dentro il checkout del motore."""
    import server
    root = _engine_stub(tmp_path / "engine")
    (root / "configs").mkdir()
    (root / "configs" / "del_motore.yml").write_text("duration: 1\n")
    ws = tmp_path / "brani"
    (ws / "configs").mkdir(parents=True)
    (ws / "configs" / "mio.yml").write_text("duration: 2\n")

    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()

    names = [f["name"] for f in client.get("/projects").get_json()["files"]]
    assert names == ["mio.yml"]                    # non del_motore.yml
    assert client.get("/file?kind=projects&name=mio.yml").get_data(as_text=True) == "duration: 2\n"
    assert client.get("/file?kind=projects&name=del_motore.yml").status_code == 404

    client.put("/file?kind=projects&name=nuovo.yml", data="duration: 3\n")
    assert (ws / "configs" / "nuovo.yml").exists()
    assert not (root / "configs" / "nuovo.yml").exists()


def test_workspace_switch_at_runtime(tmp_path):
    """POST /workspace commuta a caldo e risponde con l'elenco nuovo.

    L'elenco viaggia nella risposta perche' cambiare cartella invalida quello
    che il browser ha in mano: e' un rimpiazzo, non un merge."""
    import server
    root = _engine_stub(tmp_path / "engine")
    a = tmp_path / "a"; (a / "configs").mkdir(parents=True)
    (a / "configs" / "primo.yml").write_text("duration: 1\n")
    b = tmp_path / "b"; (b / "configs").mkdir(parents=True)
    (b / "configs" / "secondo.yml").write_text("duration: 2\n")

    client = server.make_app(root, render_timeout=600.0, workspace=a).test_client()
    assert [f["name"] for f in client.get("/projects").get_json()["files"]] == ["primo.yml"]

    r = client.post("/workspace", json={"path": str(b)})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["workspace"] == str(b)
    assert [f["name"] for f in body["projects"]] == ["secondo.yml"]

    # e le altre route seguono, senza riavviare il bridge
    assert [f["name"] for f in client.get("/projects").get_json()["files"]] == ["secondo.yml"]
    assert client.get("/health").get_json()["cache"] == str(b / "cache")


def test_workspace_empty_path_returns_to_root(tmp_path):
    """Campo svuotato = torna al default (workspace sul motore)."""
    import server
    root = _engine_stub(tmp_path / "engine")
    ws = tmp_path / "brani"; ws.mkdir()

    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()
    body = client.post("/workspace", json={"path": "  "}).get_json()

    assert body["workspace"] == str(root)
    assert body["isRoot"] is True


def test_workspace_refuses_a_path_that_does_not_exist(tmp_path):
    """Le *sotto*directory si creano, il workspace no: un percorso digitato
    male e' un refuso, e un refuso non deve seminare cartelle sul disco. E lo
    stato non si muove — la risposta dice ancora dove siamo."""
    import server
    root = _engine_stub(tmp_path / "engine")
    ws = tmp_path / "brani"; ws.mkdir()
    missing = tmp_path / "refuso"

    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()
    r = client.post("/workspace", json={"path": str(missing)})

    assert r.status_code == 400
    body = r.get_json()
    assert body["ok"] is False
    assert "non esiste" in body["error"]
    assert body["workspace"] == str(ws)            # invariato
    assert not missing.exists()                    # e nessuna cartella fabbricata
    assert client.get("/health").get_json()["configs"] == str(ws / "configs")


def test_workspace_refuses_a_file(tmp_path):
    import server
    root = _engine_stub(tmp_path / "engine")
    f = tmp_path / "non_una_cartella.txt"
    f.write_text("x")

    client = server.make_app(root, render_timeout=600.0).test_client()
    r = client.post("/workspace", json={"path": str(f)})

    assert r.status_code == 400
    assert "non e' una directory" in r.get_json()["error"]


def test_workspace_refused_while_a_render_is_running(tmp_path):
    """Commutare a render in corso manderebbe gli stem in una cartella e il
    manifest di cache in un'altra. La route rifiuta con 409 finche' il
    sottoprocesso e' vivo."""
    import server
    root = _engine_stub(tmp_path / "engine")
    # Un finto motore che stampa una riga e poi resta li': serve un processo
    # vivo, non un render vero.
    (root / "src" / "main.py").write_text(
        "import sys, time\n"
        "print('[CACHE] stream1: DIRTY', flush=True)\n"
        "time.sleep(30)\n"
    )
    # Finto venv: il generatore di /render si limita a controllare che il
    # binario esista, e con questo evitiamo di costruire un venv vero.
    venv_bin = root / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "python").symlink_to(sys.executable)

    ws = tmp_path / "brani"; ws.mkdir()
    altro = tmp_path / "altro"; altro.mkdir()
    app = server.make_app(root, render_timeout=600.0, workspace=ws)
    client = app.test_client()

    resp = client.post("/render", json={
        "yamlBasename": "prova", "yamlContent": "duration: 1\n", "streams": [],
    })
    chunks = resp.response          # generatore: avanza solo quando lo tiriamo
    try:
        next(chunks)                # riga "$ …" — il processo non e' ancora partito
        next(chunks)                # prima riga del sottoprocesso: ora si'
        r = client.post("/workspace", json={"path": str(altro)})
        assert r.status_code == 409
        assert "render in corso" in r.get_json()["error"]
        assert client.get("/health").get_json()["workspace"] == str(ws)
    finally:
        client.post("/render/cancel")
        for _ in range(200):        # drena senza rischiare un loop infinito
            try:
                next(chunks)
            except StopIteration:
                break
        resp.close()

    # A render finito la commutazione passa.
    assert client.post("/workspace", json={"path": str(altro)}).status_code == 200


def test_render_pins_the_workspace_paths_for_its_whole_life(tmp_path):
    """I path si fissano all'inizio della route, non dentro il generatore.

    Guardia sul sorgente: rileggerli a valle significherebbe, su un cambio di
    workspace a meta' stream, stem in una cartella e manifest in un'altra.

    `ws` e' nella riga come le altre tre. A valle serve solo per il percorso
    relativo della riga `done`, ma letto li' direbbe gli stem sotto una
    cartella che non li ha mai visti — e la riga finisce nel log."""
    src = (Path(__file__).resolve().parents[2] / "server.py").read_text()
    assert "ws_dir, ws_refs, ws_output, ws_cache = ws, refs, output, cache" in src
    body = src[src.index("def render():"):]
    body = body[:body.index("# --------- static UI file serving ---------")]
    gen = body[body.index("def event_stream():"):]
    for name in ("cache=cache", "refs=refs", "output=output", "relative_to(ws)"):
        assert name not in gen, f"{name}: il generatore rilegge il path invece del valore fissato"


def test_workspace_rejects_a_path_that_is_not_a_path(tmp_path):
    """Un percorso impossibile e' una risposta, non un guasto: 400 col
    messaggio, non 500 con una pagina HTML.

    Il NUL alza ValueError dal filesystem e `~utentechenonesiste` alza
    RuntimeError da expanduser(): nessuna delle due e' OSError, e senza
    gestione arrivavano al campo in Settings come "HTTP 500". E' la stessa
    svista che /render si e' portata via passando da safe_resolve."""
    import server
    root = _engine_stub(tmp_path / "engine")
    ws = tmp_path / "brani"; ws.mkdir()
    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()

    for bad in ("\x00", "/brani/\x00/x", "~utentechenonesiste42/brani"):
        r = client.post("/workspace", json={"path": bad})
        assert r.status_code == 400, f"{bad!r}: atteso 400, ricevuto {r.status_code}"
        body = r.get_json()
        assert body["ok"] is False
        assert body["error"]
        # E soprattutto: lo stato non si e' mosso.
        assert body["workspace"] == str(ws)
    assert client.get("/health").get_json()["workspace"] == str(ws)


def test_workspace_refused_from_the_first_instant_of_the_render(tmp_path):
    """Il 409 vale da prima che il sottoprocesso esista.

    Fra la POST e lo spawn ci sta la creazione del venv del motore: minuti in
    cui `rs.proc` e' None. Guardare solo il sottoprocesso lasciava passare la
    commutazione proprio li', e il render — che i path se li e' gia' fissati —
    avrebbe scritto stem e manifest nella cartella di prima mentre il browser
    mostrava la nuova."""
    import server
    root = _engine_stub(tmp_path / "engine")
    # Non serve un processo vivo: la finestra che questo caso misura sta
    # PRIMA dello spawn. Un motore che stampa e esce tiene il drenaggio corto.
    (root / "src" / "main.py").write_text(
        "print('[CACHE] stream1: DIRTY', flush=True)\n")
    venv_bin = root / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "python").symlink_to(sys.executable)

    ws = tmp_path / "brani"; ws.mkdir()
    altro = tmp_path / "altro"; altro.mkdir()
    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()

    resp = client.post("/render", json={
        "yamlBasename": "prova", "yamlContent": "duration: 1\n", "streams": [],
    })
    chunks = resp.response
    try:
        next(chunks)                # la riga "$ …": il processo non c'e' ancora
        r = client.post("/workspace", json={"path": str(altro)})
        assert r.status_code == 409, "commutazione passata prima dello spawn"
        assert client.get("/health").get_json()["workspace"] == str(ws)
    finally:
        client.post("/render/cancel")
        for _ in range(200):
            try:
                next(chunks)
            except StopIteration:
                break
        resp.close()


def test_workspace_unblocks_when_the_client_abandons_the_stream(tmp_path):
    """Una pretesa appesa bloccherebbe /workspace per tutta la vita del bridge.

    Il client che chiude a meta' stream non e' un caso di scuola: e' la pagina
    ricaricata durante un setup del venv. Chiudere il generatore alza
    GeneratorExit dentro di lui, e il finally piu' esterno deve rilasciare."""
    import server
    root = _engine_stub(tmp_path / "engine")
    (root / "src" / "main.py").write_text(
        "print('[CACHE] stream1: DIRTY', flush=True)\n")
    venv_bin = root / ".venv" / "bin"
    venv_bin.mkdir(parents=True)
    (venv_bin / "python").symlink_to(sys.executable)

    ws = tmp_path / "brani"; ws.mkdir()
    altro = tmp_path / "altro"; altro.mkdir()
    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()

    resp = client.post("/render", json={
        "yamlBasename": "prova", "yamlContent": "duration: 1\n", "streams": [],
    })
    next(resp.response)             # entra nel generatore, poi se ne va
    client.post("/render/cancel")
    resp.close()

    r = client.post("/workspace", json={"path": str(altro)})
    assert r.status_code == 200, "la pretesa e' rimasta appesa dopo la chiusura"
    assert r.get_json()["workspace"] == str(altro)


def test_render_state_claim_covers_the_gap_before_the_spawn():
    """L'unita' sotto le due route: la pretesa vale senza sottoprocesso, e
    clear() la rilascia. Il campo dice "in volo", non "c'e' un processo"."""
    rs = rp.RenderState()
    assert rs.is_running() is False
    rs.enter()
    assert rs.is_running() is True, "senza proc la pretesa non conta"
    rs.clear()
    assert rs.is_running() is False


# ---------------------------------------------------------------------------
# engine_loop_units — il vocabolario di `pointer.loop_unit` (PGE #222).
#
# Prima di #222 la chiave non aveva un insieme dichiarato: il motore testava
# `!= 'normalized'` e ogni altra stringa valeva "assoluto" per esclusione.
# Ora una grafia fuori lista e' InvalidFieldValueError, cioe' un render che
# muore, e la UI la nomina mentre si scrive (`loopUnitError`). Questa lettura
# e' cio' che impedisce a quella lista di diventare una trascrizione: la
# parita' pretende che i due lati coincidano.
#
# Solo AST, e non per gusto: importare `pointer_controller` tira dentro
# `pge.envelopes.envelope` e quindi numpy, che nel job node della CI — dove la
# parita' gira — non esiste.
# ---------------------------------------------------------------------------

def _stub_pointer_controller(root, body, layout="pge"):
    d = {"pge": root / "src" / "pge" / "controllers",
         "flat": root / "src" / "controllers",
         "root": root / "src"}[layout]
    d.mkdir(parents=True, exist_ok=True)
    (d / "pointer_controller.py").write_text(
        "import numpy as np  # mai importato dal parser\n" + body)


def test_engine_loop_units_parses_source(tmp_path):
    import engine_introspect as ei
    _stub_pointer_controller(
        tmp_path, "LOOP_UNITS = ('seconds', 'absolute', 'normalized')\n")
    assert ei.engine_loop_units(tmp_path) == ["seconds", "absolute", "normalized"]


def test_engine_loop_units_keeps_the_order(tmp_path):
    """L'ordine e' significativo: la prima grafia e' la canonica, ed e' quella
    che il selettore dell'Inspector scrive. Un set qui perderebbe proprio il
    dato che il chiamante usa."""
    import engine_introspect as ei
    _stub_pointer_controller(tmp_path, "LOOP_UNITS = ('absolute', 'normalized')\n")
    assert ei.engine_loop_units(tmp_path) == ["absolute", "normalized"]


def test_engine_loop_units_annotated(tmp_path):
    """`LOOP_UNITS: tuple = (...)` e' un AnnAssign: la grafia annotata e' stile
    di casa nel motore, e filtrare su Assign soltanto la renderebbe muta."""
    import engine_introspect as ei
    _stub_pointer_controller(
        tmp_path, "LOOP_UNITS: tuple = ('seconds', 'normalized')\n")
    assert ei.engine_loop_units(tmp_path) == ["seconds", "normalized"]


@pytest.mark.parametrize("layout", ["flat", "root"])
def test_engine_loop_units_older_layouts(tmp_path, layout):
    import engine_introspect as ei
    _stub_pointer_controller(tmp_path, "LOOP_UNITS = ('seconds',)\n", layout=layout)
    assert ei.engine_loop_units(tmp_path) == ["seconds"]


def test_engine_loop_units_missing_is_empty(tmp_path):
    """Un motore piu' vecchio di #222 non ha la costante. `[]` = "non lo so", e
    chi chiama non deve inventarsi un vocabolario."""
    import engine_introspect as ei
    assert ei.engine_loop_units(tmp_path) == []
    _stub_pointer_controller(tmp_path, "SOMETHING_ELSE = 1\n")
    assert ei.engine_loop_units(tmp_path) == []


def test_engine_loop_units_non_literal_is_empty(tmp_path):
    """Il nome c'e' ma non e' una lista di stringhe letterali: la risposta e'
    "non lo so", non una lista mezza letta."""
    import engine_introspect as ei
    _stub_pointer_controller(tmp_path, "LOOP_UNITS = tuple(_UNITS)\n")
    assert ei.engine_loop_units(tmp_path) == []
    _stub_pointer_controller(tmp_path, "LOOP_UNITS = ('seconds', 3)\n")
    assert ei.engine_loop_units(tmp_path) == []


def test_engine_loop_units_sees_a_live_bump(tmp_path):
    """Cache invalidata sull'mtime come le altre letture: il caso e' un `git
    pull` nel repo fratello sotto un `make serve` acceso. Con una cache a vita
    l'editor rifiuterebbe una grafia che il motore ha appena imparato."""
    import os
    import engine_introspect as ei
    _stub_pointer_controller(tmp_path, "LOOP_UNITS = ('seconds', 'normalized')\n")
    assert ei.engine_loop_units(tmp_path) == ["seconds", "normalized"]

    src = tmp_path / "src" / "pge" / "controllers" / "pointer_controller.py"
    src.write_text("LOOP_UNITS = ('seconds', 'absolute', 'normalized')\n")
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
    assert ei.engine_loop_units(tmp_path) == ["seconds", "absolute", "normalized"]
