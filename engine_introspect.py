#!/usr/bin/env python3
"""engine_introspect.py — read the engine's own source for the values the UI
must not hardcode.

Extracted from server.py (issue #133), same move as audio_pipeline.py /
render_pipeline.py before it (#43). Two consumers now:

  - server.py, which serves these over GET /envelope-keys and GET /bounds;
  - tests/parity/engine_oracle.py, which compares what is parsed here with
    what the engine actually holds once imported.

That second consumer is the reason for the split. The parity oracle must run
with the standard library alone — in CI the node job checks the engine out but
builds no venv — and importing server.py drags in flask, soundfile and numpy.
This module imports nothing but `ast` and `pathlib`, deliberately: the whole
point of parsing the engine's literals instead of importing them is that it
works on a checkout with no venv, and that property is now load-bearing twice.

Nothing here executes engine code. Every function reads a source file and
walks its AST.
"""

import ast
from pathlib import Path



_ENVELOPE_KEYS_CACHE: dict = {}


def engine_envelope_keys(root: Path) -> list:
    """Valid `--plot-envelopes` names = keys of the engine's `ENVELOPE_COLORS`
    dict literal (issue #31).

    We AST-parse the source rather than importing the module: it pulls in
    matplotlib/numpy/soundfile and may live in the engine's own venv, neither
    of which this bridge process has. Parsing the literal needs only stdlib and
    works even when the engine venv isn't set up yet. The UI fetches these to
    populate the score-envelope filter so the list is never hardcoded.

    The literal has moved across engine layouts (issue #109): born in
    src/rendering/score_visualizer.py, extracted to envelope_extractor.py
    (PGE #150 — score_visualizer now only re-imports it, so parsing it there
    finds nothing), then the whole package moved under src/pge/ (PGE #162).
    Candidates are tried newest-first; the first file whose parse yields keys
    wins, so every engine vintage keeps working.

    Returns the keys in source order, or [] if no candidate has the constant
    (an engine without the feature) — in which case the filter stays hidden
    and the flag is never sent. Result is cached per resolved root."""
    key = str(root)
    if key in _ENVELOPE_KEYS_CACHE:
        return _ENVELOPE_KEYS_CACHE[key]
    candidates = (
        root / "src" / "pge" / "rendering" / "envelope_extractor.py",
        root / "src" / "rendering" / "envelope_extractor.py",
        root / "src" / "rendering" / "score_visualizer.py",
    )
    keys: list = []
    for src in candidates:
        try:
            tree = ast.parse(src.read_text(encoding="utf-8"))
            for node in tree.body:
                d = _assigned_dict(node, "ENVELOPE_COLORS")
                if d is None:
                    continue
                for k in d.keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.append(k.value)
                break
        except Exception:
            keys = []
        if keys:
            break
    _ENVELOPE_KEYS_CACHE[key] = keys
    return keys


_PARAMETER_BOUNDS_CACHE: dict = {}

# Fields of the engine's ParameterBounds dataclass, in positional order, with
# the dataclass defaults for the ones that have them (min_val/max_val are
# required, so they have no default here).
_PB_FIELDS = ("min_val", "max_val", "min_range", "max_range",
              "default_jitter", "variation_mode")
_PB_DEFAULTS = {"min_range": 0.0, "max_range": 0.0,
                "default_jitter": 0.0, "variation_mode": "additive"}
# Used only if pitch_unit.py can't be parsed (older/odd engine): the nominal
# EDO presets and the ±3-octave factor, matching pitch_unit.py.
_PITCH_PRESET_DIVISIONS = {"semitones": 12, "cents": 1200,
                           "quarter_tone": 24, "eighth_tone": 48}


def _ast_literal(node):
    """ast.literal_eval a node, tolerating unary minus (e.g. -100.0) and None.
    Returns None on anything non-literal (an expression we can't resolve)."""
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def _ast_call_name(call):
    """Callee name of an ast.Call: `Foo(...)` → 'Foo', `mod.Foo(...)` → 'Foo'."""
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _parse_bounds_call(call):
    """Turn a `ParameterBounds(...)` AST call into a plain dict, applying the
    dataclass defaults for omitted fields. Positional args map onto _PB_FIELDS
    in order; keywords override. Returns None unless both min_val and max_val
    are present (max_val may legitimately be None — a sample-driven loop bound).
    """
    rec = dict(_PB_DEFAULTS)
    for field, arg in zip(_PB_FIELDS, call.args):
        rec[field] = _ast_literal(arg)
    for kw in call.keywords:
        if kw.arg in _PB_FIELDS:
            rec[kw.arg] = _ast_literal(kw.value)
    if "min_val" not in rec or "max_val" not in rec:
        return None
    return rec


