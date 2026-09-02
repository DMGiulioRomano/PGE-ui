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

.PHONY: help serve install dev-clean tests tests-node tests-python

help:
	@echo " PGE-ui · targets"
	@echo ""
	@echo "  make install         crea .venv e installa requirements.txt"
	@echo "  make serve           avvia il bridge locale su :$(PORT)"
	@echo "                       (default ROOT=$(ROOT))"
	@echo "                       WORKSPACE=~/brani per lavorare fuori dal repo engine"
	@echo ""
	@echo " Variables:"
	@echo "  PORT=7878            porta"
	@echo "  ROOT=../PythonGranularEngine   path al repo engine (sorgente)"
	@echo "  WORKSPACE=~/brani    cartella con configs/ output/ cache/"
	@echo "                       (default: = ROOT, i progetti nel repo engine)"
	@echo "  PYTHON=python3       interprete usato per creare il venv"

$(VENV_BIN)/pip:
	$(PYTHON) -m venv $(VENV)

install: $(VENV_BIN)/pip
	$(VENV_BIN)/pip install -r requirements.txt

serve: $(VENV_BIN)/pip
	$(VENV_BIN)/python server.py --root $(ROOT) $(WS_FLAG) --port $(PORT)

.PHONY: tests tests-node tests-python

tests: tests-node tests-python
	@echo ""
	@echo "All tests passed."

tests-node:
	cd tests/node && npm install --silent && for f in test-*.js; do echo "▶ $$f"; node "$$f" || exit 1; done

tests-python:
	$(VENV_BIN)/python -m pytest tests/python/ -v

dev-clean:
	@echo "Reset the editor's cached stem index: open devtools and run"
	@echo "    localStorage.clear()"
	@echo "(clears pge-local-stems / pge-local-fp; the server keeps the real files)."
