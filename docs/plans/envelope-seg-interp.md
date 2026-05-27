# Piano: Interpolazione per segmento nell'EnvelopeEditor

## Contesto

`PythonGranularEngine` supporta già interpolazione per-punto: il breakpoint `i` può avere un terzo elemento `type ∈ {linear, cubic, step}` che specifica l'interpolazione per il segmento `i→i+1` (3-tuple `[t, v, 'type']`). Il tipo sull'ultimo breakpoint è ignorato. Il formato è già letto/scritto correttamente dal motore.

**Obiettivo**: nell'EnvelopeEditor, click destro su un segmento tra due breakpoint → mini menu con tre icone (linear / cubic / step) → la curva del segmento cambia immediatamente. Il dato viene serializzato come 3-tuple nel YAML.

---

## Diagnosi dello stato attuale

| Componente | Stato | Problema |
|---|---|---|
| `envelope-loops.js:27` `isBreakpoint()` | `item.length === 2` | Blocca 3-tuple |
| `envelope-loops.js:45` `wrapEnv()` | Dict `{type, points}` se interp globale ≠ linear | Non gestisce 3-tuple |
| `EnvelopeEditor.jsx:1038` `emitGroup()` | `interp` globale per tutti i segmenti | Non legge `bps[i][2]` |
| `EnvelopeEditor.jsx:1091` `buildEnvelopeD()` | Un solo path SVG cumulativo | Nessun hit target per segmento |
| Context menu | Assente | Da creare |

---

## Modifiche

### 1. `envelope-loops.js`

**`isBreakpoint()`**: accettare anche 3-tuple `[t, v, type_string]`.

**`wrapEnv()`**: se almeno un item ha 3° elemento (interp per-punto esplicita), restituire array piatto — non wrappare in dict. La forma dict resta per global interp senza 3-tuple.

### 2. `EnvelopeEditor.jsx`

- Helper `segInterp(bp, fallback)`: legge `bp[2]` se presente, altrimenti `fallback`.
- `emitGroup()`: per ogni segmento `i→i+1` usa `segInterp(bps[i], interp)` — tangenti PCHIP calcolate una volta sola su tutti i punti (corretto per cubic).
- `buildSegmentHitPaths()`: array di `{d, bpOrigIdx, curInterp}` per ogni coppia consecutiva di breakpoint standard (linea retta fat-stroke, usata solo come hit area).
- Stato `ctxMenu`: `null` | `{ bpOrigIdx, x, y, curInterp }`.
- Handler `openSegCtxMenu` / `setSegInterp`.
- JSX: hit paths SVG trasparenti (strokeWidth 12) + menu floating con 3 bottoni + mini SVG icone.

### 3. `envelope_editor.css`

Stili per `.ee-seg-ctx-menu` e `.ee-seg-ctx-btn`.

---

## Verifica

1. Click destro su segmento → menu appare
2. Selezionare cubic → curva smooth solo su quel segmento
3. Selezionare step → gradino solo su quel segmento
4. Selezionare linear su default → nessuna 3-tuple nel YAML (pulizia)
5. Salva YAML → 3-tuple visibili per segmenti con tipo esplicito
6. Ricarica → forme curve corrette
7. Render con `make serve` → engine usa interp per segmento
