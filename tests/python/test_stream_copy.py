"""Duplicare uno stream importato crea un file nuovo, lato bridge (PGE-ui #186).

La copia di uno stream importato con `- file: streams/risacca.yml` e' un file
NUOVO accanto all'originale (`streams/<id>.yml`), e il browser lo scrive al
salvataggio o prima del render come ogni file importato cambiato. Due cose
servono dal bridge, e si pretendono qui:

- **sapere quali nomi sono gia' presi**: il browser sceglie il nome della
  copia, e un nome che sul disco c'e' gia' non va scelto. `GET /import-dir`
  elenca i documenti YAML di una cartella sotto `configs/`, con lo stesso
  confine di `GET /import` (niente traversal, niente cartelle nascoste);
- **non sovrascrivere mai un file esistente**: la copia nasce nel browser e il
  disco puo' cambiare fra l'incolla e il salvataggio (il laboratorio salva un
  file con quel nome). I file nuovi viaggiano in `createImports`, e se uno di
  loro esiste gia' la richiesta e' rifiutata — 409 con `exists`, un campo e
  non un errore da riconoscere dal testo — PRIMA di scrivere qualunque file,
  master compreso, come ogni altro rifiuto di `/save` e `/render`. E alla
  scrittura il file nuovo si apre in creazione esclusiva: la finestra fra il
  controllo e la scrittura non diventa una sovrascrittura.
"""

import json

import pytest


def _root(tmp_path, fake_python=False):
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    for d in ("configs", "refs", "output", "cache"):
        (tmp_path / d).mkdir(exist_ok=True)
    if fake_python:
        vb = tmp_path / ".venv" / "bin"
        vb.mkdir(parents=True, exist_ok=True)
        py = vb / "python"
        py.write_text("#!/bin/sh\necho MOTORE_PARTITO\nexit 0\n")
        py.chmod(0o755)
    return tmp_path


def _client(root):
    import server
    return server.make_app(root, render_timeout=600.0).test_client()


def _tree(root):
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


# ---------------------------------------------------------------------------
# GET /import-dir
# ---------------------------------------------------------------------------

def test_import_dir_lists_the_yaml_documents_of_a_folder(tmp_path):
    root = _root(tmp_path)
    s = root / "configs" / "streams"
    s.mkdir()
    (s / "risacca.yml").write_text("streams: []\n")
    (s / "Onda.YAML").write_text("streams: []\n")
    (s / "note.txt").write_text("x\n")
    (s / ".nascosto.yml").write_text("x\n")
    (s / "sotto").mkdir()
    (s / "sotto" / "dentro.yml").write_text("x\n")
    body = _client(root).get("/import-dir?dir=streams").get_json()
    assert body["ok"] is True and body["dir"] == "streams"
    # Solo i documenti YAML di QUELLA cartella: non i file d'altro tipo, non
    # quelli nascosti (che il bridge non legge ne' scrive), non le sottocartelle.
    assert body["files"] == ["Onda.YAML", "risacca.yml"]


def test_import_dir_top_of_configs(tmp_path):
    root = _root(tmp_path)
    (root / "configs" / "brano.yml").write_text("streams: []\n")
    (root / "configs" / "streams").mkdir()
    body = _client(root).get("/import-dir?dir=").get_json()
    assert body["ok"] is True and body["files"] == ["brano.yml"]
    assert _client(root).get("/import-dir").get_json()["files"] == ["brano.yml"]


def test_import_dir_a_missing_folder_is_empty(tmp_path):
    """La cartella nasce alla prima scrittura (`write_import_plan` la crea):
    finche' non c'e', nessun nome e' preso."""
    root = _root(tmp_path)
    body = _client(root).get("/import-dir?dir=streams/nuova").get_json()
    assert body == {"ok": True, "dir": "streams/nuova", "files": []}


def test_import_dir_a_file_is_not_a_folder(tmp_path):
    root = _root(tmp_path)
    (root / "configs" / "streams").write_text("non sono una cartella\n")
    body = _client(root).get("/import-dir?dir=streams").get_json()
    assert body["ok"] is True and body["files"] == []


