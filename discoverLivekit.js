const https = require("https");
const log = require("./log");

const SITE = "https://telador.vercel.app";
/** Fallback se o discovery do site falhar. */
const FALLBACK = "wss://telador2-r17fz9fd.livekit.cloud";

/** Hosts de projetos LiveKit antigos — nunca reutilizar do config. */
const STALE_HOSTS = new Set([
  "telador-fprg5who.livekit.cloud",
]);

let cached = null;

function hostOf(wssUrl) {
  try {
    return String(wssUrl || "")
      .replace(/^wss:\/\//i, "")
      .replace(/\/.*$/, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function isStaleUrl(wssUrl) {
  const h = hostOf(wssUrl);
  return !h || STALE_HOSTS.has(h);
}

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

async function discoverFromSite() {
  const html = await fetchText(SITE + "/transmissor.html");
  const m = html.match(/src="(\/assets\/transmissor-[^"]+\.js)"/);
  if (!m) throw new Error("bundle não encontrado");
  const js = await fetchText(SITE + m[1]);
  const hosts = [...js.matchAll(/wss:\/\/[a-zA-Z0-9._-]+/g)].map((x) => x[0]);
  const uniq = [...new Set(hosts)].filter((u) => !isStaleUrl(u));
  if (!uniq.length) throw new Error("host wss não encontrado");
  return uniq[0];
}

/**
 * Descobre o wss:// do LiveKit a partir do bundle público do Telador.
 * Sempre consulta o site (fonte da verdade). preferred/cache só se discovery falhar
 * e não for host antigo.
 */
async function discoverLivekitUrl(preferred) {
  try {
    const fromSite = await discoverFromSite();
    cached = fromSite;
    log.info("livekit host discovered", fromSite);
    return fromSite;
  } catch (e) {
    log.warn("livekit discover failed", e && e.message);
  }

  if (cached && !isStaleUrl(cached)) return cached;

  if (preferred && /^wss:\/\//i.test(preferred) && !isStaleUrl(preferred)) {
    cached = preferred;
    return preferred;
  }

  cached = FALLBACK;
  log.warn("livekit using fallback", FALLBACK);
  return FALLBACK;
}

function clearDiscoverCache() {
  cached = null;
}

module.exports = {
  discoverLivekitUrl,
  clearDiscoverCache,
  isStaleUrl,
  SITE,
  FALLBACK,
};
