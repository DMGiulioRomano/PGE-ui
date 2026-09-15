# PGE-ui — convenience targets
#
# The actual rendering lives in PythonGranularEngine. This Makefile only
# wraps the local bridge `server.py` and a couple of dev shortcuts.

PYTHON   ?= python3
PORT     ?= 7878
ROOT     ?= ../PythonGranularEngine
# Cartella di lavoro: configs/ output/ cache/. Vuota = come ROOT, cioe' i
# progetti stanno dentro il checkout del motore (comportamento storico). #147
WORKSPACE ?=
WS_FLAG  := $(if $(WORKSPACE),--workspace $(WORKSPACE),)
VENV     := .venv
VENV_BIN := $(VENV)/bin
# Dove `install-cli` mette il symlink `pge-ui`. ~/.local/bin e' il posto in cui
# si aggiunge un comando senza sudo; se non e' nel PATH il target lo dice, ed e'
# il modo piu' comune in cui questa cosa sembra non funzionare. #164
BINDIR   ?= $(HOME)/.local/bin
# Un `~` in BINDIR non lo espande nessuno: make non fa tilde expansion, e la
# ricetta quota ogni espansione (deve: gli spazi). `BINDIR=~/.local/bin` — la
# grafia che l'help qui sotto suggerisce — fabbricava percio' una cartella
# chiamata `~` dentro $PWD, ci metteva il link e stampava la riga di successo:
# lo stesso modo di fallire dello spazio e del `make -f`, cioe' un `pge-ui`
# annunciato installato che nessun PATH raggiunge.
# `override` non e' ornamentale: senza, l'assegnamento verrebbe ignorato
# proprio nel caso che cura — BINDIR arriva da riga di comando, e li' make fa
# vincere la riga di comando sul file. Le grafie che restano (`~utente/bin`,
# `~` nudo, HOME non esportato) make non le sa risolvere: le ferma la ricetta.
override BINDIR := $(if $(HOME),$(patsubst ~/%,$(HOME)/%,$(BINDIR)),$(BINDIR))
# Il sorgente del link si risolve sulla cartella di QUESTO Makefile, non su
# quella da cui hai lanciato make: con `$(abspath bin/pge-ui)` un
# `make -f /path/PGE-ui/Makefile install-cli` dato da un'altra cartella linkava
# `$PWD/bin/pge-ui`, che li' non esiste — e `ln -s` non guarda il target, quindi
# il link pendente nasceva annunciato come riuscito.
CLI_SRC  := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))/bin/pge-ui

# I test di parita' girano da tests/parity/, quindi il path del motore va
# assolutizzato qui: relativo si romperebbe al primo cd.
#
# La precedenza e' quella di make, non l'inverso: `ROOT=` da riga di comando
# batte tutto, poi PGE_ENGINE_ROOT dall'ambiente, poi il default. Le due
# versioni precedenti sbagliavano una a testa — `$(abspath $(ROOT))` secco
# ignorava un PGE_ENGINE_ROOT esportato (che il README documenta come variabile
# valida, e con direnv c'e' sempre); il `$(if ...)` che l'ha sostituito faceva
# vincere l'ambiente su un ROOT= esplicito, rendendo muto proprio il consiglio
# che `make tests` stampa quando la parita' salta.
ifeq ($(origin ROOT),command line)
ENGINE_ROOT := $(abspath $(ROOT))
else
ENGINE_ROOT := $(if $(PGE_ENGINE_ROOT),$(PGE_ENGINE_ROOT),$(abspath $(ROOT)))
endif

.PHONY: help serve install install-cli dev-clean tests tests-node tests-python tests-parity tests-e2e

help:
	@echo " PGE-ui · targets"
	@echo ""
	@echo "  make install         crea .venv e installa requirements.txt"
	@echo "  make install-cli     mette \`pge-ui\` sul PATH ($(BINDIR))"
	@echo "  make serve           avvia il bridge locale su :$(PORT)"
	@echo "                       (default ROOT=$(ROOT))"
	@echo "                       WORKSPACE=~/brani per lavorare fuori dal repo engine"
	@echo ""
	@echo "  make tests           suite completa (node + python + parita' + e2e)"
	@echo "  make tests-parity    solo i confronti con il motore vero"
	@echo "  make tests-e2e       boot headless dell'editor (serve un browser)"
	@echo ""
	@echo " Variables:"
	@echo "  PORT=7878            porta"
	@echo "  ROOT=../PythonGranularEngine   path al repo engine (sorgente)"
	@echo "  WORKSPACE=~/brani    cartella con configs/ output/ cache/"
	@echo "                       (default: = ROOT, i progetti nel repo engine)"
	@echo "  PYTHON=python3       interprete usato per creare il venv"
	@echo "  BINDIR=~/.local/bin  dove install-cli mette il symlink pge-ui"
	@echo "  PGE_PARITY_STRICT=1  un caso di parita' saltato diventa un errore"
	@echo "  PGE_REQUIRE_E2E=1    un e2e saltato (browser assente) diventa un errore"

