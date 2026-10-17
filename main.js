const {
  app, BrowserWindow, Tray, Menu, session, desktopCapturer, ipcMain,
  nativeImage, shell, globalShortcut, Notification, clipboard, dialog,
  powerSaveBlocker,
} = require("electron");
const path = require("path");
const fs = require("fs");
const winPlatform = require("./winPlatform");

// Antes de app.ready — captura/encode WebRTC (Chromium)
// Default do desktop capturer: só 50% de 1 núcleo → costuma travar ~20–25 fps em 1080p
try {
  app.commandLine.appendSwitch("webrtc-max-cpu-consumption-percentage", "100");
  // Switch real do Chromium (= kWebRtcMaxCaptureFramerate); "webrtc-max-capture-framerate" é alias informal
  app.commandLine.appendSwitch("max-gum-fps", "60");
  // NÃO usar disable-gpu-vsync / disable-frame-rate-limit aqui: deixam o compositor
  // sem teto em todos os renderers (~20–30% GPU mesmo sem transmitir).
  // max-gum-fps + webrtc CPU 100% já liberam a captura; o worker desliga throttling só no TX.

  if (process.platform === "win32") {
    app.commandLine.appendSwitch("ignore-gpu-blocklist");
    app.commandLine.appendSwitch("enable-gpu-rasterization");
    app.commandLine.appendSwitch("enable-zero-copy");
    // WGC de tela só em Win11 24H2+ (build ≥ 26100); ver winPlatform.js
    app.commandLine.appendSwitch(
      "enable-features",
      winPlatform.chromiumEnableFeatures().join(",")
    );
  }
} catch {}

const processAudio = require("./processAudio");
const log = require("./log");
const updater = require("./updater");
const quality = require("./quality");
const configSchema = require("./configSchema");
const winTimer = require("./winTimer");
const { discoverLivekitUrl, SITE: DISCOVER_SITE } = require("./discoverLivekit");

const SITE = DISCOVER_SITE || "https://telador.vercel.app";
const APP_VERSION = (() => {
  try { return require("./package.json").version; } catch { return "0.0.0"; }
})();
const HOOKS_VERSION = APP_VERSION;
const USE_LOCAL_WORKER = true;
// AUMID empacotado ≠ dev: se npm start usar o mesmo ID, o Windows cacheia o ícone do electron.exe na taskbar
const APP_USER_MODEL_ID = "com.telador.transmissor.win";
const cfgPath = () => path.join(app.getPath("userData"), "config.json");
const HOOKS_PATH = path.join(__dirname, "captureHooks.js");
const WORKER_HTML = path.join(__dirname, "worker", "index.html");
const ICON_PNG = path.join(__dirname, "icon.png");
const ICON_ICO = path.join(__dirname, "icon.ico");

if (process.platform === "win32") {
  try {
    app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : APP_USER_MODEL_ID + ".dev");
  } catch {}
}

function appIconPath() {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "icon.ico"));
      candidates.push(path.join(process.resourcesPath, "icon.png"));
    }
  } catch {}
  candidates.push(ICON_ICO, ICON_PNG);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return ICON_PNG;
}

function loadAppIcon() {
  for (const p of [appIconPath(), ICON_ICO, ICON_PNG]) {
    try {
      const img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) return img;
    } catch {}
  }
  return nativeImage.createEmpty();
}

function applyWindowIcon(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const img = loadAppIcon();
    if (img && !img.isEmpty()) win.setIcon(img);
  } catch {}
}

function scrubElectronStartMenuPoison() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try {
    const lnk = path.join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Electron.lnk"
    );
    if (!fs.existsSync(lnk)) return;
    const info = shell.readShortcutLink(lnk);
    const target = String((info && info.target) || "");
    if (/node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i.test(target)) {
      fs.unlinkSync(lnk);
      log.info("removed poisonous Electron.lnk");
    }
  } catch {}
}

const readCfg = () => {
  try {
    return configSchema.normalize({}, JSON.parse(fs.readFileSync(cfgPath(), "utf8")));
  } catch {
    return null;
  }
};

function writeCfg(partial) {
  const prev = readCfg() || {};
  const next = configSchema.normalize(partial || {}, prev);
  const file = cfgPath();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 0), "utf8");
  fs.renameSync(tmp, file);
  return next;
}

let tray, worker, setup, baseIcon;
let lastStatus = "";
let uiPhase = "idle";
let transmitting = false;
let switchingSource = false;
let switchStartedAt = 0;
let activeSourceId = "";
let activeSourceName = "";
let audioOk = null;
let updateProgress = 0;
let shareQueue = Promise.resolve();
let crashRestarts = [];
let isQuitting = false;
let liveStats = { bitrate: 0, loss: 0, rtt: 0, codec: "", health: "idle", fps: 0 };
let boundsSaveTimer = null;
let pendingPresent = null;
let powerBlockerId = null;

function setPowerBlock(on) {
  try {
    if (on) {
      if (powerBlockerId == null || !powerSaveBlocker.isStarted(powerBlockerId)) {
        powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      }
    } else if (powerBlockerId != null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
      powerBlockerId = null;
    }
  } catch {}
}

