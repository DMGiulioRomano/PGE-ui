"""Il terzo backend audio del motore raggiungibile dalla UI (PGE-ui #150).

Il motore rende con tre backend (`--renderer numpy|csound|supercollider`,
PGE #228 / PR #240) e la UI ne offriva uno solo, cablato. Qui il lato bridge
delle tre cose che servono perche' la scelta arrivi al popover senza diventare
una copia tenuta a mano:

* l'ELENCO dei backend, letto dal sorgente del motore
  (`engine_introspect.engine_renderer_types`, AST su
  `RendererFactory._VALID_TYPES`) — lo stesso elenco che `pge.api.renderer_types()`
  restituisce a chi lo importa, confrontato dalla parita';
* la DISPONIBILITA' di ciascuno (`render_pipeline.renderer_availability`):
  csound e scsynth devono stare nel PATH del bridge, che e' quello del
  sottoprocesso, e SuperCollider vuole in piu' la SynthDef compilata o
  compilabile. Senza, il motore esce 1 con `*NotFoundError` — messaggio pulito,
  ma un render perso: il popover lo deve dire prima;
* le route: `GET /renderers`, la riga `renderers` di `/diagnose`, e `/render`
  che rifiuta un nome che il motore non conosce PRIMA di riscrivere il config.

Nessun test qui lancia il motore. I binari sono eseguibili finti in una
cartella messa sul PATH: e' il modo piu' onesto di chiedere a
`shutil.which` quello che il sottoprocesso vedrebbe.
"""

import json
import os
from pathlib import Path

import pytest

import engine_corpus
import engine_introspect as ei
import render_pipeline as rp


# ---------------------------------------------------------------------------
# Stub del motore
# ---------------------------------------------------------------------------

def _stub_factory(root, body=None, layout="pge"):
    """Un renderer_factory.py minimo. `body` e' il corpo della classe."""
    d = (root / "src" / "pge" / "rendering") if layout == "pge" \
        else (root / "src" / "rendering")
    d.mkdir(parents=True, exist_ok=True)
    if body is None:
        body = "    _VALID_TYPES = {'numpy', 'csound', 'supercollider'}\n"
    (d / "renderer_factory.py").write_text(
        "from pge.rendering.audio_renderer import AudioRenderer  # mai importato\n"
        "\n"
        "class RendererFactory:\n" + body +
        "\n"
        "    @classmethod\n"
        "    def available_types(cls):\n"
        "        return sorted(cls._VALID_TYPES)\n",
        encoding="utf-8")
    return d / "renderer_factory.py"


def _stub_sc(root, source="supercollider/pge_grain.scd",
             sdir="supercollider", name="pgeGrain"):
    """I due moduli SuperCollider, con le sole costanti che il bridge legge."""
    d = root / "src" / "pge" / "rendering"
    d.mkdir(parents=True, exist_ok=True)
    (d / "supercollider_renderer.py").write_text(
        "import numpy as np  # mai importato dal parser\n"
        f"DEFAULT_SYNTHDEF_SOURCE = {source!r}\n"
        f"DEFAULT_SYNTHDEF_DIR = {sdir!r}\n",
        encoding="utf-8")
    (d / "sc_score_writer.py").write_text(
        "import numpy as np\n"
        f"SYNTH_NAME = {name!r}\n",
        encoding="utf-8")


def _bump_mtime(p, seconds=1):
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + seconds * 1_000_000_000))


def _fake_bin(folder, *names):
    """Eseguibili finti in `folder`: `shutil.which` li trova come quelli veri."""
    folder.mkdir(parents=True, exist_ok=True)
    for n in names:
        p = folder / n
        p.write_text("#!/bin/sh\nexit 0\n")
        p.chmod(0o755)
    return folder


def _which_from(folder):
    """Un `which` limitato a una cartella, per i test puri."""
    import shutil
    return lambda name: shutil.which(name, path=str(folder))


# ---------------------------------------------------------------------------
# engine_renderer_types — l'elenco dal sorgente del motore
# ---------------------------------------------------------------------------

