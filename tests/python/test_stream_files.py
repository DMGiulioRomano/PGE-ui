"""Lo stream come file (#183): il bridge legge i file importati dal master.

Un master (`configs/<nome>.yml`) puo' importare stream con `- file: <path>`
(PGE #290); il path e' relativo alla cartella del master, cioe' `configs/`.
Il browser non tocca il disco, quindi quei file li legge il bridge con
`GET /import?path=<path come scritto nel master>` — sempre sotto
`safe_resolve`, segmento per segmento, e mai fuori da `configs/`.

Qui si fissano tre cose:

- `safe_resolve_rel`, la regola di `safe_resolve` estesa ai path con `/`;
- la rotta: il testo, oppure `ok: false` con un errore che nomina il file —
  l'editor lo mostra accanto alla voce e apre il progetto lo stesso. Un 200,
  non un 4xx: e' un fatto della voce, non una richiesta sbagliata, e un 4xx
  sarebbe un errore nella console del browser per uno stato gestito;
- che un file importato non diventa un progetto: `/projects` elenca solo i
  `.yml` di primo livello, quindi `configs/streams/` resta fuori dall'elenco.
"""

import json
import math
import os
import struct
import wave
from pathlib import Path

import pytest

import audio_pipeline as ap


# ---------------------------------------------------------------------------
# safe_resolve_rel
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel,parts", [
    ("risacca.yml", ("risacca.yml",)),
    ("streams/risacca.yml", ("streams", "risacca.yml")),
    ("streams/mare/onda.yml", ("streams", "mare", "onda.yml")),
    # `./` e la barra doppia non escono dalla cartella: il motore le legge
    # (os.path.join), e rifiutarle sarebbe un falso rosso su YAML valido.
    ("./streams/risacca.yml", ("streams", "risacca.yml")),
    ("streams//risacca.yml", ("streams", "risacca.yml")),
])
def test_safe_resolve_rel_accepts(tmp_path, rel, parts):
    assert ap.safe_resolve_rel(tmp_path, rel) == tmp_path.joinpath(*parts)


@pytest.mark.parametrize("rel", [
    "", ".", "./", "/etc/passwd", "../fuori.yml", "streams/../../fuori.yml",
    "streams/../risacca.yml", "a\\b.yml", ".nascosto/a.yml", "streams/.a.yml",
    "streams/a\x00.yml", None, 3,
])
def test_safe_resolve_rel_rejects(tmp_path, rel):
    assert ap.safe_resolve_rel(tmp_path, rel) is None


# ---------------------------------------------------------------------------
# GET /import
# ---------------------------------------------------------------------------

def _app(tmp_path, workspace=None):
    pytest.importorskip("flask")
    import server
    root = tmp_path / "engine"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text("# stub\n")
    return server.make_app(root, render_timeout=600.0, workspace=workspace)


def _configs(tmp_path, workspace=None):
    return (workspace or (tmp_path / "engine")) / "configs"


RISACCA = "seed: 1441\nstreams:\n  - stream_id: risacca\n    sample: mare.wav\n"


def test_import_reads_a_file_under_configs(tmp_path):
    client = _app(tmp_path).test_client()
    cfg = _configs(tmp_path)
    (cfg / "streams").mkdir()
    (cfg / "streams" / "risacca.yml").write_text(RISACCA, encoding="utf-8")

    r = client.get("/import?path=streams/risacca.yml")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True
    assert body["text"] == RISACCA
    assert body["file"] == "streams/risacca.yml"
    assert body["path"] == str(cfg / "streams" / "risacca.yml")


def test_import_follows_the_workspace(tmp_path):
    ws = tmp_path / "brano"
    ws.mkdir()
    client = _app(tmp_path, workspace=ws).test_client()
    (ws / "configs" / "risacca.yml").write_text(RISACCA, encoding="utf-8")
    r = client.get("/import?path=risacca.yml")
    assert r.status_code == 200 and r.get_json()["text"] == RISACCA


def test_import_missing_names_the_file(tmp_path):
    client = _app(tmp_path).test_client()
    r = client.get("/import?path=streams/manca.yml")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is False and body["reason"] == "missing"
    assert "streams/manca.yml" in body["error"]
    assert "non trovato" in body["error"]


@pytest.mark.parametrize("rel", ["../fuori.yml", "/etc/passwd", "streams/../../x.yml", "."])
def test_import_refuses_a_path_outside_configs(tmp_path, rel):
    client = _app(tmp_path).test_client()
    # Un file vero appena fuori da configs/: rifiutarlo deve dipendere dal
    # path, non dal fatto che non esista.
    (tmp_path / "engine" / "fuori.yml").write_text(RISACCA)
    r = client.get("/import", query_string={"path": rel})
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is False and body["reason"] == "outside"
    assert "text" not in body
    assert "configs" in body["error"] and rel in body["error"]


@pytest.mark.parametrize("qs", ["", "?path="])
def test_import_without_path_is_400(tmp_path, qs):
    r = _app(tmp_path).test_client().get("/import" + qs)
    assert r.status_code == 400 and r.get_json()["ok"] is False


