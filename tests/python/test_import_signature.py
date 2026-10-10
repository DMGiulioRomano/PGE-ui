"""Due editor, un file, anche per i file importati (#185, regola 7 del piano
di mare-nostrum, sugli stream come file di #184).

Il caso tipico del piano e' proprio questo: lo stesso `streams/risacca.yml`
aperto nel laboratorio e in PGE-ui. La guardia guardava solo il master, quindi
il primo salvataggio di PGE-ui che toccava quello stream si portava via, in
silenzio, cio' che il laboratorio aveva scritto nel frattempo.

Le regole sono quelle del master (`file_signature.py`), file per file:

- `GET /import` porta la firma dei byte che manda, da una lettura sola;
- `POST /save` e `POST /render` ricevono `importSignatures` ({path: firma}),
  la firma letta di OGNI file importato del documento, e `overwriteImports`
  (i file che l'utente ha detto di sovrascrivere);
- un file importato da scrivere passa dai tre passi di `write_guarded`: gia'
  su disco -> non si scrive; cambiato e senza sovrascrittura -> rifiuto;
  altrimenti si scrive e torna la firma nuova;
- un file importato che la richiesta NON scrive, ma che l'editor ha letto, e'
  cambiato se su disco non e' piu' quello letto: l'editor ha davanti una
  versione vecchia, e il render suonerebbe quella del disco col pallino di
  quella vecchia. E' un rifiuto come gli altri: l'editor rilegge o chiede;
- il verdetto si decide per TUTTI i file prima di scriverne uno, e il 409
  li elenca tutti (`files`), il master per primo;
- un file nuovo (`createImports`, #186) non ha una lettura da rispettare.
"""

import json

import pytest

import file_signature as fsig


MASTER = "a.yml"
MASTER_DOC = "duration: 4\nstreams:\n  - file: streams/onda.yml\n    onset: 1\n"
IMPORTED = "streams/onda.yml"
IMPORTED_DOC = "seed: 1441\nstreams:\n  - stream_id: onda\n    duration: 2\n    volume: -3\n"
# Lo stesso documento come lo scriverebbe il laboratorio: un commento suo,
# un'altra formattazione. Byte diversi, documento identico.
IMPORTED_OTHER_SPELLING = (
    "# scritto dal laboratorio\n"
    "seed: 1441\n"
    "streams: [{stream_id: onda, duration: 2, volume: -3}]\n"
)
IMPORTED_BY_THE_LAB = IMPORTED_DOC.replace("volume: -3", "volume: -1")
IMPORTED_BY_PGEUI = IMPORTED_DOC.replace("duration: 2", "duration: 3")


def _root(tmp_path, fake_python=False):
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
    (tmp_path / "configs" / MASTER).write_text(MASTER_DOC)
    (tmp_path / "configs" / "streams").mkdir()
    (tmp_path / "configs" / IMPORTED).write_text(IMPORTED_DOC)
    return tmp_path


def _client(root):
    import server
    return server.make_app(root, render_timeout=600.0).test_client()


def _read(c):
    """Cio' che fa l'editor aprendo il brano: il master e l'import, con le firme."""
    import server
    master_sig = c.get(f"/file?kind=projects&name={MASTER}").headers[server.SIGNATURE_HEADER]
    body = c.get(f"/import?file={IMPORTED}").get_json()
    return master_sig, body["signature"]


def _save(c, **body):
    return c.post("/save", json={"basename": "a", "yamlContent": MASTER_DOC, **body})


def _render(c, **body):
    return c.post("/render", json={"yamlBasename": "a", "yamlContent": MASTER_DOC, **body})


def _events(r):
    """Le righe NDJSON fino alla prima che non e' una firma: il resto e' il
    (finto) motore, che qui non c'entra."""
    out = []
    it = iter(r.response)
    try:
        for line in it:
            ev = json.loads(line if isinstance(line, str) else line.decode())
            if ev.get("type") != "file-signature":
                break
            out.append(ev)
    finally:
        r.close()
    return out


# ---------------------------------------------------------------------------
# GET /import porta la firma
# ---------------------------------------------------------------------------

