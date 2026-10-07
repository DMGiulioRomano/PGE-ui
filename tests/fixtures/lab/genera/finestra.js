// La finestra che cambia nel tempo: `grain.envelope: {states, curve}`
// (MultiStateWindowStrategy), con `step`, `cubic` e un `linear` sottinteso
// sui punti della curve. hanning torna in fondo: e' uno stato nuovo, non lo
// stesso, perche' il motore pretende stati crescenti.
campo("sample", "001-41_5-5_5.wav");
document.getElementById("labDur").value = 12;
punto(0,   {"grain.envelope": "hanning", "grain.duration": 0.02}, {"grain.envelope": "step"});
punto(0.3, {"grain.envelope": "bartlett"}, {"grain.envelope": "cubic"});
punto(0.6, {"grain.envelope": "gaussian"});
punto(1,   {"grain.envelope": "hanning"});
salva("finestra");
