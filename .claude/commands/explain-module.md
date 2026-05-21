# Explain Module

Spiega in profondita un modulo o componente del codebase.

## Comportamento

Dato il path o nome del modulo in $ARGUMENTS:

1. Leggi il file sorgente completo
2. Leggi i test corrispondenti in `tests/`
3. Spiega in italiano:
   - Responsabilita del modulo (cosa fa, cosa NON fa)
   - Interfaccia pubblica (metodi, parametri, valori di ritorno)
   - Dipendenze (cosa importa, chi lo importa)
   - Pattern architetturali usati (Strategy, Factory, Template Method, ecc.)
   - Casi limite e comportamenti speciali
   - Come si collega al resto della pipeline

4. Se il modulo ha test, mostra quali comportamenti sono gia coperti
   e quali potrebbero mancare.

## Obiettivo

Aiutare l'utente a capire il codice prima di modificarlo,
in modo da prendere decisioni architetturali consapevoli.

Lingua: italiano. No emoji.
