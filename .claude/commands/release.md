# Release

Esegui il workflow di release su branch main.

## Procedura

1. Verifica di essere su `main`:
   ```bash
   git branch --show-current
   ```

2. Verifica che tutti i test siano verdi:
   ```bash
   make tests
   make e2e-tests
   ```

3. Determina il numero di versione con l'utente (vX.Y.Z):
   - MAJOR: cambiamenti architetturali incompatibili
   - MINOR: nuove funzionalita retrocompatibili
   - PATCH: bugfix

4. Chiedi il nome della release (es. "Incremental Grain")

5. Crea il tag annotato:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z — \"Nome Release\""
   ```

6. Mostra il riepilogo delle modifiche dall'ultimo tag:
   ```bash
   git log $(git describe --tags --abbrev=0 HEAD^)..HEAD --oneline
   ```

7. Chiedi conferma prima di fare push del tag.

**Non fare push del tag senza conferma esplicita dell'utente.**
Lingua: italiano.