def _assigned_value(node, name):
    """Return the AST node assigned to `name` by this statement, handling both a
    plain `name = …` (Assign) and an annotated `name: T = …` (AnnAssign). None
    if the statement isn't that assignment, or is a bare annotation with no
    value (`name: int`).

    ONE recognizer for all three readings in this module, and the reason is that
    the engine already annotates module constants — `GRANULAR_PARAMETERS`,
    `PITCH_UNIT_PRESETS` — so the annotated spelling is house style upstream,
    not a hypothetical. Two of the readings used to filter on `ast.Assign`
    alone. For `ENVELOPE_COLORS` that would silently drop the envelope-name
    filter; for `VARIATION_SEMANTICS_VERSION` it is worse, because the fallback
    is `None` = "engine unknown", and by this axis's own rule an unknown engine
    claims nothing — the whole axis would switch off and every stem go green
    exactly while the engine is about to rewrite them, triggered by the very
    event the axis watches for (a bump, shipped with a type annotation)."""
    if isinstance(node, ast.Assign):
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        value = node.value
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        targets = [node.target.id]
        value = node.value          # None for a bare `name: T`
    else:
        return None
    return value if name in targets else None


def _assigned_dict(node, name):
    """`_assigned_value` narrowed to a dict literal: None if it isn't one."""
    value = _assigned_value(node, name)
    return value if isinstance(value, ast.Dict) else None


def _parse_granular_parameters(src_text):
    """Extract GRANULAR_PARAMETERS from parameter_definitions.py source as
    {name: {min_val, max_val, …}}."""
    out = {}
    tree = ast.parse(src_text)
    for node in ast.walk(tree):
        d = _assigned_dict(node, "GRANULAR_PARAMETERS")
        if d is None:
            continue
        for k, v in zip(d.keys, d.values):
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                continue
            if isinstance(v, ast.Call) and _ast_call_name(v) == "ParameterBounds":
                rec = _parse_bounds_call(v)
                if rec is not None:
                    out[k.value] = rec
        break
    return out


def _find_value_bounds_method(classdef):
    for fn in classdef.body:
        if isinstance(fn, ast.FunctionDef) and fn.name == "value_bounds":
            return fn
    return None


def _parse_edo_factor(tree):
    """The ±N·divisions octave factor from EdoUnit.value_bounds
    (`bound = 3.0 * self.divisions`). Defaults to 3.0 if not found."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.ClassDef) and node.name == "EdoUnit"):
            continue
        fn = _find_value_bounds_method(node)
        if fn is None:
            continue
        for sub in ast.walk(fn):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.Mult):
                for a, b in ((sub.left, sub.right), (sub.right, sub.left)):
                    if (isinstance(a, ast.Constant)
                            and isinstance(a.value, (int, float))
                            and not isinstance(a.value, bool)
                            and isinstance(b, ast.Attribute)
                            and b.attr == "divisions"):
                        return float(a.value)
    return 3.0


def _parse_ratio_bounds(tree):
    """{min, max, rangeMax} from RatioUnit.value_bounds. Defaults to the known
    [0.001, 8] / rangeMax 2 if not found."""
    for node in ast.walk(tree):
        if not (isinstance(node, ast.ClassDef) and node.name == "RatioUnit"):
            continue
        fn = _find_value_bounds_method(node)
        if fn is None:
            continue
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Call) and _ast_call_name(sub) == "ParameterBounds":
                rec = _parse_bounds_call(sub)
                if rec is not None and isinstance(rec.get("min_val"), (int, float)):
                    return {"min": rec["min_val"], "max": rec["max_val"],
                            "rangeMax": rec["max_range"]}
    return {"min": 0.001, "max": 8.0, "rangeMax": 2.0}


def _parse_pitch_presets(tree):
    """EDO divisions per nominal preset from PITCH_UNIT_PRESETS
    (`'semitones': lambda: EdoUnit(12, …)` → {'semitones': 12, …})."""
    out = {}
    for node in ast.walk(tree):
        d = _assigned_dict(node, "PITCH_UNIT_PRESETS")
        if d is None:
            continue
        for k, v in zip(d.keys, d.values):
            if not (isinstance(k, ast.Constant) and isinstance(k.value, str)):
                continue
            body = v.body if isinstance(v, ast.Lambda) else v
            if (isinstance(body, ast.Call) and _ast_call_name(body) == "EdoUnit"
                    and body.args):
                div = _ast_literal(body.args[0])
                if isinstance(div, int) and not isinstance(div, bool):
                    out[k.value] = div
        break
    return out


def _parse_pitch_bounds(src_text):
    """Pitch bounds per unit, derived from pitch_unit.py: each EDO preset gets
    ±(edoFactor·divisions); ratio is read from RatioUnit. Shape mirrors the
    UI's window.PGE_BOUNDS.pitch."""
    tree = ast.parse(src_text)
    edo_factor = _parse_edo_factor(tree)
    presets = _parse_pitch_presets(tree) or dict(_PITCH_PRESET_DIVISIONS)
    out = {"edoFactor": edo_factor, "ratio": _parse_ratio_bounds(tree)}
    for name, div in presets.items():
        bound = edo_factor * div
        out[name] = {"min": -bound, "max": bound, "rangeMax": bound}
    return out


