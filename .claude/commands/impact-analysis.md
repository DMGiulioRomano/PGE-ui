# Impact Analysis

Prima di modificare qualsiasi componente esistente, esegui questa analisi.

## Procedura

1. Leggi il file o modulo indicato dall'utente
2. Identifica tutte le dipendenze dirette (chi importa questo modulo)
3. Identifica le dipendenze inverse (cosa importa questo modulo)
4. Elenca i test esistenti che coprono questo modulo
5. Valuta quali test potrebbero rompersi con la modifica proposta
6. Proponi il design della modifica PRIMA di scrivere codice

## Output richiesto

Fornisci:
- Elenco file coinvolti
- Elenco test coinvolti (con path esatti)
- Rischi architetturali
- Proposta di design (da approvare prima di procedere)

**Non generare codice di produzione finche il design non e approvato.**
**Lingua: italiano.**
