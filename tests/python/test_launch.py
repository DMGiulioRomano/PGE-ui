"""Tests per l'avvio del bridge: quale porta, e il browser (#166).

Il bridge serve l'editor da se' (`GET /` → `PGE Editor.html`), quindi
l'indirizzo dell'editor e' quello del bridge. Qui si prova cio' che succede
fra il `parse_args` e il primo byte servito:

- **la porta.** Un workspace ha un bridge solo: se ce n'e' gia' uno che serve
  questa cartella (con lo stesso motore) non se ne avvia un secondo, si apre
  il browser su quello. Altrimenti, senza `--port`, la prima porta libera da
  7878 in su; con `--port` esplicito e occupato, un messaggio — una
  dichiarazione sbagliata e' un errore, non una ricerca (la regola di
  `--root`, #165). Tutto questo PRIMA del banner e prima di creare cartelle:
  il secondo avvio di oggi stampava `Open in browser` sull'editor del primo
  bridge e fabbricava `configs/ output/ cache/` prima di scoprire la porta
  occupata.
- **il browser.** Si apre dopo il bind, quando la porta accetta connessioni,
  e non si apre con `--no-open` ne' dove non c'e' una sessione grafica.

La decisione sulla porta e' PURA (`plan_port`, sonde iniettate) e si prova
senza toccare la rete. Le sonde vere e il comando intero si provano a parte,
su porte scelte dal kernel: la 7878 e' quella di `make serve` sulla macchina di
chi sviluppa, e un test non la tocca mai in scrittura.
"""

import errno
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import pytest

import server


REPO = Path(__file__).resolve().parents[2]


def _engine(path: Path) -> Path:
    (path / "src").mkdir(parents=True, exist_ok=True)
    (path / "src" / "main.py").write_text("# stub\n")
    return path


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Dove si connette il browser
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("host, url", [
    ("127.0.0.1", "http://127.0.0.1:7878/"),
    # Un bind su tutte le interfacce non e' un indirizzo a cui connettersi:
    # Chrome blocca 0.0.0.0, e `::` non e' una destinazione.
    ("0.0.0.0",   "http://127.0.0.1:7878/"),
    ("",          "http://127.0.0.1:7878/"),
    ("::",        "http://[::1]:7878/"),
    ("::1",       "http://[::1]:7878/"),
    ("localhost", "http://localhost:7878/"),
    ("192.168.1.20", "http://192.168.1.20:7878/"),
])
def test_editor_url(host, url):
    assert server.editor_url(host, 7878) == url


# ---------------------------------------------------------------------------
# Dove si puo' aprire una finestra
# ---------------------------------------------------------------------------

def test_linux_without_display_has_no_window():
    """ssh, container, CI: `webbrowser` ripiegherebbe su lynx/w3m, che si
    prendono il terminale del bridge."""
    assert not server.graphical_session({}, "linux")
    assert not server.graphical_session({"DISPLAY": ""}, "linux")


@pytest.mark.parametrize("env", [
    {"DISPLAY": ":0"},
    {"WAYLAND_DISPLAY": "wayland-0"},
    # Un browser dichiarato vince: e' una scelta di chi lancia.
    {"BROWSER": "/usr/bin/firefox"},
])
def test_linux_with_a_session_or_a_declared_browser(env):
    assert server.graphical_session(env, "linux")


@pytest.mark.parametrize("platform", ["darwin", "win32", "cygwin"])
def test_desktop_platforms_always_have_a_window(platform):
    assert server.graphical_session({}, platform)


def test_browser_plan_says_why_it_does_not_open():
    will, line = server.browser_plan(True, {}, "linux")
    assert not will and "DISPLAY" in line
    will, line = server.browser_plan(False, {"DISPLAY": ":0"}, "linux")
    assert not will and "--no-open" in line
    will, line = server.browser_plan(True, {"DISPLAY": ":0"}, "linux")
    assert will and "--no-open" in line, "la riga dice come spegnerlo"


# ---------------------------------------------------------------------------
# plan_port — la decisione, pura
# ---------------------------------------------------------------------------

BASE = server.DEFAULT_PORT
SPAN = server.PORT_SPAN


def _net(busy, unbindable=None):
    """`busy`: {porta: /health del bridge PGE, oppure None per "qualcos'altro"}.
    `unbindable`: {porta: errno} per un bind che fallisce non per occupazione."""
    unbindable = unbindable or {}

    def bind_error(port):
        if port in unbindable:
            return OSError(unbindable[port], os.strerror(unbindable[port]))
        if port in busy:
            return OSError(errno.EADDRINUSE, "Address already in use")
        return None

    def probe(port):
        return busy.get(port)
    return bind_error, probe