def engine_parameter_bounds(root: Path) -> dict:
    """Engine parameter clamps, AST-parsed from the engine source so the UI's
    bounds aren't hardcoded.

    Like engine_envelope_keys, we parse the literals rather than importing the
    modules: parameter_definitions.py / pitch_unit.py would drag in the engine
    package (and its venv), and parsing needs only stdlib — so this works even
    when the engine venv isn't set up. Shape:

        {"params": {name: {min_val, max_val, min_range, max_range,
                           default_jitter, variation_mode}},
         "pitch":  {semitones|cents|…: {min, max, rangeMax},
                    ratio: {…}, edoFactor: float}}

    Returns {} when neither source is present (an older engine) — the UI then
    keeps its static fallback bounds. Cached per resolved root."""
    key = str(root)
    if key in _PARAMETER_BOUNDS_CACHE:
        return _PARAMETER_BOUNDS_CACHE[key]
    # Current layout first (src/pge/, PGE #162), legacy flat src/ as fallback
    # for older engine checkouts (issue #109).
    pdir = root / "src" / "pge" / "parameters"
    if not pdir.is_dir():
        pdir = root / "src" / "parameters"
    params, pitch = {}, {}
    pd = pdir / "parameter_definitions.py"
    if pd.exists():
        try:
            params = _parse_granular_parameters(pd.read_text(encoding="utf-8"))
        except Exception:
            params = {}
    pu = pdir / "pitch_unit.py"
    if pu.exists():
        try:
            pitch = _parse_pitch_bounds(pu.read_text(encoding="utf-8"))
        except Exception:
            pitch = {}
    out = {"params": params, "pitch": pitch} if (params or pitch) else {}
    _PARAMETER_BOUNDS_CACHE[key] = out
    return out


_SEMANTICS_CACHE: dict = {}


def engine_semantics_version(root: Path):
    """`VARIATION_SEMANTICS_VERSION` del motore, o None se non c'e'.

    E' la versione della semantica di variazione: il motore la mette dentro il
    proprio fingerprint perche' uno stem dipende dal testo YAML **e** dal modo
    in cui il motore lo interpreta, e la seconda puo' cambiare a YAML fermo
    (`stream_cache_manager.py`). Un bump marca dirty ogni stem di ogni
    progetto.

    La UI ne ha bisogno per lo stesso motivo: il suo hash risponde a "l'utente
    ha modificato qualcosa dall'ultimo render", che a un bump non si muove — e
    il pallino resterebbe verde su audio che il motore rifara' diverso. Letto
    di qui, e non trascritto a mano da nessuna parte.

    AST come il resto del modulo: importare `stream_cache_manager` tira dentro
    il pacchetto del motore (e il suo venv), leggere l'assegnazione no.

    None = un motore senza la costante (piu' vecchio del suo introdursi): chi
    chiama non deve inventarsi un numero, deve non pretendere niente.

    La cache si invalida sul mtime dei sorgenti, a differenza delle altre due di
    questo modulo, e la ragione e' che qui il dato cambia esattamente quando
    serve: se il motore viene aggiornato sotto un `make serve` in corso, con una
    cache a vita il bump resterebbe invisibile fino al restart del bridge —
    proprio l'evento che questa lettura esiste per intercettare. Le altre due
    (chiavi degli envelope, bound) al massimo tengono in piedi un filtro
    leggermente vecchio."""
    candidates = (
        root / "src" / "pge" / "rendering" / "stream_cache_manager.py",
        root / "src" / "rendering" / "stream_cache_manager.py",
    )
    stamps = []
    for src in candidates:
        try:
            st = src.stat()
            stamps.append((str(src), st.st_mtime_ns, st.st_size))
        except OSError:
            stamps.append((str(src), None, None))
    # Una voce sola per root, non una per stato dei sorgenti: la chiave e' la
    # root e il timbro sta nel valore. Con il timbro dentro la chiave ogni
    # salvataggio del motore ne aggiungeva una invece di sostituirla, e sotto un
    # `make serve` durante lo sviluppo del motore il dizionario cresceva a ogni
    # salvataggio.
    key = str(root)
    stamp = tuple(stamps)
    cached = _SEMANTICS_CACHE.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    version = None
    for src in candidates:
        try:
            tree = ast.parse(src.read_text(encoding="utf-8"))
        except Exception:
            continue
        for node in tree.body:
            value = _assigned_value(node, "VARIATION_SEMANTICS_VERSION")
            if value is None:
                continue
            val = _ast_literal(value)
            if isinstance(val, int) and not isinstance(val, bool):
                version = val
            break
        if version is not None:
            break
    _SEMANTICS_CACHE[key] = (stamp, version)
    return version
