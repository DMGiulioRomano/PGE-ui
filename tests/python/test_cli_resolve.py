"""Tests per la risoluzione di motore e workspace (#165).

Il bridge si lancia da una cartella qualunque, quindi i due default di un
comando che si assumeva lanciato da dentro il repo non bastano piu':

- il workspace assente era "= --root", cioe' i brani dentro il checkout del
  motore; adesso e' la cwd;
- `--root` aveva come default la stringa relativa `../PythonGranularEngine`,
  che da una cartella qualunque non punta a niente; adesso il motore si
  dichiara, con la precedenza del Makefile.

Tutto quel che si prova qui e' PURO: nessun Flask, nessuna app, nessuna porta.
E' il punto: la risposta a "quale motore" si legge prima che qualcosa parta, e
un traceback li' non e' un messaggio.

Una nota che vale per ogni caso: `env` si passa SEMPRE esplicito. Il Makefile
esporta `PGE_ENGINE_ROOT` a pytest (tests-python), quindi con `env` di default
questi test leggerebbero il motore vero della macchina invece della fixture.
"""

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import server


REPO = Path(__file__).resolve().parents[2]


def _engine(path: Path) -> Path:
    """Un checkout del motore quanto basta: la sua firma e' src/main.py."""
    (path / "src").mkdir(parents=True, exist_ok=True)
    (path / "src" / "main.py").write_text("# stub\n")
    return path


