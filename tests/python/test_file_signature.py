"""Due editor, un file — la meta' bridge della guardia (#185).

Lo stesso `streams/risacca.yml` puo' stare aperto nel laboratorio di
mare-nostrum e in PGE-ui (regola 7 del piano `stream-come-file.md`). Qui si
verifica che il bridge rifiuti la scrittura quando su disco non c'e' piu' il
file che l'editor ha letto, e che la accetti quando la firma coincide o quando
si chiede di sovrascrivere — su tutti e due i punti in cui questo bridge
scrive, `PUT /file` e la scrittura del config dentro `POST /render`.

Nessun motore: il render si rifiuta PRIMA della scrittura, quindi questi test
non arrivano mai a lanciare `main.py`.

I test di riferimento dell'altra meta' stanno in `tests/test_serve.py` del
laboratorio, dal blocco «un documento gia' su disco non si riscrive».
"""

import hashlib

import pytest
import yaml

import file_signature as fsig


# ---------------------------------------------------------------------------
# La convenzione, che e' condivisa e quindi non si puo' cambiare da un lato
# ---------------------------------------------------------------------------

def test_la_firma_e_sha256_dei_byte_col_prefisso():
    """`sha256:<hexdigest>` sui byte, e il prefisso dichiara l'algoritmo.

    La stessa firma la calcola il laboratorio (serve.py: `ALGO`, `firma_di`):
    il giorno che una delle due convenzioni cambia si deve vedere che non e' il
    file a essere cambiato, e questo e' il test che non lascia cambiarla per
    sbaglio da questo lato.
    """
    raw = b"a: 1\n"
    assert fsig.ALGO == "sha256"
    assert fsig.signature_of(raw) == "sha256:" + hashlib.sha256(raw).hexdigest()


def test_la_firma_e_dei_byte_non_del_documento(tmp_path):
    """Due byte diversi, due firme — anche a documento identico.

    Firmare il parse lascerebbe passare la riscrittura di un file che l'altro
    editor ha davvero cambiato ogni volta che il cambiamento non si vede nel
    parse: un commento, l'ordine delle chiavi.
    """
    a, b = tmp_path / "a.yml", tmp_path / "b.yml"
    a.write_bytes(b"a: 1\n")
    b.write_bytes(b"# commento\na: 1\n")
    assert yaml.safe_load(a.read_bytes()) == yaml.safe_load(b.read_bytes())
    assert fsig.file_signature(a) != fsig.file_signature(b)


def test_la_firma_non_e_l_mtime(tmp_path):
    """Riscritto identico non e' cambiato.

    Un mtime dice che qualcuno ha scritto, non che il file sia diverso, e le
    due risposte portano a cose opposte: rileggere, o lasciar passare la
    riscrittura di un file identico.
    """
    p = tmp_path / "a.yml"
    p.write_bytes(b"a: 1\n")
    sig = fsig.file_signature(p)
    import os, time
    os.utime(p, (time.time() + 1000, time.time() + 1000))
    p.write_bytes(b"a: 1\n")
    assert fsig.changed_on_disk(p, sig) is False


def test_read_signed_firma_gli_stessi_byte_che_torna(tmp_path):
    p = tmp_path / "a.yml"
    p.write_bytes(b"a: 1\n")
    raw, sig = fsig.read_signed(p)
    assert raw == b"a: 1\n"
    assert sig == fsig.signature_of(raw)


def test_write_signed_firma_cio_che_ha_scritto(tmp_path):
    """E scrive in binario: la firma e' dei byte sul disco.

    In modalita' testo una piattaforma che traduce i fine riga ne scriverebbe
    altri, e la firma direbbe un file che su disco non c'e'.
    """
    p = tmp_path / "sub" / "a.yml"
    sig = fsig.write_signed(p, "a: 1\r\nb: 2\n")
    assert p.read_bytes() == b"a: 1\r\nb: 2\n"
    assert sig == fsig.file_signature(p)


# ---------------------------------------------------------------------------
# changed_on_disk: i due casi che NON sono un file cambiato
# ---------------------------------------------------------------------------

def test_senza_firma_letta_non_c_e_niente_da_confrontare(tmp_path):
    """E' il `Save as`, il progetto nuovo, il file importato la prima volta."""
    p = tmp_path / "a.yml"
    p.write_bytes(b"a: 1\n")
    assert fsig.changed_on_disk(p, "") is False


