// src/lib/formatter.js
function formatResult(raw, profile, opts = {}) {
  const date = raw.date instanceof Date ? raw.date : new Date(raw.date || 0);
  const hash = String(raw.hash || "").toLowerCase().trim();
  if (!hash || hash.length < 20) return null;
  const title = String(raw.title || "").trim();
  if (!title) return null;
  const size = Number(raw.size) || 0;
  if (size < 1e4) return null;
  if (profile.fileSizeCap && size > profile.fileSizeCap) return null;
  const link = opts.useMagnetRaw ? raw.link : buildMagnet(hash, title);
  const tracker = String(raw.tracker || profile.name || "").trim();
  const type = opts.type || (opts.batch ? "batch" : opts.movie ? "movie" : void 0);
  return {
    title,
    size,
    tracker: tracker || "",
    uploader: String(raw.uploader || ""),
    date,
    link,
    hash,
    seeders: Math.max(0, Number(raw.seeders) || 0),
    leechers: Math.max(0, Number(raw.leechers) || 0),
    downloads: Math.max(0, Number(raw.downloads) || 0),
    accuracy: raw.accuracy || profile.accuracy || "medium",
    type: type || void 0,
    // Metadata fields extracted from title by the parser
    codec: String(raw.codec || ""),
    source: String(raw.sourceTag || ""),
    resolution: raw.resolution || null,
    releaseGroup: String(raw.releaseGroup || ""),
    isDualAudio: !!raw.isDualAudio,
    isDub: !!raw.isDub,
    subtitleLanguages: Array.isArray(raw.subtitleLanguages) ? raw.subtitleLanguages : [],
    spokenLanguages: Array.isArray(raw.spokenLanguages) ? raw.spokenLanguages : []
  };
}
var SOURCE_PROFILES = {
  nyaa: { name: "Nyaa", accuracy: "medium", parserConfidence: 0.8, earlyExit: 20 },
  animetosho: { name: "AnimeTosho", accuracy: "high", parserConfidence: 1, earlyExit: 50 },
  seadex: { name: "Seadex", accuracy: "high", parserConfidence: 0.98, earlyExit: 200 },
  subsplease: { name: "SubsPlease", accuracy: "high", parserConfidence: 0.99, earlyExit: 200 },
  yameii: { name: "Yameii", accuracy: "high", parserConfidence: 0.85, earlyExit: 10 },
  toonshub: { name: "ToonsHub", accuracy: "high", parserConfidence: 0.85, earlyExit: 10 }
};

// src/lib/prefs.js
var DEFAULTS = {
  preferredResolution: ["1080"],
  preferredCodec: [],
  preferredGroups: [],
  avoidGroups: [],
  preferredAudio: [],
  preferredSubtitles: ["en"],
  preferDualAudio: false,
  preferDub: true,
  allowRaw: false,
  preferBatch: false,
  fallbackToBatch: true,
  preferredSource: [],
  avoidBluRay: true,
  maxResults: 9,
  exclusions: [],
  maxFileSizeMB: 0
};
function resolve(user = {}) {
  return { ...DEFAULTS, ...user };
}
var CONFIG_SCHEMA = {
  preferredResolution: { label: "Preferred Resolution", type: "multi", options: ["2160", "1080", "720", "480"], default: ["1080"] },
  preferredCodec: { label: "Preferred Codec", type: "multi", options: ["hevc", "av1", "vp9", "avc", "x264", "x265"], default: [] },
  preferredGroups: { label: "Preferred Groups", type: "text", placeholder: "SubsPlease, Erai-raws, Judas", default: [] },
  avoidGroups: { label: "Avoid Groups", type: "text", placeholder: "SSA, Mini", default: [] },
  preferredAudio: { label: "Audio languages", type: "multi", options: ["ja", "en", "pt-BR", "es-419", "fr", "de", "it", "ru", "ko", "zh", "ar"], default: [] },
  preferredSubtitles: { label: "Subtitle languages", type: "multi", options: ["en", "es", "pt-BR", "fr", "de", "it", "ru", "ar", "ja", "ko", "zh"], default: ["en"] },
  preferDualAudio: { label: "Prefer Dual Audio", type: "boolean", default: false },
  preferDub: { label: "Prioritise English Dubs", type: "boolean", default: true },
  allowRaw: { label: "Allow raw (no subs)", type: "boolean", default: false },
  avoidBluRay: { label: "Avoid Blu-ray / Remux (large files)", type: "boolean", default: true },
  preferBatch: { label: "Prefer batches", type: "boolean", default: false },
  fallbackToBatch: { label: "Fallback to batch", type: "boolean", default: true },
  preferredSource: { label: "Preferred source", type: "multi", options: ["bd", "remux", "web-dl", "web", "bluray", "hdtv"], default: [] },
  maxResults: { label: "Max results", type: "integer", default: 9, hint: "max shown (0 = unlimited)" },
  exclusions: { label: "Exclude keywords", type: "text", placeholder: "pulp, shit, bad", default: [] },
  maxFileSizeMB: { label: "Max file size (MB)", type: "integer", default: 0, hint: "0 = no limit" }
};

