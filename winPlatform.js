/**
 * Capacidades / versão do Windows para ligar features só onde são seguras.
 */
"use strict";

const os = require("os");

/** Build number (ex.: 26200). Win11 começa em 22000; 24H2 em 26100. */
function windowsBuild() {
  if (process.platform !== "win32") return 0;
  try {
    const parts = String(os.release() || "").split(".");
    const build = parseInt(parts[2], 10);
    return Number.isFinite(build) ? build : 0;
  } catch (e) {
    return 0;
  }
}

function isWindows11OrNewer() {
  return windowsBuild() >= 22000;
}

/**
 * Chromium só passa a preferir WGC para captura de *tela* no 24H2+ (build ≥ 26100),
 * por suporte a 0 Hz / HDR. Em builds mais antigas forçar WGC de screen pode piorar.
 * Em Win10 < 20H1 (19041) a API nem cobre tela virtual direito — Chromium faz fallback,
 * mas evitamos pedir a feature.
 */
function shouldEnableWgcScreenCapturer() {
  return windowsBuild() >= 26100;
}

/** Features Chromium seguras neste host (sempre as de encode; WGC só se elegível). */
function chromiumEnableFeatures() {
  const features = [
    "PlatformH264CbpEncoding",
    "MediaFoundationH264CbpEncoding",
    "CanvasOopRasterization",
  ];
  if (shouldEnableWgcScreenCapturer()) {
    features.push("AllowWgcScreenCapturer");
  }
  return features;
}

function describe() {
  const build = windowsBuild();
  return {
    build,
    isWin11: isWindows11OrNewer(),
    wgcScreen: shouldEnableWgcScreenCapturer(),
  };
}

module.exports = {
  windowsBuild,
  isWindows11OrNewer,
  shouldEnableWgcScreenCapturer,
  chromiumEnableFeatures,
  describe,
};