def test_un_file_che_non_c_e_piu_non_e_un_file_cambiato(tmp_path):
    """Non ci sta il lavoro di nessuno, e rifiutare lascerebbe la domanda
    senza via d'uscita: "ricarica" non puo' rileggere un file cancellato, e
    scriverlo e' esattamente cio' che si stava chiedendo."""
    p = tmp_path / "a.yml"
    p.write_bytes(b"a: 1\n")
    sig = fsig.file_signature(p)
    p.unlink()
    assert fsig.changed_on_disk(p, sig) is False
    assert fsig.guard(p, "a: 2\n", sig)["written"] is True


def test_una_firma_diversa_e_un_file_cambiato(tmp_path):
    p = tmp_path / "a.yml"
    p.write_bytes(b"a: 1\n")
    sig = fsig.file_signature(p)
    p.write_bytes(b"a: 2\n")
    assert fsig.changed_on_disk(p, sig) is True


# ---------------------------------------------------------------------------
# same_document: i tipi contano
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("a,b", [
    (4, 4.0),            # per Python 4 == 4.0, per il motore no
    (1, True),           # e 1 == True
    ({"n": 1}, {"n": 1.0}),
    ([1, 2], [1, 2.0]),
    ({"a": 1}, {"a": 1, "b": 2}),
    ([1, 2], [1, 2, 3]),
])
def test_tipi_diversi_sono_documenti_diversi(a, b):
    """Un `n_reps` float o booleano e' un errore dalla PGE #211: un valore che
    cambia tipo e' un documento diverso, e si scrive."""
    assert fsig.same_document(a, b) is False


@pytest.mark.parametrize("doc", [
    4, 4.0, True, None, "x", [1, [2, {"a": None}]], {"a": {"b": [1, 2]}},
])
def test_lo_stesso_documento_e_lo_stesso_documento(doc):
    assert fsig.same_document(doc, yaml.safe_load(yaml.safe_dump(doc))) is True


# ---------------------------------------------------------------------------
# already_on_disk: un documento che il file ha gia' non si riscrive
# ---------------------------------------------------------------------------

def test_lo_stesso_documento_con_altri_byte_non_si_riscrive(tmp_path):
    """La regola di DMGiulioRomano/mare-nostrum#15 (`cd0edf5`), e viene prima
    della firma.

    Il laboratorio scrive col suo dumper, PGE-ui con js-yaml: lo stesso
    documento da' byte diversi. Senza questa regola ogni render di PGE-ui
    farebbe dire «cambiato su disco» alla guardia del laboratorio su un
    documento che nessuno ha cambiato, e si porterebbe via la sua
    formattazione e i suoi commenti.
    """
    p = tmp_path / "a.yml"
    p.write_bytes(b"# dell'altro editor\na: 1\n")
    res = fsig.guard(p, "a: 1\n", "sha256:firma-di-un-altro-giro")
    assert res["ok"] is True and res["written"] is False
    assert res["signature"] == fsig.file_signature(p)
    # i byte dell'altro editor sono ancora li', commento compreso
    assert p.read_bytes() == b"# dell'altro editor\na: 1\n"


def test_un_documento_diverso_non_conta_come_gia_su_disco(tmp_path):
    p = tmp_path / "a.yml"
    p.write_bytes(b"a: 1\n")
    assert fsig.already_on_disk(p, "a: 2\n") == ""


def test_illeggibile_non_e_gia_su_disco(tmp_path):
    """`PUT /file` scrive anche dove il contenuto non e' detto sia YAML, e due
    file che non si parsano non sono lo stesso documento: sarebbe una
    scrittura saltata su un file da scrivere."""
    p = tmp_path / "a.yml"
    p.write_bytes(b"\xff\xfe non utf-8")
    assert fsig.already_on_disk(p, "a: 1\n") == ""
    assert fsig.already_on_disk(p, "\xff non yaml: [") == ""


def test_un_file_vuoto_non_e_un_file_illeggibile(tmp_path):
    """`yaml.safe_load("")` e' `None`, che e' un documento: il sentinella di
    `_load` esiste per non confonderlo con "non l'ho capito"."""
    p = tmp_path / "a.yml"
    p.write_bytes(b"")
    assert fsig.already_on_disk(p, "") == fsig.file_signature(p)
    assert fsig.already_on_disk(p, "a: 1\n") == ""


# ---------------------------------------------------------------------------
# guard: la regola in tre passi
# ---------------------------------------------------------------------------