/** Idle: throttling + frame rate baixo no worker oculto. TX: sem throttling. */
function applyWorkerPerfMode(forTransmit) {
  if (!worker || worker.isDestroyed()) return;
  const tx = !!forTransmit;
  try {
    worker.webContents.setBackgroundThrottling(!tx);
  } catch {}
  try {
    if (typeof worker.webContents.setFrameRate === "function") {
      worker.webContents.setFrameRate(tx ? 60 : 5);
    }
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => { try { clearTimeout(timer); } catch {} }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}

function enqueueShare(fn) {
  const run = shareQueue.then(() => fn(), () => fn());
  shareQueue = run.catch(() => {});
  return run;
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: title || "Telador",
      body: String(body || ""),
      icon: appIconPath(),
    });
    n.show();
  } catch {}
}

function makeTrayImage(active) {
  if (!baseIcon || baseIcon.isEmpty()) return nativeImage.createEmpty();
  const img = baseIcon.resize({ width: 16, height: 16 });
  const { width: w, height: h } = img.getSize();
  const buf = Buffer.from(img.toBitmap());
  const color = active ? { r: 46, g: 204, b: 113 } : { r: 231, g: 76, b: 60 };
  const cx = w - 3.5;
  const cy = h - 3.5;
  const outer = 3.2;
  const inner = 2.2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > outer * outer) continue;
      const i = (y * w + x) * 4;
      if (d2 >= inner * inner) {
        buf[i] = 20; buf[i + 1] = 20; buf[i + 2] = 20; buf[i + 3] = 255;
      } else {
        buf[i] = color.b; buf[i + 1] = color.g; buf[i + 2] = color.r; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

function updateTrayIcon() {
  if (!tray) return;
  tray.setImage(makeTrayImage(transmitting));
}

function updateTrayTooltip() {
  if (!tray) return;
  const parts = ["Telador"];
  if (transmitting && activeSourceName) parts.push(activeSourceName);
  else if (lastStatus) parts.push(lastStatus);
  parts.push("v" + APP_VERSION);
  tray.setToolTip(parts.join(" — "));
}

async function listSources(withThumbs) {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: withThumbs ? { width: 160, height: 90 } : { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith("screen:") ? "screen" : "window",
    thumb: withThumbs && s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : "",
  }));
}

async function resolveSource(cfg) {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 },
  });
  if (!sources.length) return null;
  if (cfg?.sourceId) {
    const byId = sources.find((s) => s.id === cfg.sourceId);
    if (byId) return byId;
  }
  if (cfg?.sourceName) {
    const byName = sources.find((s) => s.name === cfg.sourceName);
    if (byName) return byName;
    const want = String(cfg.sourceName).toLowerCase();
    const fuzzy = sources.find((s) => String(s.name).toLowerCase().includes(want) || want.includes(String(s.name).toLowerCase()));
    if (fuzzy) return fuzzy;
  }
  if (cfg?.sourceType === "window") return null;
  return sources.find((s) => s.id.startsWith("screen:")) || sources[0];
}

function setActiveSourceFromCfg(cfg) {
  activeSourceId = String((cfg && cfg.sourceId) || "");
  activeSourceName = String((cfg && cfg.sourceName) || "");
}

function clearActiveSource() {
  activeSourceId = "";
  activeSourceName = "";
}

function setUiPhase(phase, statusText) {
  uiPhase = String(phase || "idle");
  if (statusText != null) lastStatus = String(statusText);
  updateTrayTooltip();
  broadcastUiState();
}

function resolveQualityFromCfg(cfg) {
  const c = cfg || readCfg() || {};
  return quality.resolvePreset(c.qualityPreset, c.customQuality);
}

function getUiState() {
  const upd = updater.getLatest();
  const cfg = readCfg() || {};
  return {
    version: (() => {
      try { return app.getVersion() || APP_VERSION; } catch { return APP_VERSION; }
    })(),
    status: lastStatus || "Aguardando",
    phase: uiPhase,
    transmitting,
    switching: switchingSource,
    sourceName: activeSourceName || cfg.sourceName || "",
    sourceId: activeSourceId || cfg.sourceId || "",
    sourceTab: cfg.sourceTab || cfg.sourceType || "screen",
    qualityPreset: cfg.qualityPreset || "balanced",
    customQuality: cfg.customQuality || null,
    presets: quality.listPresets(),
    roomHistory: cfg.roomHistory || [],
    audioOk,
    updateVersion: upd ? upd.version : "",
    updateProgress,
    updateNotes: upd ? (upd.notes || "") : "",
    updateUrl: upd ? (upd.htmlUrl || "") : "",
    stats: liveStats,
    firstRunSeen: !!cfg.firstRunSeen,
    trayClickAction: cfg.trayClickAction || "panel",
    pendingPresent: pendingPresent
      ? { target: pendingPresent.target || "", from: pendingPresent.from || "", at: pendingPresent.at || 0 }
      : null,
  };
}

function broadcastUiState() {
  try {
    if (setup && !setup.isDestroyed()) {
      setup.webContents.send("ui:state", getUiState());
    }
  } catch {}
}

function playCue(name) {
  const n = String(name || "");
  if (!n || isQuitting) return;
  try {
    if (setup && !setup.isDestroyed()) {
      setup.webContents.send("ui:sound", n);
    }
  } catch {}
}

