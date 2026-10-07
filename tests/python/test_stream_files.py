"""Lo stream come file, lato bridge (PGE-ui #183, #184).

Un master puo' importare stream da altri file (`- file: streams/risacca.yml`,
PythonGranularEngine#290). Il path e' relativo alla cartella del master, cioe'
`configs/`. Il browser non tocca il disco: i file importati li legge e li
scrive il bridge, e per la prima volta il bridge scrive file che non sono
`configs/<basename>.yml`.

Quello che si pretende qui e' il confine di fiducia di quelle scritture:

- un path importato passa da `safe_resolve` segmento per segmento
  (`safe_resolve_import`): niente traversal, niente path assoluti, niente
  file nascosti, solo `.yml`/`.yaml`, sempre sotto `configs/`;
- `/save` e `/render` validano TUTTO prima di scrivere QUALCOSA: un path
  cattivo fra gli import e il master non si tocca nemmeno;
- prima del render i file importati modificati sono gia' su disco: il motore
  li rilegge da li';
- un file in `configs/streams/` non e' un progetto.
"""

import json
from pathlib import Path

import pytest


def _root(tmp_path, fake_python=False, probe=None):
    """Una root minima per make_app. Con `fake_python` anche un finto
    `.venv/bin/python`; con `probe` quel python stampa `IMPORT_PRESENTE` se il
    file `probe` (relativo alla cwd del sottoprocesso, cioe' root) esiste nel
    momento in cui il "motore" parte."""
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    for d in ("configs", "refs", "output", "cache"):
        (tmp_path / d).mkdir(exist_ok=True)
    if fake_python:
        vb = tmp_path / ".venv" / "bin"
        vb.mkdir(parents=True, exist_ok=True)
        py = vb / "python"
        check = (f'if [ -f "{probe}" ]; then echo IMPORT_PRESENTE; '
                 f'else echo IMPORT_ASSENTE; fi\n') if probe else ""
        py.write_text("#!/bin/sh\n" + check + "exit 0\n")
        py.chmod(0o755)
    return tmp_path


def _client(root):
    import server
    return server.make_app(root, render_timeout=600.0).test_client()


def _tree(root):
    """Ogni file sotto root, col contenuto: per dire "non e' cambiato niente"."""
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


# ---------------------------------------------------------------------------
# safe_resolve_import
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rel", [
    "risacca.yml", "streams/risacca.yml", "a/b/c.yaml", "streams/risacca-2.yml",
    "streams/RISACCA.YML",
])
def test_safe_resolve_import_accepts_config_paths(tmp_path, rel):
    from audio_pipeline import safe_resolve_import
    p = safe_resolve_import(tmp_path, rel)
    assert p == tmp_path / rel


@pytest.mark.parametrize("rel", [
    "",                       # vuoto
    "/etc/x.yml",             # assoluto
    "../x.yml",               # traversal
    "streams/../../x.yml",    # traversal in mezzo
    "streams/..",             # la cartella sopra
    "a\\b.yml",               # separatore di Windows
    ".hidden/x.yml",          # cartella nascosta
    "streams/.x.yml",         # file nascosto
    "streams//x.yml",         # segmento vuoto
    "streams/",               # niente nome
    "x.txt",                  # non e' un documento YAML
    "x",                      # nemmeno
    "streams/x.yml\x00",      # NUL
    None, 3, ["x.yml"],       # non e' un path
])
def test_safe_resolve_import_rejects(tmp_path, rel):
    from audio_pipeline import safe_resolve_import
    assert safe_resolve_import(tmp_path, rel) is None


# ---------------------------------------------------------------------------
# GET /import
# ---------------------------------------------------------------------------

def test_import_reads_a_file_under_configs(tmp_path):
    root = _root(tmp_path)
    (root / "configs" / "streams").mkdir()
    (root / "configs" / "streams" / "risacca.yml").write_text("streams:\n- stream_id: r\n")
    body = _client(root).get("/import?file=streams/risacca.yml").get_json()
    assert body["ok"] is True
    assert body["text"] == "streams:\n- stream_id: r\n"
    assert body["file"] == "streams/risacca.yml"


