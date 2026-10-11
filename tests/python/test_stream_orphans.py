"""Cancellare o rinominare uno stream importato, lato bridge (PGE-ui #208).

Uno stream importato con `- file: streams/risacca.yml` e' un file. Cancellato
dall'editor, la voce sparisce dal master e il file restava in `configs/streams/`
senza che nessuno lo nominasse: uno stream che non suona da nessuna parte, che
`tests/test_brano.py` di mare-nostrum segnala come errore. Rinominato, il file
restava col suo nome e il brano suonava un id che il file, aperto da solo nel
laboratorio, non ha. La rinomina adesso SPOSTA il file — il nuovo si crea in
creazione esclusiva come la copia di #186, il vecchio diventa un file che il
master non nomina piu' — e un file che il master non nomina piu' si cancella
al salvataggio.

Il bridge non cancellava mai niente, per scelta, e la scelta resta per tutto
cio' che il browser non chiede: si cancella solo un file elencato in
`deleteImports` (`{path: firma}`, la firma con cui l'editor l'ha letto o
scritto), e solo se nessuna di queste e' vera:

- su disco non e' piu' quello che l'editor ha letto (la firma non torna): ci
  sta il lavoro di qualcun altro, il laboratorio che l'ha salvato nel frattempo;
- l'editor non ne ha una firma: non sa cosa c'e' dentro;
- un documento sotto `configs/` lo importa ancora — un altro master, la copia
  appena fatta con Save As, o il master stesso appena scritto;
- un documento sotto `configs/` che non si legge lo nomina: non si sa se lo
  importa, e il verso sicuro e' tenerlo;
- e' un link: cancellarlo toglierebbe il link, non lo stream.

Un file che resta non e' un errore del salvataggio: il master e i file
importati sono scritti, e la risposta dice quali file sono rimasti e perche'
(`kept`). Le cancellazioni vengono DOPO le scritture, e solo se le scritture
ci sono state: un rifiuto (409) o un 400 lasciano il disco intatto.
"""

import os

import pytest

import file_signature as fsig


MASTER = "a.yml"
MASTER_DOC = "duration: 4\nstreams:\n  - file: streams/onda.yml\n    onset: 1\n"
ORPHAN = "streams/vecchio.yml"
ORPHAN_DOC = "seed: 1441\nstreams:\n  - stream_id: vecchio\n    duration: 2\n"
KEPT = "streams/onda.yml"
KEPT_DOC = "seed: 1441\nstreams:\n  - stream_id: onda\n    duration: 2\n"


def _root(tmp_path):
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    for d in ("configs", "refs", "output", "cache"):
        (tmp_path / d).mkdir(exist_ok=True)
    (tmp_path / "configs" / MASTER).write_text(MASTER_DOC)
    (tmp_path / "configs" / "streams").mkdir()
    (tmp_path / "configs" / KEPT).write_text(KEPT_DOC)
    (tmp_path / "configs" / ORPHAN).write_text(ORPHAN_DOC)
    return tmp_path


def _client(root):
    import server
    return server.make_app(root, render_timeout=600.0).test_client()


def _sig(c, rel):
    """La firma con cui l'editor ha letto il file (GET /import)."""
    return c.get(f"/import?file={rel}").get_json()["signature"]


def _save(c, **body):
    return c.post("/save", json={"basename": "a", "yamlContent": MASTER_DOC, **body})


def _tree(root):
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


# ---------------------------------------------------------------------------
# Cancellato quando nessuno lo importa piu'
# ---------------------------------------------------------------------------

def test_save_deletes_an_orphan_still_as_the_editor_read_it(tmp_path):
    root = _root(tmp_path)
    c = _client(root)
    r = _save(c, deleteImports={ORPHAN: _sig(c, ORPHAN)})
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["deleted"] == [ORPHAN] and body["kept"] == [] and body["absent"] == []
    assert not (root / "configs" / ORPHAN).exists()
    # Il resto non si tocca: il file importato che il master nomina resta.
    assert (root / "configs" / KEPT).read_text() == KEPT_DOC