def test_engine_renderer_types_reads_the_factory_set(tmp_path):
    """`_VALID_TYPES` e' un insieme letterale, e `available_types()` lo
    restituisce ordinato: l'elenco che il popover disegna e' quello, non
    l'ordine in cui l'insieme e' scritto nel sorgente."""
    _stub_factory(tmp_path)
    assert ei.engine_renderer_types(tmp_path) == ["csound", "numpy", "supercollider"]


def test_engine_renderer_types_annotated(tmp_path):
    """`_VALID_TYPES: set = {...}` e' un AnnAssign: la grafia annotata e' stile
    di casa nel motore, e `_assigned_value` la copre per tutte le letture."""
    _stub_factory(tmp_path, "    _VALID_TYPES: set = {'numpy', 'csound'}\n")
    assert ei.engine_renderer_types(tmp_path) == ["csound", "numpy"]


def test_engine_renderer_types_legacy_layout(tmp_path):
    """Prima di PGE #162 il pacchetto stava in src/rendering/."""
    _stub_factory(tmp_path, "    _VALID_TYPES = {'numpy', 'csound'}\n", layout="flat")
    assert ei.engine_renderer_types(tmp_path) == ["csound", "numpy"]


def test_engine_renderer_types_missing_is_empty(tmp_path):
    """Nessun factory: `[]` = "non lo so". Chi chiama tiene il comportamento
    storico (numpy, il default del bridge), non si inventa un elenco."""
    assert ei.engine_renderer_types(tmp_path) == []


def test_engine_renderer_types_only_inside_the_class(tmp_path):
    """L'elenco e' un attributo di `RendererFactory`: un omonimo a livello di
    modulo, o dentro un'altra classe, non e' l'insieme che il motore valida."""
    d = tmp_path / "src" / "pge" / "rendering"
    d.mkdir(parents=True)
    (d / "renderer_factory.py").write_text(
        "_VALID_TYPES = {'numpy'}\n"
        "class Altro:\n"
        "    _VALID_TYPES = {'csound'}\n",
        encoding="utf-8")
    assert ei.engine_renderer_types(tmp_path) == []


@pytest.mark.parametrize("body", [
    "    _VALID_TYPES = set(_ALTRI)\n",           # espressione, non letterale
    "    _VALID_TYPES = {'numpy', 3}\n",          # un non-stringa
    "    _VALID_TYPES = set()\n",                 # vuoto
])
def test_engine_renderer_types_non_literal_is_empty(tmp_path, body):
    """Il nome c'e' ma non e' un insieme di stringhe letterali: la risposta e'
    "non lo so", non un elenco mezzo letto."""
    _stub_factory(tmp_path, body)
    assert ei.engine_renderer_types(tmp_path) == []


def test_engine_renderer_types_sees_a_live_update(tmp_path):
    """Cache invalidata sull'mtime, come le altre letture: un `git pull` nel
    repo fratello sotto un `make serve` acceso e' esattamente l'evento che
    aggiunge un backend — e' cosi' che `supercollider` e' arrivato."""
    f = _stub_factory(tmp_path, "    _VALID_TYPES = {'numpy', 'csound'}\n")
    assert ei.engine_renderer_types(tmp_path) == ["csound", "numpy"]
    _stub_factory(tmp_path)
    _bump_mtime(f)
    assert ei.engine_renderer_types(tmp_path) == ["csound", "numpy", "supercollider"]


def test_engine_renderer_types_on_the_real_engine():
    """Canarino della #132 su questa lettura. Un rename a monte (la classe, il
    file, l'attributo) non romperebbe niente di visibile: il bridge tornerebbe
    `[]` e il popover ricadrebbe sul solo numpy, zitto. La parita' confronta
    l'elenco con `pge.api.renderer_types()`; qui basta che non sia vuoto e che
    contenga il default della UI."""
    err = engine_corpus.corpus_error()
    assert err is None, err
    reason = engine_corpus.skip_reason()
    if reason is not None:
        pytest.skip(reason)
    types = ei.engine_renderer_types(Path(engine_corpus.ENGINE_ROOT))
    assert types, "il bridge non legge piu' l'elenco dei backend del motore"
    assert "numpy" in types, (
        f"{types}: numpy e' il default della UI (`renderRenderer`) e del "
        "bridge — se il motore l'ha tolto, il default va cambiato qui")


