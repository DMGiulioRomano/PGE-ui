/* =============================================================================
 * source-guard.js — il sorgente come CODICE, non come testo.
 *
 * Le guardie sorgente delle suite cercano un nome, una route, una chiamata nel
 * file che le implementa: sono l'unica copertura che hanno gli anelli che non
 * girano in node (le route del bridge, il cablaggio JSX). Lette sul sorgente
 * grezzo pero' trovano anche i COMMENTI, e allora una riscrittura che sposta la
 * logica e lascia il vecchio nome in un commento di rimando — cioe' il modo
 * normale di rifattorizzare — le lascia tutte verdi. Misurato: quattro
 * sabotaggi indipendenti (route rimossa, due call site rimossi, un `.map`
 * rimosso), tutti citati in un commento, tutti non morsi.
 *
 * `codeOf(file)` toglie i commenti e lascia tutto il resto, stringhe comprese:
 * una guardia che cerca `"/semantics-version"` deve continuare a trovarlo come
 * literal.
 *
 * `maskOf(file)` toglie anche il CONTENUTO delle stringhe (la lunghezza resta,
 * cosi' gli offset restano allineati all'originale): serve a contare le
 * parentesi senza che una graffa dentro una stringa sposti la profondita'.
 *
 * Non e' un parser: e' uno scanner che riconosce commenti di riga e di blocco,
 * le tre grafie di stringa e i letterali regex. Basta per del codice che parsa
 * gia' (`test-sources.js` lo pretende) e non introduce dipendenze.
 *
 * Il commento non si scrive allo stesso modo in ogni lingua, quindi `codeOf` e
 * `maskOf` scelgono lo scanner dall'ESTENSIONE: JS/JSX quello qui sotto, `.py`
 * quello di `scanPy`, HTML e CSS il minimo indispensabile. Passare un python
 * allo scanner JS non e' una approssimazione, e' un'altra lingua: li' `#` non
 * apre un commento e le virgolette triple non aprono una stringa.
 *
 * Quello che nessuno dei due fa e' distinguere il codice dalla PROSA dentro un
 * letterale: una stringa (in python anche una docstring) sopravvive per
 * costruzione, perche' una guardia che cerca `"/semantics-version"` deve
 * trovarlo. Se il punto e' non farsi ingannare dalla documentazione, il needle
 * va scelto in forma di codice.
 * =========================================================================== */

const fs = require("fs");

