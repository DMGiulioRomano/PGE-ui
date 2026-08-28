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
| `fingerprint` | `StreamCacheManager.compute_fingerprint` (con `semantics` opzionale, che rimpiazza la costante per la durata della chiamata) | `backend.fingerprintStream` |
| `parse_magnify_spec` | i target di `--magnify-at`, o l'errore | `window.PGEMagnifySpec` |
| `classify_deviation_probability` | modo + gate costruito, o l'errore | `window.PGEDeviationProb` |
| `build_time_distribution` | strategia, durate, errori | `window.PGEEnv.timeDistError` |
| `parameter_bounds` | i bound, letti importando **o** via AST | `bounds.js` + `PGE_BOUNDS` |
| `constants` | i registri di nomi che i mirror ricopiano interi | tutti |

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
`cce323447f0be5d798173ddaae632bc2f27fac0a`
(«Merge pull request #238 from DMGiulioRomano/claude/issue-222-resolution-mcaeyy»)

La cartella è nata contro `2b4cbf9fdfd49166314aa7113bcc41dcb6106ed8`
(PythonGranularEngine v7.2.0); fra i due commit il motore ha portato
`VARIATION_SEMANTICS_VERSION` da 2 a 3 — il primo cambiamento che questi test
hanno intercettato, e la ragione della sezione qui sotto.

Se il commit del run è più recente e la parità è caduta, il sospetto principale
è una modifica del motore: guarda il suo CHANGELOG fra quel commit e quello del
run. Se invece è lo stesso, la modifica è di questo repo.

## Divergenze dichiarate

La parità non è identità. Alcune differenze sono volute, e ogni suite le
**pretende**: se una sparisce, il test parla, invece di lasciare invecchiare un
commento.

| dove | differenza | perché |
|---|---|---|
| fingerprint | `onset` muove l'hash del motore, non quello della UI | spostare una clip sulla timeline non cambia l'audio dello stem |
| magnify-spec | SPEC vuoto: valido per la UI, rifiutato dal motore | nella UI "campo vuoto" significa "nessun target", e il flag non parte |
| magnify-spec | `stream=` vuoto: rifiutato dalla UI, accettato dal motore | la UI è più stretta; una lente su nessuno stream è un refuso |
| magnify-spec | cifre decimali Unicode (`t=１４`) | `float()` le accetta, `Number()` no; replicarle vuol dire la tabella `unicodedata.decimal` |
| time-dist | la banda int/float, larga al più uno | la UI modella la semantica intera di Python, più permissiva: mai un falso positivo. Larga **zero** dove le due soglie cadono sullo stesso intero, quindi il test mette il tetto su ogni sonda e il pavimento sul corpus |
| bounds | `grainDur.min` più basso del registro | il minimo vero è 1 campione (`1/output_sr`), override dinamico invisibile all'AST |
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
  l'ultima costante del motore ricopiata in questo repo, cioè lo stesso specchio
  che questa cartella esiste per chiudere.

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
motore noto, è invece stale — è ogni stem scritto prima che l'asse esistesse, e
il motore era già passato a 3: sono tutti stem che rifarà diversi. Quel giallo si
spegne da solo al primo giro, anche a vuoto, perché il motore emette
`stream-done` anche per gli stream che salta (`cached: true`).

## Aggiungere un caso

1. Se serve una domanda nuova al motore, aggiungi un'`op` in
   `engine_oracle.py`. **Importa dal motore, non riscrivere la sua logica**: una
   copia sarebbe un terzo specchio da tenere allineato, cioè il problema che
   questa cartella chiude.
2. Aggiungi il caso alla suite pertinente (o creane una: il file deve chiamarsi
   `test-*.js` per essere raccolto da `make tests-parity`).
3. Se la parità non regge ed è voluto, mettila nella tabella qui sopra **e**
   falla pretendere dal test.
