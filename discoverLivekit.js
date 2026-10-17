const https = require("https");
const log = require("./log");

const SITE = "https://telador.vercel.app";
/** Último host conhecido (fallback se o site mudar o asset hash). */
const FALLBACK = "wss://telador-fprg5who.livekit.cloud";

let cached = null;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Telador-Transmissor" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}

/**
 * Descobre o wss:// do LiveKit a partir do bundle público do Telador.
 * Assim o worker local não depende de VITE_* embutido.
 */
async function discoverLivekitUrl(preferred) {
  if (preferred && /^wss:\/\//i.test(preferred)) {
    cached = preferred;
    return preferred;
  }
  if (cached) return cached;
  try {
    const html = await fetchText(SITE + "/transmissor.html");
    const m = html.match(/src="(\/assets\/transmissor-[^"]+\.js)"/);
    if (!m) throw new Error("bundle não encontrado");
    const js = await fetchText(SITE + m[1]);
    const hosts = [...js.matchAll(/wss:\/\/[a-zA-Z0-9._-]+/g)].map((x) => x[0]);
    const uniq = [...new Set(hosts)];
    if (!uniq.length) throw new Error("host wss não encontrado");
    cached = uniq[0];
    log.info("livekit host discovered", cached);
    return cached;
  } catch (e) {
    log.warn("livekit discover failed, using fallback", e && e.message);
    cached = FALLBACK;
    return cached;
  }
}

module.exports = { discoverLivekitUrl, SITE, FALLBACK };
