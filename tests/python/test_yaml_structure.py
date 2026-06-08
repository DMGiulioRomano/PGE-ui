import glob
import os
import pytest
import yaml

CONFIGS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../..", "PythonGranularEngine/configs")
)
CONFIGS = sorted(glob.glob(os.path.join(CONFIGS_DIR, "*.yml")))
VALID_UNITS = {"semitones", "cents", "quarter_tone", "eighth_tone", "edo", "ratio"}


@pytest.mark.parametrize("path", CONFIGS, ids=lambda p: os.path.basename(p))
def test_no_semitone_range_in_voices(path):
    with open(path) as f:
        data = yaml.safe_load(f)
    for s in data.get("streams") or []:
        vp = (s.get("voices") or {}).get("pitch") or {}
        assert "semitone_range" not in vp, (
            f"voices.pitch contiene ancora semitone_range in {os.path.basename(path)}: {vp}"
        )


@pytest.mark.parametrize("path", CONFIGS, ids=lambda p: os.path.basename(p))
def test_pitch_unit_keys_valid(path):
    with open(path) as f:
        data = yaml.safe_load(f)
    for s in data.get("streams") or []:
        p = s.get("pitch")
        if not p or not isinstance(p, dict):
            continue
        has_unit = any(k in VALID_UNITS for k in p)
        has_edo  = "edo" in p   # EDO blocks: {edo: N, value: X}
        # pitch block with only "range" is valid: bridge defaults unit to semitones
        range_only = set(p.keys()) <= {"range"}
        assert has_unit or has_edo or range_only, (
            f"blocco pitch senza chiave unità valida in {os.path.basename(path)}: {p}"
        )
