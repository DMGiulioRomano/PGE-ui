"""audio_pipeline.py — audio helpers for the PGE bridge.

Extracted from server.py (#43) to keep the Flask module thin. Contains only
pure / I/O helpers — no Flask, no global state. The route handlers in server.py
import these and keep their exact decorators, status codes and abort messages.

  - path resolution: safe_resolve, _resolve_audio (+ _AUDIO_EXTS)
  - sample duration: audio_duration (soundfile-first, soxi fallback)
  - DSP: _compute_peaks, _compute_spectrogram (+ PEAK_BUCKETS / SPEC_* consts)
  - cached derivations: transcode_wav, peaks_file, spectrogram_file
    (each takes the exact cache_file path the route wants, so cache layout is
    unchanged; they only encapsulate the fresh-check / compute / write rule)

numpy + soundfile stay lazily imported inside the DSP functions so the bridge
runs without them (peaks/spectrogram endpoints then 500 with a clear message).
"""

import subprocess
from pathlib import Path


# -------------------------------------------------------------------------
# Path resolution
# -------------------------------------------------------------------------

def safe_resolve(base: Path, name: str) -> "Path | None":
    """Resolve `base/name` while rejecting traversal and absolute paths."""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if name.startswith("."):
        return None
    return base / name


_AUDIO_EXTS = (".aif", ".aiff", ".wav", ".flac", ".mp3")


def _resolve_audio(base: Path, fname: str) -> "Path | None":
    """Resolve an audio source under `base` by its stem, accepting any of the
    known audio extensions (the browser may request `name.aif` for a `name.wav`
    on disk, or vice versa). Rejects traversal via safe_resolve. Returns the
    first existing match, else None."""
    stem = Path(fname).stem
    for ext in _AUDIO_EXTS:
        cand = safe_resolve(base, stem + ext)
        if cand is not None and cand.exists():
            return cand
    return None


def soxi_duration(path: Path) -> "float | None":
    """Get audio file duration via `soxi -D`. Returns None if soxi isn't
    installed or the file is unreadable. Kept as the fallback for audio_duration
    (and for the rare format soundfile's libsndfile build can't read)."""
    try:
        out = subprocess.check_output(
            ["soxi", "-D", str(path)],
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        ).decode().strip()
        return float(out)
    except Exception:
        return None


def _soundfile_duration(path: Path) -> "float | None":
    """Duration via soundfile (libsndfile): a HEADER-ONLY read — no subprocess,
    no full decode (sub-millisecond). soundfile is a declared bridge dep
    (requirements.txt) already used for /peaks + /spectrogram. Returns None if
    soundfile is missing, or the file is unreadable / an unsupported format
    (e.g. mp3 on libsndfile < 1.1.0)."""
    try:
        import soundfile as sf
        return float(sf.info(str(path)).duration)
    except Exception:
        return None


def audio_duration(path: Path) -> "float | None":
    """Audio file duration in seconds — soundfile-first, with a soxi fallback.

    soundfile needs no external binary and only reads the header, so durations
    work wherever the bridge's own deps are installed (no hard `soxi`
    requirement). `soxi -D` is tried only when soundfile can't read the file
    (missing dep, or a format its libsndfile build doesn't support). None when
    neither can read it. Cheap — runs once per file at list-time; the browser
    caches the result.

    Note: sox/soxi is still used elsewhere for the AIFF→WAV playback transcode;
    only the *duration* no longer depends on it."""
    dur = _soundfile_duration(path)
    if dur is not None and dur > 0:
        return dur
    return soxi_duration(path)


# -------------------------------------------------------------------------
# DSP (numpy-only, lazily imported)
# -------------------------------------------------------------------------

PEAK_BUCKETS = 32768

# Spectrogram grid caps — keep the payload tiny regardless of file length.
SPEC_NFFT = 2048
SPEC_HOP = SPEC_NFFT // 4
SPEC_MAX_COLS = 512
SPEC_FREQ_BINS = 256
SPEC_DB_FLOOR = -90.0


def _compute_peaks(source: Path, buckets: int = PEAK_BUCKETS) -> bytes:
    """Reduce an audio file to `buckets` max-abs amplitude values in 0..1,
    returned as little-endian float32 bytes. Mirrors the browser-side
    `_computePeaks` in audio-engine.js so the visual result is identical.
    Raises ImportError if numpy/soundfile are missing."""
    import numpy as np
    import soundfile as sf

    data, _sr = sf.read(str(source), dtype="float32", always_2d=True)
    mono = np.abs(data).max(axis=1)            # max across channels → (frames,)
    n = int(min(buckets, max(1, mono.shape[0])))
    # Bucket boundaries, then max within each bucket via reduceat.
    edges = (np.arange(n) * (mono.shape[0] / n)).astype(np.int64)
    out = np.maximum.reduceat(mono, edges).astype("<f4")
    return out.tobytes()


