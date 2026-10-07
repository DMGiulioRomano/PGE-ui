// La progressione di accordi: `voices.pitch.progression: [[t, accordo,
// rivolto?], ...]` con il suo `interp`. Il maj7 ripetuto a 0.3 non apre un
// passo nuovo; il rivolto e' il terzo elemento solo dove non e' 0.
// `voice_leading: positional` perche' il default (`nearest`) non si scrive.
campo("sample", "001-41_5-5_5.wav");
document.getElementById("labDur").value = 16;
campo("voices.pitch.strategy", "chord_progression");
campo("voices.pitch.voice_leading", "positional");
punto(0,   {"voices.num_voices": 4, "voices.pitch.progression": "maj7", "voices.pitch.inversion": 0},
           {"voices.pitch.progression": "cubic"});
punto(0.3, {"voices.pitch.progression": "maj7", "voices.pitch.inversion": 0});
punto(0.6, {"voices.pitch.progression": "min7", "voices.pitch.inversion": 1});
punto(1,   {"voices.pitch.progression": "dom9", "voices.pitch.inversion": 2});
salva("progressione");
