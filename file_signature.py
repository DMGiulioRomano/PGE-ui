"""Due editor, un file (PGE-ui #185): la firma di un file e la scrittura che
la rispetta.

Lo stesso `configs/<brano>.yml` puo' stare aperto in PGE-ui e nel laboratorio
di mare-nostrum. Ognuno dei due ricorda com'era il file quando l'ha letto e,
prima di scrivere, controlla che su disco sia ancora quello: chi salva per
secondo non si porta piu' via in silenzio il lavoro dell'altro.

La convenzione non si sceglie qui: l'ha fissata il laboratorio
(DMGiulioRomano/mare-nostrum#15, `serve.py`), e questo modulo la calcola
identica. Non perche' le firme viaggino da un editor all'altro — ognuno
confronta le proprie letture — ma perche' la DOMANDA deve essere la stessa,
cioe' i due editor devono parlare negli stessi casi:

- si firmano i BYTE del file, non il documento parsato: due editor scrivono lo
  stesso documento con byte diversi, e un cambiamento che il parse non vede
  (un commento, l'ordine delle chiavi) e' comunque un file diverso;
- il contenuto, non l'mtime: un mtime dice che qualcuno ha scritto, non che il
  file sia diverso;
- un documento che il file ha GIA' non si riscrive, e non e' un file cambiato.
  Viene prima della firma (`write_guarded`, passo 1).

Solo stdlib piu' PyYAML, che e' una dipendenza dichiarata del bridge
(`requirements.txt`): senza il confronto per documento il passo 1 direbbe
"non e' lo stesso documento" dove la verita' e' "non lo so", e il sintomo si
vedrebbe nell'ALTRO editor — una domanda su un file che nessuno ha cambiato.
"""

import hashlib
from pathlib import Path

import yaml

# Il prefisso dichiara l'algoritmo: il giorno che una delle due convenzioni
# cambia si vede che non e' il file a essere cambiato. Dichiarato UNA volta,
# e letto anche dalla chiamata a `hashlib.new`: cambiarlo nel prefisso e non
# nell'hash darebbe una firma che mente su se stessa.
ALGO = "sha256"


def signature_of(raw: bytes) -> str:
    """`sha256:<hex>` dei byte."""
    return f"{ALGO}:{hashlib.new(ALGO, raw).hexdigest()}"


def signature(path) -> str:
    """La firma del file su disco; `""` se non c'e' o non si legge."""
    try:
        return signature_of(Path(path).read_bytes())
    except OSError:
        return ""


def read_signed(path):
    """`(testo, firma)` da UNA lettura sola.

    Due accessi al disco sono due risposte possibili: il file puo' cambiare nel
    mezzo, e l'editor si ritroverebbe la firma di un documento che non gli e'
    mai arrivato. Si decodificano i byte invece di `read_text`, che tradurrebbe
    i fine riga — il testo tornato non sarebbe piu' quello firmato."""
    raw = Path(path).read_bytes()
    return raw.decode("utf-8"), signature_of(raw)


def changed_on_disk(path, read_signature) -> bool:
    """Se il file su disco non e' piu' quello che l'editor ha letto.

    Due casi non sono un file cambiato, e nessuno dei due e' una scorciatoia:

    - nessuna firma letta: l'editor quel file non l'ha mai letto, e non c'e'
      niente da confrontare;
    - il file non c'e' piu': non ci sta il lavoro di nessuno, e rifiutare
      lascerebbe la domanda senza via d'uscita — "ricarica" non puo' rileggere
      un file cancellato, e scriverlo e' esattamente cio' che si chiedeva."""
    if not read_signature:
        return False
    now = signature(path)
    return bool(now) and now != read_signature


def same_document(a, b) -> bool:
    """Lo stesso documento, TIPI compresi.

    Non e' `==`: per Python `4 == 4.0` e `1 == True`, per il motore no (un
    `n_reps` float o booleano e' un errore dalla PGE #211). Un valore che
    cambia tipo e' un documento diverso, e si scrive. Le chiavi di un mapping
    si confrontano come insieme: l'ordine e' formattazione."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_document(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(map(same_document, a, b))
    return a == b


def already_on_disk(path, text: str) -> str:
    """La firma del file se contiene gia' il documento `text`, `""` se no.

    Il confronto sta qui e non nel browser perche' i due lati vengono da YAML
    letto dallo stesso parser, quindi i tipi sono quelli scritti: in JS `4` e
    `4.0` sono lo stesso numero. Un file che non si legge o non si parsa non
    contiene niente: `""`, e decide la guardia."""
    try:
        raw = Path(path).read_bytes()
        on_disk = yaml.safe_load(raw)
        wanted = yaml.safe_load(text)
    except (OSError, ValueError, yaml.YAMLError):
        # ValueError copre l'UnicodeDecodeError di byte che non sono testo.
        return ""
    return signature_of(raw) if same_document(on_disk, wanted) else ""


def write_guarded(path, text: str, read_signature="", overwrite=False,
                  yaml_document=True) -> dict:
    """Scrive `text` su `path` rispettando la lettura dell'editor. Tre passi,
    in quest'ordine:

    1. il file ha gia' il documento → non si scrive e non si guarda la firma.
       L'altro editor puo' averlo riscritto a modo suo, ma una scrittura non
       toglierebbe niente a nessuno: niente da chiedere, e la sua
       formattazione e i suoi commenti restano;
    2. altrimenti la guardia: firma letta diversa da quella su disco, e niente
       `overwrite`, e' un rifiuto. Il rifiuto NON porta la firma che c'e' su
       disco: adottarla vorrebbe dire aver letto il documento dell'altro
       editor senza averlo caricato, e la scrittura dopo passerebbe;
    3. altrimenti si scrive, e torna la firma dei byte scritti — che l'editor
       mette al posto di quella letta, o il salvataggio dopo si accuserebbe da
       solo di aver cambiato il file.

    Il passo 1 vale solo per un documento YAML: su un altro testo una lettura
    YAML puo' dire "uguale" a due stringhe diverse.

    La scrittura e' in binario, utf-8: la firma e' dei byte sul disco, e in
    modalita' testo una piattaforma che traduce i fine riga ne scriverebbe
    altri. Fra il controllo e la scrittura resta la finestra di qualunque
    controllo-poi-scrivi su un filesystem, la stessa che ha il laboratorio:
    la guardia prende il caso vero (due editor aperti per minuti), non una
    corsa di millisecondi."""
    path = Path(path)
    if yaml_document:
        sig = already_on_disk(path, text)
        if sig:
            return {"ok": True, "written": False, "signature": sig}
    if not overwrite and changed_on_disk(path, read_signature):
        return {"ok": False, "changed": True}
    raw = text.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return {"ok": True, "written": True, "signature": signature_of(raw)}


def is_yaml_name(name: str) -> bool:
    return str(name).lower().endswith((".yml", ".yaml"))
