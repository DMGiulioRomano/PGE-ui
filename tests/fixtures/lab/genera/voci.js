// `voices:` con una strategia per asse: pitch `step` in `unit: {edo: 19}`,
// onset_offset `geometric`, pointer `linear` con `normalized: true`, pan
// `stochastic` con lo spread a inviluppo (e il tipo sul punto). `num_voices`
// e `scatter` accanto.
campo("sample", "001-41_5-5_5.wav");
document.getElementById("labDur").value = 10;
campo("voices.pitch.strategy", "step");
campo("voices.pitch.unit", "edo");
campo("voices.pitch.edo", 19);
campo("voices.onset_offset.strategy", "geometric");
campo("voices.pointer.strategy", "linear");
campo("voices.pointer.normalized", "si");
campo("voices.pan.strategy", "stochastic");
punto(0, {"voices.num_voices": 3, "voices.scatter": 0.25, "voices.pitch.step": 3,
          "voices.onset_offset.step": 0.02, "voices.onset_offset.base": 1.5,
          "voices.pointer.step": 0.05, "voices.pan.spread": 30},
         {"voices.pan.spread": "cubic"});
punto(1, {"voices.num_voices": 3, "voices.scatter": 0.25, "voices.pitch.step": 5,
          "voices.onset_offset.step": 0.02, "voices.onset_offset.base": 1.5,
          "voices.pointer.step": 0.05, "voices.pan.spread": 120});
salva("voci");