def test_import_missing_names_the_file(tmp_path):
    root = _root(tmp_path)
    r = _client(root).get("/import?file=streams/nessuno.yml")
    assert r.status_code == 404
    body = r.get_json()
    assert body["ok"] is False and "streams/nessuno.yml" in body["error"]


@pytest.mark.parametrize("rel", ["../segreto.yml", "/etc/passwd", "streams/../../segreto.yml", "x.txt"])
def test_import_refuses_paths_outside_configs(tmp_path, rel):
    root = _root(tmp_path)
    (root / "segreto.yml").write_text("streams: []\n")
    r = _client(root).get("/import", query_string={"file": rel})
    assert r.status_code == 400
    body = r.get_json()
    assert body["ok"] is False and "text" not in body


def test_import_undecodable_file_is_a_message(tmp_path):
    root = _root(tmp_path)
    (root / "configs" / "rotto.yml").write_bytes(b"\xff\xfe\x00streams")
    r = _client(root).get("/import?file=rotto.yml")
    assert r.status_code == 422
    body = r.get_json()
    assert body["ok"] is False and "rotto.yml" in body["error"]


def test_a_file_in_a_subfolder_is_not_a_project(tmp_path):
    """La lista dei progetti e' quella di prima: i .yml direttamente in
    configs/. Un documento del laboratorio in configs/streams/ si importa,
    non si apre come brano."""
    root = _root(tmp_path)
    (root / "configs" / "brano.yml").write_text("streams: []\n")
    (root / "configs" / "streams").mkdir()
    (root / "configs" / "streams" / "risacca.yml").write_text("streams: []\n")
    names = [f["name"] for f in _client(root).get("/projects").get_json()["files"]]
    assert names == ["brano.yml"]


# ---------------------------------------------------------------------------
# POST /save
# ---------------------------------------------------------------------------

def test_save_writes_master_and_imports(tmp_path):
    root = _root(tmp_path)
    (root / "configs" / "streams").mkdir()
    r = _client(root).post("/save", json={
        "basename": "brano",
        "yamlContent": "streams:\n  - file: streams/risacca.yml\n",
        "imports": {"streams/risacca.yml": "streams:\n- stream_id: risacca\n"},
    })
    assert r.status_code == 200, r.get_data(as_text=True)
    body = r.get_json()
    assert body["ok"] is True
    assert (root / "configs" / "brano.yml").read_text() == "streams:\n  - file: streams/risacca.yml\n"
    assert (root / "configs" / "streams" / "risacca.yml").read_text() == "streams:\n- stream_id: risacca\n"
    assert sorted(body["written"]) == ["brano.yml", "streams/risacca.yml"]


def test_save_without_imports_writes_only_the_master(tmp_path):
    """"Il salvataggio scrive solo i file che sono cambiati": il browser manda
    solo quelli, e il bridge non ne inventa altri."""
    root = _root(tmp_path)
    (root / "configs" / "streams").mkdir()
    keep = root / "configs" / "streams" / "risacca.yml"
    keep.write_text("# del laboratorio\nstreams:\n- stream_id: risacca\n")
    r = _client(root).post("/save", json={"basename": "brano", "yamlContent": "x: 1\n"})
    assert r.status_code == 200
    assert r.get_json()["written"] == ["brano.yml"]
    assert keep.read_text() == "# del laboratorio\nstreams:\n- stream_id: risacca\n"


def test_save_creates_the_subfolder_under_configs(tmp_path):
    root = _root(tmp_path)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": "x: 1\n",
        "imports": {"streams/nuovo.yml": "streams: []\n"}})
    assert r.status_code == 200
    assert (root / "configs" / "streams" / "nuovo.yml").exists()


@pytest.mark.parametrize("imports", [
    {"../fuori.yml": "x"},
    {"/tmp/fuori.yml": "x"},
    {"streams/../../fuori.yml": "x"},
    {"streams/x.txt": "x"},
    {"streams/ok.yml": 3},            # il testo non e' una stringa
    {"brano.yml": "x"},               # il master stesso, da un'altra porta
    ["streams/ok.yml"],               # non e' una mappa
])
def test_save_validates_everything_before_writing_anything(tmp_path, imports):
    root = _root(tmp_path)
    before = _tree(root)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": "streams: []\n",
        "imports": {"streams/buono.yml": "streams: []\n", **imports}
        if isinstance(imports, dict) else imports})
    assert r.status_code == 400, r.get_data(as_text=True)
    assert r.get_json()["ok"] is False
    assert _tree(root) == before                  # nemmeno il master, nemmeno il buono
    assert not (tmp_path.parent / "fuori.yml").exists()