def _repo(path: Path) -> Path:
    """Una radice di repo git: la risalita si ferma qui."""
    path.mkdir(parents=True, exist_ok=True)
    (path / ".git").mkdir(exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# resolve_engine_root — la precedenza, e chi l'ha detto
# ---------------------------------------------------------------------------

def test_flag_wins_over_env(tmp_path):
    """Punto 1 batte punto 2, come nel Makefile (`ROOT=` da riga di comando
    batte `PGE_ENGINE_ROOT`)."""
    flag = _engine(tmp_path / "flag")
    env_root = _engine(tmp_path / "env")

    root, source = server.resolve_engine_root(
        cli_root=str(flag),
        env={server.ENGINE_ENV_VAR: str(env_root)},
        cwd=tmp_path)

    assert root == flag.resolve()
    assert source == "--root"


def test_env_when_there_is_no_flag(tmp_path):
    """Punto 2: la riga di `.envrc` che rende il motore una proprieta' della
    cartella, non un argomento da riscrivere a ogni lancio."""
    env_root = _engine(tmp_path / "env")

    root, source = server.resolve_engine_root(
        env={server.ENGINE_ENV_VAR: str(env_root)}, cwd=tmp_path)

    assert root == env_root.resolve()
    assert source == server.ENGINE_ENV_VAR


def test_empty_env_is_not_a_declaration(tmp_path):
    """`PGE_ENGINE_ROOT=` (il modo piu' comune di annullarne uno ereditato) e'
    assente, non una cartella che si chiama ''.

    E' la lettura del Makefile: `$(if $(PGE_ENGINE_ROOT),...)` sulla stringa
    vuota e' falso. Due letture diverse della stessa variabile nello stesso
    repo si vedono solo quando una delle due sbaglia."""
    repo = _repo(tmp_path / "brano")
    _engine(repo / "engine")

    root, source = server.resolve_engine_root(
        env={server.ENGINE_ENV_VAR: "   "}, cwd=repo)

    assert root == (repo / "engine").resolve()
    assert source == "engine/"


def test_fallback_finds_engine_walking_up(tmp_path):
    """Punto 3: il repo che il submodule ce l'ha ma l'`.envrc` no."""
    repo = _repo(tmp_path / "brano")
    _engine(repo / "engine")
    deep = repo / "materiali" / "bozze"
    deep.mkdir(parents=True)

    root, source = server.resolve_engine_root(env={}, cwd=deep)

    assert root == (repo / "engine").resolve()
    assert source == "engine/"


def test_fallback_stops_at_the_git_root(tmp_path):
    """La risalita si ferma alla radice del repo, non a quella del filesystem.

    Un `engine/` che sta SOPRA il repo non l'ha dichiarato nessuno per questo
    brano: prenderlo sarebbe il modo in cui l'editor e il `make` di una
    cartella finiscono su due motori diversi senza che nessuno lo scriva."""
    _engine(tmp_path / "engine")          # fuori dal repo
    repo = _repo(tmp_path / "brano")
    deep = repo / "sub"
    deep.mkdir()

    with pytest.raises(server.EngineRootError):
        server.resolve_engine_root(env={}, cwd=deep)

    assert server.find_engine_upwards(deep) is None


def test_fallback_stops_at_home(tmp_path, monkeypatch):
    """Senza repo git la risalita si ferma alla home: `/engine` non e' il
    motore di nessuno."""
    home = tmp_path / "home"
    (home / "brani" / "uno").mkdir(parents=True)
    _engine(tmp_path / "engine")          # sopra la home
    monkeypatch.setenv("HOME", str(home))

    assert server.find_engine_upwards(home / "brani" / "uno") is None
    # ...e dentro la home il fallback funziona come sempre.
    _engine(home / "brani" / "engine")
    assert server.find_engine_upwards(home / "brani" / "uno") == \
        (home / "brani" / "engine").resolve()


def test_the_repo_root_itself_is_looked_at(tmp_path):
    """Ci si ferma DOPO aver guardato la radice, non prima: `engine/` sta
    quasi sempre proprio li'."""
    repo = _repo(tmp_path / "brano")
    _engine(repo / "engine")

    assert server.find_engine_upwards(repo) == (repo / "engine").resolve()


def test_a_declaration_that_is_wrong_is_an_error_not_a_search(tmp_path):
    """Una dichiarazione sbagliata non fa ricadere sulla ricerca.

    Ricadere in silenzio vorrebbe dire girare su un motore DIVERSO da quello
    chiesto — e con un `engine/` a portata di risalita il bridge partirebbe
    pure, il che e' il modo peggiore di sbagliare."""
    repo = _repo(tmp_path / "brano")
    _engine(repo / "engine")
    vuota = repo / "non-un-motore"
    vuota.mkdir()

    with pytest.raises(server.EngineRootError) as e:
        server.resolve_engine_root(cli_root=str(vuota), env={}, cwd=repo)
    assert str(vuota) in str(e.value)
    assert "--root" in str(e.value)

    with pytest.raises(server.EngineRootError) as e:
        server.resolve_engine_root(
            env={server.ENGINE_ENV_VAR: str(vuota)}, cwd=repo)
    assert str(vuota) in str(e.value)
    assert server.ENGINE_ENV_VAR in str(e.value)


def test_no_engine_at_all_says_the_three_ways(tmp_path):
    """Punto 4: l'errore dice le tre righe, e le dice nell'ordine vero."""
    with pytest.raises(server.EngineRootError) as e:
        server.resolve_engine_root(env={}, cwd=tmp_path)

    msg = str(e.value)
    assert msg.index("--root") < msg.index(server.ENGINE_ENV_VAR) \
        < msg.index(server.ENGINE_SUBDIR + "/")
    assert str(tmp_path) in msg, "il messaggio dice da dove ha cercato"
    assert "git clone" in msg


def test_relative_and_tilde_resolve_on_the_given_cwd(tmp_path, monkeypatch):
    """Un `--root ../engine` si risolve sulla cartella da cui e' stato dato."""
    _engine(tmp_path / "engine")
    altrove = tmp_path / "brano"
    altrove.mkdir()

    root, _ = server.resolve_engine_root(cli_root="../engine", env={},
                                         cwd=altrove)
    assert root == (tmp_path / "engine").resolve()

    monkeypatch.setenv("HOME", str(tmp_path))
    root, _ = server.resolve_engine_root(cli_root="~/engine", env={},
                                         cwd=altrove)
    assert root == (tmp_path / "engine").resolve()


def test_a_path_that_cannot_be_a_path_is_not_a_crash(tmp_path):
    """Un NUL o un `~utente-inesistente` sono "non e' un motore", non un
    traceback: il messaggio li nomina e basta."""
    assert server.is_engine_root("\0") is False
    assert server.is_engine_root("~utente-che-non-esiste-di-sicuro") is False

    with pytest.raises(server.EngineRootError) as e:
        server.resolve_engine_root(cli_root="~nessuno/engine", env={},
                                   cwd=tmp_path)
    assert "~nessuno/engine" in str(e.value)


# ---------------------------------------------------------------------------
# resolve_workspace — la cartella di lavoro e' quella in cui sto
# ---------------------------------------------------------------------------

def test_workspace_absent_is_the_current_folder(tmp_path):
    assert server.resolve_workspace(cwd=tmp_path) == tmp_path.resolve()


def test_workspace_explicit_wins(tmp_path):
    brani = tmp_path / "brani"
    brani.mkdir()
    assert server.resolve_workspace(str(brani), cwd=tmp_path) == brani.resolve()
    # relativo: sulla cartella da cui il comando e' stato dato
    assert server.resolve_workspace("brani", cwd=tmp_path) == brani.resolve()


def test_empty_workspace_is_absent(tmp_path):
    """Come per l'engine: vuoto e' assente, non una cartella senza nome."""
    assert server.resolve_workspace("", cwd=tmp_path) == tmp_path.resolve()


# ---------------------------------------------------------------------------
# resolve_media_dir — refs/ o samples/, si adotta quella che c'e'
# ---------------------------------------------------------------------------

def test_media_dir_defaults_to_refs(tmp_path):
    assert server.resolve_media_dir(tmp_path) == tmp_path / "refs"


def test_media_dir_adopts_samples_when_refs_is_absent(tmp_path):
    """Il caso vero: una cartella di lavoro che il proprio corpus lo tiene in
    `samples/` (simmetrico al `--samples-dir samples` del suo Makefile).

    Creare li' una `refs/` vuota accanto a una `samples/` piena sarebbe il
    peggiore dei risultati: due nomi per la stessa cosa, e la UI elenca il
    vuoto."""
    (tmp_path / "samples").mkdir()
    assert server.resolve_media_dir(tmp_path) == tmp_path / "samples"


def test_refs_wins_when_both_exist(tmp_path):
    """`refs/` e' il nome canonico: trovarla e' gia' una dichiarazione."""
    (tmp_path / "refs").mkdir()
    (tmp_path / "samples").mkdir()
    assert server.resolve_media_dir(tmp_path) == tmp_path / "refs"


def test_a_file_named_samples_is_not_the_media_folder(tmp_path):
    (tmp_path / "samples").write_text("non sono una cartella\n")
    assert server.resolve_media_dir(tmp_path) == tmp_path / "refs"


# ---------------------------------------------------------------------------
# Il banner — le due righe da cui si capisce cosa sta succedendo
# ---------------------------------------------------------------------------

def _paths(root, ws, media="refs"):
    return {"root": str(root), "workspace": str(ws), "refs": str(ws / media),
            "configs": str(ws / "configs"), "output": str(ws / "output"),
            "cache": str(ws / "cache")}


def test_banner_says_root_and_who_said_it(tmp_path):
    lines = server.banner_path_lines(
        tmp_path / "engine", server.ENGINE_ENV_VAR,
        _paths(tmp_path / "engine", tmp_path / "brano"), True, "= $PWD")
    testa = "\n".join(lines[:2])

    assert str(tmp_path / "engine") in testa
    assert server.ENGINE_ENV_VAR in testa, \
        "con tre modi di dichiarare il motore, 'quale' non basta: serve chi l'ha detto"
    assert str(tmp_path / "brano") in testa
    assert "$PWD" in testa


def test_banner_marks_the_historical_coincidence(tmp_path):
    """Workspace = root e' ancora possibile (`make serve` lo passa apposta), e
    il banner lo dice invece di far leggere due volte la stessa path."""
    lines = server.banner_path_lines(
        tmp_path, "--root", _paths(tmp_path, tmp_path), True, "--workspace")
    assert "(= root)" in lines[1]


def test_banner_names_the_adopted_samples_folder(tmp_path):
    lines = server.banner_path_lines(
        tmp_path / "engine", "--root",
        _paths(tmp_path / "engine", tmp_path / "brano", media="samples"),
        True, "= $PWD")
    media = lines[2]

    assert "samples/:" in media
    assert str(tmp_path / "brano" / "samples") in media
    assert "refs/" in media, "e dice perche': refs/ non c'era"


def test_banner_says_when_the_engine_cannot_be_told(tmp_path):
    """Su un motore senza `--samples-dir` la cartella dei sample resta quella
    del motore, e la riga lo spiega: e' quella da cui l'autore impara dove
    metterli."""
    lines = server.banner_path_lines(
        tmp_path / "engine", "--root",
        _paths(tmp_path / "engine", tmp_path / "brano"), False, "= $PWD")
    assert "--samples-dir" in lines[2]


# ---------------------------------------------------------------------------
# Il comando vero: da una cartella vuota si esce con il messaggio, non con un
# traceback. E' il primo criterio della #165, e l'unico che prova il giro
# completo argparse → risoluzione → sys.exit.
# ---------------------------------------------------------------------------

def test_launching_from_an_empty_folder_prints_the_message(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != server.ENGINE_ENV_VAR}
    proc = subprocess.run(
        [sys.executable, str(REPO / "server.py")],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60)
    out = proc.stdout + proc.stderr
    if "Missing deps" in out:
        pytest.skip("flask assente in questo interprete")

    assert proc.returncode != 0
    assert "Traceback" not in out, out
    assert "--root" in out and server.ENGINE_ENV_VAR in out


def test_launching_with_the_env_var_gets_past_the_engine_check(tmp_path):
    """Con `PGE_ENGINE_ROOT` esportato lo stesso comando supera la
    risoluzione: non arriva piu' all'errore sul motore.

    Si ferma sul workspace — che qui viene cancellato apposta — perche' far
    partire gunicorn vorrebbe dire aprire una porta dentro pytest. Le righe
    del banner sono coperte da `banner_path_lines`, che e' pura."""
    engine = _engine(tmp_path / "engine")
    vanished = tmp_path / "sparita"
    vanished.mkdir()
    env = {**os.environ, server.ENGINE_ENV_VAR: str(engine)}
    proc = subprocess.run(
        [sys.executable, str(REPO / "server.py"),
         "--workspace", str(tmp_path / "non-esiste")],
        cwd=vanished, env=env, capture_output=True, text=True, timeout=60)
    out = proc.stdout + proc.stderr
    if "Missing deps" in out:
        pytest.skip("flask assente in questo interprete")

    assert proc.returncode != 0
    assert "Traceback" not in out, out
    assert "--workspace" in out and "non-esiste" in out
    assert server.ENGINE_ENV_VAR not in out, \
        "il motore era dichiarato: l'errore non puo' essere quello sul motore"


# ---------------------------------------------------------------------------
# La precedenza e' UNA. Qui si chiede al Makefile, non si trascrive quel che
# fa: due precedenze diverse per la stessa variabile nello stesso repo sono un
# difetto che si manifesta solo quando una delle due e' in errore.
# ---------------------------------------------------------------------------

def _make_serve(env_extra, *args):
    """`make -n serve` in un'invocazione PULITA, cioe' senza i MAKEFLAGS di
    chi ci ha lanciati.

    make esporta nell'ambiente di ogni ricetta i propri MAKEFLAGS, e le
    variabili passate da riga di comando ci viaggiano dentro: un `make tests
    ROOT=/path` — l'invocazione che l'help di questo Makefile suggerisce, e che
    CLAUDE.md documenta — arriverebbe qui dentro come un `ROOT=` da riga di
    comando del make FIGLIO. `$(origin ROOT)` risponderebbe `command line`, il
    ramo esplicito vincerebbe sempre, e la seconda meta' della domanda ("senza
    ROOT= vince PGE_ENGINE_ROOT?") diventerebbe rossa senza che il Makefile
    sia cambiato di una riga: un rosso che non parla della modifica in corso,
    che e' il modo piu' veloce di far smettere di leggere una suite.

    Le uniche variabili da riga di comando devono essere quelle in `args`."""
    env = {k: v for k, v in os.environ.items() if k not in ("MAKEFLAGS", "MFLAGS")}
    env.update(env_extra)
    proc = subprocess.run(["make", "--no-print-directory", "-n", "serve", *args],
                          cwd=REPO, env=env, capture_output=True, text=True,
                          timeout=120)
    return proc.stdout + proc.stderr


def _serve_flag(out, flag):
    """Il VALORE di `flag` nella riga che lancia server.py, non "la riga lo
    contiene da qualche parte".

    Cercare la path nell'output intero non discrimina: da #165 `WS_FLAG` porta
    anche lui `$(ENGINE_ROOT)`, quindi il motore dell'ambiente compare sulla
    riga pure quando `--root` e' regredito a `$(ROOT)` secco — cioe' esattamente
    il difetto che questo confronto esiste per vedere, e che passerebbe in
    verde attraverso `--workspace`."""
    for line in out.splitlines():
        if "server.py" not in line:
            continue
        toks = shlex.split(line)
        if flag in toks:
            i = toks.index(flag)
            return toks[i + 1] if i + 1 < len(toks) else None
    return None


@pytest.mark.skipif(shutil.which("make") is None, reason="make assente")
def test_make_serve_has_the_same_precedence(tmp_path):
    flag = tmp_path / "flag"
    env_root = tmp_path / "env"

    dal_flag = _make_serve({server.ENGINE_ENV_VAR: str(env_root)},
                           f"ROOT={flag}")
    assert _serve_flag(dal_flag, "--root") == str(flag), \
        "ROOT= da riga di comando batte l'ambiente, in make come in server.py"
    assert str(env_root) not in dal_flag, \
        "e l'ambiente non deve comparire da nessun'altra parte sulla riga"

    dall_env = _make_serve({server.ENGINE_ENV_VAR: str(env_root)})
    assert _serve_flag(dall_env, "--root") == str(env_root), \
        "senza ROOT= esplicito vince PGE_ENGINE_ROOT, in make come in server.py"
    # E il workspace di `make serve` resta esplicito: e' il motivo per cui la
    # riga porta due volte la stessa path, ed e' anche cio' che rendeva cieca
    # una ricerca sull'output intero. Detto qui, cosi' se cambia lo si legge.
    assert _serve_flag(dall_env, "--workspace") == str(env_root), \
        "make serve passa il workspace, non eredita il default sulla cwd"


# ---------------------------------------------------------------------------
# Il workspace di default e' la cwd, quindi un `python server.py` lanciato da
# dentro QUESTO checkout ci semina configs/ output/ cache/ refs/. Il .gitignore
# le copre — ma alla radice soltanto: chiesto a git, non trascritto.
# ---------------------------------------------------------------------------

@pytest.mark.skipif(shutil.which("git") is None, reason="git assente")
def test_the_working_folders_are_ignored_at_the_root_only():
    """Le quattro cartelle sono ignorate dove il bridge le crea, e NON piu' giu'.

    Un pattern senza slash iniziale vale a ogni profondita', e la prima vittima
    sarebbe `tests/e2e/fixtures/`: il progetto che l'e2e apre e' versionato qui
    dentro (#139), quindi una fixture aggiunta sotto `refs/` o `configs/`
    sparirebbe dall'indice senza un rosso — verde in locale, assente su un clone
    pulito. E' il modo silenzioso di rompere la suite che non ha bisogno del
    motore."""
    def ignored(rel):
        return subprocess.run(["git", "check-ignore", "-q", rel], cwd=REPO,
                              capture_output=True).returncode == 0

    for name in ("configs", "output", "cache", "refs"):
        assert ignored(f"{name}/x"), f"{name}/ alla radice deve restare ignorata"
        assert not ignored(f"tests/e2e/fixtures/{name}/x"), (
            f"tests/e2e/fixtures/{name}/ non e' una cartella di lavoro del "
            f"bridge: ignorarla fa sparire una fixture senza dirlo")