def test_import_carries_the_signature_of_the_bytes_it_sends(tmp_path):
    root = _root(tmp_path)
    body = _client(root).get(f"/import?file={IMPORTED}").get_json()
    assert body["ok"] is True and body["text"] == IMPORTED_DOC
    assert body["signature"] == fsig.signature(root / "configs" / IMPORTED)
    assert body["signature"].startswith("sha256:")


def test_import_signature_is_of_the_bytes_crlf_included(tmp_path):
    """La firma e' dei byte sul disco: il testo che torna e' quei byte decodificati,
    senza tradurre i fine riga, o la firma sarebbe di un testo che non arriva."""
    root = _root(tmp_path)
    p = root / "configs" / IMPORTED
    p.write_bytes(IMPORTED_DOC.replace("\n", "\r\n").encode())
    body = _client(root).get(f"/import?file={IMPORTED}").get_json()
    assert body["text"].encode() == p.read_bytes()
    assert body["signature"] == fsig.signature(p)


# ---------------------------------------------------------------------------
# POST /save
# ---------------------------------------------------------------------------

def test_save_refuses_an_imported_file_changed_since_it_was_read(tmp_path):
    """Il caso del piano: il laboratorio salva lo stream mentre PGE-ui ce l'ha
    aperto, e PGE-ui salva una sua modifica allo stesso stream. Rifiuto, e
    niente scritto: ne' l'import, ne' il master."""
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_BY_THE_LAB)
    master_before = (root / "configs" / MASTER).read_bytes()
    r = _save(c, yamlContent=MASTER_DOC.replace("onset: 1", "onset: 2"), signature=master_sig,
              imports={IMPORTED: IMPORTED_BY_PGEUI},
              importSignatures={IMPORTED: import_sig})
    assert r.status_code == 409
    body = r.get_json()
    assert body["changed"] is True and body["files"] == [IMPORTED]
    assert p.read_text() == IMPORTED_BY_THE_LAB, "il lavoro del laboratorio resta"
    assert (root / "configs" / MASTER).read_bytes() == master_before, "e il master non si scrive"


def test_save_writes_an_import_whose_signature_matches_and_returns_the_new_one(tmp_path):
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    r = _save(c, signature=master_sig, imports={IMPORTED: IMPORTED_BY_PGEUI},
              importSignatures={IMPORTED: import_sig})
    assert r.status_code == 200
    body = r.get_json()
    p = root / "configs" / IMPORTED
    assert p.read_text() == IMPORTED_BY_PGEUI
    assert body["written"] == [IMPORTED]
    assert body["importSignatures"] == {IMPORTED: fsig.signature(p)}
    # ...ed e' quella che il salvataggio dopo deve mandare.
    again = _save(c, signature=master_sig, imports={IMPORTED: IMPORTED_DOC},
                  importSignatures=body["importSignatures"])
    assert again.status_code == 200 and p.read_text() == IMPORTED_DOC


def test_save_overwrite_imports_writes_the_editors_version(tmp_path):
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_BY_THE_LAB)
    r = _save(c, signature=master_sig, imports={IMPORTED: IMPORTED_BY_PGEUI},
              importSignatures={IMPORTED: import_sig}, overwriteImports=[IMPORTED])
    assert r.status_code == 200
    assert p.read_text() == IMPORTED_BY_PGEUI


def test_save_refuses_a_stale_import_it_does_not_write(tmp_path):
    """L'editor non scrive l'import (non l'ha toccato), ma ce l'ha davanti nella
    versione di prima: un render suonerebbe quella del laboratorio col pallino
    di quella vecchia, e la prima modifica la riscriverebbe sopra. Il bridge lo
    dice, e l'editor rilegge (senza modifiche proprie non chiede niente)."""
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_BY_THE_LAB)
    master_before = (root / "configs" / MASTER).read_bytes()
    r = _save(c, yamlContent=MASTER_DOC.replace("onset: 1", "onset: 2"), signature=master_sig,
              importSignatures={IMPORTED: import_sig})
    assert r.status_code == 409
    assert r.get_json()["files"] == [IMPORTED]
    assert (root / "configs" / MASTER).read_bytes() == master_before
    assert p.read_text() == IMPORTED_BY_THE_LAB