@pytest.mark.parametrize("basename", ["../evil", "a/b", ".hidden", "", None])
def test_save_rejects_bad_basename(tmp_path, basename):
    root = _root(tmp_path)
    before = _tree(root)
    r = _client(root).post("/save", json={"basename": basename, "yamlContent": "x: 1\n"})
    assert r.status_code == 400
    assert _tree(root) == before


def test_save_needs_the_master_text(tmp_path):
    root = _root(tmp_path)
    r = _client(root).post("/save", json={"basename": "brano"})
    assert r.status_code == 400
    assert not (root / "configs" / "brano.yml").exists()


# ---------------------------------------------------------------------------
# POST /render
# ---------------------------------------------------------------------------

def _ndjson(r):
    return [json.loads(x) for x in r.get_data(as_text=True).splitlines() if x.strip()]


def test_render_writes_the_imports_before_the_engine_starts(tmp_path):
    """Il motore rilegge gli import dal disco: quando parte, il file modificato
    deve essere gia' li'. Il finto python lo controlla nel momento in cui
    viene lanciato."""
    root = _root(tmp_path, fake_python=True, probe="configs/streams/risacca.yml")
    r = _client(root).post("/render", json={
        "yamlBasename": "brano",
        "yamlContent": "streams:\n  - file: streams/risacca.yml\n",
        "imports": {"streams/risacca.yml": "streams:\n- stream_id: risacca\n"},
    })
    assert r.status_code == 200
    lines = [e.get("line", "") for e in _ndjson(r) if e.get("type") == "log"]
    assert any("IMPORT_PRESENTE" in x for x in lines), lines
    assert (root / "configs" / "streams" / "risacca.yml").read_text() == "streams:\n- stream_id: risacca\n"


def test_render_control_the_probe_sees_an_absent_file(tmp_path):
    """Controprova della sonda qui sopra: senza `imports` il file non c'e', e la
    sonda deve dirlo — altrimenti il test sopra sarebbe verde anche se il
    finto motore non guardasse niente."""
    root = _root(tmp_path, fake_python=True, probe="configs/streams/risacca.yml")
    r = _client(root).post("/render", json={
        "yamlBasename": "brano", "yamlContent": "streams: []\n"})
    lines = [e.get("line", "") for e in _ndjson(r) if e.get("type") == "log"]
    assert any("IMPORT_ASSENTE" in x for x in lines), lines


@pytest.mark.parametrize("imports", [
    {"../fuori.yml": "x"},
    {"streams/x.txt": "x"},
    {"brano.yml": "x"},
    {"streams/ok.yml": None},
])
def test_render_refuses_a_bad_import_before_writing(tmp_path, imports):
    root = _root(tmp_path, fake_python=True)
    before = _tree(root)
    r = _client(root).post("/render", json={
        "yamlBasename": "brano", "yamlContent": "streams: []\n", "imports": imports})
    assert r.status_code == 400
    assert r.get_json()["ok"] is False
    assert _tree(root) == before
    assert not (tmp_path.parent / "fuori.yml").exists()


def test_render_follows_the_workspace(tmp_path):
    """Gli import stanno sotto la cartella del master, e la cartella del master
    e' quella del workspace: non quella del motore."""
    import server
    root = _root(tmp_path / "engine", fake_python=True)
    ws = tmp_path / "brani"
    ws.mkdir()
    client = server.make_app(root, render_timeout=600.0, workspace=ws).test_client()
    r = client.post("/render", json={
        "yamlBasename": "brano", "yamlContent": "streams: []\n",
        "imports": {"streams/risacca.yml": "streams: []\n"}})
    assert r.status_code == 200
    r.get_data()
    assert (ws / "configs" / "streams" / "risacca.yml").exists()
    assert not (root / "configs" / "streams").exists()
