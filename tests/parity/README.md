# Parità JS ↔ motore

Questa cartella contiene i test che **non** verificano PGE-ui contro se stesso.
Ogni file qui prende un'affermazione che il repo fa sul motore e la chiede al
motore.

## Il problema che chiude

`src/lib/` è pieno di specchi: `timeDistError` replica le distribuzioni
temporali, `magnify-spec.js` replica una grammatica della CLI,
`deviation-probability.js` replica un classificatore, `bounds.js` replica un
registro di clamp, `fingerprintStream` replica la derivata di un hash. Sono
tutti testati — contro se stessi.

Uno specchio può essere internamente perfetto e completamente divergente
dall'originale. Prima di questa cartella:

- `tests/node/test-time-dist.js` fissava le soglie di overflow come costanti
  scritte a mano, con un commento che diceva "verificato eseguendo il motore".
  Qualcuno l'aveva eseguito una volta;
- `tests/node/test-fingerprint.js` non ha mai visto l'hash python;
- `tests/node/test-bounds.js` costruisce un payload sintetico;
- `tests/python/test_render_pipeline.py` scrive un finto
  `parameter_definitions.py` in `tmp_path`: verifica il parser AST, non la
  parità.

Un errore su uno specchio non rompeva niente. Produceva un'anteprima plausibile
e sbagliata, o un avviso su uno YAML che rende. Adesso è CI rossa.

## Com'è fatto

```
engine_oracle.py   processo python: righe JSON su stdin → righe JSON su stdout.
                   Importa dal motore, non ne riscrive la logica.
oracle.js          client node: un processo per suite, domande anche a blocco.
harness.js         runner: dichiara i casi PRIMA di girarli, così quando il
                   motore manca sa dire quanti e quali non hanno girato.
test-*-parity.js   le suite.
```

Due dettagli del protocollo che non si indovinano leggendo il codice:

- **I float non finiti viaggiano etichettati.** `Infinity` e `NaN` non sono
  JSON, quindi `_json_safe` li manda come `{"__float__": "Infinity"}` e
  `oracle.js` li ridecodifica in numeri veri. La prima versione li mandava a
  `null` "come farebbe `JSON.stringify`": era vero e inutile, perché
  `JSON.stringify` fa lo stesso di qua e il confronto diventava `null === null`
  — indistinguibili, non confrontabili. Chi confronta valori dell'oracolo deve
  quindi **non** passare per `JSON.stringify` (vedi `sameValue` in
  `test-magnify-parity.js`).
- **`ctx.note(label, righe)` non è un assert.** Serve agli elenchi che
  documentano senza discriminare (quali coppie cadono nella banda int/float,
  quali corpi il motore rifiuta e la UI lascia passare). Un `assert(label,
  true, elenco)` avrebbe due difetti: l'`extra` si stampa solo sul ramo FAIL,
  quindi l'elenco non comparirebbe mai, e un assert che non può fallire gonfia
  il conteggio con qualcosa che non parla.

Le operazioni dell'oracolo:

