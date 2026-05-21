/* =============================================================================
 * audio-engine.js — Web Audio playback for rendered stems.
 *
 * Two modes:
 *   - "mock"  : no real .aif files exist. Synthesizes a procedural sound per
 *               stream so the user can hear playback + mute/solo work.
 *               Each stream gets a distinct color-coded timbre based on its id.
 *   - "http"  : fetches real audio from server.py /audio/<basename>__<sid>.wav
 *               (server transcodes the .aif to WAV via sox for cross-browser
 *               compatibility — Firefox doesn't decode AIFF natively).
 *
 * The engine treats `audioCtx.currentTime` as the master clock once playing.
 * The visual playhead reads from `engine.currentTime` so audio and timeline
 * stay in lockstep without drift.
 *
 * Exposed as:    window.PGEAudio.engine
 *
 * Lifecycle:
 *   await engine.ensureBuffer(streamId, spec)   // {duration, url?} - cached
 *   engine.scheduleStreams(streams, basename, fromTime)
 *   engine.play(); engine.pause(); engine.stop(); engine.seek(t)
 *   engine.setStreamMute(id, m); engine.setStreamSolo(id, s)
 *   engine.invalidateStream(id)                  // forget cached buffer
 *   engine.currentTime                           // playback position (s)
 *
 * Events:  window.dispatchEvent(new CustomEvent("pge-audio-tick", {detail: t}))
 *          fires ~60Hz while playing.
 * ===========================================================================*/

