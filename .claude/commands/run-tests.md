# Run Tests

Esegui la suite di test del progetto.

## Comportamento

- Senza argomenti: lancia `make tests` (176 test, suite completa)
- Con path: lancia `make TEST_FILE=$ARGUMENTS tests` per suite specifica
- Mostra sempre il sommario finale con numero di test passati/falliti
- Se ci sono failure, mostra il traceback completo del primo errore

## Esempi

```
/run-tests                              # suite completa
/run-tests tests/rendering/             # solo rendering
/run-tests tests/core/test_grain.py     # solo un file
```

## Note

Dopo ogni run fallita, analizza il failure e proponi la correzione
seguendo il ciclo TDD: rosso -> verde -> refactor.
Lingua: italiano.