function setTransmitting(on, statusText) {
  const next = !!on;
  const was = transmitting;
  if (next !== was) {
    transmitting = next;
    updateTrayIcon();
    setPowerBlock(next);
    applyWorkerPerfMode(next);
    try { winTimer.setStreamingTimers(next); } catch {}
    // Som só na borda real: começou / parou (qualquer motivo)
    if (next) playCue("tx-start");
    else playCue("tx-stop");
  }
  if (was && !next) {
    clearActiveSource();
    liveStats = { bitrate: 0, loss: 0, rtt: 0, codec: "", health: "idle", fps: 0 };
  }
  if (statusText != null) lastStatus = String(statusText);
  if (next && switchingSource) uiPhase = "switching";
  else if (next) uiPhase = "live";
  else if (uiPhase === "live" || uiPhase === "switching") uiPhase = "connected";
  updateTrayTooltip();
  broadcastUiState();
}

function sendPcmToWorker(buf) {
  if (!worker || worker.isDestroyed()) return;
  try {
    worker.webContents.send("audio:pcm", buf);
  } catch {}
}

function startNativeAudioCapture() {
  const cfg = readCfg() || {};
  const args = processAudio.argsForConfig(cfg);
  const ok = processAudio.start(args, {
    onPcm: sendPcmToWorker,
    onLog: (line) => {
      try { console.error("[audio-exclude]", String(line).trim()); } catch {}
    },
  });
  audioOk = !!ok;
  if (!ok) notify("Telador", "Falha ao iniciar captura de áudio (audio-exclude)");
  broadcastUiState();
  return ok;
}

function stopNativeAudioCapture() {
  processAudio.stop();
}

function injectCaptureHooks() {
  if (!worker || worker.isDestroyed()) return;
  let code;
  try {
    code = fs.readFileSync(HOOKS_PATH, "utf8");
  } catch (err) {
    log.error("captureHooks.js missing", err && err.message);
    return;
  }
  const cfg = readCfg() || {};
  const preset = resolveQualityFromCfg(cfg);
  const prefix =
    `window.__teladorHooksVersion=${JSON.stringify(HOOKS_VERSION)};` +
    `window.__teladorQualityPreset=${JSON.stringify(preset.id)};` +
    `window.__teladorShareOpts=${JSON.stringify(quality.toShareOpts(preset))};` +
    `window.__teladorPubOpts=${JSON.stringify(quality.toPubOpts(preset))};`;
  worker.webContents.executeJavaScript(prefix + "\n" + code, true).catch((e) => {
    log.warn("inject hooks failed", e && e.message);
  });
}

async function injectHooksWhenReady() {
  if (!worker || worker.isDestroyed()) return;
  try { worker.webContents.setAudioMuted(true); } catch {}

  const lkReady = await runInWorker(`
    (async () => {
      if (window.LivekitClient && window.LivekitClient.Room) return true;
      return await new Promise((resolve) => {
        const done = () => resolve(!!(window.LivekitClient && window.LivekitClient.Room));
        window.addEventListener("telador-livekit-ready", done, { once: true });
        let n = 0;
        const id = setInterval(() => {
          if (window.LivekitClient && window.LivekitClient.Room) { clearInterval(id); done(); }
          else if (++n > 50) { clearInterval(id); resolve(false); }
        }, 100);
      });
    })()
  `);
  injectCaptureHooks();
  if (!lkReady) log.warn("LiveKit lento — hooks injetados mesmo assim");

  const roomReady = await runInWorker(`
    new Promise((resolve) => {
      if (window.__teladorRoom) return resolve(true);
      window.addEventListener("telador-room-ready", () => resolve(true), { once: true });
      setTimeout(() => resolve(!!window.__teladorRoom), 20000);
    })
  `);
  if (roomReady) {
    injectCaptureHooks();
    log.info("hooks wired to room");
    setUiPhase("connected", lastStatus || "Conectado");
  } else {
    log.warn("hooks: room not ready after wait");
  }
}

async function runInWorker(code) {
  if (!worker || worker.isDestroyed()) return null;
  try {
    return await worker.webContents.executeJavaScript(code, true);
  } catch {
    return null;
  }
}

async function waitForTransmit(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (transmitting && uiPhase === "live") return true;
    await sleep(200);
  }
  return false;
}

async function runStartShare() {
  return enqueueShare(async () => {
    if (!worker || worker.isDestroyed()) return;
    setUiPhase("switching", "Iniciando transmissão...");
    await runInWorker(`window.__teladorAudio = true;`);
    injectCaptureHooks();
    await sleep(40);
    await runInWorker(
      `(async () => { if (typeof window.__startShare === "function") await window.__startShare(); })()`
    );
    const ok = await waitForTransmit(12000);
    if (ok) setActiveSourceFromCfg(readCfg() || {});
    updateTrayTooltip();
  });
}

async function runStopShare() {
  return enqueueShare(async () => {
    if (!worker || worker.isDestroyed()) return;
    injectCaptureHooks();
    await runInWorker(`
      (async () => {
        if (typeof window.__forceStopShare === "function") await window.__forceStopShare();
        else if (typeof window.__stopShare === "function") await window.__stopShare();
        if (window.telador) window.telador.setStatus("Conectado");
      })()
    `);
    stopNativeAudioCapture();
    clearActiveSource();
    setTransmitting(false, "Conectado");
    setUiPhase("connected", "Conectado");
  });
}

