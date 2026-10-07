// Gli inviluppi col tipo sul punto, nella lista: `[[0, 0.001, cubic], ...]`.
// Il tipo governa il segmento che parte dal punto, l'ultimo non ne ha uno.
// Cinque parametri, tre tipi: cubic, step e linear (sottinteso).
campo("sample", "001-41_5-5_5.wav");
document.getElementById("labDur").value = 20;
punto(0,   {"grain.duration": 0.001, "fill_factor": 2, "pan": -30, "volume": -6, "pitch.ratio": 1},
           {"grain.duration": "cubic", "fill_factor": "step", "pan": "cubic", "volume": "step"});
punto(0.4, {"grain.duration": 0.008, "fill_factor": 4, "pan": 0, "volume": -3, "pitch.ratio": 0.5},
           {"grain.duration": "cubic", "pitch.ratio": "step"});
punto(1,   {"grain.duration": 0.016, "fill_factor": 1.5, "pan": 45, "volume": -12, "pitch.ratio": 1});
salva("tipo-sul-punto");
