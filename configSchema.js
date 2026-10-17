/** Schema / normalização do config.json do transmissor. */
const quality = require("./quality");

const DEFAULTS = {
  name: "",
  key: "",
  sourceId: "",
  sourceName: "",
  sourceType: "screen",
  sourceTab: "screen",
  resumeShare: false,
  livekitUrl: "",
  qualityPreset: "balanced",
  customQuality: null,
  roomHistory: [],
  windowBounds: null,
  firstRunSeen: false,
  trayClickAction: "panel", // panel | lastSource
};

function asString(v) {
  return v == null ? "" : String(v);
}

function asBool(v, fallback) {
  if (v == null) return !!fallback;
  return !!v;
}

function normalizeCustom(raw) {
  if (!raw || typeof raw !== "object") return null;
  const width = Math.min(1920, Math.max(640, parseInt(raw.width, 10) || 1920));
  const height = Math.min(1080, Math.max(360, parseInt(raw.height, 10) || 1080));
  const frameRate = Math.min(60, Math.max(15, parseInt(raw.frameRate, 10) || 60));
  const maxBitrate = Math.min(20e6, Math.max(1e6, parseInt(raw.maxBitrate, 10) || 14e6));
  return { width, height, frameRate, maxBitrate };
}

function normalizeBounds(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = parseInt(raw.x, 10);
  const y = parseInt(raw.y, 10);
  const width = parseInt(raw.width, 10);
  const height = parseInt(raw.height, 10);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (width < 640 || height < 480) return null;
  return {
    x,
    y,
    width,
    height,
    isMaximized: !!raw.isMaximized,
  };
}

function normalize(partial, prev) {
  const base = Object.assign({}, DEFAULTS, prev || {}, partial || {});
  const sourceType = base.sourceType === "window" ? "window" : "screen";
  const sourceTab = base.sourceTab === "window" || sourceType === "window" ? "window" : "screen";
  let roomHistory = Array.isArray(base.roomHistory)
    ? base.roomHistory.map(asString).filter(Boolean)
    : [];
  const key = asString(base.key).trim();
  if (partial && partial.key != null && key) {
    roomHistory = [key, ...roomHistory.filter((k) => k !== key)].slice(0, 8);
  } else {
    roomHistory = roomHistory.slice(0, 8);
  }
  const qualityPreset = quality.resolvePresetId(base.qualityPreset);
  return {
    name: asString(base.name).trim(),
    key,
    sourceId: asString(base.sourceId),
    sourceName: asString(base.sourceName),
    sourceType,
    sourceTab,
    resumeShare: asBool(base.resumeShare, false),
    livekitUrl: asString(base.livekitUrl).trim(),
    qualityPreset,
    customQuality: qualityPreset === "custom" ? normalizeCustom(base.customQuality) : normalizeCustom(base.customQuality),
    roomHistory,
    windowBounds: normalizeBounds(base.windowBounds),
    firstRunSeen: asBool(base.firstRunSeen, false),
    trayClickAction: base.trayClickAction === "lastSource" ? "lastSource" : "panel",
  };
}

function exportSafe(cfg) {
  const c = normalize({}, cfg || {});
  return {
    name: c.name,
    key: c.key,
    sourceId: c.sourceId,
    sourceName: c.sourceName,
    sourceType: c.sourceType,
    sourceTab: c.sourceTab,
    qualityPreset: c.qualityPreset,
    customQuality: c.customQuality,
    livekitUrl: c.livekitUrl,
    roomHistory: c.roomHistory,
  };
}

function importSafe(raw) {
  if (!raw || typeof raw !== "object") throw new Error("JSON inválido");
  return normalize(raw, {});
}

module.exports = {
  DEFAULTS,
  normalize,
  exportSafe,
  importSafe,
  normalizeCustom,
};