async function runSwitchShareReload() {
  writeCfg({ resumeShare: true });
  injectCaptureHooks();
  await leaveRoomInWorker();
  await sleep(300);
  if (!worker || worker.isDestroyed()) return false;
  worker.webContents.reload();
  const ok = await waitForTransmit(20000);
  if (!ok) {
    setTransmitting(false, "Conectado");
    try { writeCfg({ resumeShare: false }); } catch {}
    return false;
  }
  setActiveSourceFromCfg(readCfg() || {});
  return true;
}

async function runSwitchShare() {
  return enqueueShare(async () => {
    if (!worker || worker.isDestroyed()) return;
    if (switchingSource) return;
    switchingSource = true;
    switchStartedAt = Date.now();
    setUiPhase("switching", "Alterando fonte...");
    setTransmitting(true, "Alterando fonte...");
    try {
      injectCaptureHooks();
      await sleep(30);
      const result = await runInWorker(`
        (async () => {
          try {
            if (typeof window.__replaceShareSource === "function") {
              return await window.__replaceShareSource();
            }
            return "missing";
          } catch (e) { return "failed"; }
        })()
      `);
      if (result === "started") {
        const ok = await waitForTransmit(12000);
        if (ok) {
          setActiveSourceFromCfg(readCfg() || {});
          return;
        }
      }
      await runSwitchShareReload();
    } finally {
      switchingSource = false;
      switchStartedAt = 0;
      broadcastUiState();
    }
  });
}

async function applyQualityLive() {
  injectCaptureHooks();
  if (!transmitting || !worker || worker.isDestroyed()) return false;
  await runInWorker(`
    (async () => {
      if (typeof window.__applyQualityLive === "function") await window.__applyQualityLive();
    })()
  `);
  return true;
}

async function transmitLastSource() {
  const cfg = readCfg() || {};
  if (!cfg.sourceId) {
    showPanel();
    return;
  }
  if (transmitting && activeSourceId === cfg.sourceId) return;
  if (transmitting) await runSwitchShare();
  else await runStartShare();
}

async function leaveRoomInWorker() {
  if (!worker || worker.isDestroyed()) return;
  injectCaptureHooks();
  try {
    await withTimeout(runInWorker(`
      (async () => {
        if (typeof window.__teladorLeaveRoom === "function") await window.__teladorLeaveRoom();
        else if (window.__teladorRoom && typeof window.__teladorRoom.disconnect === "function") {
          try { await window.__teladorRoom.disconnect(true); } catch (e) {
            try { window.__teladorRoom.disconnect(); } catch (e2) {}
          }
        }
      })()
    `), 2500);
  } catch {}
  await sleep(150);
}

async function destroyWorkerGracefully() {
  stopNativeAudioCapture();
  switchingSource = false;
  switchStartedAt = 0;
  clearActiveSource();
  // Garante som/estado de "parou" se o worker caiu ou foi reiniciado
  setTransmitting(false, isQuitting ? "Encerrando..." : "Conectado");
  setUiPhase(isQuitting ? "idle" : (uiPhase === "error" ? "error" : "idle"), isQuitting ? "Encerrando..." : "Reiniciando…");
  try {
    await withTimeout(leaveRoomInWorker(), 3000);
  } catch {}
  if (worker && !worker.isDestroyed()) {
    try { worker.destroy(); } catch {}
  }
  worker = null;
}

function scheduleWorkerRestart(reason) {
  if (isQuitting) return;
  const now = Date.now();
  crashRestarts = crashRestarts.filter((t) => now - t < 60000);
  if (crashRestarts.length >= 3) {
    setUiPhase("error", "Falha repetida — reinicie manualmente");
    notify("Telador", "Falha repetida no worker — reinicie manualmente");
    return;
  }
  crashRestarts.push(now);
  setUiPhase("connecting", reason || "Reiniciando...");
  setTimeout(() => {
    if (!isQuitting) startWorker();
  }, 1200);
}

let workerOp = Promise.resolve();

function startWorker() {
  workerOp = workerOp
    .catch(() => {})
    .then(() => destroyWorkerGracefully())
    .then(() => {
      if (isQuitting) return;
      setUiPhase("connecting", "Iniciando...");
      worker = new BrowserWindow({
        show: false,
        icon: appIconPath(),
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          // Idle = throttling on (economiza GPU); TX liga perf mode em setTransmitting
          backgroundThrottling: !transmitting,
        },
      });
      applyWindowIcon(worker);
      applyWorkerPerfMode(transmitting);
      worker.webContents.setAudioMuted(true);
      worker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      worker.webContents.on("did-finish-load", () => {
        injectHooksWhenReady().catch((e) => log.warn("injectWhenReady", e && e.message));
      });
      worker.webContents.on("render-process-gone", (_e, details) => {
        stopNativeAudioCapture();
        clearActiveSource();
        const reason = details && details.reason ? String(details.reason) : "crash";
        log.error("render-process-gone", reason);
        notify("Telador", "Processo encerrado — reconectando…");
        scheduleWorkerRestart(`Processo encerrado (${reason}) — reiniciando`);
      });
      worker.webContents.on("did-fail-load", (_e, code, desc) => {
        log.error("worker failed load", { code, desc });
        if (USE_LOCAL_WORKER) {
          try { worker.loadURL(`${SITE}/transmissor.html`); } catch {}
        }
      });
      loadWorkerEntry(worker);
    });
  return workerOp;
}