def _health(workspace, root):
    return {"ok": True, "version": "0.1",
            "workspace": str(workspace), "root": str(root)}


def _plan(tmp_path, busy, port=BASE, explicit=False, unbindable=None,
          ws=None, root=None):
    ws = ws or tmp_path / "ws"
    root = root or tmp_path / "engine"
    ws.mkdir(exist_ok=True)
    root.mkdir(exist_ok=True)
    bind_error, probe = _net(busy, unbindable)
    return server.plan_port(port, explicit, ws, root, bind_error, probe)


def test_nothing_busy_serves_the_default(tmp_path):
    plan = _plan(tmp_path, {})
    assert (plan.action, plan.port, plan.passed) == ("serve", BASE, [])


def test_busy_default_moves_to_the_next_free_port(tmp_path):
    other = _health(tmp_path / "altro", tmp_path / "engine")
    plan = _plan(tmp_path, {BASE: other, BASE + 1: None})
    assert (plan.action, plan.port) == ("serve", BASE + 2)
    assert plan.passed == [(BASE, other), (BASE + 1, None)], \
        "il banner dice perche' non e' la 7878"


def test_a_bridge_on_this_workspace_is_reused(tmp_path):
    """Un workspace, un bridge: due bridge sulla stessa cartella scriverebbero
    gli stessi config e gli stessi stem senza sapere l'uno dell'altro."""
    ws, root = tmp_path / "ws", tmp_path / "engine"
    mine = _health(ws, root)
    plan = _plan(tmp_path, {BASE: mine})
    assert (plan.action, plan.port, plan.other) == ("reuse", BASE, mine)


def test_the_scan_sees_this_workspace_above_a_free_port(tmp_path):
    """La 7878 libera non basta: se questo workspace e' gia' servito sulla
    7880 (lanciato quando la 7878 era di un altro), un secondo bridge sulla
    7878 e' proprio il caso da evitare."""
    mine = _health(tmp_path / "ws", tmp_path / "engine")
    plan = _plan(tmp_path, {BASE + 2: mine})
    assert (plan.action, plan.port) == ("reuse", BASE + 2)


def test_an_explicit_port_does_not_start_a_second_bridge_either(tmp_path):
    mine = _health(tmp_path / "ws", tmp_path / "engine")
    plan = _plan(tmp_path, {BASE: mine}, port=9000, explicit=True)
    assert (plan.action, plan.port) == ("reuse", BASE)


def test_same_workspace_other_engine_is_a_conflict(tmp_path):
    other_engine = tmp_path / "engine-2"
    other_engine.mkdir()
    theirs = _health(tmp_path / "ws", other_engine)
    plan = _plan(tmp_path, {BASE: theirs})
    assert (plan.action, plan.port, plan.other) == ("conflict", BASE, theirs)


def test_the_workspace_is_compared_as_a_folder_not_as_a_string(tmp_path):
    ws, root = tmp_path / "ws", tmp_path / "engine"
    ws.mkdir()
    link = tmp_path / "via-link"
    link.symlink_to(ws)
    plan = _plan(tmp_path, {BASE: _health(link, root)}, ws=ws)
    assert plan.action == "reuse"


def test_explicit_free_port_is_served(tmp_path):
    plan = _plan(tmp_path, {}, port=9000, explicit=True)
    assert (plan.action, plan.port) == ("serve", 9000)


def test_explicit_busy_port_is_an_error_not_a_search(tmp_path):
    other = _health(tmp_path / "altro", tmp_path / "engine")
    plan = _plan(tmp_path, {9000: other}, port=9000, explicit=True)
    assert (plan.action, plan.port, plan.other) == ("busy", 9000, other)


def test_every_port_busy_is_exhausted(tmp_path):
    plan = _plan(tmp_path, {p: None for p in range(BASE, BASE + SPAN)})
    assert plan.action == "exhausted"


def test_a_bind_that_fails_for_another_reason_is_named(tmp_path):
    """EACCES su una porta privilegiata non e' "occupata": dirlo occupata
    manderebbe a cercare un altro pge-ui che non c'e'."""
    plan = _plan(tmp_path, {}, port=80, explicit=True,
                 unbindable={80: errno.EACCES})
    assert plan.action == "unbindable" and plan.error.errno == errno.EACCES
    plan = _plan(tmp_path, {}, unbindable={BASE: errno.EADDRNOTAVAIL})
    assert plan.action == "unbindable" and plan.port == BASE


