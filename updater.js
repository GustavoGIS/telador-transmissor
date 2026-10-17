const { app, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const log = require("./log");

const REPO = "GustavoGIS/telador-transmissor";
const ASSET_RE = /^Telador-Transmissor-.*\.exe$/i;

let latestInfo = null;
let downloading = false;

function parseVer(v) {
  return String(v || "")
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
}

function isNewer(remote, local) {
  const a = parseVer(remote);
  const b = parseVer(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Telador-Transmissor",
        Accept: "application/vnd.github+json",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        getJson(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      try { req.destroy(); } catch {}
      reject(new Error("timeout"));
    });
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": "Telador-Transmissor" },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      let got = 0;
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(dest);
      res.on("data", (c) => {
        got += c.length;
        hash.update(c);
        if (onProgress && total) onProgress(got / total);
      });
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve({ dest, sha256: hash.digest("hex") })));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
}

function normalizeDigest(d) {
  if (!d) return "";
  const s = String(d).trim().toLowerCase();
  const m = s.match(/^(?:sha256:)?([a-f0-9]{64})$/);
  return m ? m[1] : "";
}

async function checkForUpdates() {
  try {
    const data = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!data || data.message) {
      log.warn("update check failed", data && data.message);
      return null;
    }
    const tag = String(data.tag_name || "");
    const version = tag.replace(/^v/i, "");
    const asset = (data.assets || []).find((a) => ASSET_RE.test(a.name));
    if (!asset || !asset.browser_download_url) return null;
    if (!isNewer(version, app.getVersion())) {
      latestInfo = null;
      return null;
    }
    latestInfo = {
      version,
      tag,
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size || 0,
      digest: normalizeDigest(asset.digest),
      notes: String(data.body || "").slice(0, 2000),
      htmlUrl: String(data.html_url || `https://github.com/${REPO}/releases/tag/${tag}`),
    };
    log.info("update available", { version, digest: latestInfo.digest ? "yes" : "no" });
    return latestInfo;
  } catch (e) {
    log.warn("update check error", e && e.message);
    return null;
  }
}

function getLatest() {
  return latestInfo;
}

async function downloadLatest(onProgress) {
  if (!latestInfo) await checkForUpdates();
  if (!latestInfo) throw new Error("Nenhuma atualização");
  if (downloading) throw new Error("Download já em andamento");
  downloading = true;
  try {
    const dir = path.join(app.getPath("userData"), "updates");
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const f of fs.readdirSync(dir)) {
        if (ASSET_RE.test(f) && f !== latestInfo.name) {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        }
      }
    } catch {}
    const dest = path.join(dir, latestInfo.name);
    log.info("downloading update", dest);
    const { sha256 } = await downloadFile(latestInfo.url, dest, onProgress);
    if (latestInfo.digest) {
      if (sha256 !== latestInfo.digest) {
        try { fs.unlinkSync(dest); } catch {}
        throw new Error("Hash SHA-256 não confere — download corrompido");
      }
      log.info("update hash ok");
    } else {
      log.warn("update sem digest no GitHub — pulando verificação");
    }
    latestInfo.localPath = dest;
    latestInfo.localSha256 = sha256;
    return dest;
  } finally {
    downloading = false;
  }
}

async function applyUpdateAndRelaunch() {
  const p = latestInfo && latestInfo.localPath;
  if (!p || !fs.existsSync(p)) {
    const dest = await downloadLatest();
    return applyDownloaded(dest);
  }
  return applyDownloaded(p);
}

function applyDownloaded(exePath) {
  log.info("applying update", exePath);
  try {
    shell.openPath(exePath);
  } catch (e) {
    log.error("open update failed", e && e.message);
    throw e;
  }
  setTimeout(() => {
    try { app.quit(); } catch {}
  }, 500);
  return true;
}

module.exports = {
  checkForUpdates,
  getLatest,
  downloadLatest,
  applyUpdateAndRelaunch,
};
