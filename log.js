const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const MAX_BYTES = 512 * 1024;
const RING = 200;
let logPath = null;
const ring = [];
const listeners = new Set();

function getLogPath() {
  if (logPath) return logPath;
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, "telador.log");
  } catch {
    logPath = path.join(__dirname, "telador.log");
  }
  return logPath;
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    const bak = file + ".1";
    try { fs.unlinkSync(bak); } catch {}
    fs.renameSync(file, bak);
  } catch {}
}

function write(level, msg, extra) {
  const line =
    new Date().toISOString() +
    " [" + level + "] " +
    String(msg || "") +
    (extra != null ? " " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "") +
    "\n";
  ring.push(line.trimEnd());
  if (ring.length > RING) ring.shift();
  for (const cb of listeners) {
    try { cb(line.trimEnd()); } catch {}
  }
  try {
    const file = getLogPath();
    rotateIfNeeded(file);
    fs.appendFileSync(file, line, "utf8");
  } catch {}
  try {
    if (level === "error") console.error("[telador]", msg, extra || "");
    else console.log("[telador]", msg, extra || "");
  } catch {}
}

function tail(n) {
  const count = Math.max(1, Math.min(RING, parseInt(n, 10) || 80));
  return ring.slice(-count);
}

function onLine(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function readTailFile(maxBytes) {
  try {
    const file = getLogPath();
    if (!fs.existsSync(file)) return "";
    const st = fs.statSync(file);
    const size = st.size;
    const want = Math.min(size, maxBytes || 24 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, Math.max(0, size - want));
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

module.exports = {
  info: (m, e) => write("info", m, e),
  warn: (m, e) => write("warn", m, e),
  error: (m, e) => write("error", m, e),
  path: getLogPath,
  tail,
  onLine,
  readTailFile,
};