(function () {
  function strHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
    return Math.abs(h);
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.buffers = new Map();          // streamId → AudioBuffer
      this.bufferKeys = new Map();        // streamId → "basename__sid#fingerprint" cache key
      this.activeNodes = new Map();       // streamId → { source, gainNode, gainBase }
      this.streamMuteSolo = new Map();    // streamId → { mute, solo }
      this.anySolo = false;
      this.playing = false;
      this.startedAtCtx = 0;              // audioContext time at last play()
      this.startedFromTimeline = 0;       // timeline position at last play()
      this.lastTickTimelinePos = 0;       // for currentTime when paused
      this.tickRaf = null;
      this.lastStreams = [];              // streams we last scheduled
      this.lastBasename = null;
    }

    _ensureContext() {
      if (this.ctx) return;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error("Web Audio API not available");
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(this.ctx.destination);
    }

    // -------- buffer cache --------

    /**
     * Ensure we have a decoded AudioBuffer for `streamId`.
     * spec = { duration, url?, fingerprint?, color? }
     * If `fingerprint` differs from the cached one, the buffer is re-loaded.
     */
    async ensureBuffer(streamId, spec) {
      this._ensureContext();
      const key = (spec.url || "synth") + "#" + (spec.fingerprint || "");
      if (this.bufferKeys.get(streamId) === key && this.buffers.has(streamId)) return;

      let buffer;
      if (spec.url) {
        const res = await fetch(spec.url);
        if (!res.ok) throw new Error(`audio fetch failed: HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        buffer = await this.ctx.decodeAudioData(ab);
      } else {
        buffer = this._synthesize(streamId, spec.duration || 5, spec.color);
      }
      this.buffers.set(streamId, buffer);
      this.bufferKeys.set(streamId, key);
    }

    invalidateStream(id) {
      this.buffers.delete(id);
      this.bufferKeys.delete(id);
    }
    invalidateAll() {
      this.buffers.clear();
      this.bufferKeys.clear();
    }

    /**
     * Procedural synthesis used in mock mode. Builds a stereo buffer of
     * `duration` seconds that *sounds like* a granular stream (clouds of
     * short noise+sine grains with an ADSR-ish envelope). Per-stream pitch
     * derived from a hash of the streamId so different streams sound distinct.
     */
    _synthesize(streamId, duration, color) {
      const sr = this.ctx.sampleRate;
      const samples = Math.max(1, Math.floor(sr * duration));
      const buf = this.ctx.createBuffer(2, samples, sr);
      const hash = strHash(streamId);
      const baseFreq = 110 + (hash % 12) * 35;        // 110-495 Hz, just intonation-ish
      const grainRateHz = 6 + (hash % 5) * 2;          // 6-14 grains/sec
      const grainLen = 0.04 + (hash % 7) * 0.005;      // 40-70ms
      const detune = 1 + ((hash >> 4) % 5) * 0.003;
      const stereoSpread = 0.4 + (hash % 5) * 0.1;
      const seed = hash || 1;

      // simple LCG so the noise is reproducible per stream
      let rng = seed;
      const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return (rng / 0xffffffff) * 2 - 1; };

      for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        const pan = ch === 0 ? -stereoSpread : stereoSpread;
        const freq = baseFreq * (ch === 0 ? 1 : detune);

        // schedule a sequence of grain centers
        const nGrains = Math.max(1, Math.floor(duration * grainRateHz));
        for (let g = 0; g < nGrains; g++) {
          const tCenter = (g / nGrains) * duration + rand() * 0.02;
          const startSample = Math.max(0, Math.floor((tCenter - grainLen / 2) * sr));
          const endSample = Math.min(samples, startSample + Math.floor(grainLen * sr));
          for (let i = startSample; i < endSample; i++) {
            const local = (i - startSample) / (endSample - startSample); // 0..1
            const env = Math.sin(Math.PI * local);                       // hanning-ish
            const t = i / sr;
            const wobble = Math.sin(2 * Math.PI * (freq * 0.07) * t) * 0.04;
            const tone = Math.sin(2 * Math.PI * (freq + wobble) * t);
            const noise = rand() * 0.4;
            data[i] += (tone * 0.5 + noise * 0.5) * env * 0.45;
          }
        }
        // global fade in/out
        const fade = Math.floor(0.05 * sr);
        for (let i = 0; i < fade; i++) {
          const k = i / fade;
          data[i] *= k;
          data[samples - 1 - i] *= k;
        }
      }
      return buf;
    }

    // -------- scheduling --------

    /**
     * Schedule playback for a list of streams. Each stream gets its own
     * AudioBufferSourceNode scheduled to start at `audioCtx.currentTime +
     * (onset - fromTime)` if onset > fromTime, or already-in-progress
     * (`source.start(0, fromTime - onset)`) if we're mid-clip on seek.
     * Streams without a cached buffer are skipped (silent).
     */
    scheduleStreams(streams, basename, fromTime) {
      this._stopAllSources();
      if (!this.ctx) return;
      this.lastStreams = streams;
      this.lastBasename = basename;
      this.startedAtCtx = this.ctx.currentTime;
      this.startedFromTimeline = fromTime;

      const anySolo = streams.some(s => s.solo);
      this.anySolo = anySolo;

      for (const s of streams) {
        const buf = this.buffers.get(s.id);
        if (!buf) continue;
        const onset = +s.onset || 0;
        const dur = +s.duration || buf.duration;
        const clipEnd = onset + dur;
        if (clipEnd <= fromTime) continue;              // already past

        const source = this.ctx.createBufferSource();
        source.buffer = buf;

        const gainNode = this.ctx.createGain();
        const dbToLin = (db) => Math.pow(10, db / 20);
        const gainBase = dbToLin(typeof s.volume === "number" ? s.volume : -6);

        const muteSoloGain = this._effectiveMuteSoloGain(s, anySolo);
        gainNode.gain.value = gainBase * muteSoloGain;
        source.connect(gainNode).connect(this.master);

        const whenCtx = this.startedAtCtx + Math.max(0, onset - fromTime);
        const offset = Math.max(0, fromTime - onset);
        try {
          source.start(whenCtx, offset, Math.max(0.01, dur - offset));
        } catch {}

        this.activeNodes.set(s.id, { source, gainNode, gainBase });
      }
    }

    _effectiveMuteSoloGain(stream, anySolo) {
      const ms = this.streamMuteSolo.get(stream.id) || { mute: !!stream.mute, solo: !!stream.solo };
      if (ms.mute) return 0;
      if (anySolo && !ms.solo) return 0;
      return 1;
    }

    _stopAllSources() {
      for (const [, n] of this.activeNodes) {
        try { n.source.stop(0); } catch {}
      }
      this.activeNodes.clear();
    }

    // -------- transport --------

    async resumeIfSuspended() {
      this._ensureContext();
      if (this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch {}
      }
    }

    play() {
      if (this.playing) return;
      this._ensureContext();
      // If we already have scheduled sources (because someone called
      // scheduleStreams just now), let them run. Otherwise the caller is
      // expected to call scheduleStreams first.
      this.playing = true;
      if (this.activeNodes.size === 0 && this.lastStreams.length) {
        this.scheduleStreams(this.lastStreams, this.lastBasename, this.lastTickTimelinePos);
      }
      this._startTick();
    }

    pause() {
      if (!this.playing) return;
      this.lastTickTimelinePos = this.currentTime;
      this._stopAllSources();
      this.playing = false;
      this._stopTick();
    }

    stop() {
      this._stopAllSources();
      this.playing = false;
      this.lastTickTimelinePos = 0;
      this._stopTick();
      window.dispatchEvent(new CustomEvent("pge-audio-tick", { detail: 0 }));
    }

    seek(t) {
      const wasPlaying = this.playing;
      this._stopAllSources();
      this.lastTickTimelinePos = t;
      if (wasPlaying && this.lastStreams.length) {
        this.scheduleStreams(this.lastStreams, this.lastBasename, t);
      }
    }

    get currentTime() {
      if (!this.ctx) return this.lastTickTimelinePos;
      if (!this.playing) return this.lastTickTimelinePos;
      return this.startedFromTimeline + (this.ctx.currentTime - this.startedAtCtx);
    }

    setMasterVolume(linear) {
      if (this.master) this.master.gain.value = linear;
    }

    setStreamMute(id, mute) {
      const ms = this.streamMuteSolo.get(id) || {};
      ms.mute = !!mute;
      this.streamMuteSolo.set(id, ms);
      this._refreshLiveGains();
    }
    setStreamSolo(id, solo) {
      const ms = this.streamMuteSolo.get(id) || {};
      ms.solo = !!solo;
      this.streamMuteSolo.set(id, ms);
      this._recomputeAnySolo();
      this._refreshLiveGains();
    }
    syncMuteSoloFromStreams(streams) {
      this.streamMuteSolo.clear();
      for (const s of streams) this.streamMuteSolo.set(s.id, { mute: !!s.mute, solo: !!s.solo });
      this._recomputeAnySolo();
      this._refreshLiveGains();
    }
    _recomputeAnySolo() {
      let any = false;
      for (const [, ms] of this.streamMuteSolo) if (ms.solo) { any = true; break; }
      this.anySolo = any;
    }
    _refreshLiveGains() {
      for (const [id, node] of this.activeNodes) {
        const s = this.lastStreams.find(x => x.id === id) || { id, mute: false, solo: false };
        node.gainNode.gain.setTargetAtTime(
          node.gainBase * this._effectiveMuteSoloGain(s, this.anySolo),
          this.ctx.currentTime, 0.01
        );
      }
    }

    // -------- ticker --------

    _startTick() {
      if (this.tickRaf) return;
      const tick = () => {
        if (!this.playing) return;
        const t = this.currentTime;
        window.dispatchEvent(new CustomEvent("pge-audio-tick", { detail: t }));
        this.tickRaf = requestAnimationFrame(tick);
      };
      this.tickRaf = requestAnimationFrame(tick);
    }
    _stopTick() {
      if (this.tickRaf) cancelAnimationFrame(this.tickRaf);
      this.tickRaf = null;
    }
  }

  window.PGEAudio = { engine: new AudioEngine() };
})();
