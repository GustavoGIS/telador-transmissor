const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
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

function updatesDir() {
  return path.join(app.getPath("userData"), "updates");
}

/** Caminho real do portable que o usuário abriu (ex.: Área de trabalho\...\0.2.5.exe). */
function getPortableLaunchPath() {
  try {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portable && typeof portable === "string" && fs.existsSync(portable)) {
      return path.resolve(portable);
    }
  } catch {}
  return null;
}

/**
 * Onde substituir: SEMPRE o portable lançado.
 * Fallback: exe empacotado fora de %TEMP% (não portable).
 */
function resolveReplacePath() {
  const portable = getPortableLaunchPath();
  if (portable) return portable;
  try {
    if (app.isPackaged && process.execPath) {
      const exec = path.resolve(process.execPath);
      const temp = path.resolve(app.getPath("temp"));
      if (!exec.toLowerCase().startsWith(temp.toLowerCase() + path.sep)) {
        return exec;
      }
    }
  } catch {}
  return null;
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apaga downloads antigos em userData/updates e outros
 * Telador-Transmissor-*.exe na mesma pasta do portable (exceto o ativo).
 */
function cleanupOldArtifacts(keepPaths) {
  const keep = new Set(
    (keepPaths || []).filter(Boolean).map((p) => path.resolve(p).toLowerCase())
  );
  const removed = [];

  const sweepDir = (dir, { onlyAssets = true } = {}) => {
    if (!dir || !fs.existsSync(dir)) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (onlyAssets && !ASSET_RE.test(name)) continue;
      const full = path.resolve(dir, name);
      if (keep.has(full.toLowerCase())) continue;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        fs.unlinkSync(full);
        removed.push(full);
      } catch (e) {
        log.warn("cleanup skip", { full, err: e && e.message });
      }
    }
  };

  try {
    sweepDir(updatesDir());
  } catch {}

  try {
    const replacePath = resolveReplacePath();
    if (replacePath) sweepDir(path.dirname(replacePath));
  } catch {}

  // Pasta canônica antiga (versões intermediárias do updater) — limpar se existir
  try {
    const legacyDir = path.join(
      process.env.LOCALAPPDATA || app.getPath("appData"),
      "TeladorTransmissor"
    );
    if (fs.existsSync(legacyDir)) {
      sweepDir(legacyDir);
      try {
        const left = fs.readdirSync(legacyDir);
        if (!left.length) fs.rmdirSync(legacyDir);
      } catch {}
    }
  } catch {}

  if (removed.length) log.info("cleanup old artifacts", { count: removed.length, removed });
  return removed;
}

/**
 * Substitui o .exe portable no caminho em que está, verifica o arquivo,
 * limpa restos e relança o mesmo caminho.
 * Usa PowerShell oculto (sem janela preta com "find").
 */
