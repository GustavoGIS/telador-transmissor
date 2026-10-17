const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telador", {
  getConfig: () => ipcRenderer.invoke("cfg:get"),
  saveConfig: (c) => ipcRenderer.invoke("cfg:save", c),
  patchConfig: (c) => ipcRenderer.invoke("cfg:patch", c),
  getLivekitUrl: () => ipcRenderer.invoke("livekit:url"),
  getUiState: () => ipcRenderer.invoke("ui:state"),
  listSources: (opts) => ipcRenderer.invoke("ui:sources", opts || {}),
  listSourceThumbs: () => ipcRenderer.invoke("ui:sourceThumbs"),
  selectSourceAndShare: (src) => ipcRenderer.invoke("ui:share", src),
  stopShare: () => ipcRenderer.invoke("ui:stop"),
  restartConnection: () => ipcRenderer.invoke("ui:restart"),
  setQuality: (idOrPayload) => ipcRenderer.invoke("ui:setQuality", idOrPayload),
  setTab: (tab) => ipcRenderer.invoke("ui:setTab", tab),
  checkUpdate: () => ipcRenderer.invoke("ui:checkUpdate"),
  checkUpdateFlow: () => ipcRenderer.invoke("ui:checkUpdateFlow"),
  applyUpdate: () => ipcRenderer.invoke("ui:applyUpdate"),
  openLogs: () => ipcRenderer.invoke("ui:openLogs"),
  quitApp: () => ipcRenderer.invoke("ui:quit"),
  preflight: (draft) => ipcRenderer.invoke("ui:preflight", draft || {}),
  testAudio: () => ipcRenderer.invoke("ui:testAudio"),
  diagnostic: () => ipcRenderer.invoke("ui:diagnostic"),
  firstRunSeen: () => ipcRenderer.invoke("ui:firstRunSeen"),
  openExternal: (url) => ipcRenderer.invoke("ui:openExternal", url),
  onUiState: (cb) => {
    const handler = (_e, state) => { try { cb(state); } catch {} };
    ipcRenderer.on("ui:state", handler);
    return () => { try { ipcRenderer.removeListener("ui:state", handler); } catch {} };
  },
  onConfirmQuit: (cb) => {
    const handler = () => { try { cb(); } catch {} };
    ipcRenderer.on("ui:confirm-quit", handler);
    return () => { try { ipcRenderer.removeListener("ui:confirm-quit", handler); } catch {} };
  },
  onSound: (cb) => {
    const handler = (_e, name) => { try { cb(name); } catch {} };
    ipcRenderer.on("ui:sound", handler);
    return () => { try { ipcRenderer.removeListener("ui:sound", handler); } catch {} };
  },
  log: (level, msg, extra) => ipcRenderer.send("log", { level, msg, extra }),
  setStatus: (s) => ipcRenderer.send("status", s),
  setShareState: (state) => ipcRenderer.send("share:state", state),
  setUiPhase: (phase, detail) => ipcRenderer.send("ui:phase", phase, detail),
  setAudioStatus: (ok) => ipcRenderer.send("audio:status", !!ok),
  setStats: (s) => ipcRenderer.send("stats:update", s || {}),
  gesture: () => ipcRenderer.send("gesture"),
  requestPresent: (info) => ipcRenderer.send("present:request", info || {}),
  respondPresent: (accepted) => ipcRenderer.invoke("present:respond", !!accepted),
  startNativeAudio: () => ipcRenderer.invoke("audio:start"),
  stopNativeAudio: () => ipcRenderer.invoke("audio:stop"),
  onNativePcm: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch {} };
    ipcRenderer.on("audio:pcm", handler);
    return () => { try { ipcRenderer.removeListener("audio:pcm", handler); } catch {} };
  },
});
