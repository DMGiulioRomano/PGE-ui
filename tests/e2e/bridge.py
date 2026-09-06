#!/usr/bin/env python3
"""bridge.py — il server.py del test headless, senza il motore accanto (#139).

Il boot dell'editor non e' una pagina statica: `app.jsx` interroga /health,
/projects, /media, /envelope-keys, /bounds, /semantics-version e /diagnose
prima di avere qualcosa da disegnare, e il progetto arriva da
`GET /file?kind=projects`. Aprire l'HTML da `file://` mette quindi alla prova
meta' dell'applicazione — quella che risponde a un bridge irraggiungibile —
e mai l'altra, che e' quella che la #139 chiede di verificare.

Quindi il bridge vero, ma su un motore finto. `main()` di server.py esce se
`--root/src/main.py` non c'e', e per un buon motivo (chi lancia `make serve`
senza il repo fratello ha sbagliato path); qui si chiama `make_app` diretta,
che quel controllo non lo fa. E' la stessa strada di
tests/python/test_render_pipeline.py::test_make_app_smoke, un piano piu' in la':
li' un `test_client`, qui un socket vero, perche' il browser deve poterci
parlare.

Due stub, e ognuno spegne una cosa che altrimenti il test farebbe davvero:

  src/main.py      — /diagnose lo cerca, e senza sarebbe un check rosso in
                     piu' nel log di boot. Non cambia il verdetto, ma il
                     rumore in un test di fumo e' esattamente cio' che lo fa
                     ignorare.
  .venv/bin/python — al boot l'editor chiama POST /setup in background
                     (`setTimeout(…, 100)` in app.jsx). Con il venv gia' li'
                     `_ensure_venv_events` stampa "already present" e torna;
                     senza, il test si metterebbe a costruire un venv dentro
                     una cartella temporanea, cioe' minuti di rete per un
                     boot che dovrebbe durare secondi.

Il workspace e' una copia temporanea di fixtures/: le sottodirectory che il
bridge crea (output/, cache/) non devono comparire come roba non tracciata
dentro il repo, e un test che scrive nella propria cartella di fixture e' un
test che al secondo giro parte da uno stato diverso dal primo.

Uso:
    python3 bridge.py [--port 0]

Stampa su stdout `PGE_E2E_PORT <porta>` quando il socket e' in ascolto — con
--port 0 la porta la sceglie il kernel, che e' l'unico modo di non litigare
con un altro test (o con un `make serve` acceso) su una porta fissa.
"""

import argparse
import json
import logging
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO))


def build_tree(base: Path) -> dict:
    """Crea il motore finto e il workspace, e restituisce le due path."""
    root = base / "engine"
    (root / "src").mkdir(parents=True)
    (root / "src" / "main.py").write_text("# stub: il test non renderizza\n")
    (root / ".venv" / "bin").mkdir(parents=True)
    (root / ".venv" / "bin" / "python").write_text("# stub\n")
    (root / "refs").mkdir()

    ws = base / "workspace"
    configs = ws / "configs"
    configs.mkdir(parents=True)
    for src in sorted((HERE / "fixtures").glob("*.yml")):
        shutil.copy(src, configs / src.name)
    return {"root": root, "workspace": ws}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=0,
                    help="porta (0 = la sceglie il kernel, default)")
    ap.add_argument("--verbose", action="store_true",
                    help="lascia parlare il log delle richieste di werkzeug")
    args = ap.parse_args()

    try:
        import server                       # importato qui: senza flask il
    except ImportError as e:                # messaggio deve essere questo,
        sys.exit(                           # non un traceback.
            f"manca una dipendenza del bridge ({e}).\n"
            f"    make install     (crea .venv e installa requirements.txt)\n")
    from werkzeug.serving import make_server

    base = Path(tempfile.mkdtemp(prefix="pge-e2e-"))
    tree = build_tree(base)
    app = server.make_app(tree["root"], render_timeout=30.0,
                          workspace=tree["workspace"])

    if not args.verbose:
        logging.getLogger("werkzeug").setLevel(logging.ERROR)

    srv = make_server("127.0.0.1", args.port, app, threaded=True)
    # Il boot del browser apre piu' richieste insieme (/media apre l'header di
    # ogni file audio mentre /projects risponde): con il server a un thread
    # solo si serializzerebbero, e il test misurerebbe la coda invece del boot.
    print(f"PGE_E2E_PORT {srv.server_port}", flush=True)
    print(json.dumps({"root": str(tree["root"]),
                      "workspace": str(tree["workspace"])}), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
