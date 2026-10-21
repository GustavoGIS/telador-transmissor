/**
 * Worker local — LiveKit embutido (vendor), hooks via main.
 * __startShare / __stopShare vêm de captureHooks (única implementação).
 */
import * as LivekitClient from "./vendor/livekit-client.esm.mjs";

window.LivekitClient = LivekitClient;
window.livekit = LivekitClient;
try { window.dispatchEvent(new Event("telador-livekit-ready")); } catch (e) {}

const { Room, RoomEvent } = LivekitClient;
const SITE = "https://telador.vercel.app";
const T = window.telador;
let room;
let connecting = false;
let cfg;
let wantResumeShare = false;
let connectGeneration = 0;

function status(s) {
  try { if (T && T.setStatus) T.setStatus(s); } catch (e) {}
}

function phase(p, detail) {
  try { if (T && T.setUiPhase) T.setUiPhase(p, detail); } catch (e) {}
  if (detail) status(detail);
}

function isSharing() {
  try {
    return !!(window.__teladorShareStream || (getVideoPub() && getVideoPub().track));
  } catch (e) {
    return false;
  }
}

function getVideoPub() {
  try {
    const lp = room && room.localParticipant;
    if (!lp) return null;
    if (typeof lp.getTrackPublication === "function") {
      return lp.getTrackPublication("screen_share") || null;
    }
  } catch (e) {}
  return null;
}

async function getLivekitUrl() {
  // Sempre pergunta ao main (rediscovery do site) — não usar cfg.livekitUrl antigo
  try {
    if (T && typeof T.getLivekitUrl === "function") {
      const u = await T.getLivekitUrl();
      if (u) return u;
    }
  } catch (e) {}
  if (cfg && cfg.livekitUrl && !/telador-fprg5who/i.test(cfg.livekitUrl)) {
    return cfg.livekitUrl;
  }
  return "wss://telador2-r17fz9fd.livekit.cloud";
}

function waitForHooks(ms) {
  return new Promise((resolve) => {
    if (window.__teladorLkHooked) return resolve(true);
    const t0 = Date.now();
    const id = setInterval(() => {
      if (window.__teladorLkHooked || Date.now() - t0 > ms) {
        clearInterval(id);
        resolve(!!window.__teladorLkHooked);
      }
    }, 40);
  });
}

async function connect() {
  if (connecting) return;
  connecting = true;
  const gen = ++connectGeneration;
  phase("connecting", "Conectando…");
  try {
    if (!cfg.name || !cfg.key) {
      phase("idle", "Configure nome e código da sala");
      return;
    }

    const res = await fetch(
      `${SITE}/api/token?role=broadcaster&name=${encodeURIComponent(cfg.name)}&key=${encodeURIComponent(cfg.key)}`
    );
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error("Resposta inválida do servidor (" + res.status + ")");
    }
    if (!res.ok || !data.token) {
      const err = data && data.error ? String(data.error) : ("Falha no token (" + res.status + ")");
      const soft = /inválid|invalid|not found|não encontr|denied|unauthorized/i.test(err);
      phase("error", err);
      if (soft) {
        // Não martela o servidor com código errado
        connecting = false;
        return;
      }
      throw new Error(err);
    }

    if (gen !== connectGeneration) return;

    if (room) {
      try { await room.disconnect(true); } catch (e) {}
      room = null;
    }

    await waitForHooks(4000);

    room = new Room();
    window.__teladorRoom = room;
    window.__teladorLP = room.localParticipant;

    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.LocalTrackUnpublished, () => {
      if (window.__teladorRestartingShare) return;
      if (!isSharing()) phase("connected", "Conectado");
    });
    room.on(RoomEvent.Disconnected, () => {
      const wasSharing = isSharing() || wantResumeShare;
      try {
        if (T && T.setShareState) T.setShareState({ active: false, reason: "disconnected" });
      } catch (e) {}
      phase("connecting", "Desconectado — reconectando…");
      if (wasSharing) wantResumeShare = true;
      setTimeout(run, 5000);
    });

    const url = await getLivekitUrl();
    await room.connect(url, data.token);
    window.__teladorLP = room.localParticipant;
    try {
      if (T && typeof T.patchConfig === "function") {
        await T.patchConfig({ livekitUrl: url });
      }
    } catch (e) {}
    try { window.dispatchEvent(new Event("telador-room-ready")); } catch (e) {}
    phase("connected", "Conectado — " + (data.room || cfg.key));

    if (wantResumeShare || (cfg && cfg.resumeShare)) {
      wantResumeShare = false;
      try {
        if (T && typeof T.patchConfig === "function") {
          await T.patchConfig({ resumeShare: false });
        }
      } catch (e) {}
      setTimeout(async () => {
        try {
          if (typeof window.__startShare === "function") await window.__startShare();
        } catch (e) {}
      }, 600);
    }
  } finally {
    connecting = false;
  }
}

async function run() {
  try {
    await connect();
  } catch (e) {
    const msg = "Erro: " + (e && e.message ? e.message : e);
    phase("error", msg);
    setTimeout(run, 5000);
  }
}

function onData(payload, participant, _kind, topic) {
  if (topic !== "telador") return;
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }
  if (msg.type !== "present") return;
  const localName = room && room.localParticipant && room.localParticipant.name;
  if (msg.target === localName) {
    const from = (participant && (participant.name || participant.identity))
      || msg.from
      || "";
    try {
      if (T && typeof T.requestPresent === "function") {
        T.requestPresent({ target: msg.target, from: String(from || "") });
      }
    } catch (e) {}
  } else if (typeof window.__forceStopShare === "function") {
    window.__forceStopShare();
  } else if (typeof window.__stopShare === "function") {
    window.__stopShare();
  }
}

// Compat: se algo chamar __stopShare antes dos hooks, encaminha
window.__stopShare = async () => {
  if (typeof window.__forceStopShare === "function") {
    await window.__forceStopShare();
  }
  phase("connected", "Conectado");
};

(async () => {
  if (!T) {
    console.error("[telador] preload ausente");
    return;
  }
  cfg = (await T.getConfig()) || {};
  if (!cfg.name || !cfg.key) {
    phase("idle", "Configure nome e código da sala");
    return;
  }
  wantResumeShare = !!cfg.resumeShare;
  run();
})();