def test_la_scrittura_passa_se_la_firma_coincide(tmp_path):
    p = tmp_path / "a.yml"
    sig = fsig.write_signed(p, "a: 1\n")
    res = fsig.guard(p, "a: 2\n", sig)
    assert res["ok"] is True and res["written"] is True
    assert p.read_bytes() == b"a: 2\n"
    # ...e la firma che torna e' quella dei byte appena scritti: senza, la
    # scrittura dopo manderebbe quella di prima e si rifiuterebbe da se'.
    assert fsig.guard(p, "a: 3\n", res["signature"])["written"] is True


def test_la_scrittura_e_rifiutata_se_la_firma_non_e_quella_letta(tmp_path):
    p = tmp_path / "a.yml"
    sig = fsig.write_signed(p, "a: 1\n")
    p.write_bytes(b"a: 99\n")                 # l'altro editor
    res = fsig.guard(p, "a: 2\n", sig)
    assert res["ok"] is False and res["changed"] is True
    assert "a.yml" in res["error"]
    # NON si e' scritto niente: il lavoro dell'altro editor e' intatto
    assert p.read_bytes() == b"a: 99\n"
    # e la firma che torna e' quella del file su disco, non quella letta
    assert res["signature"] == fsig.file_signature(p)


def test_sovrascrivi_e_la_decisione_presa(tmp_path):
    p = tmp_path / "a.yml"
    sig = fsig.write_signed(p, "a: 1\n")
    p.write_bytes(b"a: 99\n")
    res = fsig.guard(p, "a: 2\n", sig, overwrite=True)
    assert res["ok"] is True and res["written"] is True
    assert p.read_bytes() == b"a: 2\n"


def test_gia_su_disco_viene_prima_della_firma(tmp_path):
    """L'ordine e' la regola, non un dettaglio: un file che l'altro editor ha
    riscritto a modo suo, ma con lo stesso documento, non e' un file cambiato —
    quindi non c'e' niente da sovrascrivere ne' da chiedere."""
    p = tmp_path / "a.yml"
    sig = fsig.write_signed(p, "a: 1\n")
    p.write_bytes(b"a:   1   # riscritto a modo suo\n")
    res = fsig.guard(p, "a: 1\n", sig)
    assert res["ok"] is True and res["written"] is False
    assert b"riscritto a modo suo" in p.read_bytes()


# ---------------------------------------------------------------------------
# Il giro vero: PUT /file e POST /render
# ---------------------------------------------------------------------------

def _app(tmp_path):
    import server
    (tmp_path / "engine" / "src").mkdir(parents=True)
    (tmp_path / "engine" / "src" / "main.py").write_text("# stub\n")
    ws = tmp_path / "ws"
    ws.mkdir()
    return server.make_app(tmp_path / "engine", render_timeout=600.0,
                           workspace=ws), ws


def test_get_file_manda_la_firma_dei_byte_che_manda(tmp_path):
    app, ws = _app(tmp_path)
    c = app.test_client()
    (ws / "configs").mkdir(exist_ok=True)
    (ws / "configs" / "a.yml").write_bytes(b"a: 1\n")
    r = c.get("/file?kind=projects&name=a.yml")
    assert r.status_code == 200
    assert r.get_data() == b"a: 1\n"
    assert r.headers["X-PGE-Signature"] == fsig.signature_of(b"a: 1\n")
    # Un charset solo: `mimetype` vuole il tipo nudo, e scriverci il charset
    # dentro ne produceva due nello stesso header.
    assert r.headers["Content-Type"] == "text/plain; charset=utf-8"


def test_head_su_file_porta_la_firma_senza_il_corpo(tmp_path):
    """`fs.fileExists` fa una HEAD su questa route: Flask la serve con la
    stessa vista e il corpo tolto, quindi la firma c'e' e i byte no."""
    app, ws = _app(tmp_path)
    (ws / "configs").mkdir(exist_ok=True)
    (ws / "configs" / "a.yml").write_bytes(b"a: 1\n")
    r = app.test_client().head("/file?kind=projects&name=a.yml")
    assert r.status_code == 200
    assert r.headers["X-PGE-Signature"] == fsig.signature_of(b"a: 1\n")
    assert r.get_data() == b""