# ---------------------------------------------------------------------------
# I messaggi: dicono cosa e' successo e cosa fare
# ---------------------------------------------------------------------------

def test_busy_message_names_the_other_bridge_and_the_remedy(tmp_path):
    other = _health(tmp_path / "altro", tmp_path / "engine")
    plan = server.PortPlan("busy", 9000, other=other)
    msg = server.port_message(plan, "127.0.0.1", tmp_path / "ws", tmp_path / "engine")
    assert "9000" in msg and "occupata" in msg
    assert str(tmp_path / "altro") in msg, "nomina il workspace dell'altro bridge"
    assert "--port" in msg


def test_busy_message_for_a_stranger(tmp_path):
    plan = server.PortPlan("busy", 9000, other=None)
    msg = server.port_message(plan, "127.0.0.1", tmp_path / "ws", tmp_path / "engine")
    assert "9000" in msg and "--port" in msg and "PGE" in msg


def test_conflict_message_names_both_engines(tmp_path):
    other = _health(tmp_path / "ws", tmp_path / "engine-2")
    plan = server.PortPlan("conflict", BASE, other=other)
    msg = server.port_message(plan, "127.0.0.1", tmp_path / "ws", tmp_path / "engine")
    assert str(tmp_path / "engine-2") in msg and str(tmp_path / "engine") in msg
    assert f"http://127.0.0.1:{BASE}/" in msg


def test_reuse_message_gives_the_address(tmp_path):
    plan = server.PortPlan("reuse", BASE + 1, other=_health(tmp_path, tmp_path))
    msg = server.port_message(plan, "127.0.0.1", tmp_path, tmp_path)
    assert f"http://127.0.0.1:{BASE + 1}/" in msg


def test_passed_ports_are_explained_in_the_banner(tmp_path):
    other = _health(tmp_path / "altro", tmp_path / "engine")
    plan = server.PortPlan("serve", BASE + 2,
                           passed=[(BASE, other), (BASE + 1, None)])
    msg = server.port_message(plan, "127.0.0.1", tmp_path / "ws", tmp_path / "engine")
    assert str(BASE) in msg and str(BASE + 1) in msg
    assert str(tmp_path / "altro") in msg


# ---------------------------------------------------------------------------
# Le sonde vere
# ---------------------------------------------------------------------------

class _Health(http.server.BaseHTTPRequestHandler):
    payload = b"{}"
    ctype = "application/json"

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", self.ctype)
        self.send_header("Content-Length", str(len(self.payload)))
        self.end_headers()
        self.wfile.write(self.payload)

    def log_message(self, *a):
        pass


