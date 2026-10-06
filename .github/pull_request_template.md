Closes #

<!--
  LA RIGA QUI SOPRA E' OBBLIGATORIA, e va completata col numero dell'issue.
  E' l'unica cosa che GitHub legge per chiudere l'issue quando questa PR
  entra in main: non il titolo, non un commento, non i messaggi di commit.

  Le parole chiave sono INGLESI e sono nove: close/closes/closed,
  fix/fixes/fixed, resolve/resolves/resolved. Un "Chiude #219" scritto in
  italiano non chiude niente -- e' il caso vero da cui questa riga nasce: la
  PR #293 di PythonGranularEngine diceva «Chiude #219», e' stata merged, e la
  #219 e' rimasta aperta.

  Una riga per ogni issue: "Closes #123, #124" collega solo la prima.

      Closes #123
      Closes #124

  Solo issue DI QUESTO repo. "Closes owner/repo#123" crea un rimando, non una
  chiusura: quell'issue la chiude una PR sul suo repo. Qui scrivila senza
  parola chiave -- "Refs owner/repo#123".

  Se questa PR non chiude nessuna issue, togli la riga e dichiaralo:

      No issue: refuso nel README

  Il check `closes-issue` verifica questa riga su ogni apertura e ogni
  modifica del corpo.
-->

## Cosa cambia

<!-- Il fatto misurato, non l'intenzione: cosa faceva prima, cosa fa adesso. -->

## Verifica

<!-- `make tests` (node + python + parity + e2e): conteggio ed esito. -->

## Impatto sul motore

<!--
  Se la modifica dipende da una superficie di PythonGranularEngine (bounds,
  costanti, elenco dei backend, chiavi degli envelope, righe del protocollo
  NDJSON), dillo: gli specchi in src/lib/ e le suite di tests/parity/ sono il
  patto con quel repo, e un patto che si muove da un lato solo e' il difetto
  che quelle suite esistono per prendere.
-->