# ---------------------------------------------------------------------------
# engine_sc_synthdef — dove il motore cerca la SynthDef
# ---------------------------------------------------------------------------

def test_engine_sc_synthdef_reads_the_three_constants(tmp_path):
    _stub_sc(tmp_path)
    assert ei.engine_sc_synthdef(tmp_path) == {
        "source": "supercollider/pge_grain.scd",
        "dir": "supercollider",
        "name": "pgeGrain",
    }


def test_engine_sc_synthdef_partial_is_none(tmp_path):
    """Una costante che manca e' "non lo so" per tutte e tre: una SynthDef di
    cui si conosce il sorgente ma non il nome compilato non si sa controllare."""
    _stub_sc(tmp_path)
    (tmp_path / "src" / "pge" / "rendering" / "sc_score_writer.py").write_text(
        "OTHER = 1\n")
    assert ei.engine_sc_synthdef(tmp_path) is None


def test_engine_sc_synthdef_missing_is_none(tmp_path):
    assert ei.engine_sc_synthdef(tmp_path) is None


def test_engine_sc_synthdef_on_the_real_engine():
    """Il sorgente che le costanti nominano esiste davvero nel checkout, dove il
    sottoprocesso lo cerchera' (cwd=root). Se il motore spostasse il `.scd`
    senza aggiornare il default, o rinominasse una costante, il popover
    direbbe "disponibile" su un render che muore."""
    err = engine_corpus.corpus_error()
    assert err is None, err
    reason = engine_corpus.skip_reason()
    if reason is not None:
        pytest.skip(reason)
    root = Path(engine_corpus.ENGINE_ROOT)
    sd = ei.engine_sc_synthdef(root)
    assert sd is not None, "il bridge non legge piu' dove sta la SynthDef"
    assert (root / sd["source"]).is_file(), sd


