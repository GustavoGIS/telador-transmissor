/** Presets de qualidade compartilhados (main / painel via IPC). */
const PRESETS = {
  high: {
    id: "high",
    label: "Alta (1080p)",
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 10e6,
  },
  balanced: {
    id: "balanced",
    label: "Equilibrada (720p)",
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 4e6,
  },
  economy: {
    id: "economy",
    label: "Economia",
    width: 1280,
    height: 720,
    frameRate: 24,
    maxBitrate: 2e6,
  },
  custom: {
    id: "custom",
    label: "Personalizado",
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 4e6,
  },
};

function resolvePresetId(id) {
  if (id === "custom") return "custom";
  return PRESETS[id] ? id : "balanced";
}

function resolvePreset(id, custom) {
  const pid = resolvePresetId(id);
  if (pid === "custom" && custom && typeof custom === "object") {
    return {
      id: "custom",
      label: "Personalizado",
      width: Math.min(1920, Math.max(640, parseInt(custom.width, 10) || 1280)),
      height: Math.min(1080, Math.max(360, parseInt(custom.height, 10) || 720)),
      frameRate: Math.min(60, Math.max(15, parseInt(custom.frameRate, 10) || 30)),
      maxBitrate: Math.min(12e6, Math.max(1e6, parseInt(custom.maxBitrate, 10) || 4e6)),
    };
  }
  return PRESETS[pid] || PRESETS.balanced;
}

function listPresets() {
  return Object.values(PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
  }));
}

function toShareOpts(preset) {
  const p = resolvePreset(preset && preset.id ? preset.id : preset, preset);
  return {
    audio: true,
    systemAudio: "include",
    resolution: { width: p.width, height: p.height, frameRate: p.frameRate },
    // motion mantém fps; detail faz o encoder largar frames sob carga
    contentHint: "motion",
  };
}

function toPubOpts(preset) {
  const p = resolvePreset(preset && preset.id ? preset.id : preset, preset);
  return {
    videoCodec: "h264",
    simulcast: false,
    // framerate primeiro — maintain-resolution oscilava ~15–21fps em 1080p
    degradationPreference: "maintain-framerate",
    screenShareEncoding: {
      maxBitrate: p.maxBitrate,
      maxFramerate: p.frameRate,
      priority: "high",
    },
    dtx: false,
    red: false,
    forceStereo: true,
    audioBitrate: 256000,
  };
}

module.exports = {
  PRESETS,
  resolvePreset,
  resolvePresetId,
  listPresets,
  toShareOpts,
  toPubOpts,
};
