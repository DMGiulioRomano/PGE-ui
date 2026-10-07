# Documenti del laboratorio (#188)

Le fixture del round-trip inverso: un file **scritto dal laboratorio** di
mare-nostrum, importato in un master con `- file:` e passato da PGE-ui (aperto,
salvato, modificato in una chiave), torna nel laboratorio con tutto quello che
aveva. Piano: mare-nostrum `docs/plans/stream-come-file.md`, passo 4.

## Cosa c'e'

| file | il caso dell'issue |
|---|---|
| `streams/finestra.yml` | `grain.envelope: {states, curve}`, la finestra che cambia nel tempo, con `step`, `cubic` e un `linear` sottinteso sui punti della curve; hanning torna in fondo come stato nuovo |
| `streams/progressione.yml` | `voices.pitch.progression: [[t, accordo, rivolto?], ...]` con `interp: cubic` e `voice_leading: positional` |
| `streams/voci.yml` | `voices:` con `unit: {edo: 19}`, `normalized: true` e una strategia per asse (pitch, onset_offset, pointer, pan) |
| `streams/tipo-sul-punto.yml` | inviluppi in lista col tipo sul punto (`[[0, 0.001, cubic], ...]`) su cinque parametri |
| `streams/risacca.yml` | la fixture di mare-nostrum: uno stream aperto dal brano, col **suo** piazzamento nel file (`onset: 12.5`, `mute: true`), un `{type: cubic, points}` e un `read_direction` a inviluppo |
| `master.yml` | il master che li importa tutti: uno con uno `stream_id` del master (`coro`), uno muto solo nel master, `risacca` a 2.5 e non muta (decide il master), e uno stream scritto dentro |

Tutti e cinque portano `seed: 1441` (quello di `studies/001-41/study.yml`, e
quello del master: un seed diverso farebbe avvisare il motore con `[SEED]`),
lo `stream_id` uguale al nome del file e, i quattro nati nel laboratorio,
`onset: 0`.

## Da dove vengono

Nessuno e' scritto a mano. `genera/genera.py` fa girare la pagina vera del
laboratorio (`src/granstudies/graph_page.html` di mare-nostrum) in node, sul
DOM finto di `tests/lab_dom.js`, con il corredo di `make serve` (lo
`study.yml` di `001-41`, le finestre e i default dell'engine); gli scenari di
`genera/` ne fanno i gesti — i campi, i menu di interpolazione,
`+ breakpoint`, il campo `tempo (0-1)`, `salva con nome` — e il documento che
`labDoc` restituisce si scrive con il dumper del server del laboratorio
(`serve._Dumper`, la chiamata di `serve._scrivi`). `risacca.yml` e' copiata
com'e' da `tests/fixtures/stream_come_file/streams/` di mare-nostrum, scritta
anche lei dalla pagina.

Generate a DMGiulioRomano/mare-nostrum@7ec8fc9, col submodule `engine/` a
DMGiulioRomano/PythonGranularEngine@027a2e2. Se il laboratorio cambia il modo
di scrivere un documento, si rigenerano da lui, non si correggono a mano:

```bash
python3 tests/fixtures/lab/genera/genera.py /path/to/mare-nostrum
```

(serve il submodule `engine/` di mare-nostrum popolato, e node).

## Chi le legge

- `tests/node/test-lab-roundtrip.js` — la strada dell'editor
  (`importRefs` + `parse` con `imports`, poi `serialize` +
  `serializeImports` / `changedImports` / `importedFileText`): aperto e
  salvato senza toccare niente il master e' lo stesso YAML e nessun file si
  riscrive; cio' che PGE-ui scriverebbe di ogni file e' gia' il documento del
  laboratorio; `volume` toccato riscrive solo quel file, e li' cambia solo
  `volume`.
- `tests/parity/test-lab-roundtrip-parity.js` — la stessa domanda al motore:
  risolti da `resolve_stream_files` prima e dopo il giro in PGE-ui, gli stream
  hanno lo stesso fingerprint della cache e lo stesso piazzamento.
- `genera/ritorno.py` — il ritorno nel laboratorio, con la sua pagina: i file
  come li scrive PGE-ui (`genera/scrivi-pgeui.js`, senza modifiche e col
  `volume` toccato) sono il documento che il laboratorio aveva scritto, tipi
  compresi (`gia_su_disco`), e riaperti si riscriverebbero identici, senza
  `• modificato` e senza lavoro proprio da perdere. Non e' un test di CI:
  mare-nostrum non e' un checkout fratello di PGE-ui, e lo sarebbe uno skip
  permanente. Si lancia a mano:

  ```bash
  python3 tests/fixtures/lab/genera/ritorno.py /path/to/mare-nostrum
  ```
