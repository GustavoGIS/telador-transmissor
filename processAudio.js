const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

let child = null;

/** ~20 ms @ 48 kHz stereo s16le (também serve em 44.1k com tamanho próximo). */
const EMIT_BYTES = 48000 * 2 * 2 / 50; // 3840

function exePath() {
  let p = path.join(__dirname, "native", "audio-exclude.exe");
  if (p.includes("app.asar")) {
    p = p.replace("app.asar", "app.asar.unpacked");
  }
  return p;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    } catch {}
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
}

function stop() {
  if (!child) return;
  const c = child;
  child = null;
  const pid = c.pid;
  try {
    c.stdout && c.stdout.removeAllListeners("data");
    c.stderr && c.stderr.removeAllListeners("data");
  } catch {}
  try { c.removeAllListeners("exit"); } catch {}
  try { c.removeAllListeners("error"); } catch {}
  killTree(pid);
  try {
    if (!c.killed) {
      if (process.platform === "win32") c.kill();
      else c.kill("SIGTERM");
    }
  } catch {}
}

/**
 * @param {string[]} args
 * @param {{ onPcm?: (buf: Buffer) => void, onLog?: (line: string) => void }} handlers
 * @returns {boolean}
 */
function start(args, handlers = {}) {
  stop();
  const exe = exePath();
  if (!fs.existsSync(exe)) {
    if (handlers.onLog) handlers.onLog("audio-exclude.exe missing: " + exe);
    return false;
  }

  child = spawn(exe, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let headerDone = false;
  let pending = Buffer.alloc(0);
  let pcmBuf = Buffer.alloc(0);

  const emitAligned = (chunk) => {
    if (!handlers.onPcm || !chunk || !chunk.length) return;
    pcmBuf = pcmBuf.length ? Buffer.concat([pcmBuf, chunk]) : chunk;
    const aligned = pcmBuf.length - (pcmBuf.length % 4);
    if (aligned <= 0) return;
    let offset = 0;
    while (aligned - offset >= EMIT_BYTES) {
      // Buffer próprio: main/IPC não precisa de Buffer.from extra
      const out = Buffer.allocUnsafe(EMIT_BYTES);
      pcmBuf.copy(out, 0, offset, offset + EMIT_BYTES);
      handlers.onPcm(out);
      offset += EMIT_BYTES;
    }
    const rest = aligned - offset;
    if (rest >= EMIT_BYTES / 2) {
      const out = Buffer.allocUnsafe(rest);
      pcmBuf.copy(out, 0, offset, offset + rest);
      handlers.onPcm(out);
      offset += rest;
    }
    pcmBuf = pcmBuf.subarray(offset);
  };

  child.stdout.on("data", (chunk) => {
    if (!handlers.onPcm) return;
    if (!headerDone) {
      pending = Buffer.concat([pending, chunk]);
      const idx = pending.indexOf(0x0a);
      if (idx < 0) return;
      headerDone = true;
      const rest = pending.slice(idx + 1);
      pending = Buffer.alloc(0);
      emitAligned(rest);
      return;
    }
    emitAligned(chunk);
  });

  child.stderr.on("data", (d) => {
    if (handlers.onLog) handlers.onLog(String(d));
  });

  child.on("error", (err) => {
    if (handlers.onLog) handlers.onLog(String(err && err.message ? err.message : err));
    child = null;
  });

  child.on("exit", () => {
    child = null;
  });

  return true;
}

/** @param {{ sourceType?: string, sourceId?: string }} cfg */
function argsForConfig(cfg) {
  if (cfg && cfg.sourceType === "window" && cfg.sourceId) {
    const m = /^window:(\d+)/i.exec(String(cfg.sourceId));
    if (m) return ["hwnd", m[1]];
  }
  return ["exclude"];
}

module.exports = { start, stop, argsForConfig, exePath };
