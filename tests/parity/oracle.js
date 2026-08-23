/* =============================================================================
 * oracle.js — il client node di `engine_oracle.py` (issue #133).
 *
 * Avvia UN processo python per suite e gli parla a righe JSON. Il costo di
 * avvio (interprete + import del motore) si paga una volta sola; le domande
 * successive sono un write e una riga di risposta.
 *
 *     const { openOracle } = require("./oracle.js");
 *     const o = await openOracle({ root });
 *     const fp = await o.ask("fingerprint", { stream });          // una
 *     const [a, b] = await o.ask([{ op, args }, { op, args }]);   // in blocco
 *     o.close();
 *
 * `ask` con un array scrive tutte le righe in un colpo solo e attende le
 * risposte: il python le serve in ordine ma le risposte sono comunque
 * appaiate per `id`, quindi l'ordine non e' un'assunzione.
 *
 * Errori. `ask` NON rigetta quando il motore rifiuta: un rifiuto del motore e'
 * un dato di parita', non un guasto. Torna `{ok:false, error:"Classe: msg"}` e
 * il test ci asserisce sopra. Rigetta solo per guasti veri — processo morto,
 * riga non JSON, timeout — e in quel caso il messaggio porta con se' lo stderr
 * del python, dove sta il traceback.
 *
 * Lo stderr del processo non viene stampato mentre gira: il motore parla di suo
 * (il clip logger annuncia il proprio file di log alla prima costruzione di un
 * gate con envelope) e sarebbe rumore in mezzo alle asserzioni. Viene tenuto e
 * mostrato solo quando serve a spiegare un guasto.
 * ===========================================================================*/

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ORACLE_PY = path.join(__dirname, "engine_oracle.py");

/* Il gemello di NON_FINITE_TAG in engine_oracle.py. `Infinity` e `NaN` non
 * sono JSON, quindi sul filo viaggiano come `{"__float__": "Infinity"}` — un
 * dict etichettato e non una stringa nuda, perche' "Infinity" puo' essere un
 * valore di stringa legittimo. Qui tornano numeri veri, cosi' le suite
 * confrontano `-Infinity` con `-Infinity` invece di `null` con `null`. */
const NON_FINITE_TAG = "__float__";
const NON_FINITE = { Infinity: Infinity, "-Infinity": -Infinity, NaN: NaN };

function decodeFloats(v) {
  if (Array.isArray(v)) return v.map(decodeFloats);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === NON_FINITE_TAG && v[NON_FINITE_TAG] in NON_FINITE) {
      return NON_FINITE[v[NON_FINITE_TAG]];
    }
    const out = {};
    for (const k of keys) out[k] = decodeFloats(v[k]);
    return out;
  }
  return v;
}

/* L'interprete con cui girare l'oracolo, in ordine di fedelta':
 *   1. PGE_PARITY_PYTHON, se qualcuno ha da dire l'ultima parola;
 *   2. il venv del motore, se c'e' — li' `pge.cli` si importa davvero e la
 *      grammatica di --magnify-at arriva dal modulo invece che dai nodi AST;
 *   3. python3 di sistema, che basta per tutto il resto: nessuna delle op ha
 *      bisogno di numpy (verificato modulo per modulo), ed e' apposta — in CI
 *      il job node fa il checkout del motore ma non ne costruisce il venv. */
function pickPython(root) {
  if (process.env.PGE_PARITY_PYTHON) return process.env.PGE_PARITY_PYTHON;
  const venv = path.join(root, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

class Oracle {
  constructor(proc, python) {
    this.proc = proc;
    this.python = python;
    this.hello = null;
    this._nextId = 1;
    this._pending = new Map();
    this._buf = "";
    this._stderr = "";
    this._dead = null;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { this._stderr += chunk; });
    proc.on("error", (err) => this._die(`impossibile avviare ${python}: ${err.message}`));
    proc.on("close", (code) => this._die(`l'oracolo e' uscito con codice ${code}`));
  }

  stderr() { return this._stderr.trim(); }

  _die(reason) {
    if (this._dead) return;
    this._dead = reason;
    const err = new Error(this._withStderr(reason));
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
  }

  _withStderr(msg) {
    const e = this.stderr();
    return e ? `${msg}\n--- stderr del python ---\n${e}` : msg;
  }

  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = decodeFloats(JSON.parse(line));
      } catch (e) {
        this._die(`riga non JSON dall'oracolo: ${line.slice(0, 200)}`);
        return;
      }
      const waiter = this._pending.get(msg.id);
      if (!waiter) continue;   // handshake fuori tempo, o risposta duplicata
      this._pending.delete(msg.id);
      waiter.resolve(msg);
    }
  }

  _expect(id, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this._dead) return reject(new Error(this._withStderr(this._dead)));
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(this._withStderr(`nessuna risposta per id=${id} entro ${timeoutMs}ms`)));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  /* ask(op, args) → {ok, value|error}
   * ask([{op, args}, …]) → array di risposte, nello stesso ordine chiesto. */
  async ask(opOrBatch, args, opts = {}) {
    const timeoutMs = opts.timeoutMs || 60000;
    const batch = Array.isArray(opOrBatch)
      ? opOrBatch
      : [{ op: opOrBatch, args: args || {} }];
    if (batch.length === 0) return [];

    const lines = [];
    const waits = [];
    for (const req of batch) {
      const id = this._nextId++;
      lines.push(JSON.stringify({ id, op: req.op, args: req.args || {} }));
      waits.push(this._expect(id, timeoutMs));
    }
    if (this._dead) throw new Error(this._withStderr(this._dead));
    this.proc.stdin.write(lines.join("\n") + "\n");

    const answers = await Promise.all(waits);
    return Array.isArray(opOrBatch) ? answers : answers[0];
  }

  /* Come ask, ma un rifiuto del motore diventa un'eccezione. Per le domande
   * che nel test sono un mezzo e non il soggetto (costruire un fingerprint di
   * riferimento, leggere le costanti): li' un errore e' un guasto. */
  async value(op, args, opts) {
    const r = await this.ask(op, args, opts);
    if (!r.ok) throw new Error(`oracolo: ${op} → ${r.error}`);
    return r.value;
  }

  close() {
    if (this.proc.exitCode === null && !this._dead) {
      try { this.proc.stdin.end(); } catch (e) { /* gia' chiuso */ }
    }
    this.proc.unref();
  }
}

/* Avvia l'oracolo e attende l'handshake. Rigetta con un messaggio che dice
 * cosa e' andato storto (e lo stderr del python, se c'e' n'e'): chi chiama lo
 * mostra all'utente prima di decidere se saltare o fallire. */
async function openOracle({ root, timeoutMs = 30000 } = {}) {
  if (!root) throw new Error("openOracle: manca 'root' (checkout del motore)");
  if (!fs.existsSync(ORACLE_PY)) throw new Error(`openOracle: manca ${ORACLE_PY}`);

  const python = pickPython(root);
  const proc = spawn(python, [ORACLE_PY, "--root", root], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const o = new Oracle(proc, python);
  const hello = await o._expect(0, timeoutMs).catch((err) => {
    o.close();
    throw err;
  });
  if (!hello.ok || !hello.value || hello.value.hello !== "pge-parity-oracle") {
    o.close();
    throw new Error(o._withStderr(`handshake inatteso: ${JSON.stringify(hello).slice(0, 300)}`));
  }
  o.hello = hello.value;
  return o;
}

module.exports = { openOracle, Oracle, pickPython, decodeFloats, ORACLE_PY };
