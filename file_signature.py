"""file_signature.py — due editor, un file (#185).

Lo stesso `streams/risacca.yml` puo' stare aperto nel laboratorio di
mare-nostrum e in PGE-ui (regola 7 del piano `stream-come-file.md`). Ognuno dei
due ricorda com'era il file quando l'ha letto e, prima di scrivere, controlla
che su disco sia ancora quello. Questo modulo e' la meta' bridge di quella
regola: le route in `server.py` ci passano e non riscrivono una versione loro.

La convenzione e' quella che il laboratorio ha fissato in
DMGiulioRomano/mare-nostrum#15 (`src/granstudies/serve.py`: `ALGO`, `firma_di`,
`cambiato_su_disco`, `gia_su_disco`, `_stesso`), e qui non c'e' niente da
scegliere: c'e' da calcolarla identica, o la guardia di uno dei due editor
parlerebbe su un file che l'altro non ha cambiato.

  `sha256:<hexdigest>` sui BYTE del file come stanno sul disco.

Tre scelte, e ognuna decide *quando* la guardia parla:

- **l'algoritmo sta nel prefisso.** La stessa firma la calcolano due programmi:
  il giorno che una delle due convenzioni cambia si deve vedere che non e' il
  file a essere cambiato. E' dichiarato una volta sola (`ALGO`, scritto anche
  nella chiamata a `hashlib.new`), perche' cambiarlo nel prefisso e non
  nell'hash darebbe una firma che mente su se stessa — l'unica cosa che il
  prefisso serve a non far succedere;
- **i byte, non il documento parsato.** La domanda e' "il file su disco e'
  quello che ho letto", e due editor scrivono lo stesso documento con
  formattazioni diverse. Firmare il parse lascerebbe passare la riscrittura di
  un file davvero cambiato ogni volta che il cambiamento non si vede nel parse
  (un commento, l'ordine delle chiavi);
- **il contenuto, non l'mtime.** Un mtime dice che qualcuno ha scritto, non che
  il file sia diverso, e le due risposte portano a cose opposte: rileggere,
  oppure lasciar passare la riscrittura di un file identico.

La regola in tre passi sta in `guard()`, in un posto solo: la scrivono sia
`PUT /file` sia la scrittura dentro `POST /render`, e in questo repo una regola
scritta due volte e' gia' divergita (il basename di `/render`, che
reimplementava `safe_resolve` piu' debole). `guard()` scrive anche, cosi'
l'ordine "controlla, poi scrivi" non e' un patto fra due chiamanti.

Niente Flask qui dentro: solo path, byte e YAML, come gli altri helper del
bridge.
"""

import hashlib
from pathlib import Path

import yaml

ALGO = "sha256"


def signature_of(raw: bytes) -> str:
    """La firma di questi byte."""
    return f"{ALGO}:{hashlib.new(ALGO, raw).hexdigest()}"


def read_signed(path: Path) -> "tuple[bytes, str]":
    """I byte del file e la loro firma, in una lettura sola.

    Una lettura sola e non due: la firma deve essere di esattamente il
    documento che e' tornato al chiamante. Con due accessi al disco il file
    puo' cambiare nel mezzo, e la pagina si ritroverebbe la firma di un
    documento che non ha — cioe' una guardia che parla, o tace, sul file
    sbagliato.
    """
    raw = path.read_bytes()
    return raw, signature_of(raw)


def file_signature(path: Path) -> str:
    """La firma del file su disco. ``""`` se non c'e' o non si legge."""
    try:
        return signature_of(path.read_bytes())
    except OSError:
        return ""


def changed_on_disk(path: Path, read_sig: str) -> bool:
    """Se il file su disco non e' quello che l'editor ha letto.

    Due casi non sono un file cambiato, e nessuno dei due e' una scorciatoia:

    - ``read_sig`` vuota: l'editor non ha mai letto quel file, non c'e' niente
      da confrontare. Di la' e' il `salva con nome` su un percorso nuovo, dove
      della sovrascrittura ha chiesto il pannello nativo; di qua e' il
      `Save as`, il progetto nuovo, e il file che il master importa per la
      prima volta;
    - il file **non c'e' piu'**: non ci sta il lavoro di nessuno, e rifiutare
      lascerebbe la domanda senza via d'uscita — "ricarica" non puo' rileggere
      un file cancellato, e scriverlo e' esattamente cio' che si stava
      chiedendo.
    """
    if not read_sig:
        return False
    now = file_signature(path)
    return bool(now) and now != read_sig