// src/lib/shared.js
var TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "http://nyaa.tracker.wf:7777/announce"
];
function buildMagnet(hash, name) {
  const trackers = TRACKERS.map((t) => "tr=" + encodeURIComponent(t)).join("&");
  const dn = name ? "&dn=" + encodeURIComponent(name) : "";
  return "magnet:?xt=urn:btih:" + String(hash).toLowerCase() + dn + "&" + trackers;
}

// src/lib/config.js
function configSchema() {
  return CONFIG_SCHEMA;
}
function configDefaults() {
  return DEFAULTS;
}
function getInstallUrl(baseUrl, prefs) {
  const merged = resolve(prefs);
  const encoded = btoa(JSON.stringify(merged));
  const sep = baseUrl.includes("?") ? "&" : "?";
  return baseUrl + sep + "c=" + encoded;
}

// src/seadex.js
var PROFILE = SOURCE_PROFILES.seadex;
var BASE = "https://releases.moe/api/collections/entries/records";
function totalSize(files) {
  if (!Array.isArray(files)) return 0;
  let s = 0;
  for (const f of files) {
    const len = Number(f && f.length);
    if (Number.isFinite(len)) s += len;
  }
  return s;
}
function firstFilename(files) {
  if (!Array.isArray(files) || !files.length) return "";
  const f = files.find((x) => x && x.name);
  return f ? f.name : "";
}
function cleanReleaseTitle(filename) {
  if (!filename) return "";
  return filename.replace(/\s*-?\s*S\d{1,2}E\d{1,3}(?:v\d)?\b/gi, "").replace(/\s+-\s+\d{1,4}(?:v\d)?\b/g, "").replace(/\.(mkv|mp4|avi|m2ts|webm)$/i, "").replace(/\s+/g, " ").trim();
}
function isBatchRelease(files) {
  if (!Array.isArray(files)) return false;
  const videoFiles = files.filter((f) => f && f.name && /\.(mkv|mp4|avi|m2ts|webm)$/i.test(f.name));
  if (videoFiles.length > 1) return true;
  return totalSize(files) > 10 * 1024 ** 3;
}
async function fetchByAnilist(anilistId) {
  const url = BASE + "?expand=trs&perPage=10&filter=" + encodeURIComponent("(alID=" + Number(anilistId) + ")");
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error("Cannot reach Seadex. Check your internet connection or try again later.");
  }
  if (!res.ok) {
    throw new Error("Seadex returned HTTP " + res.status + ". The service may be down.");
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error("Seadex returned an unexpected response.");
  }
  if (!data || !Array.isArray(data.items)) return [];
  return data.items;
}
function flattenTrs(items) {
  const out = [];
  for (const entry of items) {
    const trs = entry && entry.expand && entry.expand.trs;
    if (!Array.isArray(trs)) continue;
    for (const tr of trs) {
      if (!tr || !tr.infoHash) continue;
      out.push(tr);
    }
  }
  return out;
}
function toResult(tr) {
  const hash = String(tr.infoHash || "").toLowerCase();
  if (!hash) return null;
  const cleanName = cleanReleaseTitle(firstFilename(tr.files));
  const group = tr.releaseGroup ? "[" + tr.releaseGroup + "] " : "";
  const dual = tr.dualAudio ? " (Dual Audio)" : "";
  const title = group + (cleanName || tr.releaseGroup || "release") + dual;
  const batch = isBatchRelease(tr.files);
  return formatResult({
    title,
    hash,
    link: hash,
    seeders: 0,
    leechers: 0,
    downloads: 0,
    size: totalSize(tr.files),
    date: tr.created ? new Date(tr.created) : /* @__PURE__ */ new Date(),
    uploader: tr.releaseGroup || "",
    tracker: PROFILE.name,
    accuracy: "high"
  }, PROFILE, { type: tr.isBest ? "best" : batch ? "batch" : "alt" });
}
async function search(query) {
  if (!query || !query.anilistId) return [];
  const items = await fetchByAnilist(query.anilistId);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const tr of flattenTrs(items)) {
    const r = toResult(tr);
    if (!r || seen.has(r.hash)) continue;
    seen.add(r.hash);
    out.push(r);
  }
  return out;
}
var seadex_default = new class Seadex {
  async single(query) {
    return search(query);
  }
  async batch(query) {
    return search(query);
  }
  async movie(query) {
    return search(query);
  }
  async test() {
    let res;
    try {
      res = await fetch(BASE + "?perPage=1");
    } catch (err) {
      throw new Error("Cannot reach Seadex. Check your internet connection or try again later.");
    }
    if (!res.ok) {
      throw new Error("Seadex returned HTTP " + res.status + ". The service may be down.");
    }
    return true;
  }
  config() {
    return configSchema();
  }
  defaults() {
    return configDefaults();
  }
  installUrl(baseUrl, prefs) {
    return getInstallUrl(baseUrl, prefs);
  }
}();
export {
  seadex_default as default
};
