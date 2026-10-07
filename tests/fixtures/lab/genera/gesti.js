// I gesti dell'utente sul laboratorio, eseguiti sulla pagina vera
// (mare-nostrum, `tests/lab_dom.js`): i campi a schermo, i menu di
// interpolazione, `+ breakpoint`, il campo `tempo (0-1)`, il salvataggio.
// Nessun documento si scrive a mano: lo scrive `labDoc`, come quando si
// preme `salva` nel laboratorio.

// Un campo a schermo, come lo scrive l'utente (anche i fissi: strategie,
// unita', `normalized`).
function campo(path, v) { setSel(path, v); }

// Il menu di interpolazione di un parametro: vale per il segmento che PARTE
// dal breakpoint che si sta per aggiungere.
function tipo(path, t) { document.getElementById("I:" + path).value = t; }

// `+ breakpoint` con i valori a schermo, poi il tempo scritto nel campo
// `tempo (0-1)`. Il laboratorio mette il primo punto a 0 e gli altri a 1:
// i punti vanno aggiunti in ordine di tempo, l'ultimo a 1, perche' ogni
// nuovo punto a 1 sia l'unico li' quando lo si sposta. I menu di
// interpolazione tornano `linear` prima di ogni punto, o il tipo del punto
// prima resterebbe a schermo e finirebbe anche su questo.
function punto(t, vals, ints) {
  for (const [p, v] of Object.entries(vals || {})) campo(p, v);
  for (const p of AUT) {
    const el = document.getElementById("I:" + p.path);
    if (el) el.value = "linear";
  }
  for (const [p, it] of Object.entries(ints || {})) tipo(p, it);
  vociVis();
  bpAdd();
  if (t !== 0 && t !== 1) {
    const f = document.getElementById("bpT");
    f.value = String(t);
    f.onchange();
  }
}

// `salva con nome` in `streams/<nome>.yml`: lo `stream_id` e' il nome del
// file (#5 di mare-nostrum) e il seed quello dello `study.yml` servito.
function salva(nome) {
  document.getElementById("labName").value = nome;
  console.log(JSON.stringify(labDoc("/brano/streams/" + nome + ".yml")));
}