def test_save_an_import_already_holding_the_document_is_left_alone(tmp_path):
    """Il passo 1 vale anche per gli import: il laboratorio ha riscritto lo
    stesso documento a modo suo, e una scrittura non toglierebbe niente a
    nessuno. Resta suo, byte per byte, e torna la firma del disco."""
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_OTHER_SPELLING)
    r = _save(c, signature=master_sig, imports={IMPORTED: IMPORTED_DOC},
              importSignatures={IMPORTED: import_sig})
    assert r.status_code == 200
    body = r.get_json()
    assert IMPORTED not in body["written"]
    assert body["importSignatures"] == {IMPORTED: fsig.signature(p)}
    assert p.read_text() == IMPORTED_OTHER_SPELLING


def test_save_lists_every_changed_file_master_first(tmp_path):
    """La decisione e' per file (`PGEFileGuard.plan`): il 409 li nomina tutti,
    o l'editor ne rileggerebbe uno e al giro dopo troverebbe l'altro."""
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    (root / "configs" / MASTER).write_text("# dal laboratorio\n" + MASTER_DOC.replace("4", "5"))
    (root / "configs" / IMPORTED).write_text(IMPORTED_BY_THE_LAB)
    r = _save(c, yamlContent=MASTER_DOC.replace("onset: 1", "onset: 2"), signature=master_sig,
              imports={IMPORTED: IMPORTED_BY_PGEUI}, importSignatures={IMPORTED: import_sig})
    assert r.status_code == 409
    body = r.get_json()
    assert body["files"] == [MASTER, IMPORTED]
    assert body["name"] == MASTER


def test_save_a_deleted_import_is_not_a_change(tmp_path):
    """Come per il master: un file che non c'e' piu' non e' il lavoro di
    nessuno, e rifiutare lascerebbe la domanda senza uscita."""
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.unlink()
    r = _save(c, signature=master_sig, imports={IMPORTED: IMPORTED_BY_PGEUI},
              importSignatures={IMPORTED: import_sig})
    assert r.status_code == 200
    assert p.read_text() == IMPORTED_BY_PGEUI


def test_save_without_import_signatures_behaves_as_before(tmp_path):
    """Un browser che non manda firme (piu' vecchio di questa guardia) scrive
    come prima: la guardia tace, non rifiuta."""
    root = _root(tmp_path)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_BY_THE_LAB)
    r = _save(_client(root), imports={IMPORTED: IMPORTED_BY_PGEUI})
    assert r.status_code == 200 and p.read_text() == IMPORTED_BY_PGEUI


def test_save_a_new_file_has_no_reading_to_respect(tmp_path):
    """Una copia incollata (#186) si crea: la sua firma, se un browser la
    mandasse, non conta — il file nuovo ha gia' la sua regola, `exists`."""
    root = _root(tmp_path)
    r = _save(_client(root), imports={"streams/copia.yml": IMPORTED_DOC},
              createImports=["streams/copia.yml"],
              importSignatures={"streams/copia.yml": "sha256:" + "0" * 64})
    assert r.status_code == 200
    body = r.get_json()
    p = root / "configs" / "streams" / "copia.yml"
    assert p.read_text() == IMPORTED_DOC
    assert body["importSignatures"]["streams/copia.yml"] == fsig.signature(p)


@pytest.mark.parametrize("field,value", [
    ("importSignatures", ["sha256:x"]),
    ("importSignatures", {IMPORTED: 1}),
    ("overwriteImports", IMPORTED),
    ("overwriteImports", [1]),
])
def test_save_malformed_guard_fields_are_a_400_with_the_disk_intact(tmp_path, field, value):
    root = _root(tmp_path)
    before = (root / "configs" / IMPORTED).read_bytes()
    r = _save(_client(root), imports={IMPORTED: IMPORTED_BY_PGEUI}, **{field: value})
    assert r.status_code == 400
    assert field in r.get_json()["error"]
    assert (root / "configs" / IMPORTED).read_bytes() == before