// Un `/` che segue uno di questi apre un regex, non e' una divisione.
const RE_PREFIX = /[(,=:[!&|?{};+\-*%^~<>]$/;

function scan(src, { blankStrings }) {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");

  while (i < n) {
    const c = src[i], d = src[i + 1];

    if (c === "/" && d === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; closed = true; break; }
        // Un apice non apre una stringa solo perche' e' scritto: fra apici o
        // virgolette un a capo non ci puo' stare (puo' solo nel template
        // literal), quindi se lo incontriamo quel carattere era testo — cioe'
        // l'apostrofo di un testo JSX, `each page's densest…`. Prenderlo per
        // un'apertura desincronizzava lo scanner per TUTTO il resto del file:
        // da li' in poi i commenti non venivano piu' riconosciuti e una
        // guardia sorgente tornava verde su una riga commentata, che e'
        // esattamente il difetto per cui questo modulo esiste. Misurato su
        // RenderButton.jsx: dalla riga 225 in giu' — cioe' su tutto
        // `buildCommand` — nessun commento veniva piu' tolto.
        if (c !== "`" && src[j] === "\n") break;
        // Un `${…}` in un template puo' contenere di tutto, virgolette
        // comprese: si salta fino alla graffa di chiusura corrispondente.
        if (c === "`" && src[j] === "$" && src[j + 1] === "{") {
          let depth = 1; j += 2;
          while (j < n && depth > 0) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      // Apice mai chiuso prima dell'a capo: non era un letterale. Si emette il
      // carattere e si riprende da quello dopo, invece di inghiottire il resto.
      if (!closed && c !== "`") { out += c; i++; continue; }
      const lit = src.slice(i, j);
      out += blankStrings ? blank(lit) : lit;
      i = j;
      continue;
    }
    if (c === "/") {
      // Letterale regex: solo dove un operando non puo' stare.
      const before = out.replace(/\s+$/, "");
      if (RE_PREFIX.test(before) || before === "") {
        let j = i + 1, inClass = false;
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "\n") break;              // non era un regex
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) { j++; break; }
          j++;
        }
        const lit = src.slice(i, j);
        out += blankStrings ? blank(lit) : lit;
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Il sorgente senza commenti. Stringhe e regex restano leggibili. */
function stripComments(src) { return scan(src, { blankStrings: false }); }

/** Il sorgente senza commenti ne' contenuto di stringhe/regex, stessa lunghezza. */
function maskLiterals(src) { return scan(src, { blankStrings: true }); }

/* Il commento non e' fatto allo stesso modo in ogni linguaggio, e uno scanner
 * JS su un HTML riconoscerebbe cose che li' non sono commenti. Lo strip si
 * sceglie quindi dall'estensione, e per HTML/CSS resta volutamente minimo:
 * togliere il commento e basta. */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/* Il python ha bisogno del suo scanner, e non e' un lusso: tre guardie leggono
 * server.py e engine_introspect.py da `codeOf` (test-bounds.js,
 * test-render-status.js), e passarli allo scanner JS e' un errore di categoria
 * — li' `#` non e' un commento, tre virgolette di fila sono tre stringhe e ogni
 * apostrofo dentro una docstring apre un letterale. Il risultato non era il
 * sorgente senza commenti: era un rimescolamento che dava le sue risposte per
 * caso.
 *
 * Stesse regole della meta' JS: via i commenti (`#` fino a fine riga), le
 * stringhe restano leggibili. Con un'avvertenza che vale la pena scrivere: in
 * python la prosa sta spesso in una DOCSTRING, che e' una stringa e quindi
 * sopravvive — esattamente come sopravvive una stringa JS. Una guardia che
 * cerca un nome citato in una docstring lo trova ancora: se il punto e'
 * distinguere il codice dalla prosa, il needle va scelto in forma di codice
 * (`opts.get("bw"`, non `bw`). */
function scanPy(src, { blankStrings }) {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");

  while (i < n) {
    const c = src[i];
    if (c === "#") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      // Le virgolette triple possono contenere un a capo, quelle singole no:
      // la stessa regola della meta' JS, e per la stessa ragione.
      const triple = src.slice(i, i + 3) === c + c + c;
      const q = triple ? c + c + c : c;
      let j = i + q.length;
      let closed = false;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src.startsWith(q, j)) { j += q.length; closed = true; break; }
        if (!triple && src[j] === "\n") break;
        j++;
      }
      if (!closed && !triple) { out += c; i++; continue; }
      const lit = src.slice(i, j);
      out += blankStrings ? blank(lit) : lit;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Il sorgente python senza commenti. Stringhe (docstring comprese) restano. */
function stripPyComments(src) { return scanPy(src, { blankStrings: false }); }
/** Il sorgente python senza commenti ne' contenuto delle stringhe. */
function maskPyLiterals(src) { return scanPy(src, { blankStrings: true }); }

function codeOf(file) {
  const src = fs.readFileSync(file, "utf8");
  if (/\.html?$/i.test(file)) return stripHtmlComments(src);
  if (/\.css$/i.test(file)) return stripBlockComments(src);
  if (/\.py$/i.test(file)) return stripPyComments(src);
  return stripComments(src);
}
function maskOf(file) {
  const src = fs.readFileSync(file, "utf8");
  if (/\.py$/i.test(file)) return maskPyLiterals(src);
  return maskLiterals(src);
}

/**
 * Profondita' di parentesi (tonde, quadre, graffe) all'offset dato, contata su
 * un sorgente gia' mascherato.
 */
function depthAt(masked, index) {
  let depth = 0;
  for (let i = 0; i < index && i < masked.length; i++) {
    const c = masked[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
  }
  return depth;
}

/**
 * Gli offset in cui `needle` compare a livello di modulo (profondita' 0).
 *
 * Il needle si cerca nel sorgente SENZA COMMENTI (le stringhe restano
 * leggibili, quindi un needle che ne contiene una si trova), e la profondita'
 * si conta su quello mascherato: le due letture hanno la stessa lunghezza
 * dell'originale, quindi gli offset sono gli stessi.
 */
function topLevelOccurrences(src, needle) {
  const code = stripComments(src);
  const mask = maskLiterals(src);
  const out = [];
  let i = code.indexOf(needle);
  while (i >= 0) {
    if (depthAt(mask, i) === 0) out.push(i);
    i = code.indexOf(needle, i + 1);
  }
  return out;
}

module.exports = {
  stripComments, stripHtmlComments, stripBlockComments, stripPyComments,
  maskLiterals, maskPyLiterals, codeOf, maskOf, depthAt, topLevelOccurrences,
};