def test_engine_binaries_on_the_real_engine():
    """I nomi dei binari che `renderer_availability` cerca nel PATH sono
    trascritti (`RENDERER_BINARIES`): il motore li scrive come default dentro
    una chiamata, non come costante di modulo, e una lettura AST di
    `sc_config.get('scsynth_bin', ...)` sarebbe piu' fragile della copia.
    Questa e' la guardia che la tiene onesta: ogni nome deve comparire come
    costante di stringa (non in un commento) nel modulo del renderer che lo
    lancia — un rename a monte fa rosso qui invece di un "disponibile" falso."""
    err = engine_corpus.corpus_error()
    assert err is None, err
    reason = engine_corpus.skip_reason()
    if reason is not None:
        pytest.skip(reason)
    import ast
    rdir = Path(engine_corpus.ENGINE_ROOT) / "src" / "pge" / "rendering"
    modules = {"csound": rdir / "csound_renderer.py",
               "supercollider": rdir / "supercollider_renderer.py"}
    for renderer, binaries in rp.RENDERER_BINARIES.items():
        tree = ast.parse(modules[renderer].read_text(encoding="utf-8"))
        consts = {n.value for n in ast.walk(tree)
                  if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        for b in binaries:
            assert b in consts, f"{modules[renderer].name} non lancia piu' {b!r}"
    assert rp.SC_COMPILER in {
        n.value for n in ast.walk(ast.parse(
            modules["supercollider"].read_text(encoding="utf-8")))
        if isinstance(n, ast.Constant) and isinstance(n.value, str)}


# ---------------------------------------------------------------------------
# renderer_availability — cosa manca prima che il motore esca 1
# ---------------------------------------------------------------------------

SD = {"source": "supercollider/pge_grain.scd", "dir": "supercollider",
      "name": "pgeGrain"}


def _avail(root, names, binfolder, synthdef=SD):
    rows = rp.renderer_availability(root, names, which=_which_from(binfolder),
                                    synthdef=synthdef)
    return {r["name"]: r for r in rows}


def test_availability_keeps_the_engine_order(tmp_path):
    names = ["csound", "numpy", "supercollider"]
    rows = rp.renderer_availability(tmp_path, names,
                                    which=_which_from(tmp_path / "bin"),
                                    synthdef=SD)
    assert [r["name"] for r in rows] == names


def test_numpy_needs_no_binary(tmp_path):
    a = _avail(tmp_path, ["numpy"], tmp_path / "vuota")
    assert a["numpy"]["available"] is True


def test_csound_needs_csound_on_the_path(tmp_path):
    a = _avail(tmp_path, ["csound"], tmp_path / "vuota")
    assert a["csound"]["available"] is False
    assert "csound" in a["csound"]["detail"]
    b = _avail(tmp_path, ["csound"], _fake_bin(tmp_path / "bin", "csound"))
    assert b["csound"]["available"] is True


def test_supercollider_needs_scsynth(tmp_path):
    """Senza scsynth il motore alza SuperColliderNotFoundError al primo grano:
    niente SynthDef tiene in piedi un render senza server."""
    bins = _fake_bin(tmp_path / "bin", "sclang")
    a = _avail(tmp_path, ["supercollider"], bins)
    assert a["supercollider"]["available"] is False
    assert "scsynth" in a["supercollider"]["detail"]


def test_supercollider_with_a_compiled_synthdef_needs_no_sclang(tmp_path):
    """sclang serve solo a compilare la SynthDef, e una volta: col `.scsyndef`
    gia' li' (e non piu' vecchio del sorgente) basta scsynth."""
    sc = tmp_path / "supercollider"
    sc.mkdir()
    (sc / "pge_grain.scd").write_text("// sorgente\n")
    (sc / "pgeGrain.scsyndef").write_bytes(b"SCgf")
    _bump_mtime(sc / "pgeGrain.scsyndef")
    a = _avail(tmp_path, ["supercollider"], _fake_bin(tmp_path / "bin", "scsynth"))
    assert a["supercollider"]["available"] is True, a


def test_supercollider_first_render_needs_sclang(tmp_path):
    """Nessun `.scsyndef`: il motore lancia sclang per compilarlo. Senza, esce
    con SuperColliderNotFoundError — ed e' il caso di chi ha installato il solo
    server (su Debian `supercollider-server` non porta sclang)."""
    sc = tmp_path / "supercollider"
    sc.mkdir()
    (sc / "pge_grain.scd").write_text("// sorgente\n")
    a = _avail(tmp_path, ["supercollider"], _fake_bin(tmp_path / "bin", "scsynth"))
    assert a["supercollider"]["available"] is False
    assert "sclang" in a["supercollider"]["detail"]
    b = _avail(tmp_path, ["supercollider"],
               _fake_bin(tmp_path / "bin2", "scsynth", "sclang"))
    assert b["supercollider"]["available"] is True, b


def test_supercollider_without_sclang_names_a_remedy_that_works(tmp_path):
    """Il testo e' il rimedio che il popover mostra sul bottone spento, e
    compare proprio quando sclang NON c'e': non puo' mandare a lanciare
    `make sc-synthdef`, che nel motore controlla sclang per prima cosa e si
    ferma. I due rimedi veri sono installare sclang o portare nel motore un
    `.scsyndef` compilato altrove — nella cartella dove il sottoprocesso lo
    cerchera', che e' quella che il testo deve nominare."""
    sc = tmp_path / "supercollider"
    sc.mkdir()
    (sc / "pge_grain.scd").write_text("// sorgente\n")
    detail = _avail(tmp_path, ["supercollider"],
                    _fake_bin(tmp_path / "bin", "scsynth"))["supercollider"]["detail"]
    assert "make sc-synthdef" not in detail, detail
    assert "install sclang" in detail, detail
    assert "pgeGrain.scsyndef" in detail and "supercollider/" in detail, detail


def test_supercollider_stale_synthdef_says_it_is_stale(tmp_path):
    """Un `.scsyndef` piu' vecchio del sorgente non e' "non ancora compilato":
    c'e', e il motore lo cancella per ricompilarlo. Il testo deve dire quale
    dei due casi e', o manda a cercare un file che sta li'."""
    sc = tmp_path / "supercollider"
    sc.mkdir()
    (sc / "pgeGrain.scsyndef").write_bytes(b"SCgf")
    (sc / "pge_grain.scd").write_text("// sorgente\n")
    _bump_mtime(sc / "pge_grain.scd")
    detail = _avail(tmp_path, ["supercollider"],
                    _fake_bin(tmp_path / "bin", "scsynth"))["supercollider"]["detail"]
    assert "older than" in detail, detail
    assert "isn't compiled" not in detail, detail
    assert "make sc-synthdef" not in detail, detail


def test_supercollider_stale_synthdef_needs_sclang_too(tmp_path):
    """Un `.scsyndef` piu' vecchio del sorgente il motore lo ricompila (la regola
    di un Makefile, `_needs_compile`): non conta come compilato."""
    sc = tmp_path / "supercollider"
    sc.mkdir()
    (sc / "pgeGrain.scsyndef").write_bytes(b"SCgf")
    (sc / "pge_grain.scd").write_text("// sorgente\n")
    _bump_mtime(sc / "pge_grain.scd")
    a = _avail(tmp_path, ["supercollider"], _fake_bin(tmp_path / "bin", "scsynth"))
    assert a["supercollider"]["available"] is False
    assert "sclang" in a["supercollider"]["detail"]


def test_supercollider_compiled_without_source_is_enough(tmp_path):
    """Un'installazione che spedisce il solo compilato: senza sorgente il
    compilato vale comunque, come nel motore."""
    sc = tmp_path / "supercollider"
    sc.mkdir()
    (sc / "pgeGrain.scsyndef").write_bytes(b"SCgf")
    a = _avail(tmp_path, ["supercollider"], _fake_bin(tmp_path / "bin", "scsynth"))
    assert a["supercollider"]["available"] is True, a


def test_supercollider_nothing_to_compile_from(tmp_path):
    """Ne' compilato ne' sorgente: sclang non avrebbe niente da compilare."""
    a = _avail(tmp_path, ["supercollider"],
               _fake_bin(tmp_path / "bin", "scsynth", "sclang"))
    assert a["supercollider"]["available"] is False
    assert "pge_grain.scd" in a["supercollider"]["detail"]


def test_supercollider_paths_resolve_against_the_engine_root(tmp_path):
    """I default del motore sono relativi al CWD del sottoprocesso, che e' il
    root (`rs.start(cmd, root)`): e' li' che vanno cercati, non nella cwd del
    bridge — che da #165 e' la cartella del brano."""
    sc = tmp_path / "engine" / "supercollider"
    sc.mkdir(parents=True)
    (sc / "pgeGrain.scsyndef").write_bytes(b"SCgf")
    a = _avail(tmp_path / "engine", ["supercollider"],
               _fake_bin(tmp_path / "bin", "scsynth"))
    assert a["supercollider"]["available"] is True, a


def test_supercollider_with_unknown_synthdef_checks_scsynth_only(tmp_path):
    """Costanti della SynthDef illeggibili: si controlla il server e si dice
    che la SynthDef non e' stata controllata. Rifiutare il backend per un
    layout che non riconosciamo sarebbe inventare un guasto."""
    a = _avail(tmp_path, ["supercollider"], _fake_bin(tmp_path / "bin", "scsynth"),
               synthdef=None)
    assert a["supercollider"]["available"] is True
    assert "not checked" in a["supercollider"]["detail"]


def test_an_unknown_backend_is_not_refused(tmp_path):
    """Un quarto backend aggiunto a monte: il bridge non sa cosa gli serve, e
    lo dice con `None` — "non lo so", non "non c'e'". La UI non lo disabilita:
    a rifiutarlo, se serve, sara' il motore, col suo messaggio."""
    a = _avail(tmp_path, ["futuro"], tmp_path / "vuota")
    assert a["futuro"]["available"] is None


# ---------------------------------------------------------------------------
# Le route
# ---------------------------------------------------------------------------

def _root(tmp_path, factory=True):
    (tmp_path / "src").mkdir(parents=True, exist_ok=True)
    (tmp_path / "src" / "main.py").write_text("# stub\n")
    for d in ("configs", "refs", "output", "cache"):
        (tmp_path / d).mkdir(exist_ok=True)
    if factory:
        _stub_factory(tmp_path)
        _stub_sc(tmp_path)
    vb = tmp_path / ".venv" / "bin"
    vb.mkdir(parents=True, exist_ok=True)
    py = vb / "python"
    py.write_text("#!/bin/sh\nexit 0\n")
    py.chmod(0o755)
    return tmp_path


def test_renderers_endpoint(tmp_path, monkeypatch):
    """Il PATH del bridge e' quello del sottoprocesso (Popen eredita l'ambiente):
    la risposta si misura li'."""
    import server
    root = _root(tmp_path / "engine")
    monkeypatch.setenv("PATH", str(_fake_bin(tmp_path / "bin", "csound")))
    body = server.make_app(root, render_timeout=600.0).test_client() \
        .get("/renderers").get_json()
    assert body["ok"] is True
    got = {r["name"]: r["available"] for r in body["renderers"]}
    assert [r["name"] for r in body["renderers"]] == ["csound", "numpy", "supercollider"]
    assert got == {"csound": True, "numpy": True, "supercollider": False}


def test_renderers_endpoint_rereads_the_path(tmp_path, monkeypatch):
    """Nessuna cache sulla disponibilita': chi installa SuperCollider col bridge
    acceso lo vede alla riapertura del popover, senza riavviare niente."""
    import server
    root = _root(tmp_path / "engine")
    sc = root / "supercollider"
    sc.mkdir()
    (sc / "pgeGrain.scsyndef").write_bytes(b"SCgf")
    bins = tmp_path / "bin"
    bins.mkdir()
    monkeypatch.setenv("PATH", str(bins))
    client = server.make_app(root, render_timeout=600.0).test_client()
    first = {r["name"]: r["available"] for r in client.get("/renderers").get_json()["renderers"]}
    assert first["supercollider"] is False
    _fake_bin(bins, "scsynth")
    again = {r["name"]: r["available"] for r in client.get("/renderers").get_json()["renderers"]}
    assert again["supercollider"] is True


def test_renderers_endpoint_without_engine_list(tmp_path):
    """Motore di cui non si legge l'elenco: `[]`, e la UI resta sul numpy di
    sempre invece di offrire nomi inventati."""
    import server
    root = _root(tmp_path, factory=False)
    body = server.make_app(root, render_timeout=600.0).test_client() \
        .get("/renderers").get_json()
    assert body == {"ok": True, "renderers": []}


def test_diagnose_names_the_renderers(tmp_path, monkeypatch):
    """Una riga sola, e verde quando l'elenco si legge: un backend opzionale che
    manca non e' un guasto del sistema, e una riga rossa per csound a ogni avvio
    (su Fedora non e' nemmeno nei repo) accenderebbe il toast "Diagnostic
    issues" per tutti. Il dettaglio dice comunque chi manca e perche'."""
    import server
    root = _root(tmp_path / "engine")
    monkeypatch.setenv("PATH", str(tmp_path / "vuota"))
    checks = server.make_app(root, render_timeout=600.0).test_client() \
        .get("/diagnose").get_json()["checks"]
    row = next(c for c in checks if c["label"] == "renderers")
    assert row["ok"] is True
    assert "numpy" in row["detail"]
    assert "csound" in row["detail"] and "supercollider" in row["detail"]
    assert "csound not on PATH" in row["detail"]


def test_diagnose_flags_an_unreadable_renderer_list(tmp_path):
    """Qui invece e' un guasto: il popover non ha un elenco da offrire, e il
    motore quasi certamente ha cambiato forma sotto il bridge."""
    import server
    root = _root(tmp_path, factory=False)
    checks = server.make_app(root, render_timeout=600.0).test_client() \
        .get("/diagnose").get_json()["checks"]
    row = next(c for c in checks if c["label"] == "renderers")
    assert row["ok"] is False


def _argv_line(client, payload):
    r = client.post("/render", json=payload)
    assert r.status_code == 200, r.get_data(as_text=True)
    for raw in r.get_data(as_text=True).splitlines():
        ev = json.loads(raw)
        if ev.get("type") == "log" and str(ev.get("line", "")).startswith("$ "):
            return ev["line"]
    raise AssertionError("nessuna riga argv nello stream NDJSON")


def test_render_forwards_the_chosen_renderer(tmp_path):
    """La scelta del popover arriva in argv verbatim, e senza i flag Csound:
    quelli sono del solo ramo csound (`build_render_command`). La SynthDef non
    ha flag: i default del motore sono relativi al cwd, che e' il root."""
    import server
    root = _root(tmp_path)
    client = server.make_app(root, render_timeout=600.0).test_client()
    line = _argv_line(client, {"yamlBasename": "P", "yamlContent": "streams: []\n",
                               "renderer": "supercollider"})
    argv = line.split()
    assert argv[argv.index("--renderer") + 1] == "supercollider"
    assert "--orc-path" not in argv and "--ssdir" not in argv


def test_render_refuses_a_renderer_the_engine_does_not_offer(tmp_path):
    """Un nome ignoto fa uscire il motore con InvalidRendererError, e il config
    sarebbe gia' stato riscritto. Rifiutato prima, come il formato."""
    import server
    root = _root(tmp_path)
    client = server.make_app(root, render_timeout=600.0).test_client()
    r = client.post("/render", json={"yamlBasename": "P",
                                     "yamlContent": "streams: []\n",
                                     "renderer": "fantasma"})
    assert r.status_code == 400
    body = r.get_json()
    assert body["ok"] is False and "fantasma" in body["error"]
    assert "supercollider" in body["error"]      # dice cosa c'e'
    assert not (root / "configs" / "P.yml").exists()


@pytest.mark.parametrize("bad", [None, "", 3, ["numpy"]])
def test_render_refuses_a_renderer_that_is_not_a_name(tmp_path, bad):
    """Un non-nome finirebbe in argv (`None` e' un TypeError di Popen dentro il
    generatore): rifiutato anche quando l'elenco del motore non si legge."""
    import server
    root = _root(tmp_path, factory=False)
    client = server.make_app(root, render_timeout=600.0).test_client()
    r = client.post("/render", json={"yamlBasename": "P",
                                     "yamlContent": "streams: []\n",
                                     "renderer": bad})
    assert r.status_code == 400, bad
    assert not (root / "configs" / "P.yml").exists()


def test_render_without_engine_list_forwards_verbatim(tmp_path):
    """Senza elenco il bridge non sa cosa rifiutare: il nome passa e a decidere
    e' il motore, che e' il comportamento di prima di questa modifica."""
    import server
    root = _root(tmp_path, factory=False)
    client = server.make_app(root, render_timeout=600.0).test_client()
    line = _argv_line(client, {"yamlBasename": "P", "yamlContent": "streams: []\n",
                               "renderer": "csound"})
    argv = line.split()
    assert argv[argv.index("--renderer") + 1] == "csound"


def test_render_default_renderer_is_still_numpy(tmp_path):
    """Un corpo senza `renderer` (un editor piu' vecchio) rende come prima."""
    import server
    root = _root(tmp_path)
    client = server.make_app(root, render_timeout=600.0).test_client()
    line = _argv_line(client, {"yamlBasename": "P", "yamlContent": "streams: []\n"})
    argv = line.split()
    assert argv[argv.index("--renderer") + 1] == "numpy"
