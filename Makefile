# PGE-ui — convenience targets
#
# The actual rendering lives in PythonGranularEngine. This Makefile only
# wraps the local bridge `server.py` and a couple of dev shortcuts.

PYTHON ?= python3
PORT   ?= 7878
ROOT   ?= ../PythonGranularEngine

.PHONY: help serve install dev-clean

help:
	@echo " PGE-ui · targets"
	@echo ""
	@echo "  make install         pip install -r requirements.txt"
	@echo "  make serve           run the local bridge on :$(PORT)"
	@echo "                       (defaults to ROOT=$(ROOT))"
	@echo ""
	@echo " Variables:"
	@echo "  PORT=7878            port to listen on"
	@echo "  ROOT=../PythonGranularEngine   path to engine repo"
	@echo "  PYTHON=python3       python interpreter to use"

install:
	$(PYTHON) -m pip install -r requirements.txt

serve:
	$(PYTHON) server.py --root $(ROOT) --port $(PORT)

dev-clean:
	@echo "Removing localStorage hint: open the editor's devtools and run"
	@echo "    localStorage.clear()"
	@echo "to reset the mock backend's saved state."
