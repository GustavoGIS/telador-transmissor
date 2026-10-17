/**
 * Hooks do worker (idempotente). Contrato: window.__teladorHooksVersion
 * - Áudio: MediaStreamTrackGenerator (sem playout / mixer)
 * - Troca de fonte: unpublish → publish + nudge
 * - Bitrate: só getStats (perda/RTT)
 */
(async () => {
  const HOOKS_VER = window.__teladorHooksVersion || "0.2.3";
  if (window.__teladorHooksApplied === HOOKS_VER && window.__teladorReady) {
    // Re-aplica só funções públicas (reinjeção ocasional / reload parcial)
  }
  window.__teladorHooksApplied = HOOKS_VER;
  window.__teladorHooksVersion = HOOKS_VER;
  window.__teladorReady = true;
  window.__teladorAudio = true;

  function tlog(level, msg, extra) {
    try {
      if (window.telador && typeof window.telador.log === "function") {
        window.telador.log(level, msg, extra);
      }
    } catch (e) {}
  }

  const baseBitrate = Number(
    (window.__teladorPubOpts &&
      window.__teladorPubOpts.screenShareEncoding &&
      window.__teladorPubOpts.screenShareEncoding.maxBitrate) ||
      4e6
  );
  const VIDEO_BITRATE = {
    excellent: Math.round(baseBitrate * 1.25),
    good: baseBitrate,
    poor: Math.round(baseBitrate * 0.55),
    lost: Math.max(1e6, Math.round(baseBitrate * 0.35)),
  };

  // Preserva opts injetados pelo main (quality.js); só preenche se ausentes
  if (!window.__teladorShareOpts) {
    window.__teladorShareOpts = {
      audio: true,
      systemAudio: "include",
      resolution: { width: 1280, height: 720, frameRate: 30 },
      contentHint: "detail",
    };
  }
  if (!window.__teladorPubOpts) {
    window.__teladorPubOpts = {
      videoCodec: "h264",
      simulcast: false,
      degradationPreference: "maintain-resolution",
      screenShareEncoding: { maxBitrate: VIDEO_BITRATE.good, maxFramerate: 30, priority: "high" },
      dtx: false,
      red: false,
      forceStereo: true,
      audioBitrate: 256000,
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getLP() {
    try {
      if (!window.__teladorLP && window.__teladorRoom) {
        window.__teladorLP = window.__teladorRoom.localParticipant;
      }
    } catch (e) {}
    return window.__teladorLP || (window.__teladorRoom && window.__teladorRoom.localParticipant) || null;
  }

  function listPubs(lp) {
    try {
      const map = lp && lp.trackPublications;
      if (!map) return [];
      return typeof map.values === "function" ? Array.from(map.values()) : Object.values(map);
    } catch (e) {
      return [];
    }
  }

  function findScreenPubs(lp) {
    let videoPub = null;
    let audioPub = null;
    if (lp && typeof lp.getTrackPublication === "function") {
      try {
        videoPub = lp.getTrackPublication("screen_share") || null;
        audioPub = lp.getTrackPublication("screen_share_audio") || null;
      } catch (e) {}
    }
    for (const pub of listPubs(lp)) {
      const src = String(pub.source || "");
      if (!videoPub && src === "screen_share") videoPub = pub;
      if (!audioPub && src === "screen_share_audio") audioPub = pub;
    }
    return { videoPub, audioPub };
  }

  async function waitForScreenClear(lp, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const { videoPub, audioPub } = findScreenPubs(lp);
      if (!videoPub && !audioPub) return true;
      await sleep(50);
    }
    return false;
  }

  function reportShareState(active, reason) {
    try {
      if (window.telador && typeof window.telador.setShareState === "function") {
        window.telador.setShareState({ active: !!active, reason: String(reason || "") });
      }
    } catch (e) {}
    try {
      if (window.telador && typeof window.telador.setUiPhase === "function") {
        if (reason === "switching") window.telador.setUiPhase("switching", "Alterando fonte…");
        else if (active) window.telador.setUiPhase("live", "Transmitindo");
        else if (reason !== "audio-missing") window.telador.setUiPhase("connected", "Conectado");
      }
    } catch (e) {}
    try {
      if (window.telador && window.telador.setStatus) {
        if (reason === "switching") window.telador.setStatus("Trocando fonte...");
        else if (reason === "audio-missing") window.telador.setStatus("Transmitindo (sem áudio do app)");
        else window.telador.setStatus(active ? "Transmitindo" : "Conectado");
      }
    } catch (e) {}
  }

  function reportAudioOk(ok) {
    try {
      if (window.telador && typeof window.telador.setAudioStatus === "function") {
        window.telador.setAudioStatus(!!ok);
      }
    } catch (e) {}
  }

  function bindTrackEnded(track) {
    if (!track || track.__teladorEndedBound) return;
    track.__teladorEndedBound = true;
    try {
      const mst = track.mediaStreamTrack || track;
      const onEnded = () => {
        try {
          if (window.__teladorRestartingShare) return;
          const { videoPub } = findScreenPubs(getLP());
          const live = videoPub && videoPub.track && (
            (videoPub.track.mediaStreamTrack && videoPub.track.mediaStreamTrack.readyState === "live") ||
            videoPub.track.readyState === "live"
          );
          if (!live) reportShareState(false, "ended");
        } catch (e) {}
      };
      if (mst && typeof mst.addEventListener === "function") mst.addEventListener("ended", onEnded);
      if (typeof track.on === "function") track.on("ended", onEnded);
    } catch (e) {}
  }

  const floatPool = [];

  function acquireFloat(n) {
    let a = floatPool.pop();
    if (!a || a.length !== n) a = new Float32Array(n);
    return a;
  }

  function releaseFloat(a) {
    if (a && floatPool.length < 48) floatPool.push(a);
  }

  function parsePcmStereo(data) {
    let u8;
    if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (data && data.buffer) {
      u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length);
    } else return null;
    const even = u8.byteLength - (u8.byteLength % 4);
    if (even < 4) return null;
    let i16;
    if ((u8.byteOffset % 2) === 0 && even === u8.byteLength) {
      i16 = new Int16Array(u8.buffer, u8.byteOffset, even / 2);
    } else {
      const ab = new ArrayBuffer(even);
      new Uint8Array(ab).set(u8.subarray(0, even));
      i16 = new Int16Array(ab);
    }
    const frames = (i16.length / 2) | 0;
    const lArr = acquireFloat(frames);
    const rArr = acquireFloat(frames);
    const inv = 1 / 32768;
    for (let i = 0, f = 0; f < frames; i += 2, f++) {
      lArr[f] = i16[i] * inv;
      rArr[f] = i16[i + 1] * inv;
    }
    return { frames, lArr, rArr };
  }

  async function createGeneratorAudioPipeline() {
    if (typeof MediaStreamTrackGenerator !== "function" || typeof AudioData !== "function") {
      return null;
    }
    if (!window.telador || !window.telador.startNativeAudio) return null;
    const ok = await window.telador.startNativeAudio();
    if (!ok) return null;

    const sampleRate = 48000;
    const syncDelayMs = 100;
    let gen;
    try {
      gen = new MediaStreamTrackGenerator({ kind: "audio" });
    } catch (e) {
      try { await window.telador.stopNativeAudio(); } catch (e2) {}
      return null;
    }

    const writer = gen.writable.getWriter();
    let timestampUs = Math.floor(performance.now() * 1000);
    let closed = false;
    let pumping = false;
    const pending = [];
    let pumpTimer = null;

    const pump = async () => {
      if (closed || pumping || !pending.length) return;
      pumping = true;
      try {
        const now = performance.now();
        while (pending.length && pending[0].due <= now) {
          const item = pending.shift();
          let ad = null;
          try {
            const buf = new ArrayBuffer(item.frames * 2 * 4);
            const f32 = new Float32Array(buf);
            f32.set(item.lArr, 0);
            f32.set(item.rArr, item.frames);
            ad = new AudioData({
              format: "f32-planar",
              sampleRate,
              numberOfFrames: item.frames,
              numberOfChannels: 2,
              timestamp: timestampUs,
              data: buf,
            });
            timestampUs += Math.floor((item.frames / sampleRate) * 1e6);
            await writer.write(ad);
            ad = null;
          } catch (e) {
            try { if (ad) ad.close(); } catch (e2) {}
            break;
          } finally {
            releaseFloat(item.lArr);
            releaseFloat(item.rArr);
          }
        }
        if (pending.length > 40) {
          const drop = pending.splice(0, pending.length - 24);
          for (const d of drop) {
            releaseFloat(d.lArr);
            releaseFloat(d.rArr);
          }
        }
      } finally {
        pumping = false;
      }
    };

    // 20ms ≈ tamanho do chunk PCM; evita timer ocioso a 10ms
    pumpTimer = setInterval(() => { pump(); }, 20);

    const unsub = window.telador.onNativePcm((data) => {
      try {
        const parsed = parsePcmStereo(data);
        if (!parsed) return;
        pending.push({
          due: performance.now() + syncDelayMs,
          frames: parsed.frames,
          lArr: parsed.lArr,
          rArr: parsed.rArr,
        });
        if (pending.length === 1) pump();
      } catch (e) {}
    });

    try { gen.contentHint = "music"; } catch (e) {}

    window.__teladorNativeAudioCleanup = async () => {
      closed = true;
      try { clearInterval(pumpTimer); } catch (e) {}
      try { if (typeof unsub === "function") unsub(); } catch (e) {}
      try { await writer.close(); } catch (e) {}
      try { await window.telador.stopNativeAudio(); } catch (e) {}
      pending.length = 0;
    };

    window.__teladorAudioTrack = gen;
    return gen;
  }

  async function createNativeAudioPipeline() {
    if (typeof window.__teladorNativeAudioCleanup === "function") {
      try { await window.__teladorNativeAudioCleanup(); } catch (e) {}
      window.__teladorNativeAudioCleanup = null;
    }
    try {
      const track = await createGeneratorAudioPipeline();
      if (track) {
        tlog("info", "audio: MediaStreamTrackGenerator");
        return track;
      }
    } catch (e) {
      tlog("error", "audio generator failed", e && e.message);
    }
    tlog("error", "áudio nativo indisponível");
    return null;
  }

  function silenceLocalMediaElements() {
    try {
      document.querySelectorAll("audio, video").forEach((el) => {
        try {
          el.muted = true;
          el.volume = 0;
          el.defaultMuted = true;
        } catch (e) {}
      });
    } catch (e) {}
  }

  function installLocalPlaybackGuard() {
    if (window.__teladorPlaybackGuard) return;
    window.__teladorPlaybackGuard = true;
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
      if (desc && desc.set) {
        Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(v) {
            desc.set.call(this, v);
            try {
              this.muted = true;
              this.volume = 0;
              this.defaultMuted = true;
            } catch (e) {}
          },
        });
      }
    } catch (e) {}
    try {
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        try {
          this.muted = true;
          this.volume = 0;
        } catch (e) {}
        return origPlay.apply(this, args);
      };
    } catch (e) {}
    try {
      const origConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (dest, ...rest) {
        try {
          if (dest && this.context && dest === this.context.destination) return dest;
        } catch (e) {}
        return origConnect.apply(this, [dest, ...rest]);
      };
    } catch (e) {}
    // Observer (sem poll 750ms)
    try {
      const silenceEl = (el) => {
        if (!el || el.__teladorSilenced) return;
        el.__teladorSilenced = true;
        el.muted = true;
        el.volume = 0;
      };
      document.querySelectorAll("audio,video").forEach(silenceEl);
      const mo = new MutationObserver((muts) => {
        for (const m of muts) {
          m.addedNodes && m.addedNodes.forEach((n) => {
            if (!n || n.nodeType !== 1) return;
            if (n.matches && n.matches("audio,video")) silenceEl(n);
            if (n.querySelectorAll) n.querySelectorAll("audio,video").forEach(silenceEl);
          });
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    silenceLocalMediaElements();
  }

  installLocalPlaybackGuard();

  async function attachNativeAudio(stream) {
    stream.getAudioTracks().forEach((t) => {
      try { stream.removeTrack(t); t.stop(); } catch (e) {}
    });
    const track = await createNativeAudioPipeline();
    if (track) {
      stream.addTrack(track);
      silenceLocalMediaElements();
      reportAudioOk(true);
      return true;
    }
    reportAudioOk(false);
    try {
      if (window.telador && window.telador.setStatus) {
        window.telador.setStatus("Transmitindo (sem áudio do app)");
      }
    } catch (e) {}
    try {
      if (window.telador && typeof window.telador.setShareState === "function") {
        window.telador.setShareState({ active: true, reason: "audio-missing" });
      }
    } catch (e) {}
    return false;
  }

  async function applyVideoBitrate(maxBitrate) {
    try {
      const { videoPub } = findScreenPubs(getLP());
      const track = videoPub && videoPub.track;
      const mst = track && (track.mediaStreamTrack || track);
      if (mst && mst.readyState && mst.readyState !== "live") return;
      const rtp = track && track.sender;
      if (!rtp || typeof rtp.getParameters !== "function") return;
      const params = rtp.getParameters();
      if (!params.encodings || !params.encodings[0]) return;
      const cur = Number(params.encodings[0].maxBitrate) || 0;
      const next = Number(maxBitrate) || 0;
      if (!next || Math.abs(cur - next) < 50e3) return;
      params.encodings[0].maxBitrate = next;
      params.encodings[0].maxFramerate = 30;
      await rtp.setParameters(params);
      window.__teladorLastBitrate = next;
    } catch (e) {
      tlog("warn", "applyVideoBitrate", e && e.message);
    }
  }

  function startAdaptiveBitrate() {
    if (window.__teladorAdaptiveTimer) return;
    let prev = { packets: 0, lost: 0 };
    window.__teladorAdaptiveTimer = setInterval(async () => {
      try {
        const { videoPub } = findScreenPubs(getLP());
        const sender = videoPub && videoPub.track && videoPub.track.sender;
        if (!sender || typeof sender.getStats !== "function") return;
        const stats = await sender.getStats();
        let packets = 0;
        let lost = 0;
        let rtt = 0;
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && (r.kind === "video" || r.mediaType === "video")) {
            packets += Number(r.packetsSent) || 0;
          }
          if (r.type === "remote-inbound-rtp" && (r.kind === "video" || r.mediaType === "video")) {
            if (r.roundTripTime != null) rtt = Math.max(rtt, Number(r.roundTripTime) * 1000);
            lost += Number(r.packetsLost) || 0;
          }
        });
        let lossRate = 0;
        if (packets >= prev.packets) {
          const dp = packets - prev.packets;
          const dl = Math.max(0, lost - prev.lost);
          if (dp + dl > 0) lossRate = dl / (dp + dl);
        }
        prev = { packets, lost };

        let target = VIDEO_BITRATE.good;
        let health = "good";
        if (lossRate > 0.08 || rtt > 400) { target = VIDEO_BITRATE.lost; health = "bad"; }
        else if (lossRate > 0.03 || rtt > 250) { target = VIDEO_BITRATE.poor; health = "fair"; }
        else if (lossRate < 0.01 && rtt > 0 && rtt < 120) { target = VIDEO_BITRATE.excellent; health = "excellent"; }
        await applyVideoBitrate(target);

        let bitrate = Number(window.__teladorLastBitrate) || target;
        let codec = "";
        try {
          const { videoPub } = findScreenPubs(getLP());
          const sender = videoPub && videoPub.track && videoPub.track.sender;
          if (sender && typeof sender.getParameters === "function") {
            const p = sender.getParameters();
            if (p && p.codecs && p.codecs[0]) codec = String(p.codecs[0].mimeType || "");
            if (p && p.encodings && p.encodings[0] && p.encodings[0].maxBitrate) {
              bitrate = Number(p.encodings[0].maxBitrate) || bitrate;
            }
          }
        } catch (e2) {}
        try {
          if (window.telador && typeof window.telador.setStats === "function") {
            window.telador.setStats({ bitrate, loss: lossRate, rtt, codec, health });
          }
        } catch (e3) {}
      } catch (e) {}
    }, 3000);
  }

  window.__applyQualityLive = async () => {
    try {
      const enc = (window.__teladorPubOpts && window.__teladorPubOpts.screenShareEncoding) || {};
      const maxBitrate = Number(enc.maxBitrate) || VIDEO_BITRATE.good;
      const maxFramerate = Number(enc.maxFramerate) || 30;
      const { videoPub } = findScreenPubs(getLP());
      const track = videoPub && videoPub.track;
      const rtp = track && track.sender;
      if (rtp && typeof rtp.getParameters === "function") {
        const params = rtp.getParameters();
        if (params.encodings && params.encodings[0]) {
          params.encodings[0].maxBitrate = maxBitrate;
          params.encodings[0].maxFramerate = maxFramerate;
          await rtp.setParameters(params);
          window.__teladorLastBitrate = maxBitrate;
        }
      } else {
        await applyVideoBitrate(maxBitrate);
      }
      tlog("info", "applyQualityLive", { maxBitrate, maxFramerate });
    } catch (e) {
      tlog("warn", "applyQualityLive", e && e.message);
    }
  };

  async function nudgeViewersRemount(lp) {
    try {
      if (lp && typeof lp.setMetadata === "function") {
        await lp.setMetadata(JSON.stringify({ teladorSwitch: Date.now(), v: HOOKS_VER }));
      }
    } catch (e) {}
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ type: "source-switch", t: Date.now() }));
      if (lp && typeof lp.publishData === "function") {
        await lp.publishData(payload, { reliable: true, topic: "telador" });
      }
    } catch (e) {}
  }

  function videoTrackLooksAlive(stream) {
    try {
      const vt = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      if (!vt || vt.readyState !== "live") return false;
      const s = typeof vt.getSettings === "function" ? vt.getSettings() : {};
      if (s.width === 0 || s.height === 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  if (!window.__teladorCaptureHooked) {
    window.__teladorCaptureHooked = true;
    const md = navigator.mediaDevices;
    if (md && md.getDisplayMedia) {
      const orig = md.getDisplayMedia.bind(md);
      md.getDisplayMedia = async (constraints = {}) => {
        const next = Object.assign({}, constraints);
        next.audio = false;
        if (!next.video || next.video === true) {
          next.video = { frameRate: { ideal: 30, max: 30 } };
        } else if (typeof next.video === "object") {
          next.video = Object.assign({}, next.video, {
            frameRate: next.video.frameRate != null ? next.video.frameRate : { ideal: 30, max: 30 },
          });
        }
        const stream = await orig(next);
        const vt = stream.getVideoTracks()[0];
        if (vt) {
          try { if ("contentHint" in vt) vt.contentHint = "detail"; } catch (e) {}
        }
        if (!videoTrackLooksAlive(stream)) {
          tlog("error", "video track inválida após getDisplayMedia");
        }
        if (window.__teladorAudio) {
          try { await attachNativeAudio(stream); } catch (e) {
            tlog("warn", "attachNativeAudio", e && e.message);
          }
        }
        window.__teladorShareStream = stream;
        return stream;
      };
    }
    if (md && md.getUserMedia) {
      const origGum = md.getUserMedia.bind(md);
      md.getUserMedia = async (constraints) => {
        try {
          const a = constraints && constraints.audio;
          const src = a && ((a.mandatory && a.mandatory.chromeMediaSource) || a.chromeMediaSource);
          if (src === "desktop") return new MediaStream();
        } catch (e) {}
        return origGum(constraints);
      };
    }
  }

  window.__teladorBlockRemoteAudio = (room) => {
    if (!room) return;
    const blockPub = (pub) => {
      try {
        const src = String(pub.source || "");
        const kind = String(pub.kind || "");
        const isAudio =
          kind === "audio" ||
          src === "microphone" ||
          src === "screen_share_audio" ||
          src.indexOf("audio") !== -1;
        if (!isAudio) return;
        if (typeof pub.setSubscribed === "function") pub.setSubscribed(false);
        const t = pub.track;
        if (t) {
          try { if (typeof t.setVolume === "function") t.setVolume(0); } catch (e) {}
          try { if (typeof t.detach === "function") t.detach(); } catch (e) {}
          try { t.enabled = false; } catch (e) {}
        }
      } catch (e) {}
    };
    try {
      const parts = room.remoteParticipants;
      const list = parts
        ? (typeof parts.values === "function" ? Array.from(parts.values()) : Object.values(parts))
        : [];
      for (const p of list) {
        const pubs = p.trackPublications
          ? (typeof p.trackPublications.values === "function"
            ? Array.from(p.trackPublications.values())
            : Object.values(p.trackPublications))
          : [];
        pubs.forEach(blockPub);
      }
    } catch (e) {}
  };

  function wireRoomShareState(room) {
    if (!room || room.__teladorShareStateWired) return;
    room.__teladorShareStateWired = true;
    try {
      room.on("localTrackPublished", (pub) => {
        try {
          const src = String(pub.source || "");
          if (src === "screen_share" || src === "screen_share_audio") {
            if (pub.track) bindTrackEnded(pub.track);
            if (src === "screen_share_audio" || String(pub.kind || "") === "audio") {
              try {
                const t = pub.track;
                if (t && typeof t.detach === "function") {
                  const els = t.detach();
                  if (Array.isArray(els)) els.forEach((el) => {
                    try { el.muted = true; el.pause(); el.remove(); } catch (e2) {}
                  });
                }
              } catch (e2) {}
              silenceLocalMediaElements();
            }
            if (src === "screen_share") {
              reportShareState(true, "published");
              startAdaptiveBitrate();
            }
          }
        } catch (e) {}
      });
      room.on("localTrackUnpublished", (pub) => {
        try {
          if (window.__teladorRestartingShare) return;
          const src = String(pub.source || "");
          if (src !== "screen_share" && src !== "screen_share_audio") return;
          const { videoPub } = findScreenPubs(getLP());
          if (!videoPub) reportShareState(false, "unpublished");
        } catch (e) {}
      });
    } catch (e) {}
    try { window.__teladorBlockRemoteAudio(room); } catch (e) {}
  }

  if (window.__teladorRoom) {
    wireRoomShareState(window.__teladorRoom);
    try { window.__teladorBlockRemoteAudio(window.__teladorRoom); } catch (e) {}
  }

  if (!window.__teladorMuteRemoteHooked && window.__teladorRoom) {
    window.__teladorMuteRemoteHooked = true;
    try {
      const room = window.__teladorRoom;
      room.on("trackPublished", (_pub, participant) => {
        if (participant && participant.isLocal) return;
        window.__teladorBlockRemoteAudio(room);
      });
      room.on("trackSubscribed", (track, pub, participant) => {
        try {
          if (participant && participant.isLocal) return;
          if (pub && typeof pub.setSubscribed === "function") pub.setSubscribed(false);
          if (track && track.kind === "audio") {
            try { if (typeof track.setVolume === "function") track.setVolume(0); } catch (e2) {}
            try { if (typeof track.detach === "function") track.detach(); } catch (e2) {}
          }
        } catch (e) {}
      });
      room.on("participantConnected", () => {
        try { window.__teladorBlockRemoteAudio(room); } catch (e) {}
      });
    } catch (e) {}
  }

  window.__forceStopShare = async () => {
    try {
      if (typeof window.__teladorNativeAudioCleanup === "function") {
        await window.__teladorNativeAudioCleanup();
        window.__teladorNativeAudioCleanup = null;
      }
    } catch (e) {}

    const lp = getLP();
    if (lp) {
      try { await lp.setScreenShareEnabled(false); } catch (e) {}
      try {
        for (const pub of listPubs(lp)) {
          const src = String(pub.source || "");
          if (src !== "screen_share" && src !== "screen_share_audio") continue;
          if (!pub.track) continue;
          try { await lp.unpublishTrack(pub.track, true); } catch (e2) {
            try { await lp.unpublishTrack(pub.track); } catch (e3) {}
          }
          try { pub.track.stop(); } catch (e4) {}
        }
      } catch (e) {}
      await waitForScreenClear(lp, 1500);
    }

    try {
      const stream = window.__teladorShareStream;
      if (stream) {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
        window.__teladorShareStream = null;
      }
    } catch (e) {}
    window.__teladorAudioTrack = null;
  };

  window.__stopShare = async () => {
    await window.__forceStopShare();
    reportShareState(false, "stopped");
  };

  window.__teladorLeaveRoom = async () => {
    window.__teladorRestartingShare = true;
    try {
      try { await window.__forceStopShare(); } catch (e) {}
      const room = window.__teladorRoom;
      if (room && typeof room.disconnect === "function") {
        try { await room.disconnect(true); } catch (e) {
          try { room.disconnect(); } catch (e2) {}
        }
      }
      window.__teladorRoom = null;
      window.__teladorLP = null;
    } catch (e) {}
    finally {
      window.__teladorRestartingShare = false;
    }
    reportShareState(false, "left");
  };

  if (!window.__teladorLeaveHooked) {
    window.__teladorLeaveHooked = true;
    const leaveSync = () => {
      try {
        const room = window.__teladorRoom;
        if (room && typeof room.disconnect === "function") {
          try { room.disconnect(true); } catch (e) { try { room.disconnect(); } catch (e2) {} }
        }
      } catch (e) {}
    };
    window.addEventListener("pagehide", leaveSync);
    window.addEventListener("beforeunload", leaveSync);
  }

  async function forceKeyframe(localVideo) {
    try {
      const sender = localVideo && localVideo.sender;
      if (sender && typeof sender.generateKeyFrame === "function") {
        await sender.generateKeyFrame();
        return;
      }
    } catch (e) {}
    try {
      const mst = localVideo && localVideo.mediaStreamTrack;
      if (mst) {
        mst.enabled = false;
        await sleep(40);
        mst.enabled = true;
      }
    } catch (e) {}
  }

  window.__replaceShareSource = async () => {
    const lp = getLP();
    if (!lp) {
      await window.__startShare();
      return "started";
    }

    reportShareState(true, "switching");
    window.__teladorRestartingShare = true;
    try {
      await window.__forceStopShare();
      await waitForScreenClear(lp, 1200);
      await sleep(80);

      const enc = (window.__teladorPubOpts && window.__teladorPubOpts.screenShareEncoding) || {};
      const pubOpts = Object.assign({}, window.__teladorPubOpts, {
        name: "screen-" + Date.now(),
        screenShareEncoding: Object.assign({}, enc, {
          maxBitrate: VIDEO_BITRATE.good,
          maxFramerate: enc.maxFramerate || 30,
        }),
      });
      delete pubOpts.backupCodec;

      try {
        await lp.setScreenShareEnabled(true, window.__teladorShareOpts, pubOpts);
      } catch (e1) {
        await lp.setScreenShareEnabled(true, window.__teladorShareOpts, {
          videoCodec: "vp8",
          simulcast: false,
          name: "screen-" + Date.now(),
          screenShareEncoding: {
            maxBitrate: VIDEO_BITRATE.good,
            maxFramerate: (enc && enc.maxFramerate) || 30,
          },
          degradationPreference: "maintain-resolution",
        });
      }

      let videoTrack = null;
      for (let i = 0; i < 24; i++) {
        const { videoPub, audioPub } = findScreenPubs(lp);
        if (videoPub && videoPub.track) {
          videoTrack = videoPub.track;
          bindTrackEnded(videoPub.track);
          if (audioPub && audioPub.track) bindTrackEnded(audioPub.track);
          break;
        }
        await sleep(50);
      }
      if (!videoTrack) {
        reportShareState(false, "failed");
        return "failed";
      }

      await forceKeyframe(videoTrack);
      await sleep(120);
      await forceKeyframe(videoTrack);
      await nudgeViewersRemount(lp);
      startAdaptiveBitrate();

      reportShareState(true, "published");
      tlog("info", "replaceShareSource ok");
      return "started";
    } catch (e) {
      tlog("error", "replaceShareSource failed", e && e.message);
      reportShareState(false, "failed");
      return "failed";
    } finally {
      window.__teladorRestartingShare = false;
    }
  };

  function resolveLiveKitModule() {
    return (
      window.LivekitClient ||
      window.livekit ||
      window.LiveKit ||
      null
    );
  }

  if (!window.__teladorLkHooked) {
    try {
      const mod = resolveLiveKitModule();
      if (mod && mod.Room && mod.Room.prototype && !mod.Room.prototype.__teladorConnectHooked) {
        const origConnect = mod.Room.prototype.connect;
        mod.Room.prototype.connect = async function () {
          try {
            if (window.__teladorRoom && window.__teladorRoom !== this
              && typeof window.__teladorRoom.disconnect === "function") {
              try { await window.__teladorRoom.disconnect(true); } catch (e) {}
            }
          } catch (e) {}
          window.__teladorRoom = this;
          window.__teladorLP = this.localParticipant;
          try {
            const url = arguments && arguments[0];
            if (url && window.telador && typeof window.telador.patchConfig === "function") {
              window.telador.patchConfig({ livekitUrl: String(url) });
            }
          } catch (e) {}
          const ret = await origConnect.apply(this, arguments);
          wireRoomShareState(this);
          try { window.__teladorBlockRemoteAudio(this); } catch (e) {}
          try {
            window.__teladorIdentity = this.localParticipant && this.localParticipant.identity;
          } catch (e) {}
          try { await window.__teladorMaybeResumeShare(); } catch (e) {}
          return ret;
        };
        mod.Room.prototype.__teladorConnectHooked = true;
      }
      if (mod && mod.LocalParticipant && mod.LocalParticipant.prototype) {
        const proto = mod.LocalParticipant.prototype;
        if (!proto.__teladorShareHooked) {
          const orig = proto.setScreenShareEnabled;
          proto.setScreenShareEnabled = async function (enabled, opts, pubOpts) {
            window.__teladorLP = this;
            window.__teladorRoom = window.__teladorRoom || this.room;
            if (window.__teladorRoom) wireRoomShareState(window.__teladorRoom);
            if (enabled) {
              opts = Object.assign({}, opts || {}, window.__teladorShareOpts);
              pubOpts = Object.assign({}, pubOpts || {}, window.__teladorPubOpts, {
                screenShareEncoding: Object.assign(
                  {},
                  window.__teladorPubOpts.screenShareEncoding,
                  (pubOpts && pubOpts.screenShareEncoding) || {}
                ),
              });
              delete pubOpts.backupCodec;
              pubOpts.screenShareEncoding.maxBitrate = Math.min(
                Math.max(Number(pubOpts.screenShareEncoding.maxBitrate) || 0, VIDEO_BITRATE.poor),
                VIDEO_BITRATE.excellent
              );
              pubOpts.screenShareEncoding.maxFramerate =
                Number(pubOpts.screenShareEncoding.maxFramerate) || 30;
              pubOpts.dtx = false;
              pubOpts.red = false;
              pubOpts.forceStereo = true;
              pubOpts.audioBitrate = Math.max(Number(pubOpts.audioBitrate) || 0, 256000);
              if (!pubOpts.name) pubOpts.name = "screen-" + Date.now();
            }
            let result;
            try {
              result = await orig.call(this, enabled, opts, pubOpts);
            } catch (err) {
              if (enabled) {
                try {
                  result = await orig.call(this, true, window.__teladorShareOpts, {
                    videoCodec: "vp8",
                    simulcast: false,
                    name: "screen-" + Date.now(),
                    screenShareEncoding: { maxBitrate: VIDEO_BITRATE.poor, maxFramerate: 30 },
                    degradationPreference: "maintain-resolution",
                  });
                } catch (err2) {
                  throw err;
                }
              } else {
                throw err;
              }
            }
            if (enabled) {
              try {
                const { videoPub, audioPub } = findScreenPubs(this);
                if (videoPub && videoPub.track) bindTrackEnded(videoPub.track);
                if (audioPub && audioPub.track) bindTrackEnded(audioPub.track);
                setTimeout(() => {
                  try {
                    const { videoPub: vp } = findScreenPubs(this);
                    if (vp && vp.track) forceKeyframe(vp.track);
                  } catch (e2) {}
                }, 400);
                startAdaptiveBitrate();
                reportShareState(true, "published");
              } catch (e) {}
            } else {
              reportShareState(false, "unpublished");
            }
            return result;
          };
          proto.__teladorShareHooked = true;
        }
      }
      window.__teladorLkHooked = !!(mod && mod.Room);
      window.__teladorLkModuleOk = window.__teladorLkHooked;
      if (!window.__teladorLkHooked) tlog("warn", "LiveKit module não encontrado em window");
    } catch (e) {
      window.__teladorLkModuleOk = false;
      tlog("error", "LiveKit hook failed", e && e.message);
    }
  }

  if (typeof window.__startShare === "function" && !window.__startShare.__isTelador) {
    window.__teladorOrigStart = window.__startShare;
  }

  window.__startShare = async () => {
    window.__teladorRestartingShare = true;
    try {
      await window.__forceStopShare();
      await sleep(120);

      const lp = getLP();
      if (!lp) {
        if (typeof window.__teladorOrigStart === "function") {
          await window.__teladorOrigStart();
          startAdaptiveBitrate();
          reportShareState(true, "published");
          return;
        }
        throw new Error("sem conexão com a sala");
      }
      await lp.setScreenShareEnabled(true, window.__teladorShareOpts, window.__teladorPubOpts);
      startAdaptiveBitrate();
      reportShareState(true, "published");
    } finally {
      window.__teladorRestartingShare = false;
    }
  };
  window.__startShare.__isTelador = true;

  window.__teladorMaybeResumeShare = async () => {
    if (window.__teladorResumingShare) return;
    if (!window.telador || typeof window.telador.getConfig !== "function") return;
    let cfg;
    try { cfg = await window.telador.getConfig(); } catch (e) { return; }
    if (!cfg || !cfg.resumeShare) return;
    window.__teladorResumingShare = true;
    try {
      try {
        if (typeof window.telador.patchConfig === "function") {
          await window.telador.patchConfig({ resumeShare: false });
        }
      } catch (e) {}
      reportShareState(true, "switching");
      for (let i = 0; i < 40; i++) {
        if (getLP()) break;
        await sleep(100);
      }
      await sleep(400);
      if (typeof window.__startShare === "function") await window.__startShare();
    } catch (e) {
      reportShareState(false, "failed");
    } finally {
      window.__teladorResumingShare = false;
    }
  };

  try {
    if (getLP()) window.__teladorMaybeResumeShare();
  } catch (e) {}
})();
