"""render_pipeline.py — render orchestration for the PGE bridge.

Extracted from server.py (#43): stdout→NDJSON parsing, the single-render state
(spawn / cancel, serialized by a lock), command construction, and a process
watchdog. No Flask here — the /render and /render/cancel routes in server.py
own the HTTP/NDJSON concerns and delegate process mechanics to this module.
"""

import re
import subprocess
import threading


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
_RE_CACHE_LINE = re.compile(r"^\[CACHE\]\s+(\S+):\s+(.+)$")
# Matches absolute path ending in __<streamId>.<aif|wav|flac>
_RE_STEM_PATH  = re.compile(r"^\s+.+__(\w+)\.(aif|aiff|wav|flac)\s*$", re.IGNORECASE)


def parse_render_line(line: str, state: dict) -> list:
    """Turn a single stdout line into one or more browser-bound events."""
    events = [{"type": "log", "line": line}]

    # [CACHE] stream1: clean  → cached, emit start+done immediately
    # [CACHE] stream1: DIRTY  → about to render, emit start only
    m = _RE_CACHE_LINE.match(line)
    if m:
        sid   = m.group(1)
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
        if prev:
            sid = m2.group(1)
            if sid == prev:
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

    def clear(self):
        with self.lock:
            self.proc = None


def build_render_command(venv_py, root, yml, output_stem, *, renderer, use_cache,
                         cache, visualize, page_duration, reaper, basename,
                         refs, output, fmt) -> list:
    """Build the `python src/main.py …` argv. Pure (no spawning) so it is unit
    testable. `--show-static` is appended only with `--visualize` — it has no
    effect otherwise (engine docs/reference/cli.md). #43"""
    cmd = [
        str(venv_py), str(root / "src" / "main.py"),
        str(yml), str(output_stem),
        "--renderer", renderer,
        "--per-stream",
        "--format", fmt,
    ]
    if use_cache:
        cmd += ["--cache", "--cache-dir", str(cache)]
    if visualize:
        cmd += ["--visualize", "--show-static"]
        if page_duration is not None and float(page_duration) != 15.0:
            cmd += ["--page-duration", str(float(page_duration))]
    if reaper:
        cmd += ["--reaper", "--reaper-path", str(output / f"{basename}.rpp")]
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