function applyDownloaded(exePath) {
  const downloaded = path.resolve(exePath);
  if (!fs.existsSync(downloaded)) {
    throw new Error("Arquivo de update não encontrado");
  }

  const replacePath = resolveReplacePath();
  log.info("applying update", {
    downloaded,
    replacePath: replacePath || "(none)",
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE || "",
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR || "",
  });

  if (!replacePath) {
    cleanupOldArtifacts([downloaded]);
    spawn(downloaded, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => {
      try { app.exit(0); } catch {}
    }, 400);
    return true;
  }

  const pid = process.pid;
  const tmp = app.getPath("temp");
  const ps1Path = path.join(tmp, `telador-update-${pid}-${Date.now()}.ps1`);
  const verifyPath = path.join(tmp, `telador-update-verify-${pid}.txt`);
  const expectedSize = (() => {
    try { return fs.statSync(downloaded).size; } catch { return 0; }
  })();
  const replaceDir = path.dirname(replacePath);
  const keepName = path.basename(replacePath);
  const updates = updatesDir();
  const legacyDir = path.join(process.env.LOCALAPPDATA || "", "TeladorTransmissor");

  const ps = `
$ErrorActionPreference = 'Continue'
$pidWait = ${pid}
$downloaded = ${JSON.stringify(downloaded)}
$replacePath = ${JSON.stringify(replacePath)}
$replaceDir = ${JSON.stringify(replaceDir)}
$keepName = ${JSON.stringify(keepName)}
$updatesDir = ${JSON.stringify(updates)}
$legacyDir = ${JSON.stringify(legacyDir)}
$verifyPath = ${JSON.stringify(verifyPath)}
$expectedSize = ${expectedSize}
$self = $MyInvocation.MyCommand.Path

# Espera o app atual encerrar (sem tasklist/find na tela)
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
  $alive = Get-Process -Id $pidWait -ErrorAction SilentlyContinue
  if (-not $alive) { break }
  Start-Sleep -Milliseconds 400
}
Start-Sleep -Seconds 1

# Mata restos na bandeja
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match '^(Telador Transmissor|Telador-Transmissor)$' } |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

function Start-Fallback {
  try { Start-Process -FilePath $downloaded } catch {}
}

try {
  Copy-Item -LiteralPath $downloaded -Destination $replacePath -Force
} catch {
  Set-Content -LiteralPath $verifyPath -Value 'COPY_FAIL' -Encoding ascii
  Start-Fallback
  if (Test-Path -LiteralPath $self) { Remove-Item -LiteralPath $self -Force -ErrorAction SilentlyContinue }
  exit 1
}

if ($expectedSize -gt 0) {
  $sz = (Get-Item -LiteralPath $replacePath).Length
  if ($sz -ne $expectedSize) {
    Set-Content -LiteralPath $verifyPath -Value ("SIZE_FAIL " + $sz) -Encoding ascii
    Start-Fallback
    if (Test-Path -LiteralPath $self) { Remove-Item -LiteralPath $self -Force -ErrorAction SilentlyContinue }
    exit 1
  }
}

Set-Content -LiteralPath $verifyPath -Value 'OK' -Encoding ascii

# Limpa staging e outros portables antigos na mesma pasta
if (Test-Path -LiteralPath $updatesDir) {
  Get-ChildItem -LiteralPath $updatesDir -Filter 'Telador-Transmissor-*.exe' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
Get-ChildItem -LiteralPath $replaceDir -Filter 'Telador-Transmissor-*.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ine $keepName } |
  Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $legacyDir) {
  Get-ChildItem -LiteralPath $legacyDir -Filter 'Telador-Transmissor*.exe' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

try { Start-Process -FilePath $replacePath } catch { Start-Fallback }
if (Test-Path -LiteralPath $self) { Remove-Item -LiteralPath $self -Force -ErrorAction SilentlyContinue }
`.trim();

  fs.writeFileSync(ps1Path, ps, "utf8");

  // -WindowStyle Hidden evita a janela preta; windowsHide reforça no spawn
  spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", ps1Path,
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }
  ).unref();

  setTimeout(() => {
    try { app.exit(0); } catch {}
  }, 500);
  return true;
}

/** Limpeza leve na abertura (não apaga o portable ativo). */
function cleanupOnStartup() {
  try {
    const keep = [getPortableLaunchPath(), resolveReplacePath()].filter(Boolean);
    // Só limpa userData/updates e pasta legada — NÃO varre a Área de trabalho
    // (pode haver cópias intencionais). Desktop só limpa no apply pós-update.
    const removed = [];
    const dir = updatesDir();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!ASSET_RE.test(name)) continue;
        const full = path.join(dir, name);
        if (keep.some((k) => path.resolve(k).toLowerCase() === path.resolve(full).toLowerCase())) {
          continue;
        }
        if (safeUnlink(full)) removed.push(full);
      }
    }
    const legacyDir = path.join(
      process.env.LOCALAPPDATA || app.getPath("appData"),
      "TeladorTransmissor"
    );
    if (fs.existsSync(legacyDir)) {
      for (const name of fs.readdirSync(legacyDir)) {
        if (!ASSET_RE.test(name) && name !== "Telador-Transmissor.exe") continue;
        const full = path.join(legacyDir, name);
        if (safeUnlink(full)) removed.push(full);
      }
      try {
        if (!fs.readdirSync(legacyDir).length) fs.rmdirSync(legacyDir);
      } catch {}
    }
    if (removed.length) log.info("startup cleanup", { count: removed.length });
    return removed;
  } catch (e) {
    log.warn("startup cleanup", e && e.message);
    return [];
  }
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
    log.info("update available", {
      version,
      digest: latestInfo.digest ? "yes" : "no",
      replacePath: resolveReplacePath() || "(unknown)",
    });
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
    const dir = updatesDir();
    fs.mkdirSync(dir, { recursive: true });
    // Limpa staging antigo antes de baixar o novo
    try {
      for (const f of fs.readdirSync(dir)) {
        if (ASSET_RE.test(f) && f !== latestInfo.name) {
          safeUnlink(path.join(dir, f));
        }
      }
    } catch {}
    const dest = path.join(dir, latestInfo.name);
    log.info("downloading update", dest);
    const { sha256 } = await downloadFile(latestInfo.url, dest, onProgress);
    if (latestInfo.digest) {
      if (sha256 !== latestInfo.digest) {
        safeUnlink(dest);
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

module.exports = {
  checkForUpdates,
  getLatest,
  downloadLatest,
  applyUpdateAndRelaunch,
  getPortableLaunchPath,
  resolveReplacePath,
  cleanupOnStartup,
  cleanupOldArtifacts,
};