def test_a_file_the_editor_wrote_is_deleted_with_the_signature_it_got_back(tmp_path):
    """La firma di cio' che l'editor ha appena scritto torna dal salvataggio
    (`importSignatures`): e' quella con cui, al salvataggio dopo, lo cancella —
    la copia incollata e poi annullata, la coda di uno split annullato."""
    root = _root(tmp_path)
    c = _client(root)
    new = "streams/stream7.yml"
    r1 = _save(c, imports={new: "streams:\n  - stream_id: stream7\n"}, createImports=[new])
    assert r1.status_code == 200, r1.get_json()
    sig = r1.get_json()["importSignatures"][new]
    r2 = _save(c, deleteImports={new: sig})
    assert r2.get_json()["deleted"] == [new]
    assert not (root / "configs" / new).exists()


def test_a_save_without_deletions_answers_empty_lists(tmp_path):
    """Un browser piu' vecchio di #208 non manda `deleteImports`: non si
    cancella niente, e la risposta lo dice con tre liste vuote."""
    root = _root(tmp_path)
    body = _save(_client(root)).get_json()
    assert body["ok"] is True
    assert (body["deleted"], body["absent"], body["kept"]) == ([], [], [])
    assert (root / "configs" / ORPHAN).exists()


def test_an_orphan_already_gone_is_absent_not_kept(tmp_path):
    """Qualcuno l'ha gia' tolto (un `git rm`): non c'e' niente da cancellare, e
    non e' un file rimasto. Il browser lo toglie dal disco che ricorda."""
    root = _root(tmp_path)
    c = _client(root)
    sig = _sig(c, ORPHAN)
    (root / "configs" / ORPHAN).unlink()
    body = _save(c, deleteImports={ORPHAN: sig}).get_json()
    assert body["absent"] == [ORPHAN] and body["deleted"] == [] and body["kept"] == []


# ---------------------------------------------------------------------------
# Tenuto: la firma
# ---------------------------------------------------------------------------

def test_an_orphan_changed_since_it_was_read_is_kept(tmp_path):
    """Il laboratorio ha salvato lo stream mentre PGE-ui lo cancellava: il
    lavoro del laboratorio resta, byte per byte, e il salvataggio riesce."""
    root = _root(tmp_path)
    c = _client(root)
    sig = _sig(c, ORPHAN)
    lab = ORPHAN_DOC.replace("duration: 2", "duration: 3")
    (root / "configs" / ORPHAN).write_text(lab)
    r = _save(c, deleteImports={ORPHAN: sig})
    assert r.status_code == 200
    body = r.get_json()
    assert body["deleted"] == []
    assert [k["file"] for k in body["kept"]] == [ORPHAN]
    assert body["kept"][0]["reason"] == "changed"
    assert (root / "configs" / ORPHAN).read_text() == lab


def test_the_same_document_rewritten_is_still_a_changed_file(tmp_path):
    """Si firmano i byte, come per le scritture (#185): lo stesso documento
    con un'altra formattazione e' un file che qualcuno ha riscritto, e non si
    cancella al posto suo."""
    root = _root(tmp_path)
    c = _client(root)
    sig = _sig(c, ORPHAN)
    (root / "configs" / ORPHAN).write_text("# dal laboratorio\n" + ORPHAN_DOC)
    body = _save(c, deleteImports={ORPHAN: sig}).get_json()
    assert body["kept"][0]["reason"] == "changed"


def test_an_orphan_without_a_signature_is_kept(tmp_path):
    """Senza una firma l'editor non sa cosa c'e' nel file: non lo cancella.
    E' il verso opposto della scrittura, dove "nessuna firma" vuol dire "scrivi
    come prima": scrivere un file mai letto e' cio' che si chiede, cancellarlo
    no."""
    root = _root(tmp_path)
    body = _save(_client(root), deleteImports={ORPHAN: ""}).get_json()
    assert body["kept"][0]["file"] == ORPHAN and body["kept"][0]["reason"] == "unread"
    assert (root / "configs" / ORPHAN).exists()


# ---------------------------------------------------------------------------
# Tenuto: qualcuno lo importa ancora
# ---------------------------------------------------------------------------

