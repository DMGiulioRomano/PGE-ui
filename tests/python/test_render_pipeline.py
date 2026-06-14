"""Tests for render_pipeline.py — the stdout→NDJSON parser, command builder,
and process watchdog extracted from server.py (#43), plus a Flask smoke test
that the split didn't break route registration (#46).

These don't need the engine repo (no main.py is spawned). The kill/watchdog
tests spawn a short-lived python sleeper. Run: pytest tests/python/ -v
"""

import subprocess
import sys
import time
from pathlib import Path

import pytest

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


def test_engine_envelope_keys_parses_source_in_order(tmp_path):
    import server
    _stub_score_visualizer(tmp_path)
    assert server.engine_envelope_keys(tmp_path) == ["volume", "pan", "pitch"]


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
