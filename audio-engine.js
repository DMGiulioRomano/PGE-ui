/* =============================================================================
 * audio-engine.js — Web Audio playback for rendered stems.
 *
 * Fetches real audio from server.py /audio/<basename>__<sid>.wav (the server
 * transcodes the .aif to WAV via sox for cross-browser compatibility — Firefox
 * doesn't decode AIFF natively). Streams without a rendered stem stay silent.
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
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.buffers = new Map();          // streamId → decoded AudioBuffer
      this.bufferKeys = new Map();        // streamId → "basename__sid#fingerprint" cache key
      this.peaks = new Map();             // streamId → { key, data: Float32Array }  waveform peaks
      this.streamUrls = new Map();        // streamId → stem URL (real stems → streamed, not decoded)
      // streamId → { el?, mediaSource?, gainNode?, gainBase?, source?, timers: [] }
      this.activeNodes = new Map();
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
      this.master.gain.value = 1.0;
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
      if (!spec.url) return;            // no rendered stem → stays silent
      const key = spec.url + "#" + (spec.fingerprint || "");
      if (this.bufferKeys.get(streamId) === key && this.buffers.has(streamId)) return;

      const res = await fetch(spec.url);
      if (!res.ok) throw new Error(`audio fetch failed: HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(ab);
      this.buffers.set(streamId, buffer);
      this.bufferKeys.set(streamId, key);
    }

    /**
     * Register the stem URL for each real-stem stream. When a stream has a URL
     * here it is *streamed* via an <audio> element at schedule time (the
     * browser buffers only a few seconds ahead, ~MBs) instead of being decoded
     * whole into an AudioBuffer (~160 MB for an 8-min stereo stem). Streams
     * absent from this map fall back to the decoded-buffer path.
     * Pass `{ [streamId]: url|null }`; null/empty entries are ignored.
     */
    setStreamUrls(map) {
      this.streamUrls.clear();
      for (const id in map) { if (map[id]) this.streamUrls.set(id, map[id]); }
    }

    invalidateStream(id) {
      this.buffers.delete(id);
      this.bufferKeys.delete(id);
      this.peaks.delete(id);
    }
    invalidateAll() {
      this.buffers.clear();
      this.bufferKeys.clear();
      this.peaks.clear();
    }

    // -------- waveform peaks --------

    /**
     * Reduce an AudioBuffer to a fixed-resolution peak array for waveform
     * drawing. One pass over the samples; for each of `buckets` columns we take
     * the max absolute amplitude across all channels. Result is a Float32Array
     * of length `buckets` with values in 0..1. Downsample this to the clip's
     * pixel width at draw time.
     */
    _computePeaks(buffer, buckets = 32768) {
      const len = buffer.length;
      const n = Math.min(buckets, Math.max(1, len));
      const out = new Float32Array(n);
      const chans = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
      const per = len / n;
      for (let b = 0; b < n; b++) {
        const start = Math.floor(b * per);
        const end = Math.min(len, Math.floor((b + 1) * per));
        let peak = 0;
        for (const data of chans) {
          for (let i = start; i < end; i++) {
            const a = Math.abs(data[i]);
            if (a > peak) peak = a;
          }
        }
        out[b] = peak;
      }
      return out;
    }

    /**
     * Ensure we have a peak array for `streamId`. Keyed on url#fingerprint so a
     * re-render (new fingerprint) yields fresh peaks. Returns a Float32Array.
     *
     * Local backend supplies `spec.peaksUrl`: we fetch a ready-made 32768-float
     * array (~128 KB) from the server and NEVER decode the full PCM here — that
     * would pin ~160 MB per 8-min stereo stem in `this.buffers` just to draw a
     * waveform. Without a peaksUrl we fall back to decoding and computing peaks
     * locally.
     */
    async ensurePeaks(streamId, spec) {
      const key = (spec.url || "") + "#" + (spec.fingerprint || "");
      const cached = this.peaks.get(streamId);
      if (cached && cached.key === key) return cached.data;

      if (spec.peaksUrl) {
        const res = await fetch(spec.peaksUrl);
        if (!res.ok) throw new Error(`peaks fetch failed: HTTP ${res.status}`);
        const data = new Float32Array(await res.arrayBuffer());
        this.peaks.set(streamId, { key, data });
        return data;
      }

      // Fallback: decode + compute locally (no server peaks for this stem).
      await this.ensureBuffer(streamId, spec);
      const buffer = this.buffers.get(streamId);
      if (!buffer) return null;
      const data = this._computePeaks(buffer);
      this.peaks.set(streamId, { key, data });
      return data;
    }

    // -------- scheduling --------

    /**
     * Schedule playback for a list of streams from timeline position
     * `fromTime`. Two per-stream paths:
     *   - real stem (URL in `streamUrls`)  → streamed via an <audio> element,
     *     created lazily right before its onset so only currently-sounding
     *     clips hold a media decoder (caps RAM at ~MBs/clip, not ~160 MB).
     *   - decoded stem (AudioBuffer in `buffers`) → AudioBufferSourceNode.
     * Streams with neither are silent.
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

      for (const s of streams) this._scheduleOne(s, fromTime, anySolo);
    }

    // Schedule a single stream from `fromTime`. Picks the streaming or buffer
    // path. Assumes any prior node for `s.id` has been torn down.
    _scheduleOne(s, fromTime, anySolo) {
      const onset = +s.onset || 0;
      const dur = +s.duration || 0;
      const clipEnd = onset + (dur || Infinity);
      if (dur && clipEnd <= fromTime) return;          // already past

      const url = this.streamUrls.get(s.id);
      if (url) { this._scheduleStreaming(s, url, fromTime, anySolo); return; }

      const buf = this.buffers.get(s.id);
      if (!buf) return;                                 // silent
      const bdur = dur || buf.duration;
      if (onset + bdur <= fromTime) return;

      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      const gainNode = this.ctx.createGain();
      const gainBase = this._dbToLin(s.volume);
      gainNode.gain.value = gainBase * this._effectiveMuteSoloGain(s, anySolo);
      source.connect(gainNode).connect(this.master);

      const whenCtx = this.startedAtCtx + Math.max(0, onset - fromTime);
      const offset = Math.max(0, fromTime - onset);
      try { source.start(whenCtx, offset, Math.max(0.01, bdur - offset)); } catch {}
      this.activeNodes.set(s.id, { source, gainNode, gainBase, timers: [] });
    }

    // Stream a real stem via <audio>. The element + media node are built right
    // before the clip sounds (now if mid-clip, else on a timer) so only active
    // clips own a decoder. A second timer tears it down at clipEnd.
    _scheduleStreaming(s, url, fromTime, anySolo) {
      const onset = +s.onset || 0;
      const dur = +s.duration || 0;
      const offset = Math.max(0, fromTime - onset);     // into-clip seek
      const startDelay = Math.max(0, onset - fromTime); // s until onset
      const entry = { gainBase: this._dbToLin(s.volume), timers: [] };
      this.activeNodes.set(s.id, entry);

      const build = () => {
        if (this.activeNodes.get(s.id) !== entry) return; // stopped meanwhile
        const el = new Audio();
        el.src = url;
        el.preload = "auto";
        el.crossOrigin = "anonymous";
        const mediaSource = this.ctx.createMediaElementSource(el);
        const gainNode = this.ctx.createGain();
        gainNode.gain.value = entry.gainBase * this._effectiveMuteSoloGain(s, this.anySolo);
        mediaSource.connect(gainNode).connect(this.master);
        entry.el = el; entry.mediaSource = mediaSource; entry.gainNode = gainNode;

        const go = () => { try { el.currentTime = offset; } catch {} el.play().catch(() => {}); };
        if (el.readyState >= 2) go(); else el.addEventListener("canplay", go, { once: true });
      };

      if (startDelay <= 0) build();
      else entry.timers.push(setTimeout(build, startDelay * 1000));

      // Tear down at clip end, timed from `fromTime` (the schedule baseline)
      // so it is independent of when `build` actually runs.
      if (dur) {
        const stopMs = Math.max(0, (onset + dur - fromTime) * 1000);
        entry.timers.push(setTimeout(() => this._teardownNode(s.id), stopMs));
      }
    }

    _dbToLin(db) { return Math.pow(10, (typeof db === "number" ? db : 0) / 20); }

    // Tear down and forget a single active node (streaming or buffer).
    _teardownNode(id) {
      const n = this.activeNodes.get(id);
      if (!n) return;
      if (n.timers) for (const t of n.timers) clearTimeout(t);
      if (n.el) {
        try { n.el.pause(); } catch {}
        try { n.mediaSource.disconnect(); } catch {}
        try { n.gainNode.disconnect(); } catch {}
        n.el.src = "";
      } else if (n.source) {
        try { n.source.stop(0); } catch {}
      }
      this.activeNodes.delete(id);
    }

    _effectiveMuteSoloGain(stream, anySolo) {
      const ms = this.streamMuteSolo.get(stream.id) || { mute: !!stream.mute, solo: !!stream.solo };
      if (ms.mute) return 0;
      if (anySolo && !ms.solo) return 0;
      return 1;
    }

    _stopAllSources() {
      for (const [, n] of this.activeNodes) {
        if (n.timers) for (const t of n.timers) clearTimeout(t);
        if (n.el) {
          try { n.el.pause(); } catch {}
          try { n.mediaSource.disconnect(); } catch {}
          try { n.gainNode.disconnect(); } catch {}
          n.el.src = "";
        } else if (n.source) {
          try { n.source.stop(0); } catch {}
        }
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

    // Reschedule a single stream without touching others.
    rescheduleStream(stream) {
      if (!this.ctx || !this.playing) return;
      this._teardownNode(stream.id);
      this._scheduleOne(stream, this.currentTime, this.anySolo);
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
        if (!node.gainNode) continue;   // streaming clip not yet sounding
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
