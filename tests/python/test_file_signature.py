"""Due editor, un file (#185): la firma del file e la scrittura che la rispetta.

Lo stesso `configs/<brano>.yml` puo' stare aperto in PGE-ui e nel laboratorio
di mare-nostrum. Ognuno dei due ricorda com'era il file quando l'ha letto e,
prima di scrivere, controlla che su disco sia ancora quello. La convenzione e'
quella del laboratorio (DMGiulioRomano/mare-nostrum#15): `sha256:<hex>` sui
BYTE del file, piu' il passo "un documento che il file ha gia' non si
riscrive", che viene prima della firma.

Qui si verifica il lato del bridge, in due strati: il modulo puro
(`file_signature`) e il giro HTTP vero sulle tre route che leggono o scrivono
un progetto — `GET /file`, `PUT /file`, `POST /render`.
"""

import hashlib
import json

import pytest

import file_signature as fsig


DOC = "title: risacca\nduration: 4\nstreams:\n  - stream_id: s1\n    duration: 4\n"
# Lo stesso documento come lo scriverebbe l'ALTRO editor: un commento suo,
# un'altra formattazione, un altro ordine delle chiavi. Byte diversi, documento
# identico — il caso per cui il primo passo esiste.
DOC_OTHER_SPELLING = (
    "# scritto dal laboratorio\n"
    "streams: [{duration: 4, stream_id: s1}]\n"
    "duration: 4\n"
    "title: risacca\n"
)
DOC_CHANGED = DOC.replace("duration: 4\nstreams", "duration: 6\nstreams")


# ---------------------------------------------------------------------------
# La convenzione. E' condivisa con il laboratorio: muoverla da un lato solo
# fa dire "cambiato" a ogni file letto dall'altro.
# ---------------------------------------------------------------------------

def test_signature_is_sha256_of_the_bytes_with_the_algorithm_in_the_prefix():
    raw = DOC.encode("utf-8")
    assert fsig.ALGO == "sha256"
    assert fsig.signature_of(raw) == "sha256:" + hashlib.sha256(raw).hexdigest()


def test_the_prefix_and_the_hash_come_from_one_declaration(monkeypatch):
    """Cambiare l'algoritmo nel prefisso e non nell'hash darebbe una firma che
    mente su se stessa — l'unica cosa che il prefisso serve a non far
    succedere."""
    monkeypatch.setattr(fsig, "ALGO", "sha1")
    raw = b"abc"
    assert fsig.signature_of(raw) == "sha1:" + hashlib.sha1(raw).hexdigest()


def test_the_bytes_not_the_parse_are_signed():
    """Due grafie dello stesso documento sono due firme: la domanda e' "il file
    su disco e' quello che ho letto", e una modifica di sola formattazione o un
    commento sono un file diverso."""
    assert fsig.signature_of(DOC.encode()) != fsig.signature_of(DOC_OTHER_SPELLING.encode())


def test_signature_of_a_missing_file_is_empty(tmp_path):
    assert fsig.signature(tmp_path / "nope.yml") == ""


def test_read_signed_signs_exactly_the_bytes_it_returns(tmp_path):
    p = tmp_path / "a.yml"
    p.write_bytes(DOC.encode("utf-8"))
    text, sig = fsig.read_signed(p)
    assert text == DOC
    assert sig == fsig.signature_of(text.encode("utf-8")) == fsig.signature(p)


def test_read_signed_keeps_crlf_so_the_signature_is_of_the_disk_bytes(tmp_path):
    """`read_text` tradurrebbe i fine riga: il testo restituito non sarebbe
    piu' quello firmato."""
    p = tmp_path / "a.yml"
    p.write_bytes(b"title: x\r\nstreams: []\r\n")
    text, sig = fsig.read_signed(p)
    assert sig == fsig.signature_of(text.encode("utf-8"))


# ---------------------------------------------------------------------------
# "Cambiato su disco", e i due casi che non lo sono.
# ---------------------------------------------------------------------------

def test_unchanged_file_is_not_changed(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    assert fsig.changed_on_disk(p, fsig.signature(p)) is False


def test_a_rewritten_file_is_changed(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    read = fsig.signature(p)
    p.write_text(DOC_CHANGED)
    assert fsig.changed_on_disk(p, read) is True


def test_no_signature_read_is_not_a_change(tmp_path):
    """Un file mai letto non ha niente con cui confrontarsi."""
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    assert fsig.changed_on_disk(p, "") is False
    assert fsig.changed_on_disk(p, None) is False


def test_a_deleted_file_is_not_a_change(tmp_path):
    """Non ci sta il lavoro di nessuno, e rifiutare lascerebbe la domanda senza
    via d'uscita: "ricarica" non puo' rileggere un file cancellato."""
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    read = fsig.signature(p)
    p.unlink()
    assert fsig.changed_on_disk(p, read) is False


# ---------------------------------------------------------------------------
# Lo stesso documento, tipi compresi.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("a,b", [
    (4, 4.0),                 # per il motore un n_reps float e' un errore (PGE #211)
    (1, True),
    (0, False),
    ({"n": 4}, {"n": 4.0}),
    ([1, 2], [1, 2.0]),
    ([1, 2], [1, 2, 3]),
    ({"a": 1}, {"a": 1, "b": 2}),
    ("4", 4),
    (None, 0),
])
def test_same_document_tells_types_apart(a, b):
    assert fsig.same_document(a, b) is False
    assert fsig.same_document(b, a) is False


