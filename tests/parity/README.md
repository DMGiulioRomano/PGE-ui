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

Le operazioni dell'oracolo:

| op | risponde con | mirror che verifica |
|---|---|---|
| `fingerprint` | `StreamCacheManager.compute_fingerprint` | `backend.fingerprintStream` |
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
girato e li contano. Il salto diventa un fallimento quando:

- `PGE_PARITY_STRICT=1`, oppure
- si è in CI **e il motore è presente**.

In CI senza motore si salta e basta: il checkout del motore nel workflow è
`continue-on-error` apposta, perché una PR da un fork non ha il token, e
trasformare quella condizione in un rosso punirebbe PR che non c'entrano.

## Quando una parità fallisce

Ha due letture: **abbiamo sbagliato noi** oppure **il motore è cambiato**. Per
distinguerle, ogni run stampa il commit del motore contro cui ha confrontato, e
lo ripete nel riepilogo. Confrontalo con quello qui sotto.

**Commit del motore alla scrittura di questa cartella:**
`2b4cbf9fdfd49166314aa7113bcc41dcb6106ed8`
(«Merge pull request #226 from DMGiulioRomano/claude/issue-225-investigation-u6lhik»,
PythonGranularEngine v7.2.0)

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
| time-dist | la banda int/float larga uno | la UI modella la semantica intera di Python, più permissiva: mai un falso positivo |
| bounds | `grainDur.min` più basso del registro | il minimo vero è 1 campione (`1/output_sr`), override dinamico invisibile all'AST |
| bounds | `loop_*` con un tetto statico | nel motore `max_val` è `null`: il tetto vero è la durata del sample |
| fingerprint | nessuna `VARIATION_SEMANTICS_VERSION` lato UI | i due hash rispondono a domande diverse; il numero è fissato come canarino |

## Aggiungere un caso

1. Se serve una domanda nuova al motore, aggiungi un'`op` in
   `engine_oracle.py`. **Importa dal motore, non riscrivere la sua logica**: una
   copia sarebbe un terzo specchio da tenere allineato, cioè il problema che
   questa cartella chiude.
2. Aggiungi il caso alla suite pertinente (o creane una: il file deve chiamarsi
   `test-*.js` per essere raccolto da `make tests-parity`).
3. Se la parità non regge ed è voluto, mettila nella tabella qui sopra **e**
   falla pretendere dal test.