def test_la_firma_e_leggibile_anche_da_un_altra_origine(tmp_path):
    """`expose_headers`, o su `file://` la guardia resta disarmata.

    Di default il browser non lascia leggere a `fetch()` un header di risposta
    che non sia uno dei sei "safelisted". La pagina servita dal bridge e'
    same-origin e non se ne accorgerebbe; l'editor aperto come `file://` ha
    origine "null", cioe' e' cross-origin, ed e' proprio li' che leggeva
    `null`.
    """
    app, ws = _app(tmp_path)
    (ws / "configs").mkdir(exist_ok=True)
    (ws / "configs" / "a.yml").write_bytes(b"a: 1\n")
    r = app.test_client().get("/file?kind=projects&name=a.yml",
                              headers={"Origin": "null"})
    exposed = r.headers.get("Access-Control-Expose-Headers", "")
    assert "X-PGE-Signature" in exposed


def test_put_file_rifiuta_con_409_e_non_scrive(tmp_path):
    app, ws = _app(tmp_path)
    c = app.test_client()
    sig = c.put("/file?kind=projects&name=a.yml", data="a: 1\n").get_json()["signature"]
    (ws / "configs" / "a.yml").write_bytes(b"a: 99\n")       # l'altro editor
    r = c.put(f"/file?kind=projects&name=a.yml&signature={sig}", data="a: 2\n")
    assert r.status_code == 409
    body = r.get_json()
    # `changed` e' un campo a parte e non un errore da riconoscere dal testo:
    # la pagina lo deve distinguere da un guasto. Stessa forma del laboratorio.
    assert body["ok"] is False and body["changed"] is True
    assert (ws / "configs" / "a.yml").read_bytes() == b"a: 99\n"


def test_put_file_accetta_con_la_firma_giusta_o_sovrascrivendo(tmp_path):
    app, ws = _app(tmp_path)
    c = app.test_client()
    sig = c.put("/file?kind=projects&name=a.yml", data="a: 1\n").get_json()["signature"]
    r = c.put(f"/file?kind=projects&name=a.yml&signature={sig}", data="a: 2\n")
    assert r.status_code == 200 and r.get_json()["written"] is True
    (ws / "configs" / "a.yml").write_bytes(b"a: 99\n")
    r = c.put(f"/file?kind=projects&name=a.yml&signature={sig}&overwrite=1",
              data="a: 3\n")
    assert r.status_code == 200 and r.get_json()["written"] is True
    assert (ws / "configs" / "a.yml").read_bytes() == b"a: 3\n"


@pytest.mark.parametrize("spelling", ["0", "false", "no", "off", ""])
def test_overwrite_spento_resta_spento(tmp_path, spelling):
    """La presenza da sola non e' il criterio: `?overwrite=0` e
    `?overwrite=false` sono il modo in cui un client dice *no*, e letti come
    "c'e', quindi si'" sarebbero una sovrascrittura chiesta da nessuno."""
    app, ws = _app(tmp_path)
    c = app.test_client()
    sig = c.put("/file?kind=projects&name=a.yml", data="a: 1\n").get_json()["signature"]
    (ws / "configs" / "a.yml").write_bytes(b"a: 99\n")
    r = c.put(f"/file?kind=projects&name=a.yml&signature={sig}"
              f"&overwrite={spelling}", data="a: 2\n")
    assert r.status_code == 409
    assert (ws / "configs" / "a.yml").read_bytes() == b"a: 99\n"


def test_put_file_senza_firma_scrive_come_prima(tmp_path):
    """Il `Save as` e il progetto nuovo: nessuna lettura dietro, niente da
    confrontare. E' anche il comportamento di prima di questa issue."""
    app, ws = _app(tmp_path)
    c = app.test_client()
    (ws / "configs").mkdir(exist_ok=True)
    (ws / "configs" / "a.yml").write_bytes(b"a: 1\n")
    r = c.put("/file?kind=projects&name=a.yml", data="a: 2\n")
    assert r.status_code == 200 and r.get_json()["written"] is True


def test_render_rifiuta_prima_di_scrivere_il_config(tmp_path):
    """La guardia sta prima della scrittura, e la scrittura prima del motore.

    Rifiutata, `configs/<basename>.yml` e' ancora quello dell'altro editor e il
    motore non e' partito: «il render non parte finche' la domanda non ha avuto
    risposta».
    """
    app, ws = _app(tmp_path)
    c = app.test_client()
    sig = c.put("/file?kind=projects&name=a.yml", data="a: 1\n").get_json()["signature"]
    (ws / "configs" / "a.yml").write_bytes(b"streams: []\n")   # l'altro editor
    r = c.post("/render", json={"yamlBasename": "a",
                                "yamlContent": "a: 2\n",
                                "signature": sig})
    assert r.status_code == 409
    body = r.get_json()
    assert body["ok"] is False and body["changed"] is True
    assert body["name"] == "a.yml"
    assert (ws / "configs" / "a.yml").read_bytes() == b"streams: []\n"