def same_document(a, b) -> bool:
    """Lo stesso documento, tipi compresi.

    Non e' ``==``: per Python ``4 == 4.0`` e ``1 == True``, per il motore no —
    un ``n_reps`` float o booleano e' un errore dalla PGE #211. Un valore che
    cambia tipo e' un documento diverso, e si scrive. Il confronto si fa QUI e
    non nel browser per la stessa ragione al contrario: in JS ``4`` e ``4.0``
    sono lo stesso numero, quindi di la' la domanda non e' nemmeno ponibile.
    Tutti e due i lati vengono da YAML, cosi' i tipi sono quelli scritti.
    """
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_document(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(map(same_document, a, b))
    return a == b


class _Unreadable:
    """Il sentinella di "non l'ho capito", che non e' un documento."""


_UNREADABLE = _Unreadable()


def _load(raw: bytes):
    """Il parse YAML di questi byte, o ``_UNREADABLE`` se non si legge.

    Il sentinella e non ``None``, perche' ``None`` e' un documento: un file
    vuoto lo da'. Senza, "non l'ho capito" e "contiene null" sarebbero la
    stessa risposta, e due file illeggibili risulterebbero lo stesso
    documento — cioe' una scrittura saltata su un file che va scritto.
    """
    try:
        return yaml.safe_load(raw)
    except (ValueError, yaml.YAMLError):
        # ValueError copre l'UnicodeDecodeError di byte che non sono utf-8:
        # `PUT /file` scrive anche dove il contenuto non e' detto sia YAML.
        return _UNREADABLE


def already_on_disk(path: Path, text: str) -> str:
    """La firma del file se contiene gia' lo stesso DOCUMENTO, ``""`` se no.

    Viene **prima** della guardia, ed e' una regola della convenzione, non una
    scorciatoia (DMGiulioRomano/mare-nostrum#15, `cd0edf5`).

    Con la firma sui byte un salvataggio "identico" fra due editor non esiste:
    il laboratorio scrive col suo dumper, PGE-ui con js-yaml e la sua
    intestazione `# saved:`, quindi lo stesso documento da' byte diversi — il
    punto sull'mtime vale dentro un editor, non fra due. E `POST /render`
    scrive il config prima di lanciare il motore, a ogni render, anche su uno
    stream che nessuno ha toccato: senza questa regola ogni render di PGE-ui
    farebbe dire "cambiato su disco" alla guardia del laboratorio su un
    documento che nessuno ha cambiato, e si porterebbe via la sua
    formattazione e i suoi commenti.

    Se il file contiene gia' il documento non si scrive, non si guarda la
    firma, e non c'e' niente da sovrascrivere ne' da chiedere: scrivere non
    cambierebbe niente a nessuno. Torna la firma dei byte che ci sono, che
    prende il posto di quella letta come dopo una scrittura, perche' e'
    cio' che c'e' su disco.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return ""
    mine, theirs = _load(text.encode("utf-8")), _load(raw)
    if isinstance(mine, _Unreadable) or isinstance(theirs, _Unreadable):
        return ""
    return signature_of(raw) if same_document(theirs, mine) else ""


def write_signed(path: Path, text: str) -> str:
    """Scrive il testo e torna la firma dei byte scritti.

    Si firma cio' che si e' scritto, non il file riletto dopo: sono due accessi
    al disco e due risposte possibili, e quella che l'editor deve ricordare e'
    la prima.

    In **binario**, non con `write_text`: la firma e' dei byte sul disco, e in
    modalita' testo una piattaforma che traduce i fine riga ne scriverebbe
    altri — la firma direbbe un file che su disco non c'e'. L'encoding resta
    utf-8, quello che `GET /file` legge e che il laboratorio scrive.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = text.encode("utf-8")
    path.write_bytes(raw)
    return signature_of(raw)


def guard(path: Path, text: str, read_sig: str = "",
          overwrite: bool = False) -> dict:
    """La regola in tre passi, piu' la scrittura. Un posto solo, due route.

    1. se il file su disco, parsato, e' **gia'** il documento da scrivere: non
       si scrive e non si guarda la firma (`already_on_disk`);
    2. altrimenti la guardia: ``read_sig`` diversa dalla firma su disco, e
       niente ``overwrite``, vuol dire ``changed`` — e non si scrive niente.
       A decidere (rileggere o sovrascrivere) e' chi ha le modifiche, cioe' la
       pagina: qui si dice soltanto che il file e' cambiato;
    3. altrimenti si scrive.

    Torna sempre ``signature``: la firma di cio' che c'e' su disco dopo questa
    chiamata. Senza, la scrittura dopo manderebbe la firma di prima e si
    rifiuterebbe da se'.

    ``changed`` e' un campo a parte e non un errore da riconoscere dal testo —
    la stessa forma del laboratorio, perche' e' la pagina a doverlo distinguere
    da un errore vero.
    """
    already = already_on_disk(path, text)
    if already:
        return {"ok": True, "written": False, "signature": already}
    if not overwrite and changed_on_disk(path, read_sig):
        return {"ok": False, "changed": True,
                "signature": file_signature(path),
                "error": f"{path.name} e' cambiato su disco da quando l'hai "
                         f"letto: ricarica o sovrascrivi."}
    return {"ok": True, "written": True, "signature": write_signed(path, text)}