def test_an_orphan_another_master_imports_is_kept(tmp_path):
    """Due brani possono importare lo stesso stream: toglierlo da uno non lo
    toglie dall'altro."""
    root = _root(tmp_path)
    (root / "configs" / "b.yml").write_text(f"streams:\n  - file: {ORPHAN}\n")
    c = _client(root)
    body = _save(c, deleteImports={ORPHAN: _sig(c, ORPHAN)}).get_json()
    assert body["deleted"] == []
    kept = body["kept"][0]
    assert kept["file"] == ORPHAN and kept["reason"] == "imported" and kept["by"] == ["b.yml"]
    assert (root / "configs" / ORPHAN).exists()


@pytest.mark.parametrize("where,spelling", [
    ("b.yml", "./streams/vecchio.yml"),
    ("b.yaml", "streams/vecchio.yml"),
    ("vecchi/b.yml", "../streams/vecchio.yml"),
    ("streams/sotto/b.yml", "../vecchio.yml"),
])
def test_an_import_is_recognized_whatever_its_spelling_and_wherever_the_master(tmp_path, where, spelling):
    """Il path di `file:` e' relativo alla cartella del documento che lo
    scrive (la regola del motore), e due grafie dello stesso path sono lo
    stesso file."""
    root = _root(tmp_path)
    doc = root / "configs" / where
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text(f"streams:\n  - file: {spelling}\n    onset: 3\n")
    c = _client(root)
    body = _save(c, deleteImports={ORPHAN: _sig(c, ORPHAN)}).get_json()
    assert body["kept"] and body["kept"][0]["by"] == [where], body
    assert (root / "configs" / ORPHAN).exists()


def test_the_master_just_written_still_naming_it_keeps_it(tmp_path):
    """Il controllo si fa sul disco DOPO le scritture: il master appena scritto
    conta come ogni altro. Un browser che chiedesse di cancellare un file che
    il suo stesso master importa non toglie lo stream al brano."""
    root = _root(tmp_path)
    c = _client(root)
    doc = MASTER_DOC + f"  - file: {ORPHAN}\n"
    body = _save(c, yamlContent=doc, deleteImports={ORPHAN: _sig(c, ORPHAN)}).get_json()
    assert body["kept"][0]["reason"] == "imported" and body["kept"][0]["by"] == [MASTER]
    assert (root / "configs" / ORPHAN).exists()


def test_a_save_as_copy_still_importing_it_keeps_it(tmp_path):
    """Save As scrive un master nuovo e lascia quello vecchio: finche' il
    vecchio importa il file, il file resta. (Save As non manda cancellazioni,
    ma chi le manda dopo trova l'altro master su disco.)"""
    root = _root(tmp_path)
    (root / "configs" / MASTER).write_text(MASTER_DOC + f"  - file: {ORPHAN}\n")
    c = _client(root)
    r = c.post("/save", json={"basename": "a_copy", "yamlContent": MASTER_DOC, "overwrite": True,
                              "deleteImports": {ORPHAN: _sig(c, ORPHAN)}})
    body = r.get_json()
    assert body["kept"][0]["by"] == [MASTER]
    assert (root / "configs" / ORPHAN).exists()


def test_a_document_that_does_not_parse_and_names_it_keeps_it(tmp_path):
    """Un documento rotto non dice se importa il file: se lo nomina, il file
    resta. Se non lo nomina non puo' importarlo, e non ferma niente."""
    root = _root(tmp_path)
    (root / "configs" / "rotto.yml").write_text("streams:\n  - file: streams/vecchio.yml\n  bad: [\n")
    c = _client(root)
    body = _save(c, deleteImports={ORPHAN: _sig(c, ORPHAN)}).get_json()
    assert body["kept"][0]["reason"] == "unknown" and body["kept"][0]["by"] == ["rotto.yml"]
    assert (root / "configs" / ORPHAN).exists()

    (root / "configs" / "rotto.yml").write_text("streams:\n  - file: streams/altro.yml\n  bad: [\n")
    body = _save(c, deleteImports={ORPHAN: _sig(c, ORPHAN)}).get_json()
    assert body["deleted"] == [ORPHAN], body