$(VENV_BIN)/pip:
	$(PYTHON) -m venv $(VENV)

install: $(VENV_BIN)/pip
	$(VENV_BIN)/pip install -r requirements.txt

serve: $(VENV_BIN)/pip
	$(VENV_BIN)/python server.py --root $(ROOT) $(WS_FLAG) --port $(PORT)

# Un nome sul PATH per il bridge (#164): `cd ~/qualsiasi-brano && pge-ui`.
# E' un symlink, non una copia, cosi' un `git pull` aggiorna anche il comando.
# `-sfn` lo rende idempotente: lanciarlo due volte di fila non e' un errore e
# non lascia un link dentro un link.
#
# Nessuna dipendenza dal venv: `install-cli` e' un gesto di installazione, non
# di setup, e chi tiene le dipendenze fuori dal repo non deve vedersi creare un
# .venv per avere il comando. Il venv, se c'e', lo preferisce bin/pge-ui.
#
# Ogni espansione e' quotata: uno spazio nel path del checkout o del BINDIR
# (~/Documents/…, ~/Library/Mobile Documents/…) faceva fabbricare a `mkdir -p`
# una cartella relativa dentro il repo e poi fallire `ln` nominando la
# destinazione, che invece esisteva. bin/pge-ui lo spazio lo reggeva gia'.
install-cli:
	@test -f "$(CLI_SRC)" || { \
	  echo "install-cli: non trovo $(CLI_SRC)" >&2; \
	  echo "  (lancialo dal checkout: make install-cli, oppure make -C /path/PGE-ui install-cli)" >&2; \
	  exit 1; }
	@test -x "$(CLI_SRC)" || { \
	  echo "install-cli: $(CLI_SRC) non e' eseguibile" >&2; \
	  echo "  chmod +x \"$(CLI_SRC)\"  — un link a un file senza bit x e' un nome" >&2; \
	  echo "  sul PATH che risponde 'Permission denied', annunciato come installato" >&2; \
	  exit 1; }
	@case "$(BINDIR)" in "~"*) \
	  echo "install-cli: BINDIR=$(BINDIR) comincia per ~, e qui nessuno lo espande" >&2; \
	  echo "  (make non fa tilde expansion: scrivilo per esteso, BINDIR=\$$HOME/.local/bin)" >&2; \
	  exit 1;; esac
	@mkdir -p "$(BINDIR)"
	@ln -sfn "$(CLI_SRC)" "$(BINDIR)/pge-ui"
	@echo "pge-ui -> $(BINDIR)/pge-ui"
	@case ":$$PATH:" in \
	  *:"$(BINDIR)":*|*:"$(BINDIR)/":*) ;; \
	  *) echo ""; \
	     echo "  attenzione: $(BINDIR) non e' nel PATH, quindi \`pge-ui\` non si"; \
	     echo "  trova ancora. Aggiungilo alla tua shell, per esempio:"; \
	     echo ""; \
	     echo "      export PATH=\"$(BINDIR):\$$PATH\"" ;; \
	esac

.PHONY: tests tests-node tests-python tests-parity tests-e2e

