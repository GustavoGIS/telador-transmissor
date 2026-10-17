/** Copia livekit-client ESM para worker/vendor (offline / sem CDN). */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "livekit-client", "dist", "livekit-client.esm.mjs");
const destDir = path.join(__dirname, "..", "worker", "vendor");
const dest = path.join(destDir, "livekit-client.esm.mjs");

if (!fs.existsSync(src)) {
  console.error("livekit-client não instalado. Rode: npm install");
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("vendored", dest, "(" + fs.statSync(dest).size + " bytes)");