def test_hidden_documents_and_other_files_are_not_readers(tmp_path):
    """Il bridge non legge ne' scrive file nascosti, e un file che non e' YAML
    non importa niente: nessuno dei due tiene in vita un file."""
    root = _root(tmp_path)
    (root / "configs" / ".bozza.yml").write_text(f"streams:\n  - file: {ORPHAN}\n")
    (root / "configs" / "note.txt").write_text(f"streams:\n  - file: {ORPHAN}\n")
    (root / "configs" / ".git").mkdir()
    (root / "configs" / ".git" / "x.yml").write_text(f"streams:\n  - file: {ORPHAN}\n")
    c = _client(root)
    body = _save(c, deleteImports={ORPHAN: _sig(c, ORPHAN)}).get_json()
    assert body["deleted"] == [ORPHAN], body


def test_a_link_is_kept(tmp_path):
    """Un link sotto configs/ e' una scelta di chi lavora li': cancellarlo
    toglierebbe il link, non lo stream."""
    root = _root(tmp_path)
    real = root / "configs" / ORPHAN
    link = root / "configs" / "streams" / "link.yml"
    link.symlink_to(real)
    c = _client(root)
    body = _save(c, deleteImports={"streams/link.yml": _sig(c, "streams/link.yml")}).get_json()
    assert body["kept"][0]["reason"] == "link"
    assert link.is_symlink() and real.exists()


def test_a_disk_error_keeps_the_file_and_the_save(tmp_path, monkeypatch):
    """La cancellazione che fallisce (permessi, un disco di sola lettura) non
    disfa il salvataggio: master e import sono gia' scritti, e il file resta
    con l'errore nominato."""
    import server
    root = _root(tmp_path)
    c = _client(root)
    sig = _sig(c, ORPHAN)

    def refuse(path, *a, **k):
        raise PermissionError(13, "Permission denied", str(path))
    monkeypatch.setattr(server.os, "remove", refuse)
    r = _save(c, yamlContent=MASTER_DOC.replace("onset: 1", "onset: 2"), deleteImports={ORPHAN: sig})
    assert r.status_code == 200
    body = r.get_json()
    assert body["kept"][0]["reason"] == "error" and "Permission denied" in body["kept"][0]["detail"]
    assert "onset: 2" in (root / "configs" / MASTER).read_text()


# ---------------------------------------------------------------------------
# La rinomina: un file nuovo e il vecchio cancellato, in un salvataggio solo
# ---------------------------------------------------------------------------

def test_rename_creates_the_new_file_and_deletes_the_old_one(tmp_path):
    root = _root(tmp_path)
    c = _client(root)
    sig = _sig(c, KEPT)
    master = MASTER_DOC.replace("streams/onda.yml", "streams/marea.yml")
    r = _save(c, yamlContent=master,
              imports={"streams/marea.yml": KEPT_DOC.replace("onda", "marea")},
              createImports=["streams/marea.yml"],
              deleteImports={KEPT: sig})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["deleted"] == [KEPT]
    assert not (root / "configs" / KEPT).exists()
    assert "stream_id: marea" in (root / "configs" / "streams" / "marea.yml").read_text()


def test_a_new_file_that_exists_refuses_and_deletes_nothing(tmp_path):
    """Il nome nuovo e' gia' preso su disco (il laboratorio ha salvato un
    `marea.yml` nel frattempo): 409 `exists`, e il file vecchio resta — una
    rinomina a meta' sarebbe uno stream che non c'e' piu' da nessuna parte."""
    root = _root(tmp_path)
    c = _client(root)
    sig = _sig(c, KEPT)
    (root / "configs" / "streams" / "marea.yml").write_text("streams:\n  - stream_id: marea\n")
    before = _tree(root)
    r = _save(c, yamlContent=MASTER_DOC.replace("streams/onda.yml", "streams/marea.yml"),
              imports={"streams/marea.yml": KEPT_DOC}, createImports=["streams/marea.yml"],
              deleteImports={KEPT: sig})
    assert r.status_code == 409 and r.get_json()["exists"] is True
    assert _tree(root) == before