def test_render_sovrascrive_su_decisione(tmp_path):
    """E qui il 409 non c'e' piu': il config si scrive, e il render prosegue
    (fino al venv assente, che e' un evento dello stream, non un rifiuto)."""
    app, ws = _app(tmp_path)
    c = app.test_client()
    sig = c.put("/file?kind=projects&name=a.yml", data="a: 1\n").get_json()["signature"]
    (ws / "configs" / "a.yml").write_bytes(b"streams: []\n")
    r = c.post("/render", json={"yamlBasename": "a", "yamlContent": "a: 2\n",
                                "signature": sig, "overwrite": True})
    assert r.status_code == 200
    r.close()
    assert (ws / "configs" / "a.yml").read_bytes() == b"a: 2\n"


def test_render_non_riscrive_un_documento_che_il_file_ha_gia(tmp_path):
    """Il caso che la regola esiste per: `/render` riscrive il config a ogni
    giro, anche su un documento che nessuno ha toccato. Scriverlo a modo
    proprio farebbe dire «cambiato su disco» alla guardia del laboratorio dopo
    ogni render di PGE-ui, e si porterebbe via i suoi commenti."""
    app, ws = _app(tmp_path)
    c = app.test_client()
    (ws / "configs").mkdir(exist_ok=True)
    altro = b"# del laboratorio\nstreams: []\n"
    (ws / "configs" / "a.yml").write_bytes(altro)
    r = c.post("/render", json={"yamlBasename": "a",
                                "yamlContent": "streams: []\n",
                                "signature": "sha256:di-un-altro-giro"})
    assert r.status_code == 200
    first = next(r.response).decode()
    r.close()
    assert (ws / "configs" / "a.yml").read_bytes() == altro
    # e la firma che torna e' quella dei byte che ci sono
    ev = yaml.safe_load(first)
    assert ev["type"] == "file-signatures"
    assert ev["signatures"] == {"a.yml": fsig.signature_of(altro)}


def test_render_manda_la_firma_di_cio_che_ha_scritto(tmp_path):
    """Primo evento dello stream, e una mappa per nome: i file di un render
    saranno N (il master piu' gli stream importati, #184), e l'evento non
    cambiera' forma."""
    app, ws = _app(tmp_path)
    c = app.test_client()
    r = c.post("/render", json={"yamlBasename": "a", "yamlContent": "a: 2\n"})
    assert r.status_code == 200
    ev = yaml.safe_load(next(r.response).decode())
    r.close()
    assert ev == {"type": "file-signatures",
                  "signatures": {"a.yml": fsig.signature_of(b"a: 2\n")}}


def test_render_senza_yaml_content_non_firma_niente(tmp_path):
    """Non ha scritto, quindi non ha niente da far prendere il posto della
    firma letta: l'evento non parte affatto."""
    app, ws = _app(tmp_path)
    c = app.test_client()
    (ws / "configs").mkdir(exist_ok=True)
    (ws / "configs" / "a.yml").write_bytes(b"a: 1\n")
    r = c.post("/render", json={"yamlBasename": "a"})
    assert r.status_code == 200
    first = yaml.safe_load(next(r.response).decode())
    r.close()
    assert first["type"] != "file-signatures"


# ---------------------------------------------------------------------------
# La guardia passa dalla stessa funzione in tutte e due le route
# ---------------------------------------------------------------------------

def test_le_due_route_che_scrivono_passano_dalla_stessa_regola():
    """In questo repo una regola scritta due volte e' gia' divergita: il
    basename di `/render` reimplementava `safe_resolve` piu' debole (niente
    `\\`, niente punto iniziale, e il NUL faceva 500). La guardia e' una
    funzione sola, e nessuna delle due route ne tiene una copia."""
    import inspect, re
    import server
    src = inspect.getsource(server)
    # `guard` arriva come `signature_guard`: l'unico nome con cui le route lo
    # chiamano, e lo chiamano tutte e due.
    assert len(re.findall(r"signature_guard\(", src)) == 2, (
        "una delle due route ha smesso di passare da file_signature.guard, "
        "oppure ne e' comparsa una terza che va aggiunta al conto")
    # ...e nessuna delle due ricalcola la firma per conto suo.
    assert "hashlib" not in src, (
        "la firma si calcola in file_signature.py: una seconda copia qui "
        "sarebbe libera di divergere dalla convenzione del laboratorio")