# ---------------------------------------------------------------------------
# POST /render
# ---------------------------------------------------------------------------

def test_render_refuses_a_changed_import_before_writing_and_before_the_engine(tmp_path):
    root = _root(tmp_path)                      # niente venv: se partisse, si vedrebbe
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_BY_THE_LAB)
    r = _render(c, signature=master_sig, imports={IMPORTED: IMPORTED_BY_PGEUI},
                importSignatures={IMPORTED: import_sig})
    assert r.status_code == 409 and r.mimetype == "application/json"
    assert r.get_json()["files"] == [IMPORTED]
    assert p.read_text() == IMPORTED_BY_THE_LAB
    assert not (root / ".venv").exists()


def test_render_refuses_a_stale_import_it_does_not_write(tmp_path):
    """Il render e' il caso che fa male: il motore rilegge l'import dal disco e
    suona la versione del laboratorio, mentre l'editor ne mostra un'altra e
    la registra come resa. Prima di partire, l'editor deve rileggere."""
    root = _root(tmp_path)
    c = _client(root)
    master_sig, import_sig = _read(c)
    (root / "configs" / IMPORTED).write_text(IMPORTED_BY_THE_LAB)
    r = _render(c, signature=master_sig, importSignatures={IMPORTED: import_sig})
    assert r.status_code == 409
    assert r.get_json()["files"] == [IMPORTED]
    assert not (root / ".venv").exists()


def test_render_emits_the_signature_of_every_import_it_wrote(tmp_path):
    """La firma di cio' che il render ha scritto prende il posto di quella
    letta: un evento per file, dopo quello del master."""
    root = _root(tmp_path, fake_python=True)
    c = _client(root)
    master_sig, import_sig = _read(c)
    r = _render(c, signature=master_sig, imports={IMPORTED: IMPORTED_BY_PGEUI},
                importSignatures={IMPORTED: import_sig})
    assert r.status_code == 200
    evs = _events(r)
    p = root / "configs" / IMPORTED
    assert evs[0]["kind"] == "projects" and evs[0]["name"] == MASTER
    assert evs[1:] == [{"type": "file-signature", "kind": "import", "name": IMPORTED,
                        "signature": fsig.signature(p), "written": True}]
    assert p.read_text() == IMPORTED_BY_PGEUI


def test_render_overwrite_imports_writes(tmp_path):
    root = _root(tmp_path, fake_python=True)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_BY_THE_LAB)
    r = _render(c, signature=master_sig, imports={IMPORTED: IMPORTED_BY_PGEUI},
                importSignatures={IMPORTED: import_sig}, overwriteImports=[IMPORTED])
    assert r.status_code == 200
    _events(r)
    assert p.read_text() == IMPORTED_BY_PGEUI


def test_render_an_import_already_on_disk_is_not_rewritten(tmp_path):
    root = _root(tmp_path, fake_python=True)
    c = _client(root)
    master_sig, import_sig = _read(c)
    p = root / "configs" / IMPORTED
    p.write_text(IMPORTED_OTHER_SPELLING)
    r = _render(c, signature=master_sig, imports={IMPORTED: IMPORTED_DOC},
                importSignatures={IMPORTED: import_sig})
    assert r.status_code == 200
    evs = _events(r)
    assert evs[1] == {"type": "file-signature", "kind": "import", "name": IMPORTED,
                      "signature": fsig.signature(p), "written": False}
    assert p.read_text() == IMPORTED_OTHER_SPELLING


# ---------------------------------------------------------------------------
# La scrittura: i byte che si firmano
# ---------------------------------------------------------------------------

def test_apply_import_plan_returns_the_signature_of_the_bytes_written(tmp_path):
    from server import apply_import_plan
    target = tmp_path / "streams" / "onda.yml"
    written, sigs = apply_import_plan([("streams/onda.yml", target, IMPORTED_DOC)])
    assert written == ["streams/onda.yml"]
    assert sigs == {"streams/onda.yml": fsig.signature(target)}
    assert target.read_bytes() == IMPORTED_DOC.encode("utf-8")