def test_a_master_changed_on_disk_refuses_and_deletes_nothing(tmp_path):
    """Il rifiuto di #185 sul master arriva prima di ogni scrittura, e quindi
    prima di ogni cancellazione."""
    import server
    root = _root(tmp_path)
    c = _client(root)
    master_sig = c.get(f"/file?kind=projects&name={MASTER}").headers[server.SIGNATURE_HEADER]
    sig = _sig(c, ORPHAN)
    (root / "configs" / MASTER).write_text(MASTER_DOC + "title: dal laboratorio\n")
    before = _tree(root)
    r = _save(c, yamlContent=MASTER_DOC.replace("onset: 1", "onset: 2"), signature=master_sig,
              deleteImports={ORPHAN: sig})
    assert r.status_code == 409 and r.get_json()["changed"] is True
    assert _tree(root) == before


def test_exists_remedy_names_the_rename_too(tmp_path):
    """Il file nuovo ha un terzo gesto che lo crea, la rinomina: il rimedio
    del rifiuto lo nomina, o chi ha rinominato uno stream va a cercare un
    incolla che non ha fatto."""
    root = _root(tmp_path)
    (root / "configs" / "streams" / "marea.yml").write_text("streams: []\n")
    error = _save(_client(root), imports={"streams/marea.yml": KEPT_DOC},
                  createImports=["streams/marea.yml"]).get_json()["error"]
    assert "incolla" in error and "split" in error and "rinominato" in error, error


# ---------------------------------------------------------------------------
# Una richiesta sbagliata e' un 400 a disco intatto
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("deletes", [
    ["streams/vecchio.yml"],
    "streams/vecchio.yml",
    {"streams/vecchio.yml": 7},
    {"streams/vecchio.yml": None},
])
def test_malformed_delete_imports_is_a_400(tmp_path, deletes):
    root = _root(tmp_path)
    before = _tree(root)
    r = _save(_client(root), yamlContent=MASTER_DOC + "title: x\n", deleteImports=deletes)
    assert r.status_code == 400 and "deleteImports" in r.get_json()["error"]
    assert _tree(root) == before


@pytest.mark.parametrize("rel", ["../fuori.yml", "/etc/x.yml", "streams/.nascosto.yml",
                                 "streams/vecchio.txt", "a//b.yml", "streams\\vecchio.yml"])
def test_a_bad_path_is_a_400_with_the_disk_untouched(tmp_path, rel):
    root = _root(tmp_path)
    before = _tree(root)
    r = _save(_client(root), yamlContent=MASTER_DOC + "title: x\n", deleteImports={rel: "sha256:x"})
    assert r.status_code == 400
    assert _tree(root) == before


def test_the_master_is_not_an_import_to_delete(tmp_path):
    root = _root(tmp_path)
    before = _tree(root)
    r = _save(_client(root), yamlContent=MASTER_DOC + "title: x\n", deleteImports={MASTER: "sha256:x"})
    assert r.status_code == 400
    assert _tree(root) == before


def test_a_file_written_and_deleted_in_one_request_is_a_400(tmp_path):
    """Scrivere e cancellare lo stesso file e' una richiesta che si
    contraddice: nessuno dei due ordini e' quello voluto."""
    root = _root(tmp_path)
    before = _tree(root)
    r = _save(_client(root), yamlContent=MASTER_DOC + "title: x\n",
              imports={ORPHAN: ORPHAN_DOC}, deleteImports={ORPHAN: "sha256:x"})
    assert r.status_code == 400
    assert _tree(root) == before


# ---------------------------------------------------------------------------
# Il render non cancella
# ---------------------------------------------------------------------------

def test_render_does_not_delete(tmp_path):
    """Il render scrive cio' che il motore rilegge — master e file importati —
    e nient'altro: un file che nessuno importa non lo legge nessuno, e la
    cancellazione e' del salvataggio, che e' dove l'autore la vede annunciata."""
    root = _root(tmp_path)
    vb = root / ".venv" / "bin"
    vb.mkdir(parents=True)
    (vb / "python").write_text("#!/bin/sh\nexit 0\n")
    (vb / "python").chmod(0o755)
    c = _client(root)
    r = c.post("/render", json={"yamlBasename": "a", "yamlContent": MASTER_DOC,
                                "deleteImports": {ORPHAN: _sig(c, ORPHAN)}})
    r.close()
    assert (root / "configs" / ORPHAN).exists()
