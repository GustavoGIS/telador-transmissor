(() => {
  let ctx = null;

  function ac() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") {
      try { ctx.resume(); } catch (e) {}
    }
    return ctx;
  }

  function tone(c, freq, start, dur, type, peak) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, c.currentTime + start);
    const t0 = c.currentTime + start;
    const vol = peak == null ? 0.16 : peak;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.04, dur));
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  function play(name) {
    try {
      const c = ac();
      if (!c) return;
      if (name === "tx-start") {
        // Subida curta — começou a transmitir
        tone(c, 587.33, 0, 0.11, "sine", 0.17);
        tone(c, 880, 0.1, 0.16, "sine", 0.14);
      } else if (name === "tx-stop") {
        // Queda — não está mais transmitindo (qualquer motivo)
        tone(c, 493.88, 0, 0.13, "triangle", 0.15);
        tone(c, 329.63, 0.11, 0.22, "triangle", 0.12);
      } else if (name === "present") {
        // Atenção — pedido de transmissão
        tone(c, 988, 0, 0.08, "sine", 0.12);
        tone(c, 988, 0.13, 0.08, "sine", 0.12);
        tone(c, 1318.5, 0.26, 0.14, "sine", 0.11);
      }
    } catch (e) {}
  }

  window.teladorSounds = { play };
})();
