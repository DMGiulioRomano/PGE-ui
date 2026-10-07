"""Rigenera le fixture di `tests/fixtures/lab/streams/` dal laboratorio vero.

    python3 tests/fixtures/lab/genera/genera.py /path/to/mare-nostrum

Le fixture sono documenti **scritti dal laboratorio** di mare-nostrum, non a
mano: la pagina intera (`src/granstudies/graph_page.html`) gira in node sul
DOM finto di `tests/lab_dom.js`, gli scenari di questa cartella ne fanno i
gesti (campi, menu di interpolazione, `+ breakpoint`, `salva con nome`), e il
documento che `labDoc` restituisce si scrive con il dumper del server del
laboratorio (`serve._Dumper`, la stessa chiamata di `serve._scrivi`).

La pagina riceve il corredo di `make serve` (`graph.lab_completo`): lo
`study.yml` di `studies/001-41`, le finestre e i default dell'engine, i limiti
dei parametri. Per questo serve il submodule `engine/` del checkout di
mare-nostrum popolato (`git submodule update --init`), e node.

`risacca.yml` non si genera qui: e' la fixture di mare-nostrum
(`tests/fixtures/stream_come_file/streams/risacca.yml`), anche lei scritta
dalla pagina, copiata com'e'.

Se il laboratorio cambia il modo di scrivere un documento, le fixture si
rigenerano da lui con questo script, non si correggono a mano.
"""
import json
import os
import subprocess
import sys
import tempfile

QUI = os.path.dirname(os.path.abspath(__file__))
STREAMS = os.path.join(os.path.dirname(QUI), "streams")
SCENARI = ["finestra", "progressione", "voci", "tipo-sul-punto"]
STUDIO = "001-41"
CAMPIONI = ["001-41_5-5_5.wav"]      # il sample di `base:` dello studio


def main(mn):
    mn = os.path.abspath(mn)
    if not os.path.isdir(os.path.join(mn, "engine", "src", "pge")):
        sys.exit(f"{mn}/engine/src non c'e': `git submodule update --init` in mare-nostrum")
    sys.path.insert(0, os.path.join(mn, "src"))
    import yaml
    from granstudies import bounds, engine_bridge
    from granstudies.__main__ import _finestre
    from granstudies.graph import build_html, lab_completo
    from granstudies.serve import _Dumper

    with open(os.path.join(mn, "studies", STUDIO, "study.yml")) as fh:
        raw = yaml.safe_load(fh)
    with tempfile.TemporaryDirectory() as tmp:
        pagina = os.path.join(tmp, "graph.html")
        with open(pagina, "w") as fh:
            fh.write(build_html(STUDIO, lab_completo(
                raw, CAMPIONI, _finestre(), bounds.bounds_for,
                engine_bridge.parameter_path_defaults())))
        with open(os.path.join(QUI, "gesti.js")) as fh:
            gesti = fh.read()
        for nome in SCENARI:
            scenario = os.path.join(tmp, nome + ".js")
            with open(os.path.join(QUI, nome + ".js")) as fh, open(scenario, "w") as out:
                out.write(gesti + "\n" + fh.read())
            run = subprocess.run(
                ["node", os.path.join(mn, "tests", "lab_dom.js"), pagina, scenario],
                capture_output=True, text=True, timeout=120)
            if run.returncode != 0:
                sys.exit(f"{nome}: {run.stderr}")
            doc = json.loads(run.stdout.strip().splitlines()[-1])
            dst = os.path.join(STREAMS, nome + ".yml")
            with open(dst, "wb") as fh:
                fh.write(yaml.dump(doc, Dumper=_Dumper, sort_keys=False,
                                   allow_unicode=True).encode())
            print("scritto", os.path.relpath(dst))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