async function loadWorkerEntry(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const cfg = readCfg() || {};
    const url = await discoverLivekitUrl(cfg.livekitUrl);
    if (url && url !== cfg.livekitUrl) writeCfg({ livekitUrl: url });
  } catch (e) {
    log.warn("livekit discover", e && e.message);
  }
  if (USE_LOCAL_WORKER && fs.existsSync(WORKER_HTML)) {
    log.info("loading local worker");
    win.loadFile(WORKER_HTML);
    return;
  }
  log.info("loading remote worker");
  win.loadURL(`${SITE}/transmissor.html`);
}

function persistBoundsSoon() {
  if (!setup || setup.isDestroyed()) return;
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    try {
      if (!setup || setup.isDestroyed()) return;
      const isMaximized = setup.isMaximized();
      const b = isMaximized ? setup.getNormalBounds() : setup.getBounds();
      writeCfg({
        windowBounds: {
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          isMaximized,
        },
      });
    } catch {}
  }, 400);
}

function showPanel() {
  if (setup && !setup.isDestroyed()) {
    setup.show();
    setup.focus();
    return;
  }
  openPanel();
}

function openPanel() {
  if (setup && !setup.isDestroyed()) {
    setup.show();
    setup.focus();
    return;
  }
  const cfg = readCfg() || {};
  const bounds = cfg.windowBounds;
  const opts = {
    width: (bounds && bounds.width) || 1100,
    height: (bounds && bounds.height) || 720,
    minWidth: 880,
    minHeight: 560,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: "#060b14",
    title: "Telador",
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  };
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    opts.x = bounds.x;
    opts.y = bounds.y;
  }
  setup = new BrowserWindow(opts);
  applyWindowIcon(setup);
  setup.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    persistBoundsSoon();
    setup.hide();
  });
  setup.on("closed", () => { setup = null; });
  setup.on("resize", persistBoundsSoon);
  setup.on("move", persistBoundsSoon);
  setup.once("ready-to-show", () => {
    applyWindowIcon(setup);
    try {
      if (bounds && bounds.isMaximized) setup.maximize();
      else if (!bounds) setup.maximize();
    } catch {}
    setup.show();
    setup.focus();
  });
  setup.loadFile(path.join(__dirname, "panel", "index.html"));
}

function buildTrayMenu() {
  const cfg = readCfg() || {};
  const hasLast = !!(cfg.sourceId);
  const upd = updater.getLatest();
  return Menu.buildFromTemplate([
    { label: "Abrir painel", click: showPanel },
    {
      label: "Transmitir última fonte",
      enabled: hasLast && !switchingSource,
      click: () => transmitLastSource(),
    },
    {
      label: "Parar transmissão",
      enabled: transmitting && !switchingSource,
      click: () => runStopShare(),
    },
    { type: "separator" },
    {
      label: upd ? `Atualizar v${upd.version}` : "Verificar atualizações",
      click: async () => {
        const info = await updater.checkForUpdates();
        broadcastUiState();
        if (info) showPanel();
      },
    },
    { type: "separator" },
    { label: `v${APP_VERSION}`, enabled: false },
    {
      label: "Sair",
      click: () => {
        if (transmitting) {
          showPanel();
          try { setup.webContents.send("ui:confirm-quit"); } catch {}
        } else app.quit();
      },
    },
  ]);
}