@pytest.mark.parametrize("a,b", [
    (4, 4),
    ({"a": 1, "b": [1.5, "x"]}, {"b": [1.5, "x"], "a": 1}),   # l'ordine delle chiavi no
    (None, None),
])
def test_same_document_equal(a, b):
    assert fsig.same_document(a, b) is True


def test_already_on_disk_reads_the_document_not_the_bytes(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text(DOC_OTHER_SPELLING)
    assert fsig.already_on_disk(p, DOC) == fsig.signature(p)


def test_already_on_disk_is_empty_for_another_document(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    assert fsig.already_on_disk(p, DOC_CHANGED) == ""


def test_already_on_disk_compares_with_types(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text("n_reps: 4\n")
    assert fsig.already_on_disk(p, "n_reps: 4.0\n") == ""


@pytest.mark.parametrize("content", [b"title: [unclosed\n", b"\xff\xfe\x00broken"])
def test_already_on_disk_is_empty_on_an_unreadable_file(tmp_path, content):
    p = tmp_path / "a.yml"
    p.write_bytes(content)
    assert fsig.already_on_disk(p, DOC) == ""


def test_already_on_disk_is_empty_on_a_missing_file(tmp_path):
    assert fsig.already_on_disk(tmp_path / "nope.yml", DOC) == ""


# ---------------------------------------------------------------------------
# write_guarded: i tre passi, in quest'ordine.
#   1. il file ha gia' il documento → non si scrive, e non si guarda la firma;
#   2. firma letta diversa da quella su disco, senza `overwrite` → rifiuto;
#   3. altrimenti si scrive, e torna la firma dei byte scritti.
# ---------------------------------------------------------------------------

def test_step1_same_document_is_not_written_even_with_a_stale_signature(tmp_path):
    """L'altro editor ha riscritto lo stesso documento a modo suo: una
    scrittura non toglierebbe niente a nessuno, quindi non c'e' niente da
    chiedere — e la sua formattazione e i suoi commenti restano."""
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    stale = fsig.signature(p)
    p.write_text(DOC_OTHER_SPELLING)
    r = fsig.write_guarded(p, DOC, read_signature=stale)
    assert r == {"ok": True, "written": False, "signature": fsig.signature(p)}
    assert p.read_text() == DOC_OTHER_SPELLING


def test_step2_a_changed_file_is_refused_and_left_alone(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    read = fsig.signature(p)
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    before = p.read_bytes()
    r = fsig.write_guarded(p, DOC_CHANGED, read_signature=read)
    assert r["ok"] is False and r["changed"] is True
    assert "signature" not in r, "la firma dell'altro editor non si adotta senza rileggerlo"
    assert p.read_bytes() == before


def test_step2_overwrite_is_the_answer_that_writes(tmp_path):
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    read = fsig.signature(p)
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    r = fsig.write_guarded(p, DOC_CHANGED, read_signature=read, overwrite=True)
    assert r["ok"] is True and r["written"] is True
    assert p.read_text() == DOC_CHANGED
    assert r["signature"] == fsig.signature(p)


def test_step3_matching_signature_writes_and_returns_the_new_one(tmp_path):
    """La firma di cio' che si e' scritto prende il posto di quella letta: senza,
    il salvataggio dopo si accuserebbe da solo di aver cambiato il file."""
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    r = fsig.write_guarded(p, DOC_CHANGED, read_signature=fsig.signature(p))
    assert r["ok"] is True and r["written"] is True
    assert r["signature"] == fsig.signature(p) == fsig.signature_of(DOC_CHANGED.encode())
    again = fsig.write_guarded(p, DOC_CHANGED.replace("6", "7"), read_signature=r["signature"])
    assert again["ok"] is True and again["written"] is True


def test_step3_no_signature_and_missing_file_write(tmp_path):
    p = tmp_path / "a.yml"
    assert fsig.write_guarded(p, DOC)["written"] is True
    read = fsig.signature(p)
    p.unlink()
    r = fsig.write_guarded(p, DOC, read_signature=read)
    assert r["ok"] is True and r["written"] is True and p.read_text() == DOC


def test_step1_comes_before_step2(tmp_path):
    """Invertiti, il file riscritto dall'altro editor con lo stesso documento
    tornerebbe un rifiuto, cioe' una domanda su niente."""
    p = tmp_path / "a.yml"
    p.write_text(DOC)
    stale = fsig.signature(p)
    p.write_text(DOC_OTHER_SPELLING)
    assert fsig.write_guarded(p, DOC, read_signature=stale)["ok"] is True


def test_step1_applies_to_yaml_only(tmp_path):
    """Il confronto per documento ha senso su YAML: per un altro testo una
    lettura YAML puo' dire "uguale" a due stringhe diverse."""
    p = tmp_path / "note.txt"
    p.write_text("a\nb\n")
    r = fsig.write_guarded(p, "a b\n", yaml_document=False)
    assert r["written"] is True and p.read_text() == "a b\n"


def test_written_bytes_are_utf8_without_newline_translation(tmp_path):
    p = tmp_path / "a.yml"
    text = "title: perché\nstreams: []\n"
    r = fsig.write_guarded(p, text)
    assert p.read_bytes() == text.encode("utf-8")
    assert r["signature"] == fsig.signature_of(text.encode("utf-8"))


# ---------------------------------------------------------------------------
# Il giro HTTP vero.
# ---------------------------------------------------------------------------

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
    return tmp_path


def _client(root):
    import server
    return server.make_app(root, render_timeout=600.0).test_client()


def test_get_file_carries_the_signature_of_the_bytes_it_sends(tmp_path):
    import server
    root = _root(tmp_path)
    (root / "configs" / "a.yml").write_text(DOC)
    r = _client(root).get("/file?kind=projects&name=a.yml")
    assert r.status_code == 200
    assert r.get_data(as_text=True) == DOC
    assert r.headers[server.SIGNATURE_HEADER] == fsig.signature(root / "configs" / "a.yml")
    assert r.mimetype == "text/plain"
    assert r.headers["Content-Type"].count("charset") == 1


def test_get_file_exposes_the_header_cross_origin(tmp_path):
    """La pagina aperta come `file://` ha origine "null", quindi e' cross-origin:
    senza `Access-Control-Expose-Headers` il browser non lascia leggere a
    `fetch()` l'header, e la guardia resterebbe disarmata proprio li'."""
    import server
    root = _root(tmp_path)
    (root / "configs" / "a.yml").write_text(DOC)
    r = _client(root).get("/file?kind=projects&name=a.yml", headers={"Origin": "null"})
    exposed = [h.strip().lower() for h in r.headers.get("Access-Control-Expose-Headers", "").split(",")]
    assert server.SIGNATURE_HEADER.lower() in exposed


def test_head_file_still_answers_existence(tmp_path):
    """`fs.fileExists` fa una HEAD su /file."""
    root = _root(tmp_path)
    (root / "configs" / "a.yml").write_text(DOC)
    c = _client(root)
    assert c.head("/file?kind=projects&name=a.yml").status_code == 200
    assert c.head("/file?kind=projects&name=b.yml").status_code == 404


def _put(c, name, body, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return c.put(f"/file?kind=projects&name={name}" + (f"&{q}" if q else ""),
                 data=body.encode("utf-8"), content_type="text/plain")


def test_put_file_refuses_a_file_changed_since_it_was_read(tmp_path):
    import server
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))          # il laboratorio salva
    before = p.read_bytes()
    r = _put(c, "a.yml", DOC_CHANGED, signature=read)
    assert r.status_code == 409
    body = r.get_json()
    assert body["ok"] is False and body["changed"] is True and body["name"] == "a.yml"
    assert p.read_bytes() == before


@pytest.mark.parametrize("flag", ["1", "true"])
def test_put_file_overwrite_writes(tmp_path, flag):
    import server
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    r = _put(c, "a.yml", DOC_CHANGED, signature=read, overwrite=flag)
    assert r.status_code == 200
    assert r.get_json()["written"] is True
    assert p.read_text() == DOC_CHANGED


@pytest.mark.parametrize("flag", ["0", "false", "no", ""])
def test_put_file_overwrite_is_read_strictly(tmp_path, flag):
    """`bool("false")` e' True: una sovrascrittura chiesta da nessuno."""
    import server
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    assert _put(c, "a.yml", DOC_CHANGED, signature=read, overwrite=flag).status_code == 409


def test_put_file_returns_the_signature_that_the_next_write_must_send(tmp_path):
    import server
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    r = _put(c, "a.yml", DOC_CHANGED, signature=read)
    assert r.status_code == 200
    body = r.get_json()
    assert body["written"] is True and body["signature"] == fsig.signature(p)
    assert body["bytes"] == p.stat().st_size
    assert _put(c, "a.yml", DOC, signature=body["signature"]).status_code == 200


def test_put_file_same_document_leaves_the_other_editors_bytes(tmp_path):
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC_OTHER_SPELLING)
    r = _put(_client(root), "a.yml", DOC, signature="sha256:" + "0" * 64)
    assert r.status_code == 200
    assert r.get_json()["written"] is False
    assert r.get_json()["signature"] == fsig.signature(p)
    assert p.read_text() == DOC_OTHER_SPELLING


def test_put_file_without_signature_behaves_as_before(tmp_path):
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    assert _put(_client(root), "a.yml", DOC_CHANGED).status_code == 200
    assert p.read_text() == DOC_CHANGED


def test_put_file_still_rejects_a_bad_name(tmp_path):
    root = _root(tmp_path)
    assert _put(_client(root), "..%2Fevil.yml", DOC).status_code == 400


def _render(c, **body):
    return c.post("/render", json={"yamlBasename": "a", **body})


def test_render_refuses_before_writing_and_before_the_engine(tmp_path):
    """Il render scrive `configs/<basename>.yml` prima di lanciare il motore: il
    rifiuto va li', PRIMA della scrittura — e del venv e dello stream."""
    import server
    root = _root(tmp_path)                      # niente venv: se partisse, si vedrebbe
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    before = p.read_bytes()
    r = _render(c, yamlContent=DOC_CHANGED, signature=read)
    assert r.status_code == 409
    assert r.mimetype == "application/json"
    body = r.get_json()
    assert body["changed"] is True and body["name"] == "a.yml"
    assert p.read_bytes() == before
    assert not (root / ".venv").exists()


def _first_event(r):
    """Solo la prima riga dello stream: consumarlo tutto vorrebbe dire far
    girare il (finto) motore, che qui non c'entra."""
    it = iter(r.response)
    try:
        first = next(it)
    finally:
        r.close()
    return json.loads(first if isinstance(first, str) else first.decode())


def test_render_emits_the_signature_of_what_it_wrote_first(tmp_path):
    import server
    root = _root(tmp_path, fake_python=True)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    r = _render(c, yamlContent=DOC_CHANGED, signature=read)
    assert r.status_code == 200
    ev = _first_event(r)
    assert ev == {"type": "file-signature", "kind": "projects", "name": "a.yml",
                  "signature": fsig.signature(p), "written": True}
    assert p.read_text() == DOC_CHANGED


def test_render_overwrite_writes(tmp_path):
    import server
    root = _root(tmp_path, fake_python=True)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    r = _render(c, yamlContent=DOC_CHANGED, signature=read, overwrite=True)
    assert r.status_code == 200
    _first_event(r)
    assert p.read_text() == DOC_CHANGED


@pytest.mark.parametrize("flag", ["true", 1, "1", "yes"])
def test_render_overwrite_must_be_a_json_true(tmp_path, flag):
    """Nel body JSON la risposta e' un booleano: una stringa o un numero non
    sono una decisione presa da qualcuno."""
    import server
    root = _root(tmp_path)
    p = root / "configs" / "a.yml"
    p.write_text(DOC)
    c = _client(root)
    read = c.get("/file?kind=projects&name=a.yml").headers[server.SIGNATURE_HEADER]
    p.write_text(DOC_OTHER_SPELLING.replace("4", "9"))
    assert _render(c, yamlContent=DOC_CHANGED, signature=read, overwrite=flag).status_code == 409


def test_render_of_a_document_already_on_disk_leaves_the_file_alone(tmp_path):
    """Il caso che conta: PGE-ui rilegge il file che il laboratorio ha appena
    scritto e lo rende. Senza il primo passo il render lo riscriverebbe col
    proprio serializzatore, e al giro dopo la guardia del laboratorio direbbe
    "cambiato su disco" su un documento che nessuno ha cambiato."""
    root = _root(tmp_path, fake_python=True)
    p = root / "configs" / "a.yml"
    p.write_text(DOC_OTHER_SPELLING)
    r = _render(_client(root), yamlContent=DOC, signature="sha256:" + "0" * 64)
    assert r.status_code == 200
    ev = _first_event(r)
    assert ev["written"] is False and ev["signature"] == fsig.signature(p)
    assert p.read_text() == DOC_OTHER_SPELLING


def test_render_without_yaml_content_emits_no_signature(tmp_path):
    """Senza documento il bridge non scrive niente: una firma emessa li' sarebbe
    adottata senza che nessuno abbia letto il file."""
    root = _root(tmp_path, fake_python=True)
    (root / "configs" / "a.yml").write_text(DOC)
    r = _render(_client(root))
    assert r.status_code == 200
    events = [json.loads(l) for l in r.get_data(as_text=True).splitlines() if l]
    assert not any(e.get("type") == "file-signature" for e in events)
