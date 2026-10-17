/** Gera icon.ico a partir de icon.png (Windows taskbar / electron-builder). */
const fs = require("fs");
const path = require("path");

async function main() {
  const root = path.join(__dirname, "..");
  const png = path.join(root, "icon.png");
  const ico = path.join(root, "icon.ico");
  if (!fs.existsSync(png)) {
    console.error("icon.png não encontrado");
    process.exit(1);
  }
  const mod = require("png-to-ico");
  const pngToIco = mod.default || mod;
  const buf = await pngToIco(png);
  fs.writeFileSync(ico, buf);
  console.log("wrote", ico, buf.length, "bytes");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
