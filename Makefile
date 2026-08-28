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
tests: tests-node tests-python
	@if [ -d "$(ENGINE_ROOT)/src/pge" ]; then \
	  $(MAKE) --no-print-directory tests-parity; \
	else \
	  echo ""; \
	  echo "parita' saltata: nessun motore in $(ENGINE_ROOT)"; \
	  echo "  clona PythonGranularEngine accanto a PGE-ui, oppure: make tests ROOT=/path/to/engine"; \
	fi
	@echo ""
	@echo "All tests passed."

tests-node:
	cd tests/node && npm install --silent && for f in test-*.js; do echo "▶ $$f"; node "$$f" || exit 1; done

tests-python:
	$(VENV_BIN)/python -m pytest tests/python/ -v

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
	@echo "(clears pge-local-stems / pge-local-fp; the server keeps the real files)."