@pytest.mark.parametrize("rel", ["..", "../fuori", "/etc", "streams/../..", ".nascosta", "a//b", "a\\b",
                                 "streams/\x00", "streams/"])
def test_import_dir_refuses_paths_outside_configs(tmp_path, rel):
    root = _root(tmp_path)
    (tmp_path.parent / "fuori").mkdir(exist_ok=True)
    r = _client(root).get("/import-dir", query_string={"dir": rel})
    assert r.status_code == 400
    body = r.get_json()
    assert body["ok"] is False and "files" not in body


# ---------------------------------------------------------------------------
# createImports su POST /save
# ---------------------------------------------------------------------------

MASTER = "streams:\n  - file: streams/risacca.yml\n  - file: streams/stream3.yml\n"


def _with_original(root):
    s = root / "configs" / "streams"
    s.mkdir(exist_ok=True)
    (s / "risacca.yml").write_text("streams:\n- stream_id: risacca\n")
    (root / "configs" / "brano.yml").write_text("streams:\n  - file: streams/risacca.yml\n")


def test_save_creates_a_new_file(tmp_path):
    root = _root(tmp_path)
    _with_original(root)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": MASTER,
        "imports": {"streams/stream3.yml": "streams:\n- stream_id: stream3\n"},
        "createImports": ["streams/stream3.yml"]})
    assert r.status_code == 200, r.get_data(as_text=True)
    assert (root / "configs" / "streams" / "stream3.yml").read_text() == "streams:\n- stream_id: stream3\n"
    assert (root / "configs" / "brano.yml").read_text() == MASTER


def test_save_never_overwrites_an_existing_file(tmp_path):
    """Il file nuovo c'e' gia' (l'ha salvato il laboratorio nel frattempo):
    niente si scrive, ne' lui ne' il master ne' gli altri import della
    richiesta, e il rifiuto lo nomina."""
    root = _root(tmp_path)
    _with_original(root)
    (root / "configs" / "streams" / "stream3.yml").write_text("# del laboratorio\nstreams: []\n")
    before = _tree(root)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": MASTER,
        "imports": {"streams/risacca.yml": "streams:\n- stream_id: risacca\n  volume: -3\n",
                    "streams/stream3.yml": "streams:\n- stream_id: stream3\n"},
        "createImports": ["streams/stream3.yml"]})
    assert r.status_code == 409
    body = r.get_json()
    assert body["ok"] is False and body["exists"] is True and body["files"] == ["streams/stream3.yml"]
    assert "changed" not in body                  # non e' il rifiuto di #185
    assert "streams/stream3.yml" in body["error"]
    assert _tree(root) == before


def test_save_existing_file_without_create_is_a_plain_write(tmp_path):
    """Senza `createImports` un file importato si riscrive come sempre: e' il
    file di uno stream gia' letto, o gia' scritto da questo editor."""
    root = _root(tmp_path)
    _with_original(root)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": MASTER,
        "imports": {"streams/risacca.yml": "streams:\n- stream_id: risacca\n  volume: -3\n"}})
    assert r.status_code == 200
    assert "volume" in (root / "configs" / "streams" / "risacca.yml").read_text()


@pytest.mark.parametrize("create", [
    "streams/stream3.yml",               # non e' una lista
    [3],                                 # non e' un path
    ["streams/altro.yml"],               # non e' fra gli import della richiesta
])
def test_save_validates_create_before_writing(tmp_path, create):
    root = _root(tmp_path)
    _with_original(root)
    before = _tree(root)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": MASTER,
        "imports": {"streams/stream3.yml": "streams: []\n"},
        "createImports": create})
    assert r.status_code == 400, r.get_data(as_text=True)
    assert r.get_json()["ok"] is False
    assert _tree(root) == before