| op | risponde con | mirror che verifica |
|---|---|---|
| `fingerprint` | `StreamCacheManager.compute_fingerprint` (con `semantics` opzionale, che rimpiazza la costante per la durata della chiamata, e `renderer`, il backend che sta dentro l'hash accanto ad essa — default `numpy`, come cabla la UI) | `backend.fingerprintStream` |
| `parse_magnify_spec` | i target di `--magnify-at`, o l'errore | `window.PGEMagnifySpec` |
| `classify_deviation_probability` | modo + gate costruito, o l'errore | `window.PGEDeviationProb` |
| `build_time_distribution` | strategia, durate, errori | `window.PGEEnv.timeDistError` |
| `parameter_bounds` | i bound, letti importando **o** via AST | `bounds.js` + `PGE_BOUNDS` |
| `constants` | i registri di nomi e le costanti che i mirror ricopiano interi (`ENVELOPE_COLORS` e `PLOT_ENVELOPE_KEYS` compresi, importati: `envelope_extractor` e' matplotlib-free) | tutti |

## Come si lancia

```bash
make tests-parity                       # solo la parità
make tests                              # tutto; la parità entra se il motore c'è
make tests-parity ROOT=/path/to/engine  # motore altrove
node tests/parity/test-bounds-parity.js # una suite sola
```

Variabili:

| variabile | effetto |
|---|---|
| `PGE_ENGINE_ROOT` | checkout del motore (default: `../PythonGranularEngine`) |
| `PGE_PARITY_STRICT=1` | un caso saltato diventa un errore |
| `PGE_PARITY_PYTHON` | l'interprete con cui girare l'oracolo |

L'oracolo non ha bisogno del venv del motore: nessuna delle op importa numpy,
soundfile o matplotlib, verificato modulo per modulo. È voluto — in CI il job
node fa il checkout del motore ma non ne costruisce il venv. Se il venv c'è,
`oracle.js` lo preferisce (con quello anche `pge.cli` si importa davvero,
invece di eseguire i soli nodi AST della grammatica di `--magnify-at`).

## Un caso saltato non è un caso passato

Senza motore le suite **saltano rumorosamente**: elencano i casi che non hanno
girato e li contano. Il salto diventa un fallimento quando `PGE_PARITY_STRICT`
è acceso — e basta: il runner non lo decide da sé.

In CI lo passa il workflow, quando il passo di checkout del motore ha riportato
`outcome: success`, esattamente come fa con `PGE_REQUIRE_ENGINE_FIXTURES`. La
decisione sta lì e non qui perché **il runner sa solo se trova i sorgenti**: la
versione precedente usava `CI && engineRoot() !== null`, e quella condizione si
spegneva sul caso che doveva intercettare — un checkout riuscito che non lascia
i sorgenti dove i test li cercano faceva saltare tutte e cinque le suite col job
verde. È la trappola `conclusion`/`outcome` di #132, spostata dal workflow al
runner.

In CI senza motore si salta e basta: il checkout è `continue-on-error` apposta,
perché una PR da un fork non ha il token, e trasformare quella condizione in un
rosso punirebbe PR che non c'entrano.

## Quando una parità fallisce

Ha due letture: **abbiamo sbagliato noi** oppure **il motore è cambiato**. Per
distinguerle, ogni run stampa il commit del motore contro cui ha confrontato, e
lo ripete nel riepilogo. Confrontalo con quello qui sotto.

**Commit del motore contro cui i patti sono verificati:**
`e57ccecc5453549aa9f507b7079337fb63a099f1`
(«fix(build): allinea la versione del pacchetto al tag (v9.0.2)»)

Questa riga **non è più solo una nota**: `test-fingerprint-parity.js` pretende
che lo SHA scritto qui sia un antenato del commit contro cui il run ha davvero
confrontato. Uno SHA con un refuso, o rimasto indietro rispetto a un motore che
nel frattempo ha riscritto la storia, adesso fa parlare qualcuno — prima nessun
test la guardava, e con 41 commit di deriva la risposta a «abbiamo sbagliato noi
o è cambiato il motore?» era sempre la seconda.

La cartella è nata contro `2b4cbf9fdfd49166314aa7113bcc41dcb6106ed8`
(PythonGranularEngine v7.2.0); fra quello e `cce3234` il motore ha portato
`VARIATION_SEMANTICS_VERSION` da 2 a 3 — il primo cambiamento che questi test
hanno intercettato, e la ragione della sezione qui sotto. Fra `cce3234` e il
commit qui sopra è entrato `renderer_type` nel fingerprint del motore (`bcc2c84`):
un terzo asse, oggi tenuto a bada da un backend cablato su entrambi i lati.

Se il commit del run è più recente e la parità è caduta, il sospetto principale
è una modifica del motore: guarda il suo CHANGELOG fra quel commit e quello del
run. Se invece è lo stesso, la modifica è di questo repo.

## Il livello a cui le chiavi escluse si escludono

Il motore filtra `solo`/`mute` con una dict-comprehension su
`stream_dict.items()`: il **solo primo livello**. La UI ora fa lo stesso, e il
primo livello che conta è quello dello **YAML**, non quello dell'oggetto JS —
`serializeStream` splicia `_extra` nel livello del blocco che lo contiene,
quindi `stream._extra.mute` esce come un `mute:` di primo livello (escluso da
entrambi) mentre `grain._extra.mute` esce come `grain: {mute: …}` (hashato da
entrambi). Prima la UI filtrava a ogni profondità, e il secondo caso muoveva
l'hash del motore e non il suo: un render di meno, il verso sbagliato.

Il caso di parità usa un `_extra` **già presente in entrambi i termini**:
comparire e basta muove l'hash per la chiave stessa, quindi un confronto contro
la base non discriminerebbe niente.

## I campi di preservazione del multistate

`statePositions` e `_curveRaw` (#59) sono iniettati al parse per riemettere le
posizioni esplicite e la curva verbatim. Erano esclusi **entrambi** dall'hash
della UI, con la stessa motivazione: «rispecchiano dati gia' codificati negli
stati e nella curva». Vera di uno, falsa dell'altro, e nessuno l'aveva chiesta
al motore — e' il punto 3 della issue #134, quello scritto *da verificare, non
da assumere*.

Il criterio non e' «campo dell'editor», e' **arriva nello YAML**: cio' che ci
arriva lo hasha il motore.

- `statePositions` ci arriva, spliciato dentro `states` (`[[pos, name], …]`),
  e le posizioni sono soglie in value-space: cambiano l'audio. Con
  l'esclusione, modificarle nel tab Raw — l'unica strada che le scrive, nessun
  componente lo fa — lasciava `states` una lista degli stessi nomi: hash del
  motore mosso, hash della UI fermo, pallino verde su uno stem che il motore
  stava per riscrivere diverso. Ora e' hashato. Prezzo: un render di troppo per
  ogni stem multistate gia' reso con posizioni non uniformi — verso sicuro, e
  si spegne da solo al primo giro.
- `_curveRaw` ci arriva pure, ma non puo' muoversi da solo: `parseGrainEnvelope`
  **deriva** `curve` da lui (`rescaleCurveY`, lineare), quindi una deriva troppo
  piccola perche' il 1e-9 di `curveMatchesRaw` la noti — e percio' riemessa
  verbatim, muovendo l'hash del motore — finisce comunque in `curve`, che e'
  hashata. Resta escluso, e la premessa e' un caso di parita' invece che un
  commento: se il parse smettesse di derivare `curve`, il test parla.

Vale la pena notare cosa non era bastato: `tests/node/test-fingerprint.js`
fissava l'assunzione sbagliata (`ignores grain.envelope.statePositions`), verde
e sicura di se'. Lo specchio internamente perfetto e divergente dall'originale,
cioe' esattamente cio' che questa cartella esiste per chiudere.

## Le chiavi degli envelope, il gemello dimenticato di /bounds

`ENVELOPE_COLORS` → `engine_introspect` (AST) → `GET /envelope-keys` → il filtro
della popover di render, e in mezzo `server.py` che interseca i nomi richiesti
con quella stessa lettura prima di comporre argv: un nome ignoto fa uscire il
motore con 1, audio compreso.

Stessa forma dei bound, stesso buco: ogni anello aveva il suo test e nessuno
leggeva il file vero (`test_render_pipeline.py` scrive un finto
`envelope_extractor.py` in `tmp_path`, cioe' verifica il parser). Un rename
upstream lasciava tutto verde con `keys: []`, e il filtro spariva dalla popover
in silenzio. Qui non c'e' un fallback statico da controllare, quindi le domande
sono due, e stanno in `test-bounds-parity.js`:

- la lettura AST del bridge da' le stesse chiavi del modulo importato, **nello
  stesso ordine** — l'endpoint restituisce l'ordine del sorgente e la popover
  disegna le caselle in quell'ordine;
- `PLOT_ENVELOPE_KEYS` — l'insieme contro cui `cli.py` valida davvero — e'
  ancora `frozenset(ENVELOPE_COLORS)`. Se il motore restringesse la validazione
  senza toccare il dict, il filtro del bridge diventerebbe piu' largo del
  motore: un nome che passa il filtro e uccide il render.

## Divergenze dichiarate

La parità non è identità. Alcune differenze sono volute, e ogni suite le
**pretende**: se una sparisce, il test parla, invece di lasciare invecchiare un
commento.

| dove | differenza | perché |
|---|---|---|
| fingerprint | `onset` muove l'hash del motore, non quello della UI | spostare una clip sulla timeline non cambia l'audio dello stem |
| fingerprint | `renderer_type` è nell'hash del motore e non ha un asse nella UI | oggi il backend è cablato su entrambi i lati (`app.jsx` e il default di `server.py`, pinnati da una guardia sorgente); il giorno che diventa una scelta serve un asse come quello della semantica |
| magnify-spec | SPEC vuoto: valido per la UI, rifiutato dal motore | nella UI "campo vuoto" significa "nessun target", e il flag non parte |
| magnify-spec | `stream=` vuoto: rifiutato dalla UI, accettato dal motore | la UI è più stretta; una lente su nessuno stream è un refuso |
| magnify-spec | cifre decimali Unicode (`t=１４`) | `float()` le accetta, `Number()` no; replicarle vuol dire la tabella `unicodedata.decimal` |
| magnify-spec | i bordi che solo Python striscia (U+00A0, U+2028, U+3000, `\x1c`, `\x85`…) | la UI toglie il solo insieme ASCII, sottoinsieme di `str.isspace()`: la divergenza è garantita nel verso sicuro senza replicare una tabella Unicode. Pretesa da `error()` **e** dal gate: ai bordi esterni dello SPEC è `sendable()` a decidere da solo, e lì il test chiede al motore se lo SPEC grezzo passa. Il verso pericoloso era U+FEFF, che `trim()` toglieva e `strip()` no — chiuso, e i due lati concordano |
| magnify-spec | SPEC vuoto o di soli separatori: non parte affatto | non è `error()` a fermarlo ma `sendable()`, ed è lo stesso gate che usa la UI: al motore arriva il testo che finirebbe in argv |
| time-dist | la banda int/float, larga al più uno | la UI modella la semantica intera di Python, più permissiva: mai un falso positivo. Larga **zero** dove le due soglie cadono sullo stesso intero, quindi il test mette il tetto su ogni sonda e il pavimento sul corpus |
| bounds | `grainDur.min` più basso del registro | il minimo vero è 1 campione (`1/output_sr`), override dinamico invisibile all'AST dei bound — il sample rate arriva però dal motore per la sua strada, vedi sotto |
| bounds | `loop_*` con un tetto statico | nel motore `max_val` è `null`: il tetto vero è la durata del sample |
| fingerprint | nessuna `VARIATION_SEMANTICS_VERSION` dentro l'hash della UI | i due hash rispondono a domande diverse; la versione è un **secondo asse** di staleness, non un campo dell'hash — vedi sotto |

## La semantica del motore, e perché non è più un numero scritto qui

`VARIATION_SEMANTICS_VERSION` (motore, `stream_cache_manager.py`) dice **come**
il motore legge lo YAML. Entra nel suo fingerprint, quindi un bump marca dirty
ogni stem di ogni progetto anche a YAML fermo.

La prima versione di questa cartella lo trascriveva a mano in
`test-fingerprint-parity.js` (`const ATTESA = 2`), come canarino: al bump la
suite diventava rossa e qualcuno decideva. È successo — il motore è passato a 3
in `cf386e6` (PGE #222) — e la decisione presa non è stata «aggiorna il numero»:

- l'hash della UI **non** contiene la versione, e continua a non contenerla: le
  due domande restano distinte («l'utente ha modificato lo YAML» contro «il
  motore deve rifare lo stem»);
- ma il **pallino** risponde alla seconda, e a un bump mostrava verde su stem
  che il motore avrebbe rifatto diversi. Quindi la versione è diventata un
  secondo asse di staleness accanto all'hash: `staleReason` in
  `render-status.js`, registrata per stream insieme ai fingerprint
  (`loadSemantics` in `backend.js`), letta dal motore via
  `GET /semantics-version` → `engine_introspect.engine_semantics_version`;
- e con la UI che legge il numero da sola, trascriverlo qui non serviva più: era
  una costante del motore ricopiata in questo repo, cioè lo stesso specchio
  che questa cartella esiste per chiudere. (Ne restava **una**, e non era
  innocua: vedi la sezione qui sotto sul sample rate.)

Al posto di `ATTESA`, la suite pretende i due fatti da cui quella decisione
dipende: che il lettore AST del bridge — l'unica strada per cui il numero
raggiunge la UI — legga **lo stesso** numero della costante importata, e che
quel numero sia davvero dentro l'hash del motore (chiesto rifacendo il conto con
la costante cambiata, e verificando che il patch non resti attaccato).

Regola che governa i due lati, e che vale la pena non perdere: **i due ignoti
non sono lo stesso ignoto**, e la differenza è se il giallo si possa poi
spegnere. *Motore* ignoto (bridge irraggiungibile, motore senza la costante) non
pretende niente: `_persistSem` scrive solo quando il numero si sa, quindi quel
giallo sarebbe **ineliminabile**. Uno *stem* senza versione registrata, con
motore noto, è invece stale — è ogni stem scritto prima che l'asse esistesse,
cioè uno stem scritto da un motore di cui non sappiamo la lettura. La regola non
ha bisogno del numero: dirlo qui rimetterebbe in questo repo la costante che
`ATTESA` ci aveva già messo una volta. Quel giallo si spegne da solo al primo
giro, anche a vuoto, perché il motore emette `stream-done` anche per gli stream
che salta (`cached: true`).

## Il sample rate, l'ultima costante ricopiata (e la peggiore)

Chiusa la versione di semantica ne restava **una**, e il fatto che nessuno la
guardasse è esattamente ciò che la rendeva pericolosa: `OUTPUT_SR = 48000` in
`src/lib/yaml-bridge.js`, cioè `DEFAULT_OUTPUT_SR` di
`pge/shared/constants.py`. Il commento accanto diceva «una sola copia: se il
motore la muove, si muove qui» — una promessa che nessun test pretendeva.

Ha **due** lettori, e il secondo è quello che conta:

- `grainDur.min = 1/sr`: il minimo di `grain_duration` è 1 campione (PGE #158),
  l'override dinamico della tabella qui sopra;
- `grainUnitFactor` (`envelope-utils.js`): `1/sr` è il fattore di
  `grain.duration_unit: samples`, e `convertGrainDurationUnit` con quel fattore
  **riscrive** `duration`/`duration_range` nello YAML. Un sample rate sbagliato
  non stringe una manopola: scrive durate sbagliate su disco.

E il verso è quello brutto. Con il motore a 44100 e la UI ferma a 48000,
`1/48000 < 1/44100`: la UI ammette un grano **più corto di un campione vero** —
la stessa forma del difetto `durationRange` che questa cartella ha trovato al
primo giro, e altrettanto invisibile, perché niente lo interrogava.

Ora il numero arriva dal motore per la stessa strada dei bound: `GET /bounds`
porta `output_sr` (`engine_introspect.engine_output_sr`, lettura AST, cache
invalidata sull'mtime come la versione di semantica), e
`window.PGEBounds.apply` lo installa su `window.PGE_OUTPUT_SR` prima che
qualcuno lo legga. Il letterale in `yaml-bridge.js` resta il **fallback
statico**, come `window.PGE_BOUNDS`: vale su `file://` e col bridge giù.

`test-bounds-parity.js` pretende i tre anelli — la costante importata, la
lettura AST del bridge, e il letterale statico, che qui deve essere **uguale**
al numero del motore e non solo «non più largo». La disuguaglianza non ha un
verso sicuro: un `sr` statico più alto dà un min più piccolo (permissivo, il
verso brutto) e insieme una conversione `samples` troppo corta, che è sbagliata
e basta.

Una nota sul pavimento: era scritto `Math.min(base.min, 1/sr)`, ed è stato
sostituito da `1/sr`. I due coincidono finché il min dichiarato dal motore sta
sopra un campione (oggi 0.002 s = 96 campioni a 48 kHz), ma il vincolo ha un
verso solo — sotto un campione non c'è niente da rendere — e con il payload che
porta il solo `output_sr` il `Math.min` teneva il pavimento derivato dal sample
rate **vecchio**, cioè faceva rientrare il difetto dalla porta di servizio.

## Aggiungere un caso

1. Se serve una domanda nuova al motore, aggiungi un'`op` in
   `engine_oracle.py`. **Importa dal motore, non riscrivere la sua logica**: una
   copia sarebbe un terzo specchio da tenere allineato, cioè il problema che
   questa cartella chiude.
2. Aggiungi il caso alla suite pertinente (o creane una: il file deve chiamarsi
   `test-*.js` per essere raccolto da `make tests-parity`).
3. Se la parità non regge ed è voluto, mettila nella tabella qui sopra **e**
   falla pretendere dal test.
