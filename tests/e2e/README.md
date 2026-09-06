# Boot headless dell'editor

Questa cartella contiene un test solo, e risponde a una domanda sola:
**l'applicazione esiste e risponde?**

Non e' un test di regressione visiva. Non guarda un pixel, non confronta
screenshot, non sa che aspetto ha un bottone. Guarda che il boot arrivi in
fondo senza errori, che un progetto entri in timeline, che Inspector ed
EnvelopeEditor si aprano disegnando qualcosa, e che un giro di undo/redo
riporti lo stato dov'era.

```bash
cd tests/e2e
npm install
npx playwright install chromium     # ~150 MB, una volta sola
node test-boot.js                   # oppure, dalla root: make tests-e2e
```

## Il problema che chiude

`tests/node/test-sources.js` (#138) verifica che ogni sorgente **parsi**, che
`PGE Editor.html` li carichi tutti esattamente una volta e che nessuno legga un
`window.*` che arriva dopo. E' il gate statico, ed e' il sottoinsieme economico
del problema.

Un componente pero' puo' parsare benissimo ed esplodere al primo render. Da li'
in poi il sintomo e' una pagina bianca, e fino a questo file nessuna suite la
vedeva: la verifica dell'interfaccia era manuale — aprire l'editor, Settings →
backend locale, test connection, render — e il CLAUDE.md lo diceva apertamente.
E' la ragione per cui lavorare su ventimila righe di componenti richiedeva piu'
cautela di quanta ne richieda un repo con un boot verificato.

## I tre pezzi

| file | ruolo |
| --- | --- |
| `bridge.py` | avvia `server.make_app` su un socket vero, con un motore **finto** e una copia temporanea di `fixtures/`. Stampa la porta su stdout. |
| `browser.js` | la politica di rete: cosa la pagina puo' ottenere, e da dove. Piu' `verifyVendor()`, che confronta i byte serviti con l'`integrity` dell'HTML. |
| `test-boot.js` | la suite. Verdetto in un handler `exit`, come tutte (`tests/node/test-suite-harness.js` lo verifica anche per questo file). |
| `fixtures/PGE_smoke.yml` | il progetto che l'editor apre. Versionato qui: il test non dipende dal checkout del motore. |

## Decisioni deliberate

**Il motore non serve, ne' il suo checkout ne' il suo venv.** `main()` di
`server.py` esce se non trova `src/main.py`, quindi `bridge.py` chiama
`make_app` diretta su una root stub. Il progetto e' quello in `fixtures/`. Cosi'
la suite gira per intero anche su una PR da un fork, dove il secret del motore
non c'e'.

**La rete e' quella del test, non internet.** `browser.js` intercetta *tutto*:

- i quattro script vendor che l'HTML chiede alla CDN → serviti da
  `node_modules/`, cioe' dai pacchetti npm da cui la CDN pubblica quegli stessi
  byte;
- i tre `@font-face` remoti di `styles/` → bloccati (sono decorazione);
- `http://localhost:7878`, la costante dell'app → riscritta sulla porta del
  bridge, cosi' il test non deve occupare la porta di `make serve`;
- **qualunque altra cosa → il test fallisce nominandola.**

Le prime due liste sono **lette dai sorgenti** (i tag `<script>` dell'HTML, i
blocchi `@font-face` del CSS), non trascritte qui: una copia scritta a mano
andrebbe muta esattamente quando la dipendenza esterna cambia.

**I byte vendor sono quelli dell'utente.** `verifyVendor()` ricalcola l'hash SRI
di ogni file locale e pretende che sia uguale all'`integrity` scritto
nell'HTML. Una versione bumpata da una parte sola diventa un fallimento con il
suo nome, invece di un boot che muore su uno script bloccato.

## Quando diventa rosso

| sintomo | cosa e' successo |
| --- | --- |
| `i quattro vendor coincidono…` FAIL | versione o hash divergenti fra `PGE Editor.html` e `package.json`. Allinea i due, non silenziare il confronto. |
| `nessuna eccezione non gestita` FAIL | e' il caso per cui questo file esiste: un componente esplode. Lo stack e' nel messaggio. |
| `nessuna richiesta verso l'esterno oltre a quelle dichiarate` FAIL | qualcuno ha aggiunto un asset remoto. Dichiaralo in `browser.js` (o togli la dipendenza). |
| `l'URL di default del bridge in app.jsx…` FAIL | `app.jsx` non usa piu' `http://localhost:7878`. Aggiorna `APP_DEFAULT_SERVER`: senza, l'app andrebbe in `serverDown` e il test resterebbe verde su meta' applicazione. |
| `il progetto arriva in timeline` FAIL | il boot non e' arrivato in fondo. Guarda l'errore riportato subito sotto, e il log del bridge su stderr. |

## Skip

Senza playwright installato, o senza il suo browser scaricato, la suite si
salta **rumorosamente** (stampa il comando e esce 0): 150 MB non sono roba che
un target di test debba tirare giu' da solo. `PGE_REQUIRE_E2E=1` rende quello
skip un fallimento, ed e' cio' che passa la CI — la stessa regola di
`PGE_REQUIRE_ENGINE_FIXTURES`.

La meta' statica (vendor, SRI, guardia di sorgente) gira comunque, browser o no.
