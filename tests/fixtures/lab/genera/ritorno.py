"""Il ritorno nel laboratorio: cio' che PGE-ui scrive, riaperto dalla pagina vera.

    python3 tests/fixtures/lab/genera/ritorno.py /path/to/mare-nostrum

Per ogni documento delle fixture, `scrivi-pgeui.js` produce il file come lo
scriverebbe PGE-ui (senza modifiche, e col `volume` toccato); qui la pagina
del laboratorio lo apre (`carica`, col path `streams/<nome>.yml`) e si chiede:

  - il file di PGE-ui e' il documento che il laboratorio aveva scritto (la
    fixture; col `volume` a -3 nella variante toccata), tipi compresi: e' la
    domanda dell'issue, "torna con tutto quello che aveva". Le altre quattro da
    sole non la fanno — un documento a cui PGE-ui avesse tolto un `interp` il
    laboratorio lo riaprirebbe e riscriverebbe identico lo stesso;
  - `labDoc()` e' il file: il laboratorio lo riscriverebbe identico;
  - `gia_su_disco`: identico anche coi tipi (`4` contro `4.0`), cioe' un
    `rendi e ascolta` non riscriverebbe il file e la firma dell'altro editor
    resterebbe buona;
  - niente `• modificato` (`sporco`), niente valori a schermo diversi dal
    breakpoint (`cambiati`), niente lavoro proprio da perdere (`daPerdere`).

Non e' un test di CI: mare-nostrum non e' un checkout fratello di PGE-ui. Il
corredo della pagina e' quello di `genera.py` (lo `study.yml` di 001-41, le
finestre e i default dell'engine), con i sample che le fixture nominano.
Esce 0 se tutto torna.
"""
import json
import os
import subprocess
import sys
import tempfile

QUI = os.path.dirname(os.path.abspath(__file__))
STREAMS = os.path.join(os.path.dirname(QUI), "streams")


def main(mn):
    mn = os.path.abspath(mn)
    sys.path.insert(0, os.path.join(mn, "src"))
    import yaml
    from granstudies import bounds, engine_bridge
    from granstudies.__main__ import _finestre
    from granstudies.graph import build_html, lab_completo
    from granstudies.serve import gia_su_disco

    with open(os.path.join(mn, "studies", "001-41", "study.yml")) as fh:
        raw = yaml.safe_load(fh)
    esito = True
    with tempfile.TemporaryDirectory() as tmp:
        uscita = os.path.join(tmp, "pgeui")
        subprocess.run(["node", os.path.join(QUI, "scrivi-pgeui.js"), uscita], check=True)
        pagina = os.path.join(tmp, "graph.html")
        with open(pagina, "w") as fh:
            fh.write(build_html("001-41", lab_completo(
                raw, ["001-41_5-5_5.wav", "onda.wav"], _finestre(), bounds.bounds_for,
                engine_bridge.parameter_path_defaults())))
        for f in sorted(os.listdir(uscita)):
            path = os.path.join(uscita, f)
            nome = f.split("__", 1)[1]
            with open(path) as fh:
                doc = yaml.safe_load(fh)
            scenario = os.path.join(tmp, "scenario.js")
            with open(scenario, "w") as fh:
                fh.write("carica(%s, '/brano/streams/%s');\n" % (json.dumps(doc), nome)
                         + "console.log(JSON.stringify({doc: labDoc(), sporco: sporco(),"
                           " cambiati: cambiati(), daPerdere: daPerdere()}));\n")
            run = subprocess.run(["node", os.path.join(mn, "tests", "lab_dom.js"), pagina, scenario],
                                 capture_output=True, text=True, timeout=120)
            if run.returncode:
                print(f"{f}: la pagina non ha girato\n{run.stderr}")
                esito = False
                continue
            got = json.loads(run.stdout.strip().splitlines()[-1])
            with open(os.path.join(STREAMS, nome)) as fh:
                atteso = yaml.safe_load(fh)
            if f.startswith("volume__"):
                atteso["streams"][0]["volume"] = -3
            prove = {
                "il documento del laboratorio": bool(gia_su_disco(path, atteso)),
                "labDoc == file": got["doc"] == doc,
                "gia_su_disco": bool(gia_su_disco(path, got["doc"])),
                "non sporco": got["sporco"] is False,
                "niente a schermo": got["cambiati"] == [],
                "niente da perdere": got["daPerdere"] is False,
            }
            ok = all(prove.values())
            esito &= ok
            print(("ok   " if ok else "NO   ") + f + "  " +
                  "  ".join(k for k, v in prove.items() if not v))
    print("tutto torna" if esito else "qualcosa non torna")
    return 0 if esito else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