def test_save_existing_check_comes_before_the_master_guard(tmp_path):
    """Un rifiuto e' un disco intatto, qualunque sia: anche con una firma
    letta che sul disco non torna, il file nuovo che c'e' gia' si dice prima
    di decidere sul master, e niente si scrive."""
    root = _root(tmp_path)
    _with_original(root)
    (root / "configs" / "streams" / "stream3.yml").write_text("streams: []\n")
    before = _tree(root)
    r = _client(root).post("/save", json={
        "basename": "brano", "yamlContent": MASTER, "signature": "sha256:altro",
        "imports": {"streams/stream3.yml": "streams:\n- stream_id: stream3\n"},
        "createImports": ["streams/stream3.yml"]})
    assert r.status_code == 409 and r.get_json().get("exists") is True
    assert _tree(root) == before


# ---------------------------------------------------------------------------
# createImports su POST /render
# ---------------------------------------------------------------------------

def _ndjson(r):
    return [json.loads(x) for x in r.get_data(as_text=True).splitlines() if x.strip()]


def test_render_creates_the_new_file_before_the_engine(tmp_path):
    root = _root(tmp_path, fake_python=True)
    _with_original(root)
    r = _client(root).post("/render", json={
        "yamlBasename": "brano", "yamlContent": MASTER,
        "imports": {"streams/stream3.yml": "streams:\n- stream_id: stream3\n"},
        "createImports": ["streams/stream3.yml"]})
    assert r.status_code == 200
    _ndjson(r)
    assert (root / "configs" / "streams" / "stream3.yml").read_text() == "streams:\n- stream_id: stream3\n"


def test_render_never_overwrites_an_existing_file(tmp_path):
    root = _root(tmp_path, fake_python=True)
    _with_original(root)
    (root / "configs" / "streams" / "stream3.yml").write_text("# del laboratorio\nstreams: []\n")
    before = _tree(root)
    r = _client(root).post("/render", json={
        "yamlBasename": "brano", "yamlContent": MASTER,
        "imports": {"streams/stream3.yml": "streams:\n- stream_id: stream3\n"},
        "createImports": ["streams/stream3.yml"]})
    assert r.status_code == 409
    body = r.get_json()
    assert body["ok"] is False and body["exists"] is True and body["files"] == ["streams/stream3.yml"]
    # Un JSON e non uno stream: il motore non e' partito.
    assert "MOTORE_PARTITO" not in r.get_data(as_text=True)
    assert _tree(root) == before


def test_render_validates_create(tmp_path):
    root = _root(tmp_path, fake_python=True)
    before = _tree(root)
    r = _client(root).post("/render", json={
        "yamlBasename": "brano", "yamlContent": "streams: []\n",
        "imports": {}, "createImports": ["streams/stream3.yml"]})
    assert r.status_code == 400
    assert _tree(root) == before


# ---------------------------------------------------------------------------
# La scrittura: creazione esclusiva
# ---------------------------------------------------------------------------

def test_write_import_plan_creates_exclusively(tmp_path):
    """Il controllo precede la scrittura, e fra i due il disco puo' cambiare.
    In quella finestra un file nuovo comparso non si sovrascrive: la scrittura
    fallisce (un OSError, che le route rendono JSON) e il file resta quello
    dell'altro."""
    from server import write_import_plan
    target = tmp_path / "streams" / "stream3.yml"
    target.parent.mkdir()
    target.write_text("# del laboratorio\n")
    plan = [("streams/stream3.yml", target, "streams: []\n")]
    with pytest.raises(FileExistsError):
        write_import_plan(plan, creates={"streams/stream3.yml"})
    assert target.read_text() == "# del laboratorio\n"
    # Senza `creates` lo stesso piano e' una riscrittura qualunque.
    write_import_plan(plan)
    assert target.read_text() == "streams: []\n"


def test_write_import_plan_creates_a_new_file_and_its_folder(tmp_path):
    from server import write_import_plan
    target = tmp_path / "streams" / "nuova" / "stream3.yml"
    assert write_import_plan([("streams/nuova/stream3.yml", target, "a: 1\n")],
                             creates={"streams/nuova/stream3.yml"}) == ["streams/nuova/stream3.yml"]
    assert target.read_text() == "a: 1\n"
