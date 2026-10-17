/** Gera icon.ico a partir de icon.png (Windows taskbar / electron-builder). */
const fs = require("fs");
const path = require("path");

async function main() {
  const root = path.join(__dirname, "..");
  const png = path.join(root, "icon.png");
  const ico = path.join(root, "icon.ico");
  const panelPng = path.join(root, "panel", "icon.png");
  if (!fs.existsSync(png)) {
    console.error("icon.png não encontrado");
    process.exit(1);
  }
  // Cópia ao lado do HTML do painel — ../icon.png quebra no asar empacotado
  fs.copyFileSync(png, panelPng);
  console.log("wrote", panelPng);
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