function buildTray() {
  baseIcon = loadAppIcon();
  tray = new Tray(makeTrayImage(false));
  updateTrayTooltip();
  tray.on("right-click", () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on("click", () => {
    const cfg = readCfg() || {};
    if (cfg.trayClickAction === "lastSource") transmitLastSource();
    else showPanel();
  });
  tray.on("double-click", () => transmitLastSource());
}

function registerShortcuts() {
  try {
    globalShortcut.unregisterAll();
    globalShortcut.register("CommandOrControl+Shift+T", () => showPanel());
    globalShortcut.register("CommandOrControl+Shift+S", () => {
      if (transmitting) runStopShare();
    });
    globalShortcut.register("CommandOrControl+Shift+R", () => transmitLastSource());
  } catch (e) {
    log.warn("globalShortcut", e && e.message);
  }
}

async function runPreflight(cfg) {
  const checks = [];
  const audioPath = processAudio.exePath();
  const audioExists = fs.existsSync(audioPath);
  checks.push({
    id: "audio",
    ok: audioExists,
    message: audioExists ? "Captura de áudio disponível" : "audio-exclude.exe ausente",
  });

  let livekitUrl = "";
  try {
    livekitUrl = await discoverLivekitUrl(cfg && cfg.livekitUrl);
    checks.push({
      id: "livekit",
      ok: !!livekitUrl,
      message: livekitUrl ? ("LiveKit: " + livekitUrl) : "URL LiveKit não encontrada",
    });
  } catch (e) {
    checks.push({ id: "livekit", ok: false, message: "Falha ao descobrir LiveKit" });
  }

  let tokenOk = false;
  let tokenMsg = "Informe nome e código da sala";
  if (cfg && cfg.name && cfg.key) {
    try {
      const res = await fetch(
        `${SITE}/api/token?role=broadcaster&name=${encodeURIComponent(cfg.name)}&key=${encodeURIComponent(cfg.key)}`
      );
      let data = null;
      try { data = await res.json(); } catch {}
      tokenOk = !!(res.ok && data && data.token);
      tokenMsg = tokenOk
        ? ("Token OK — sala " + (data.room || cfg.key))
        : ((data && data.error) || ("Token inválido (" + res.status + ")"));
    } catch (e) {
      tokenMsg = "Sem resposta do servidor de token";
    }
  }
  checks.push({ id: "token", ok: tokenOk, message: tokenMsg });

  const vendor = path.join(__dirname, "worker", "vendor", "livekit-client.esm.mjs");
  checks.push({
    id: "sdk",
    ok: fs.existsSync(vendor),
    message: fs.existsSync(vendor) ? "SDK LiveKit embutido" : "SDK LiveKit ausente (rode npm run vendor:livekit)",
  });

  return {
    ok: checks.every((c) => c.id === "token" ? (cfg && cfg.name && cfg.key ? c.ok : true) : c.ok),
    checks,
    livekitUrl,
  };
}

ipcMain.handle("cfg:get", () => readCfg());
ipcMain.handle("cfg:patch", (_e, partial) => writeCfg(partial || {}));
ipcMain.handle("livekit:url", async () => {
  const cfg = readCfg() || {};
  return discoverLivekitUrl(cfg.livekitUrl);
});
ipcMain.on("log", (_e, payload) => {
  const level = (payload && payload.level) || "info";
  const msg = payload && payload.msg;
  const extra = payload && payload.extra;
  if (level === "error") log.error(msg, extra);
  else if (level === "warn") log.warn(msg, extra);
  else log.info(msg, extra);
});
ipcMain.handle("ui:state", () => getUiState());
ipcMain.handle("ui:sources", async (_e, opts) => {
  try {
    return await listSources(!!(opts && opts.thumbs));
  } catch (e) {
    log.warn("listSources", e && e.message);
    return [];
  }
});
ipcMain.handle("ui:sourceThumbs", async () => {
  try {
    return await listSources(true);
  } catch (e) {
    return [];
  }
});
ipcMain.handle("ui:share", async (_e, src) => {
  if (!src || !src.sourceId) return false;
  writeCfg({
    sourceId: String(src.sourceId),
    sourceName: String(src.sourceName || ""),
    sourceType: src.sourceType === "window" ? "window" : "screen",
    sourceTab: src.sourceType === "window" ? "window" : "screen",
  });
  if (transmitting) await runSwitchShare();
  else await runStartShare();
  broadcastUiState();
  return true;
});
ipcMain.handle("ui:stop", async () => {
  await runStopShare();
  return true;
});
ipcMain.handle("ui:restart", async () => {
  await startWorker();
  return true;
});
ipcMain.handle("ui:setQuality", async (_e, payload) => {
  const id = typeof payload === "string" ? payload : (payload && payload.id);
  const custom = typeof payload === "object" && payload ? payload.custom : null;
  const patch = { qualityPreset: id };
  if (custom) patch.customQuality = custom;
  writeCfg(patch);
  await applyQualityLive();
  broadcastUiState();
  return true;
});
ipcMain.handle("ui:setTab", (_e, tab) => {
  writeCfg({ sourceTab: tab === "window" ? "window" : "screen" });
  return true;
});
ipcMain.handle("ui:checkUpdate", async () => {
  const info = await updater.checkForUpdates();
  broadcastUiState();
  return info;
});
ipcMain.handle("ui:applyUpdate", async () => {
  try {
    updateProgress = 0;
    setUiPhase(uiPhase, "Baixando atualização...");
    await updater.downloadLatest((p) => {
      updateProgress = Math.round((p || 0) * 100);
      broadcastUiState();
    });
    updateProgress = 100;
    broadcastUiState();
    await updater.applyUpdateAndRelaunch();
    return true;
  } catch (e) {
    log.error("applyUpdate", e && e.message);
    updateProgress = 0;
    setUiPhase("error", "Falha ao atualizar: " + (e && e.message ? e.message : e));
    notify("Telador", "Falha ao atualizar");
    return false;
  }
});
/** Verifica update; se houver, pergunta e instala. */
ipcMain.handle("ui:checkUpdateFlow", async () => {
  try {
    const info = await updater.checkForUpdates();
    broadcastUiState();
    if (!info || !info.version) return { status: "uptodate" };

    const replacePath = (() => {
      try { return updater.resolveReplacePath(); } catch { return ""; }
    })();
    const detail = (String(info.notes || "").trim().slice(0, 500)
      || "Deseja baixar e instalar agora? O app será reiniciado.")
      + (replacePath
        ? "\n\nO arquivo portable será substituído em:\n" + replacePath
        : "\n\nO arquivo portable que você abriu será substituído no mesmo lugar.");
    const { response } = await dialog.showMessageBox(setup && !setup.isDestroyed() ? setup : undefined, {
      type: "question",
      buttons: ["Instalar", "Agora não"],
      defaultId: 0,
      cancelId: 1,
      title: "Atualização disponível",
      message: "Nova versão " + info.version,
      detail,
      noLink: true,
    });
    if (response !== 0) return { status: "declined", version: info.version };

    updateProgress = 0;
    setUiPhase(uiPhase, "Baixando atualização...");
    broadcastUiState();
    // Responde cedo para a UI mostrar progresso; aplica em seguida
    setImmediate(async () => {
      try {
        await updater.downloadLatest((p) => {
          updateProgress = Math.round((p || 0) * 100);
          broadcastUiState();
        });
        updateProgress = 100;
        broadcastUiState();
        await updater.applyUpdateAndRelaunch();
      } catch (e) {
        log.error("applyUpdate", e && e.message);
        updateProgress = 0;
        setUiPhase("error", "Falha ao atualizar: " + (e && e.message ? e.message : e));
        notify("Telador", "Falha ao atualizar");
        broadcastUiState();
      }
    });
    return { status: "installing", version: info.version };
  } catch (e) {
    log.error("checkUpdateFlow", e && e.message);
    return { status: "failed", message: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle("ui:openLogs", () => {
  try { shell.showItemInFolder(log.path()); } catch {}
  return true;
});
ipcMain.handle("ui:logTail", (_e, n) => log.tail(n || 100));
ipcMain.handle("ui:quit", () => {
  app.quit();
  return true;
});
ipcMain.handle("ui:preflight", async (_e, draft) => {
  const cfg = Object.assign({}, readCfg() || {}, draft || {});
  return runPreflight(cfg);
});
ipcMain.handle("ui:testAudio", async () => {
  stopNativeAudioCapture();
  const ok = startNativeAudioCapture();
  if (ok) {
    await sleep(2500);
    stopNativeAudioCapture();
  }
  return { ok, message: ok ? "Pipeline de áudio respondeu" : "Falha ao iniciar audio-exclude" };
});
ipcMain.handle("ui:exportConfig", async () => {
  const data = configSchema.exportSafe(readCfg() || {});
  const { canceled, filePath } = await dialog.showSaveDialog(setup || undefined, {
    title: "Exportar configuração",
    defaultPath: "telador-config.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  return true;
});
ipcMain.handle("ui:importConfig", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(setup || undefined, {
    title: "Importar configuração",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths || !filePaths[0]) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePaths[0], "utf8"));
    const next = writeCfg(configSchema.importSafe(raw));
    broadcastUiState();
    return next;
  } catch (e) {
    throw new Error(e && e.message ? e.message : "Falha ao importar");
  }
});
ipcMain.handle("ui:diagnostic", () => {
  const cfg = readCfg() || {};
  const text = [
    "Telador Transmissor diagnóstico",
    "version=" + APP_VERSION,
    "phase=" + uiPhase,
    "status=" + lastStatus,
    "transmitting=" + transmitting,
    "audioOk=" + audioOk,
    "quality=" + cfg.qualityPreset,
    "source=" + (cfg.sourceName || "") + " (" + (cfg.sourceId || "") + ")",
    "livekit=" + (cfg.livekitUrl || ""),
    "stats=" + JSON.stringify(liveStats),
    "--- log ---",
    log.tail(40).join("\n"),
  ].join("\n");
  clipboard.writeText(text);
  return text;
});
ipcMain.handle("ui:firstRunSeen", () => {
  writeCfg({ firstRunSeen: true });
  return true;
});
ipcMain.handle("ui:setTrayClick", (_e, action) => {
  writeCfg({ trayClickAction: action === "lastSource" ? "lastSource" : "panel" });
  broadcastUiState();
  return true;
});
ipcMain.handle("ui:openExternal", (_e, url) => {
  if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});
ipcMain.handle("cfg:save", async (e, cfg) => {
  if (!setup || e.sender !== setup.webContents) return false;
  const patch = { name: cfg.name, key: cfg.key };
  if (cfg.qualityPreset != null) patch.qualityPreset = cfg.qualityPreset;
  if (cfg.customQuality != null) patch.customQuality = cfg.customQuality;
  writeCfg(patch);
  setUiPhase("connecting", "Iniciando...");
  startWorker();
  broadcastUiState();
  return true;
});
ipcMain.handle("audio:start", () => {
  stopNativeAudioCapture();
  const ok = startNativeAudioCapture();
  if (!ok) {
    log.error("audio-exclude failed to start");
    audioOk = false;
    notify("Telador", "Áudio do aplicativo indisponível");
  } else {
    log.info("audio-exclude started");
    audioOk = true;
  }
  broadcastUiState();
  return ok;
});
ipcMain.handle("audio:stop", () => {
  stopNativeAudioCapture();
  return true;
});
ipcMain.on("audio:status", (_e, ok) => {
  const next = !!ok;
  if (audioOk !== false && next === false) {
    notify("Telador", "Áudio do aplicativo indisponível");
  }
  audioOk = next;
  broadcastUiState();
});
ipcMain.on("ui:phase", (_e, phase, detail) => {
  setUiPhase(phase, detail != null ? detail : lastStatus);
});
ipcMain.on("stats:update", (_e, s) => {
  if (!s || typeof s !== "object") return;
  liveStats = {
    bitrate: Number(s.bitrate) || 0,
    loss: Number(s.loss) || 0,
    rtt: Number(s.rtt) || 0,
    codec: String(s.codec || ""),
    health: String(s.health || "ok"),
    fps: Number(s.fps) || 0,
  };
  broadcastUiState();
});

ipcMain.on("status", (_e, s) => {
  const prev = lastStatus;
  lastStatus = String(s || "");
  if (/erro/i.test(lastStatus)) uiPhase = "error";
  else if (/conectando|iniciando|desconectado/i.test(lastStatus)) uiPhase = "connecting";
  else if (/transmitindo/i.test(lastStatus)) uiPhase = "live";
  else if (/conectado/i.test(lastStatus)) uiPhase = transmitting ? "live" : "connected";
  if (/desconectado/i.test(lastStatus) && !/desconectado/i.test(prev)) {
    notify("Telador", "Desconectado — tentando reconectar…");
  }
  if (/erro/i.test(lastStatus) && !/erro/i.test(prev)) {
    notify("Telador", lastStatus);
  }
  updateTrayTooltip();
  broadcastUiState();
});

ipcMain.on("share:state", (_e, state) => {
  const active = !!(state && state.active);
  const reason = String((state && state.reason) || "");
  if (reason === "switching") {
    switchingSource = true;
    if (!switchStartedAt) switchStartedAt = Date.now();
    setUiPhase("switching", "Alterando fonte...");
    // Não mexe em transmitting aqui — evita som falso de start/stop na troca de fonte
    broadcastUiState();
    return;
  }
  if (reason === "audio-missing") {
    audioOk = false;
    if (active || transmitting) {
      setTransmitting(true, "Transmitindo (sem áudio do app)");
      setUiPhase("live", "Transmitindo (sem áudio do app)");
      notify("Telador", "Transmitindo sem áudio do aplicativo");
    } else {
      broadcastUiState();
    }
    return;
  }
  if (active) {
    switchingSource = false;
    switchStartedAt = 0;
    setActiveSourceFromCfg(readCfg() || {});
    setTransmitting(true, audioOk === false ? "Transmitindo (sem áudio do app)" : "Transmitindo");
    setUiPhase("live", lastStatus || "Transmitindo");
  } else {
    // Durante troca de fonte o track pode cair um instante — não é "parou de transmitir"
    if (switchingSource) {
      broadcastUiState();
      return;
    }
    switchingSource = false;
    switchStartedAt = 0;
    setTransmitting(false, lastStatus && !/^transmitindo/i.test(lastStatus) ? lastStatus : "Conectado");
    stopNativeAudioCapture();
    if (uiPhase !== "error" && uiPhase !== "connecting") setUiPhase("connected", lastStatus || "Conectado");
  }
});

ipcMain.on("gesture", () => {
  // Compat: gesto antigo = pedido de transmissão (não inicia sozinho)
  pendingPresent = { target: "", from: "", at: Date.now() };
  showPanel();
  playCue("present");
  notify("Telador", "Pedido de transmissão — aceite ou recuse no painel");
  broadcastUiState();
});

ipcMain.on("present:request", (_e, info) => {
  const i = info && typeof info === "object" ? info : {};
  pendingPresent = {
    target: String(i.target || ""),
    from: String(i.from || ""),
    at: Date.now(),
  };
  showPanel();
  playCue("present");
  const who = pendingPresent.from ? ` de ${pendingPresent.from}` : "";
  notify("Telador", `Pedido de transmissão${who} — aceite ou recuse no painel`);
  broadcastUiState();
});

ipcMain.handle("present:respond", async (_e, accepted) => {
  const had = pendingPresent;
  pendingPresent = null;
  broadcastUiState();
  if (accepted && had) {
    await runStartShare();
    return { ok: true, started: true };
  }
  return { ok: true, started: false };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showPanel();
  });

  app.whenReady().then(async () => {
    scrubElectronStartMenuPoison();
    baseIcon = loadAppIcon();
    try {
      const caps = winPlatform.describe();
      // HighQoS / timeBeginPeriod só enquanto transmite (winTimer.setStreamingTimers)
      log.info("win platform", {
        build: caps.build,
        isWin11: caps.isWin11,
        wgcScreenCapturer: caps.wgcScreen ? "on" : "off",
        powerThrottlingOptOut: "on-transmit",
      });
    } catch (e) {
      log.warn("win platform init", e && e.message);
    }
    log.info("app ready", { version: APP_VERSION, packaged: app.isPackaged });
    const allowPerm = new Set(["media", "display-capture", "mediaKeySystem", "fullscreen"]);
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowPerm.has(String(perm)));
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
      cb(allowPerm.has(String(perm)));
    });
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      const cfg = readCfg() || {};
      const source = await resolveSource(cfg);
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source });
    });
    buildTray();
    registerShortcuts();
    try {
      await updater.checkForUpdates();
      updateTrayTooltip();
    } catch (e) {
      log.warn("update check", e && e.message);
    }
    try {
      const replacePath = updater.resolveReplacePath();
      if (replacePath) log.info("portable path", replacePath);
      updater.cleanupOnStartup();
    } catch (e) {
      log.warn("update cleanup", e && e.message);
    }
    openPanel();
    if (readCfg()) startWorker();
  });

  app.on("will-quit", () => {
    try { winTimer.shutdown(); } catch {}
    try { globalShortcut.unregisterAll(); } catch {}
  });

  app.on("before-quit", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    isQuitting = true;
    withTimeout(destroyWorkerGracefully(), 4000)
      .catch(() => {})
      .finally(() => {
        try { winTimer.shutdown(); } catch {}
        try { stopNativeAudioCapture(); } catch {}
        app.exit(0);
      });
  });

  app.on("window-all-closed", (e) => e.preventDefault());
}
