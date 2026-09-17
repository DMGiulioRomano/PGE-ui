# PGE-ui — convenience targets
#
# The actual rendering lives in PythonGranularEngine. This Makefile only
# wraps the local bridge `server.py` and a couple of dev shortcuts.

PYTHON   ?= python3
PORT     ?= 7878
ROOT     ?= ../PythonGranularEngine
# Cartella di lavoro: configs/ output/ cache/. Vuota = come ENGINE_ROOT, cioe'
# i progetti stanno dentro il checkout del motore (comportamento storico, #147).
#
# Da #165 il DEFAULT DEL BRIDGE e' invece la cwd: `pge-ui` da ~/un-brano lavora
# li'. `make serve` pero' si lancia da dentro questo checkout, dove la cwd e'
# PGE-ui: ereditare quel default significherebbe creare configs/ output/ cache/
# dentro il repo dell'editor e far sparire dall'elenco i progetti di chi
# aggiorna. Quindi qui il workspace si passa sempre, esplicito.
WORKSPACE ?=
VENV     := .venv
VENV_BIN := $(VENV)/bin
# Dove `install-cli` mette il symlink `pge-ui`. ~/.local/bin e' il posto in cui
# si aggiunge un comando senza sudo; se non e' nel PATH il target lo dice, ed e'
# il modo piu' comune in cui questa cosa sembra non funzionare. #164
# Senza HOME il default non esiste: `$(HOME)/.local/bin` diventerebbe
# `/.local/bin`, che nessun `~` ferma — e su una macchina dove `/` e'
# scrivibile (un container, un CI) l'install ci riusciva davvero e stampava la
# riga di successo. Vuoto, invece, lo ferma la ricetta dicendo cosa manca.
BINDIR   ?= $(if $(HOME),$(HOME)/.local/bin,)
# Un `~` in BINDIR non lo espande nessuno: make non fa tilde expansion, e la
# ricetta quota ogni espansione (deve: gli spazi). `BINDIR=~/.local/bin` — la
# grafia che l'help qui sotto suggerisce — fabbricava percio' una cartella
# chiamata `~` dentro $PWD, ci metteva il link e stampava la riga di successo:
# lo stesso modo di fallire dello spazio e del `make -f`, cioe' un `pge-ui`
# annunciato installato che nessun PATH raggiunge.
# `override` non e' ornamentale: senza, l'assegnamento verrebbe ignorato
# proprio nel caso che cura — BINDIR arriva da riga di comando, e li' make fa
# vincere la riga di comando sul file.
# `patsubst` pero' lavora a PAROLE, e li' l'espansione del `~` si portava
# dietro la stessa bugia che toglie: `BINDIR=/tmp/a  b` tornava `/tmp/a b`, cioe'
# il link in una cartella che non e' quella chiesta, annunciata riuscita. La
# riscrittura si applica percio' solo al BINDIR di una parola sola — dove
# patsubst non ha niente da spezzare; ogni altro passa verbatim, e gli spazi
# li regge la ricetta, che quota ogni espansione. Le grafie che restano
# (`~utente/bin`, `~` nudo, `~/con  spazi`) make non le sa risolvere: le ferma
# la ricetta, invece di inventare una cartella.
#
# Nello stesso ramo cade la GRAFIA del path, e per una ragione sola: non
# cambia dove finisce il link — `mkdir` e `ln` la reggono qualunque — ma il
# confronto con il PATH e' testuale, e `$PATH` elenca `/home/tu/.local/bin`.
# Cioe' l'avviso «BINDIR non e' nel PATH» — l'unica cosa che qui dentro spiega
# un `command not found` — parlava sulle grafie piu' facili da produrre: la
# barra in fondo che la tab-completion scrive da sola, e la barra doppia che
# il default stesso fabbricava da un `HOME=/root/` (una grafia che i container
# producono). Un avviso che grida dove non c'e' niente e' il primo che si
# impara a non leggere.
# Le toglie `abspath`, che e' gia' in casa (CLI_SRC) e le prende tutte in una
# volta: barre in fondo quante sono, barre doppie in mezzo, `.` e `..`. Due
# `patsubst` di fila ne toglievano due sole, e in fondo soltanto: `BINDIR=/x//`
# restava `/x/`, e la barra doppia del default non la vedeva nessuno.
# Il filtro `/%` NON e' ornamentale: `abspath` di un path relativo lo risolve
# sulla cwd di make, cioe' sceglierebbe proprio la cartella che la ricetta si
# rifiuta di scegliere — il guardiano sul BINDIR relativo diventerebbe muto,
# perche' non gli arriverebbe mai piu' un path relativo. Fuori dal filtro
# passano verbatim; `/` resta `/`, che `abspath` non svuota.
ifeq ($(words $(BINDIR)),1)
override BINDIR := $(if $(HOME),$(patsubst ~/%,$(HOME)/%,$(BINDIR)),$(BINDIR))
override BINDIR := $(if $(filter /%,$(BINDIR)),$(abspath $(BINDIR)),$(BINDIR))
endif
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

WS_FLAG  := --workspace $(if $(WORKSPACE),$(WORKSPACE),$(ENGINE_ROOT))

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
	@echo "                       (senza ROOT=: PGE_ENGINE_ROOT, poi il default)"
	@echo "  WORKSPACE=~/brani    cartella con configs/ output/ cache/"
	@echo "                       (default di make serve: = ROOT, i progetti nel"
	@echo "                        repo engine; il bridge lanciato a mano usa la"
	@echo "                        cartella corrente)"
	@echo "  PYTHON=python3       interprete usato per creare il venv"
	@echo "  BINDIR=~/.local/bin  dove install-cli mette il symlink pge-ui"
	@echo "  PGE_PARITY_STRICT=1  un caso di parita' saltato diventa un errore"
	@echo "  PGE_REQUIRE_E2E=1    un e2e saltato (browser assente) diventa un errore"