@pytest.fixture
def fake_bridge():
    """Un /health su una porta del kernel. `serve(payload)` → porta."""
    servers = []

    def serve(payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        handler = type("H", (_Health,), {"payload": body, "ctype": ctype})
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        servers.append(srv)
        return srv.server_address[1]

    yield serve
    for s in servers:
        s.shutdown()
        s.server_close()


def test_bind_error_sees_a_listener():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        port = s.getsockname()[1]
        err = server.bind_error("127.0.0.1", port)
        assert err is not None and err.errno == errno.EADDRINUSE
    assert server.bind_error("127.0.0.1", _free_port()) is None


def test_probe_recognizes_a_pge_bridge(fake_bridge, tmp_path):
    port = fake_bridge(_health(tmp_path, tmp_path))
    info = server.probe_bridge("127.0.0.1", port)
    assert info and info["workspace"] == str(tmp_path)


def test_probe_ignores_the_proxy(fake_bridge, tmp_path, monkeypatch):
    """urllib onora HTTP_PROXY anche verso 127.0.0.1: con un proxy nel
    l'ambiente (container, rete aziendale) la sonda chiederebbe /health al
    proxy e non riconoscerebbe mai un bridge."""
    port = fake_bridge(_health(tmp_path, tmp_path))
    for var in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(var, "http://127.0.0.1:9")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    assert server.probe_bridge("127.0.0.1", port)


@pytest.mark.parametrize("payload", [
    b"<html>un altro server</html>",
    {"ok": True},                          # JSON, ma non la forma del bridge
    ["workspace", "root"],
])
def test_probe_rejects_other_servers(fake_bridge, payload):
    port = fake_bridge(payload)
    assert server.probe_bridge("127.0.0.1", port) is None


def test_probe_of_a_silent_listener_times_out():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        t0 = time.monotonic()
        assert server.probe_bridge("127.0.0.1", s.getsockname()[1],
                                   timeout=0.3) is None
        assert time.monotonic() - t0 < 3


def test_probe_of_nothing_is_none():
    assert server.probe_bridge("127.0.0.1", _free_port()) is None


# ---------------------------------------------------------------------------
# Il processo che apre il browser
# ---------------------------------------------------------------------------

def test_open_browser_detaches_a_child():
    seen = {}

    def fake_popen(argv, **kw):
        seen["argv"], seen["kw"] = argv, kw
        return None

    server.open_browser("http://127.0.0.1:7878/", popen=fake_popen)
    assert seen["argv"][0] == sys.executable
    assert seen["argv"][-1] == "http://127.0.0.1:7878/"
    # Fuori dal gruppo del terminale: un Ctrl-C al bridge non deve portarsi
    # via il browser appena aperto.
    assert seen["kw"].get("start_new_session") is True


@pytest.mark.parametrize("body", [
    "def open(url, *a, **k):\n    return False\n",
    "def open(url, *a, **k):\n    raise RuntimeError('rotto')\n",
])
def test_the_child_exits_zero_even_without_a_browser(tmp_path, body):
    """Il figlio lo raccoglie il master di gunicorn con `waitpid(-1)`, e fino a
    gunicorn 25 un figlio sconosciuto uscito con 3 o 4 veniva letto come un
    worker che non parte: HaltServer, e il bridge si spegne. Quindi il figlio
    esce 0 sempre, e il fallimento lo dice a parole.

    Il `webbrowser` e' uno stub messo davanti alla stdlib con PYTHONPATH: con
    quello vero, su macOS il fallback del modulo aprirebbe il browser di chi
    lancia i test."""
    stub = tmp_path / "stub"
    stub.mkdir()
    (stub / "webbrowser.py").write_text(body)
    env = {**_env(), "PYTHONPATH": str(stub)}
    proc = subprocess.run(
        [sys.executable, "-c", server.BROWSER_CHILD, "http://127.0.0.1:7878/"],
        env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert "http://127.0.0.1:7878/" in proc.stderr


# ---------------------------------------------------------------------------
# Il comando intero
# ---------------------------------------------------------------------------

def _recorder(tmp_path: Path) -> tuple:
    """Un "browser" per $BROWSER: fa la GET che farebbe un browser vero e
    scrive cosa ha ottenuto. E' cosi' che si misura il timing: se l'apertura
    arrivasse prima del bind la GET prenderebbe connection refused."""
    out = tmp_path / "browser.json"
    script = tmp_path / "browser"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, sys, urllib.request\n"
        "url = sys.argv[1]\n"
        "op = urllib.request.build_opener(urllib.request.ProxyHandler({}))\n"
        "try:\n"
        "    with op.open(url, timeout=20) as r:\n"
        "        rec = {'url': url, 'status': r.status,\n"
        "               'head': r.read(4096).decode('utf-8', 'replace')}\n"
        "except Exception as e:\n"
        "    rec = {'url': url, 'status': repr(e), 'head': ''}\n"
        f"open({str(out)!r}, 'w').write(json.dumps(rec))\n")
    script.chmod(0o755)
    return script, out


def _env(**extra):
    env = {k: v for k, v in os.environ.items()
           if k not in (server.ENGINE_ENV_VAR, "BROWSER")}
    env.update(extra)
    return env


def _launch(tmp_path, *args, env=None):
    engine = _engine(tmp_path / "engine")
    ws = tmp_path / "brano"
    ws.mkdir(exist_ok=True)
    proc = subprocess.Popen(
        [sys.executable, str(REPO / "server.py"), "--root", str(engine), *args],
        cwd=ws, env=env or _env(), stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True)
    return proc, ws, engine


def _wait_for(pred, timeout=30.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred():
            return True
        time.sleep(0.1)
    return False


def _stop(proc):
    proc.terminate()
    try:
        out, _ = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
    return out


def _flask_or_skip(out):
    if "Missing deps" in out:
        pytest.skip("flask assente in questo interprete")
    pytest.importorskip("gunicorn")


def test_the_browser_lands_on_a_working_editor(tmp_path):
    script, rec = _recorder(tmp_path)
    port = _free_port()
    proc, _, _ = _launch(tmp_path, "--port", str(port),
                         env=_env(BROWSER=str(script)))
    try:
        opened = _wait_for(rec.exists)
    finally:
        out = _stop(proc)
    _flask_or_skip(out)
    assert opened, f"nessun browser aperto\n{out}"
    got = json.loads(rec.read_text())
    assert got["url"] == f"http://127.0.0.1:{port}/"
    assert got["status"] == 200, got
    assert "PGE" in got["head"], "e' l'editor, non una pagina qualunque"


def test_no_open_opens_nothing(tmp_path):
    script, rec = _recorder(tmp_path)
    port = _free_port()
    proc, _, _ = _launch(tmp_path, "--port", str(port), "--no-open",
                         env=_env(BROWSER=str(script)))
    try:
        up = _wait_for(lambda: server.probe_bridge("127.0.0.1", port) is not None)
        # L'apertura parte dal bind, prima che /health risponda: se dovesse
        # arrivare, arriverebbe entro questa finestra — il test positivo qui
        # sopra la misura nello stesso modo.
        time.sleep(2.0)
    finally:
        out = _stop(proc)
    _flask_or_skip(out)
    assert up, out
    assert not rec.exists(), "--no-open ha aperto il browser"
    assert "--no-open" in out


def test_explicit_busy_port_explains_and_creates_nothing(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        port = s.getsockname()[1]
        proc, ws, _ = _launch(tmp_path, "--port", str(port), "--no-open")
        out = proc.communicate(timeout=60)[0]
    _flask_or_skip(out)
    assert proc.returncode != 0
    assert "Traceback" not in out, out
    assert str(port) in out and "--port" in out
    assert "Connection in use" not in out, "il messaggio arriva prima di gunicorn"
    assert not (ws / "configs").exists(), \
        "un avvio che non parte non fabbrica le cartelle di lavoro"


def test_a_bridge_on_this_workspace_is_reused_not_doubled(tmp_path, fake_bridge):
    script, rec = _recorder(tmp_path)
    engine = _engine(tmp_path / "engine")
    ws = tmp_path / "brano"
    ws.mkdir()
    port = fake_bridge(_health(ws.resolve(), engine.resolve()))
    proc, _, _ = _launch(tmp_path, "--port", str(port),
                         env=_env(BROWSER=str(script)))
    out = proc.communicate(timeout=60)[0]
    _flask_or_skip(out)
    assert proc.returncode == 0, out
    assert f"http://127.0.0.1:{port}/" in out
    assert not (ws / "configs").exists()
    assert _wait_for(rec.exists, 20), "il browser si apre sul bridge che c'e'"
    assert json.loads(rec.read_text())["url"] == f"http://127.0.0.1:{port}/"


def test_same_workspace_other_engine_refuses(tmp_path, fake_bridge):
    ws = tmp_path / "brano"
    ws.mkdir()
    other = _engine(tmp_path / "engine-2")
    port = fake_bridge(_health(ws.resolve(), other.resolve()))
    proc, _, engine = _launch(tmp_path, "--port", str(port), "--no-open")
    out = proc.communicate(timeout=60)[0]
    _flask_or_skip(out)
    assert proc.returncode != 0
    assert "Traceback" not in out, out
    assert str(other.resolve()) in out and str(engine.resolve()) in out


def test_the_serving_path_opens_only_from_when_ready():
    """Il test qui sopra misura il timing, ma una corsa la vince quasi
    sempre: un `open_browser(url)` scritto prima di `.run()` partirebbe
    qualche decina di millisecondi prima del bind, e di solito arriverebbe
    tardi abbastanza. Quindi la struttura si guarda anche da qui: in `main()`
    `open_browser` si chiama soltanto dentro la lambda di
    `options["when_ready"]` (dopo il bind) o nel ramo del riuso (dove la porta
    e' di un bridge che ascolta gia')."""
    import ast
    tree = ast.parse((REPO / "server.py").read_text())
    main = next(n for n in tree.body
                if isinstance(n, ast.FunctionDef) and n.name == "main")
    parent = {}
    for node in ast.walk(main):
        for child in ast.iter_child_nodes(node):
            parent[child] = node

    def allowed(call):
        node = call
        while node in parent:
            up = parent[node]
            if (isinstance(node, ast.Lambda) and isinstance(up, ast.Assign)
                    and any(isinstance(t, ast.Subscript)
                            and isinstance(t.slice, ast.Constant)
                            and t.slice.value == "when_ready"
                            for t in up.targets)):
                return True
            if isinstance(up, ast.If) and node in up.body and "reuse" in ast.unparse(up.test):
                return True
            node = up
        return False

    calls = [n for n in ast.walk(main) if isinstance(n, ast.Call)
             and getattr(n.func, "id", None) == "open_browser"]
    assert calls, "main() non apre piu' il browser da nessuna parte"
    bad = [ast.unparse(c) for c in calls if not allowed(c)]
    assert not bad, f"open_browser fuori da when_ready e dal riuso: {bad}"
