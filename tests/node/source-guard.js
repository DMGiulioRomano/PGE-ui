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
 * gia' (`test-jsx-parse.js` lo pretende) e non introduce dipendenze.
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
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
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

function codeOf(file) { return stripComments(fs.readFileSync(file, "utf8")); }
function maskOf(file) { return maskLiterals(fs.readFileSync(file, "utf8")); }

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
  stripComments, maskLiterals, codeOf, maskOf, depthAt, topLevelOccurrences,
};
