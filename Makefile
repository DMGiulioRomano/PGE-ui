# PGE-ui — convenience targets
#
# The actual rendering lives in PythonGranularEngine. This Makefile only
# wraps the local bridge `server.py` and a couple of dev shortcuts.

PYTHON   ?= python3
PORT     ?= 7878
ROOT     ?= ../PythonGranularEngine
VENV     := .venv
VENV_BIN := $(VENV)/bin

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

.PHONY: help serve install dev-clean tests tests-node tests-python tests-parity

help:
	@echo " PGE-ui · targets"
	@echo ""
	@echo "  make install         crea .venv e installa requirements.txt"
	@echo "  make serve           avvia il bridge locale su :$(PORT)"
	@echo "                       (default ROOT=$(ROOT))"
	@echo ""
	@echo "  make tests           suite completa (node + python + parita')"
	@echo "  make tests-parity    solo i confronti con il motore vero"
	@echo ""
	@echo " Variables:"
	@echo "  PORT=7878            porta"
	@echo "  ROOT=../PythonGranularEngine   path al repo engine"
	@echo "  PYTHON=python3       interprete usato per creare il venv"
	@echo "  PGE_PARITY_STRICT=1  un caso di parita' saltato diventa un errore"

$(VENV_BIN)/pip:
	$(PYTHON) -m venv $(VENV)

install: $(VENV_BIN)/pip
	$(VENV_BIN)/pip install -r requirements.txt

serve: $(VENV_BIN)/pip
	$(VENV_BIN)/python server.py --root $(ROOT) --port $(PORT)

.PHONY: tests tests-node tests-python tests-parity

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
