// "il mondo dorme" — composition data, mirroring configs/PGE_test.yml structure.
// 5 streams, 60s timeline.
window.PGE_DATA = {
  project: "PGE_test",
  title: "il mondo dorme",
  duration: 60,
  bpm: 120,
  streams: [
    {
      id: "stream1", onset: 0.0, duration: 5.0, sample: "pino.wav",
      color: "#5C8868", mute: false, solo: false,
      timeMode: "normalized", distributionMode: "gaussian",
      density: null, densityEnv: [[0,10],[0.15,10],[0.40,50],[0.60,30],[1,30]],
      distribution: null, distributionEnv: [[0,0],[0.5,1],[1,0]],
      volume: -6.0, volumeRange: 0,
      pan: 0, panRange: 0,
      grain: { duration: null, durationEnv: [[0,0.05],[0.5,0.08],[1,0.05]], durationRange: 0.01, envelope: "hanning" },
      pointer: { start: 0, speedRatio: null, speedRatioEnv: [[0,-1],[1,1]], loopStart: null, loopDur: null },
      pitch: { semitones: 0, range: 0 },
      voices: { num: 1 },
      // dephase: global envelope — probability ramps in time
      dephase: [[0,50],[0.5,0],[1,30]],
    },
    {
      id: "stream2", onset: 40.0, duration: 5.0, sample: "pino.wav",
      color: "#B89241", mute: false, solo: false,
      timeMode: "normalized", distributionMode: "uniform",
      // density: blocco compatto puro — 6 cicli con accelerando esponenziale
      density: null,
      densityEnv: [
        [[[0, 5], [50, 40], [100, 5]], 1, 6, "cubic", "exponential"]
      ],
      distribution: 0.0,
      volume: -6.0, volumeRange: 0,
      pan: 0, panRange: 0,
      // grain.duration: misto — plateau iniziale, poi loop di triangoli
      grain: {
        duration: null,
        durationEnv: [
          [0, 0.02],
          [0.1, 0.02],
          [[[0, 0.05], [50, 0.18], [100, 0.05]], 0.9, 5, "linear", "geometric"],
          [1, 0.05]
        ],
        durationRange: 0, envelope: "hanning"
      },
      pointer: { start: 0, speedRatio: 1.0, loopStart: null, loopDur: null },
      pitch: { semitones: 0, range: 0 },
      voices: { num: 1 },
      // dephase: global scalar — 30% probability uniformly
      dephase: 30,
    },
    {
      id: "stream3", onset: 30.0, duration: 5.0, sample: "pino.wav",
      color: "#3F8884", mute: false, solo: false,
      timeMode: "absolute", distributionMode: "uniform",
      density: 12, distribution: 0.0,
      volume: -6.0, volumeRange: 0,
      pan: 0, panRange: 0,
      grain: { duration: 0.05, durationRange: 0, envelope: "hanning" },
      pointer: { start: 0, speedRatio: 1.0, loopStart: null, loopDur: null },
      pitch: { semitones: 0, range: 0 },
      voices: { num: 1 },
      // dephase: per-parameter — different probabilities per dimension
      dephase: { volume: 50, pan: 30, duration: 20 },
    },
    {
      id: "stream4", onset: 20.0, duration: 5.0, sample: "pino.wav",
      color: "#5965A8", mute: false, solo: false,
      timeMode: "normalized", distributionMode: "uniform",
      density: 12, distribution: 0.0,
      volume: -6.0, volumeRange: 0,
      // pan come loop con distribuzione logaritmica (ritardando)
      pan: null,
      panEnv: [
        [[[0, -45], [25, 45], [50, -45], [75, 45], [100, -45]], 1, 4, "cubic", {type: "logarithmic", base: 3}]
      ],
      panRange: 0,
      grain: { duration: 0.05, durationRange: 0, envelope: "hanning" },
      pointer: { start: 0, speedRatio: 1.0, loopStart: null, loopDur: null },
      pitch: { semitones: 0, range: 0 },
      voices: { num: 1 },
    },
    {
      id: "stream5", onset: 0.0, duration: 10.0, sample: "001-0-27_9.wav",
      color: "#8E5F8E", mute: false, solo: false,
      timeMode: "normalized", distributionMode: "gaussian",
      density: 3, distribution: null, distributionEnv: [[0,0],[0.5,1],[1,0]],
      volume: -9.0, volumeRange: 0,
      pan: null, panEnv: [[0,-3600],[1,3600]], panRange: 0,
      grain: { duration: 0.05, durationRange: 0, envelope: "gaussian" },
      pointer: { start: 0, speedRatio: 1.0, loopStart: null, loopDur: null },
      pitch: { semitones: 0, range: 0 },
      voices: { num: 1 },
    },
  ],
  samples: [
    { name: "pino.wav", duration: 3.402 },
    { name: "001-0-27_9.wav", duration: 9.180 },
    { name: "drum_loop.wav", duration: 2.000 },
    { name: "sweep_long.wav", duration: 12.500 },
    { name: "rain_field.wav", duration: 8.320 },
    { name: "voice_a.wav", duration: 5.100 },
  ],
};