# La parita' entra in `make tests` solo se il motore c'e': senza repo fratello
# non c'e' niente da confrontare, e fallire li' punirebbe un clone appena
# fatto. Quando invece il motore c'e', i confronti girano e contano — e in CI
# (dove il motore viene fatto il checkout) un caso saltato e' un errore, vedi
# tests/parity/harness.js.
# I tre target girano TUTTI, e l'esito si accumula: `tests: tests-node
# tests-python` era una dipendenza make, quindi una suite node rossa faceva
# sparire pytest E la parita' — chi lancia `make tests` per avere il censimento
# ne riceveva un terzo. Dentro tests-node e tests-parity l'accumulo c'era gia',
# fra i tre target no.
tests:
	@rc=0; \
	$(MAKE) --no-print-directory tests-node   || rc=1; \
	$(MAKE) --no-print-directory tests-python || rc=1; \
	if [ -d "$(ENGINE_ROOT)/src/pge" ]; then \
	  $(MAKE) --no-print-directory tests-parity || rc=1; \
	else \
	  echo ""; \
	  echo "parita' saltata: nessun motore in $(ENGINE_ROOT)"; \
	  echo "  clona PythonGranularEngine accanto a PGE-ui, oppure: make tests ROOT=/path/to/engine"; \
	fi; \
	$(MAKE) --no-print-directory tests-e2e || rc=1; \
	echo ""; \
	if [ $$rc -eq 0 ]; then echo "All tests passed."; \
	else echo "Qualcosa e' rosso: il censimento qui sopra e' completo."; fi; \
	exit $$rc

# Stessa regola di `tests-parity`, e per la stessa ragione: `|| exit 1` fermava
# il ciclo alla prima suite rossa, e con venti file significa vedere un
# fallimento per giro invece di tutti. L'esito si accumula e si esce in fondo:
# un giro, il censimento completo.
#
# `PGE_ENGINE_ROOT` come negli altri due target: era l'unico a non passarla, e
# `test-yaml-bridge.js` era l'unico dei tre lettori a non leggerla, quindi
# `make tests-node ROOT=/path` — il ROOT= che l'help qui sopra suggerisce — non
# arrivava alle sette fixture nominate e il corpus spariva in uno skip verde.
# La stessa #132 che questo repo presidia, dalla porta di servizio.
tests-node:
	cd tests/node && npm install --silent
	@cd tests/node && rc=0; for f in test-*.js; do \
	  echo "▶ $$f"; \
	  PGE_ENGINE_ROOT="$(ENGINE_ROOT)" node "$$f" || rc=1; \
	done; exit $$rc

# `PGE_ENGINE_ROOT` passata anche qui: senza, `make tests-python ROOT=/path`
# — il ROOT= che l'help di questo Makefile suggerisce — non arrivava a pytest,
# ed `engine_corpus.py` ricadeva sul fratello calcolato da `__file__`. Un
# corpus che sparisce in uno skip verde, cioe' la #132 nell'unica meta' che
# non la rispettava.
tests-python:
	PGE_ENGINE_ROOT="$(ENGINE_ROOT)" $(VENV_BIN)/python -m pytest tests/python/ -v

# js-yaml sta in tests/node/node_modules (unico package.json del repo): le
# suite di parita' che serializzano uno stream lo caricano da li'.
# `|| exit 1` fermerebbe il ciclo alla prima suite rossa, e con cinque suite
# significa vedere un fallimento per giro invece di tutti. Qui l'esito si
# accumula e si esce in fondo: un giro, il censimento completo.
tests-parity:
	cd tests/node && npm install --silent
	@cd tests/parity && rc=0; for f in test-*.js; do \
	  echo "▶ $$f"; \
	  PGE_ENGINE_ROOT="$(ENGINE_ROOT)" node "$$f" || rc=1; \
	done; exit $$rc

dev-clean:
	@echo "Reset the editor's cached stem index: open devtools and run"
	@echo "    localStorage.clear()"
	@echo "(clears pge-local-stems / pge-local-fp / pge-local-sem; the server"
	@echo " keeps the real files)."

# Boot headless dell'editor (#139): apre `PGE Editor.html` in un Chromium
# guidato da playwright, contro il bridge vero su un motore finto, e verifica
# che l'app parta senza errori, carichi il progetto versionato in
# tests/e2e/fixtures/, apra Inspector ed EnvelopeEditor e faccia un giro di
# undo/redo. E' l'unica suite che dimostra che un componente *funziona*: il
# gate statico (tests/node/test-sources.js) dice solo che parsa.
#
# `npm install` qui dentro e non in tests/node: playwright pesa, e ogni
# `make tests-node` la pagherebbe. Il BROWSER invece non si scarica da soli —
# sono ~150 MB, non e' roba che un target di test debba tirare giu' senza che
# nessuno l'abbia chiesto: se manca, test-boot.js si salta rumorosamente e
# dice il comando. PGE_REQUIRE_E2E=1 rende quello skip un fallimento, ed e'
# cio' che passa la CI — la stessa regola di PGE_REQUIRE_ENGINE_FIXTURES.
tests-e2e:
	cd tests/e2e && npm install --silent
	cd tests/e2e && node test-boot.js