$(VENV_BIN)/pip:
	$(PYTHON) -m venv $(VENV)

install: $(VENV_BIN)/pip
	$(VENV_BIN)/pip install -r requirements.txt

# `$(ENGINE_ROOT)` e non `$(ROOT)`: la precedenza del motore e' quella
# calcolata qui sopra (ROOT= esplicito > PGE_ENGINE_ROOT > default), la stessa
# che `server.py` implementa per conto suo (#165). `make serve` la ignorava —
# passava `--root $(ROOT)` secco, quindi con un PGE_ENGINE_ROOT esportato
# `make tests` e `make serve` giravano su due motori diversi. Due precedenze
# per la stessa variabile nello stesso repo si vedono solo quando una delle due
# sbaglia; tests/python/test_cli_resolve.py adesso le confronta chiedendolo a
# make, non trascrivendo.
serve: $(VENV_BIN)/pip
	$(VENV_BIN)/python server.py --root $(ENGINE_ROOT) $(WS_FLAG) --port $(PORT)

# Un nome sul PATH per il bridge (#164): `cd ~/qualsiasi-brano && pge-ui`.
# E' un symlink, non una copia, cosi' un `git pull` aggiorna anche il comando.
# `-sfn` lo rende idempotente: lanciarlo due volte di fila non e' un errore e
# non lascia un link dentro un link.
#
# Nessuna dipendenza dal venv: `install-cli` e' un gesto di installazione, non
# di setup, e chi tiene le dipendenze fuori dal repo non deve vedersi creare un
# .venv per avere il comando. Il venv, se c'e', lo preferisce bin/pge-ui.
#
# Su `realpath` invece la dipendenza c'e', ed e' del lanciatore: e' cosi' che
# risolve il symlink che questo target crea. Non e' POSIX (su macOS arriva con
# la 12.3), e senza di lui bin/pge-ui si ferma — a ragione, invece di risolvere
# REPO sulla cartella corrente. Ma la ricetta non lo usa, quindi l'install
# riusciva lo stesso e annunciava un `pge-ui` che poi non parte mai: l'ultima
# grafia di quella famiglia, e l'unica che non nasce da un BINDIR scritto male
# ma da una piattaforma intera. Il guardiano lo chiede prima di linkare.
#
# Ogni espansione e' quotata: uno spazio nel path del checkout o del BINDIR
# (~/Documents/…, ~/Library/Mobile Documents/…) faceva fabbricare a `mkdir -p`
# una cartella relativa dentro il repo e poi fallire `ln` nominando la
# destinazione, che invece esisteva. bin/pge-ui lo spazio lo reggeva gia'.
#
# E un BINDIR relativo si ferma qui, che e' l'ultima grafia della stessa
# famiglia: `mybin` non nomina una cartella finche' non si sceglie rispetto a
# cosa: `make -C /path/PGE-ui` lo risolve dentro il checkout, `make -f
# /path/PGE-ui/Makefile` dentro la cartella da cui l'hai lanciato — la stessa
# ambiguita' che CLI_SRC toglie al sorgente del link, lasciata aperta sulla
# destinazione. Riusciva, stampava la riga di successo, e chiudeva
# consigliando `export PATH="mybin:$PATH"`: una voce di PATH relativa, cioe' un
# comando che risponde solo dalla cartella giusta — annunciato installato.
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
	@command -v realpath >/dev/null 2>&1 || { \
	  echo "install-cli: realpath non c'e' sul PATH, e bin/pge-ui lo usa per" >&2; \
	  echo "  risolvere il proprio path ATTRAVERSO il symlink che questo target" >&2; \
	  echo "  sta per creare. Senza, il lanciatore esce 1 a ogni invocazione:" >&2; \
	  echo "  installarlo adesso sarebbe un \`pge-ui\` sul PATH che non parte," >&2; \
	  echo "  annunciato come installato." >&2; \
	  echo "  (macOS prima della 12.3 non ce l'ha: brew install coreutils, e metti" >&2; \
	  echo "  la sua realpath sul PATH — un alias di shell non basta, qui serve un" >&2; \
	  echo "  eseguibile)" >&2; \
	  exit 1; }
	@test -n "$(BINDIR)" || { \
	  echo "install-cli: BINDIR e' vuoto, quindi non c'e' dove installare" >&2; \
	  echo "  (HOME non impostato? il default ne dipende: passa la destinazione" >&2; \
	  echo "  a mano, make install-cli BINDIR=/path/bin)" >&2; \
	  exit 1; }
	@case "$(BINDIR)" in "~"*) \
	  echo "install-cli: BINDIR=$(BINDIR) comincia per ~, e qui nessuno lo espande" >&2; \
	  echo "  (make non fa tilde expansion: scrivilo per esteso, BINDIR=\$$HOME/.local/bin)" >&2; \
	  exit 1;; esac
	@case "$(BINDIR)" in /*) ;; *) \
	  echo "install-cli: BINDIR=$(BINDIR) e' relativo, e un PATH relativo non e' un PATH" >&2; \
	  echo "  (si risolve sulla cartella di make — che \`make -C\` e \`make -f\` scelgono" >&2; \
	  echo "  diversa — e il comando risponderebbe solo da li': scrivilo assoluto," >&2; \
	  echo "  BINDIR=\$$HOME/.local/bin)" >&2; \
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