def test_import_of_a_directory_is_an_error_not_a_500(tmp_path):
    client = _app(tmp_path).test_client()
    (_configs(tmp_path) / "streams").mkdir()
    r = client.get("/import?path=streams")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is False and body["reason"] == "not-file"
    assert "streams" in body["error"]


def test_import_not_utf8_is_an_error_not_a_500(tmp_path):
    client = _app(tmp_path).test_client()
    (_configs(tmp_path) / "latin.yml").write_bytes("seed: 1\n# caff\xe8\n".encode("latin-1"))
    r = client.get("/import?path=latin.yml")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is False and body["reason"] == "not-utf8"
    assert "latin.yml" in body["error"]


def test_imported_files_in_a_subfolder_are_not_projects(tmp_path):
    client = _app(tmp_path).test_client()
    cfg = _configs(tmp_path)
    (cfg / "streams").mkdir()
    (cfg / "streams" / "risacca.yml").write_text(RISACCA)
    (cfg / "brano.yml").write_text("streams:\n  - file: streams/risacca.yml\n")
    names = [f["name"] for f in client.get("/projects").get_json()["files"]]
    assert names == ["brano.yml"]


# ---------------------------------------------------------------------------
# Il render di un master con `file:`, col motore vero
# ---------------------------------------------------------------------------
#
# `/render` scrive il master com'e' (con le voci `file:`) in configs/, e gli
# import li risolve il motore, sulla cartella del master. Da qui in poi lo
# stream importato e' uno stream come gli altri: lo stem porta il suo id
# effettivo — il nome del file — e il pallino lo chiude il suo
# `stream-done`, come per uno stream scritto nel master. E il file importato
# non si tocca.
#
# Ha bisogno del venv del motore, come test_engine_render.py: senza, salta.

ENGINE_ROOT = os.path.abspath(os.environ.get("PGE_ENGINE_ROOT") or os.path.join(
    os.path.dirname(__file__), "../../..", "PythonGranularEngine"))
ENGINE_PY = os.path.join(ENGINE_ROOT, ".venv", "bin", "python")
needs_engine = pytest.mark.skipif(
    not (os.path.exists(ENGINE_PY) and os.path.exists(os.path.join(ENGINE_ROOT, "src", "main.py"))),
    reason="PythonGranularEngine venv/main.py not available")


def _tone(path, seconds=3.0, sr=48000):
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = bytearray()
    for i in range(int(seconds * sr)):
        v = 0.3 * math.sin(2 * math.pi * 220 * i / sr)
        frames += struct.pack("<h", int(v * 32767))
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))


LAB_DOC = """seed: 1441
duration: 2
streams:
  - stream_id: stream1
    onset: 0
    duration: 2
    sample: mare.wav
    density: 20
    grain:
      duration: 0.05
"""

MASTER_WITH_FILE = """seed: 1441
duration: 4
streams:
  - file: streams/risacca.yml
    onset: 0.5
"""


def _render(client, yaml_content):
    r = client.post("/render", json={
        "yamlBasename": "brano", "yamlContent": yaml_content,
        "streams": [{"id": "risacca"}], "outputFormat": "wav",
        "renderer": "numpy", "useCache": True, "grainJson": False,
    })
    assert r.status_code == 200, r.get_data(as_text=True)
    return [json.loads(l) for l in r.get_data(as_text=True).splitlines() if l.strip()]


@needs_engine
def test_render_of_a_master_with_file_gives_the_stem_and_its_dot(tmp_path):
    pytest.importorskip("flask")
    import server
    ws = tmp_path / "brano"
    ws.mkdir()
    client = server.make_app(Path(ENGINE_ROOT), render_timeout=600.0, workspace=ws).test_client()
    _tone(ws / "refs" / "mare.wav")
    imported = ws / "configs" / "streams" / "risacca.yml"
    imported.parent.mkdir(parents=True)
    imported.write_text(LAB_DOC, encoding="utf-8")

    events = _render(client, MASTER_WITH_FILE)
    log = "\n".join(e.get("line", "") for e in events if e.get("type") == "log")
    done = [e for e in events if e.get("type") == "done"]
    assert done and done[-1]["ok"] is True, log[-3000:]
    stem = ws / "output" / "brano__risacca.wav"
    assert stem.exists(), log[-3000:]
    ids = [e["streamId"] for e in events if e.get("type") == "stream-done"]
    assert ids == ["risacca"], (ids, log[-3000:])

    # Il master scritto e' quello mandato, voce `file:` compresa; il file
    # importato e' intatto.
    assert (ws / "configs" / "brano.yml").read_text(encoding="utf-8") == MASTER_WITH_FILE
    assert imported.read_text(encoding="utf-8") == LAB_DOC

    # Secondo giro, niente di cambiato: la cache vede lo stream risolto, e il
    # pallino si chiude come cached.
    again = _render(client, MASTER_WITH_FILE)
    cached = [e for e in again if e.get("type") == "stream-done"]
    assert [e["streamId"] for e in cached] == ["risacca"]
    assert cached[0].get("cached") is True, [e for e in again if e.get("type") == "log"][-20:]