def _compute_spectrogram(source: Path, scale: str = "linear") -> bytes:
    """Compute a log-magnitude STFT spectrogram, returned as binary:
    8-byte little-endian header (uint32 width=time cols, uint32 height=freq
    bins) followed by width*height uint8 values (0..255). numpy-only — no
    scipy/matplotlib. Heavy FFT work runs here so the browser only paints.

    `scale` controls the FREQUENCY axis: "linear" buckets the rfft bins
    evenly; "log" buckets them on a log-frequency (geometric) spacing so low
    frequencies get more vertical room. Magnitude is always in dB either way.
    Raises ImportError if numpy/soundfile are missing."""
    import numpy as np
    import soundfile as sf

    data, _sr = sf.read(str(source), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)                    # downmix to mono
    n = mono.shape[0]
    if n < SPEC_NFFT:
        mono = np.pad(mono, (0, SPEC_NFFT - n))
        n = mono.shape[0]

    # Frame the signal: one column per hop.
    n_frames = 1 + (n - SPEC_NFFT) // SPEC_HOP
    n_frames = max(1, n_frames)
    window = np.hanning(SPEC_NFFT).astype("float32")
    idx = np.arange(SPEC_NFFT)[None, :] + np.arange(n_frames)[:, None] * SPEC_HOP
    frames = mono[idx] * window                 # (n_frames, nfft)

    spec = np.abs(np.fft.rfft(frames, axis=1))  # (n_frames, nfft/2+1)
    db = 20.0 * np.log10(spec + 1e-9)
    db = np.clip(db, SPEC_DB_FLOOR, 0.0)
    norm = ((db - SPEC_DB_FLOOR) / (-SPEC_DB_FLOOR) * 255.0)  # 0..255

    # Downsample to the capped grid via max-pool (reduceat) on each axis.
    # Linear edges are evenly spaced; log edges are geometric (low freq gets
    # more bins). reduceat needs strictly increasing edges, so dedupe.
    def _pool(arr, target, axis, log=False):
        size = arr.shape[axis]
        if size <= target and not log:
            return arr
        if log:
            edges = np.unique(np.geomspace(1, size, target).astype(np.int64)) - 1
            edges = np.clip(edges, 0, size - 1)
        else:
            edges = (np.arange(target) * (size / target)).astype(np.int64)
        return np.maximum.reduceat(arr, edges, axis=axis)

    norm = _pool(norm, SPEC_MAX_COLS, axis=0)   # time cols (always linear)
    norm = _pool(norm, SPEC_FREQ_BINS, axis=1, log=(scale == "log"))  # freq bins
    grid = norm.astype(np.uint8)                # (cols, bins)

    width, height = grid.shape[0], grid.shape[1]
    header = np.array([width, height], dtype="<u4").tobytes()
    # Row-major by time column: column c, then its freq bins low→high.
    return header + grid.tobytes()


# -------------------------------------------------------------------------
# Cached derivations
#
# Each takes the EXACT cache_file path the caller wants, so the on-disk cache
# layout is identical to the pre-split routes; these only encapsulate the
# shared "regenerate only when the source is newer than the cache" rule.
# -------------------------------------------------------------------------

class SoxNotFound(RuntimeError):
    """sox binary missing — route maps this to a 500 with its own message."""


class SoxFailed(RuntimeError):
    """sox returned non-zero — route maps this to a 500 with its own message."""


def _is_fresh(cache_file: Path, source: Path) -> bool:
    return cache_file.exists() and cache_file.stat().st_mtime >= source.stat().st_mtime


def transcode_wav(source: Path, cache_file: Path, timeout: float = 30.0) -> Path:
    """Transcode `source` to WAV at `cache_file` via sox if stale; return it.
    Raises SoxNotFound / SoxFailed (the caller turns these into HTTP 500)."""
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    if not _is_fresh(cache_file, source):
        try:
            subprocess.check_call(
                ["sox", str(source), str(cache_file)],
                stderr=subprocess.DEVNULL,
                timeout=timeout,
            )
        except FileNotFoundError:
            raise SoxNotFound()
        except subprocess.CalledProcessError as e:
            raise SoxFailed(str(e))
    return cache_file


def peaks_file(source: Path, cache_file: Path) -> Path:
    """Compute (if stale) and return the peaks cache file for `source`.
    Raises ImportError if numpy/soundfile are missing."""
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    if not _is_fresh(cache_file, source):
        cache_file.write_bytes(_compute_peaks(source))
    return cache_file


def spectrogram_file(source: Path, cache_file: Path, scale: str = "linear") -> Path:
    """Compute (if stale) and return the spectrogram cache file for `source`.
    Raises ImportError if numpy/soundfile are missing."""
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    if not _is_fresh(cache_file, source):
        cache_file.write_bytes(_compute_spectrogram(source, scale))
    return cache_file
