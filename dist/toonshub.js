// src/lib/resolver.js
var ANILIST_API = "https://graphql.anilist.co";
var TV_FORMATS = /* @__PURE__ */ new Set(["TV", "TV_SHORT", "ONA"]);
var MOVIE_FORMATS = /* @__PURE__ */ new Set(["MOVIE"]);
var SPECIAL_FORMATS = /* @__PURE__ */ new Set(["SPECIAL", "OVA", "ONA"]);
var cache = /* @__PURE__ */ new Map();
function gql(query, variables) {
  return httpGet(ANILIST_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables })
  }).then((res) => res.ok ? res.json() : null).catch(() => null);
}
function branchTokens(titles) {
  const out = /* @__PURE__ */ new Set();
  for (const t of titles || []) {
    for (const tok of String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (tok.length >= 3) out.add(tok);
    }
  }
  return out;
}
function franchiseRoot(titles) {
  if (!titles || !titles.length) return "";
  const shortest = titles.slice().sort((a, b) => a.length - b.length)[0];
  return String(shortest).replace(/\s*:\s*.*/, "").replace(/\bseason\s*\d+\b/gi, "").replace(/\b\d+(st|nd|rd|th)\s+season\b/gi, "").replace(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/gi, "").replace(/\b(19|20)\d{2}\b/g, "").replace(/[^a-z0-9]+/gi, " ").trim();
}
function toBranch(media, seasonGuess) {
  const titles = [
    media?.title?.romaji,
    media?.title?.english,
    media?.title?.native,
    ...media?.synonyms || []
  ].filter(Boolean);
  return {
    anilist: media?.id,
    idMal: media?.idMal || null,
    anidb: null,
    // filled later from animetosho mapping if available
    format: media?.format || null,
    type: media?.type || "ANIME",
    seasonInFranchise: seasonGuess || 1,
    episodeCount: media?.episodes || null,
    startDate: media?.startDate || null,
    titles,
    franchiseRoot: franchiseRoot(titles),
    tokens: branchTokens(titles)
  };
}
async function resolveCanonical(anilistId) {
  const id = Number(anilistId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const key = String(id);
  if (cache.has(key)) return cache.get(key);
  cache.set(key, (async () => {
    const visited = /* @__PURE__ */ new Set();
    const branches = [];
    let queue = [{ id, depth: 0 }];
    const seed = await gql(
      "query($id:Int){Media(id:$id,type:ANIME){id idMal format episodes startDate{year month day} title{romaji english native} synonyms}}",
      { id }
    );
    if (!seed?.data?.Media) return null;
    branches.push(toBranch(seed.data.Media, 1));
    visited.add(id);
    while (queue.length) {
      const next = [];
      for (const { id: cur, depth } of queue) {
        if (depth >= 2) continue;
        const r = await gql(
          "query($id:Int){Media(id:$id,type:ANIME){id idMal format episodes startDate{year month day} title{romaji english native} synonyms relations{edges{relationType}relations:edges{node{id idMal type format episodes startDate{year month day} title{romaji english native} synonyms}}}}}",
          { id: cur }
        );
        const edges = r?.data?.Media?.relations?.relations || [];
        for (const e of edges) {
          const sib = e?.node;
          if (!sib || sib.type !== "ANIME") continue;
          if (visited.has(sib.id)) continue;
          visited.add(sib.id);
          branches.push(toBranch(sib, 1));
          if (depth + 1 < 2) next.push({ id: sib.id, depth: depth + 1 });
        }
      }
      queue = next;
    }
    await annotateTvChain(branches, id);
    const franchiseRoot2 = pickFranchiseRoot(branches, id);
    return {
      anilist: id,
      titles: branches[0].titles,
      franchiseRoot: franchiseRoot2,
      branches,
      seedAnilist: id,
      // Per-branch quick lookup tables reused by filters.
      byFormat: {
        tv: branches.filter((b) => TV_FORMATS.has(b.format)),
        movie: branches.filter((b) => MOVIE_FORMATS.has(b.format)),
        special: branches.filter((b) => SPECIAL_FORMATS.has(b.format))
      }
    };
  })());
  return cache.get(key);
}
async function annotateTvChain(branches, seedId) {
  const byId = new Map(branches.map((b) => [b.anilist, b]));
  const seed = byId.get(seedId);
  if (!seed || !TV_FORMATS.has(seed.format)) return;
  let cursor = seedId;
  let backCount = 0;
  const seen = /* @__PURE__ */ new Set([seedId]);
  while (backCount < 12) {
    const r = await gql(
      "query($id:Int){Media(id:$id,type:ANIME){id format relations{edges{relationType node{id format}}}}}",
      { id: cursor }
    );
    const prequel = (r?.data?.Media?.relations?.edges || []).find((e) => e.relationType === "PREQUEL" && TV_FORMATS.has(e.node?.format) && !seen.has(e.node.id));
    if (!prequel) break;
    seen.add(prequel.node.id);
    cursor = prequel.node.id;
    backCount++;
    const b = byId.get(prequel.node.id);
    if (b) b.seasonInFranchise = b.seasonInFranchise || 1;
  }
  seed.seasonInFranchise = backCount + 1;
  cursor = seedId;
  let fwdCount = 0;
  const seenF = /* @__PURE__ */ new Set([seedId]);
  while (fwdCount < 12) {
    const r = await gql(
      "query($id:Int){Media(id:$id,type:ANIME){id format relations{edges{relationType node{id format}}}}}",
      { id: cursor }
    );
    const sequel = (r?.data?.Media?.relations?.edges || []).find((e) => e.relationType === "SEQUEL" && TV_FORMATS.has(e.node?.format) && !seenF.has(e.node.id));
    if (!sequel) break;
    seenF.add(sequel.node.id);
    cursor = sequel.node.id;
    fwdCount++;
    const b = byId.get(sequel.node.id);
    if (b) b.seasonInFranchise = seed.seasonInFranchise + fwdCount;
  }
}
function pickFranchiseRoot(branches, seedId) {
  const seed = branches.find((b) => b.anilist === seedId);
  if (seed && seed.franchiseRoot) return seed.franchiseRoot;
  const counts = /* @__PURE__ */ new Map();
  for (const b of branches) {
    if (!b.franchiseRoot) continue;
    counts.set(b.franchiseRoot, (counts.get(b.franchiseRoot) || 0) + 1);
  }
  if (!counts.size) return "";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
async function attachCanonical(query, ctx) {
  try {
    const entity = query.anilistId ? await resolveCanonical(query.anilistId) : null;
    return { ...ctx, canonical: entity };
  } catch {
    return ctx;
  }
}
var RESOLVER_TV_FORMATS = TV_FORMATS;
var RESOLVER_MOVIE_FORMATS = MOVIE_FORMATS;
var RESOLVER_SPECIAL_FORMATS = SPECIAL_FORMATS;

// src/lib/normalize.js
function normalizeTorrent(raw) {
  const title = String(raw.title || "");
  const parsed = parseTitle(title);
  return {
    // identity
    title,
    link: raw.link || "",
    hash: String(raw.hash || "").toLowerCase(),
    tracker: raw.tracker || raw.source || "unknown",
    // show/episode semantics
    anime: parsed.animeWords,
    episode: parsed.episode,
    season: parsed.season,
    absolute: parsed.absolute,
    // release metadata
    releaseGroup: parsed.releaseGroup,
    resolution: parsed.resolution,
    codec: parsed.codec,
    sourceTag: parsed.sourceTag,
    container: parsed.container,
    // language
    spokenLanguages: parsed.spokenLanguages,
    subtitleLanguages: parsed.subtitleLanguages,
    isDub: parsed.isDub,
    isDualAudio: parsed.isDualAudio,
    isSubbed: parsed.isSubbed,
    // type
    isBatch: parsed.isBatch || /\b(batch|complete|vol\.?\s*\d+|cour\s*\d|part\s*\d)\b/i.test(title),
    isMovie: parsed.isMovie,
    isOva: parsed.isOva,
    // stats
    seeders: Number(raw.seeders) || 0,
    leechers: Number(raw.leechers) || 0,
    downloads: Number(raw.downloads) || 0,
    size: Number(raw.size) || 0,
    date: raw.date instanceof Date ? raw.date : raw.date ? new Date(raw.date) : /* @__PURE__ */ new Date(0),
    accuracy: raw.accuracy || "medium",
    // parser confidence: how strongly the title parser believes its own
    // extraction (1.0 = every field parsed cleanly, 0.5 = episode inferred from
    // bare numeral, 0.3 = title only). Scorer weighs this.
    confidence: parsed.confidence
  };
}
var RES_RE = /\b(\d{3,4})p\b/i;
var RES_NAMED = { "4k": 2160, "2160p": 2160, "1080p": 1080, "1080i": 1080, "720p": 720, "540p": 540, "480p": 480 };
var CODEC_RE = /\b(x264|x265|h\.?264|h\.?265|avc|hevc|hevc1|hev1|vp9|av1|dv|vvc|mpeg-?2)\b/i;
var CONTAINER_RE = /\.(mkv|mp4|avi|ts|mov|m2ts)\b/i;
var GROUP_RE = /^\s*\[([^\]]+)\]/;
var GROUP_END_RE = /\[([^\]]+)\]\s*$/;
var DUB_TAGS = /\b(dub|dubbed|eng\s*dub|english\s*dub)\b/i;
var DUAL_AUDIO = /\b(dual[-\s]?audio|multi[-\s]?audio)\b/i;
var SUBBED_TAGS = /\b(sub|subbed|eng\s*sub|english\s*sub|multisub|multi[-\s]?sub)\b/i;
var LANG_CODES = {
  ENG: "en",
  JPN: "ja",
  JAP: "ja",
  POR: "pt",
  PORBR: "pt-BR",
  BR: "pt-BR",
  SPA: "es",
  SPALA: "es-419",
  LAT: "es-419",
  FRE: "fr",
  FRA: "fr",
  GER: "de",
  ITA: "it",
  DUT: "nl",
  RUS: "ru",
  KOR: "ko",
  CHI: "zh",
  HUN: "hu",
  POL: "pl",
  DAN: "da",
  NOR: "no",
  SWE: "sv",
  FIN: "fi",
  CZE: "cs",
  ROM: "ro",
  HEB: "he",
  ARA: "ar",
  HIN: "hi",
  THA: "th",
  IND: "id",
  MAY: "ms",
  VIE: "vi",
  TUR: "tr",
  UKR: "uk",
  GRE: "el"
};
function extractLanguages(title) {
  const spoken = /* @__PURE__ */ new Set();
  const subs = /* @__PURE__ */ new Set();
  const codeRe = /\[([A-Z]{2,3}(?:-[A-Z]{2,3})?)\]/g;
  let m;
  const bracketLangs = /* @__PURE__ */ new Set();
  while ((m = codeRe.exec(title)) !== null) {
    const key = m[1].toUpperCase().replace("-", "");
    const iso = LANG_CODES[key] || LANG_CODES[m[1].toUpperCase()];
    if (iso) bracketLangs.add(iso);
  }
  const hasDubMarker = DUB_TAGS.test(title);
  const hasDualMarker = DUAL_AUDIO.test(title);
  const hasSubMarker = SUBBED_TAGS.test(title) || /Multi[-\s]?Sub/i.test(title);
  if (hasDualMarker || hasDubMarker) {
    for (const iso of bracketLangs) spoken.add(iso);
  }
  if (hasSubMarker || /eng\s*sub/i.test(title)) {
    for (const iso of bracketLangs) subs.add(iso);
    if (!hasDualMarker && !hasDubMarker) {
      for (const iso of bracketLangs) spoken.delete(iso);
    }
  }
  if (hasDualMarker) spoken.add("dual");
  if (hasDubMarker) spoken.add("en");
  if (hasSubMarker) subs.add("multi");
  if (/eng\s*sub/i.test(title)) subs.add("en");
  return {
    spoken: [...spoken],
    subs: [...subs]
  };
}
function parseEpisode(title) {
  let m;
  m = title.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
  if (m) return { season: +m[1], episode: +m[2], absolute: null, isBatch: false, confidence: 1 };
  m = title.match(/\bS(\d{1,2})\s*[-~]?\s*(\d{1,3})(?:v\d)?\b(?![\d\-])\b/i);
  if (m) return { season: +m[1], episode: +m[2], absolute: null, isBatch: false, confidence: 1 };
  m = title.match(/\bSeason\s+(\d{1,2})\b(?:\s*Episode\s*(\d{1,3})\b)?/i) || title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b(?:\s*Episode\s*(\d{1,3})\b)?/i);
  if (m) return { season: +m[1], episode: m[2] ? +m[2] : null, absolute: null, isBatch: false, confidence: m[2] ? 0.95 : 0.6 };
  m = title.match(/\b(?:Episode|E(?:P)?)\.?\s+0*(\d{1,3})(?:v\d)?\b/i);
  if (m) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 1 };
  m = title.match(/\b0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})\b(?![\d])/);
  if (m) return { season: null, episode: +m[1], absolute: +m[2], isBatch: true, confidence: 0.8 };
  m = title.match(/[\[(]\s*0*(\d{1,3})(?:v\d)?\s*[\])]/);
  if (m) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 0.7 };
  m = title.match(/[-~]\s*0*(\d{1,3})(?:v\d)?(?=\s*[\[(\.\-]|\s*$)/);
  if (m) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 0.7 };
  m = title.match(/(?<=\s)0*(\d{1,3})(?:\s*$|\s+[\[(\.]|\s+[a-z])/);
  if (m && +m[1] <= 99) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 0.5 };
  return { season: null, episode: null, absolute: null, isBatch: false, confidence: 0.3 };
}
function parseTitle(title) {
  const ep = parseEpisode(title);
  const langs = extractLanguages(title);
  const res = (title.match(RES_RE) || [])[1];
  const resolution = res ? +res : RES_NAMED[title.toLowerCase().match(/\b(2160p|1080p|720p|540p|480p|4k)\b/i)?.[1]] || null;
  const codec = (title.match(CODEC_RE) || [])[1]?.toLowerCase();
  const container = (title.match(CONTAINER_RE) || [])[1]?.toLowerCase();
  const groupMatch = title.match(GROUP_RE) || title.match(GROUP_END_RE);
  const releaseGroup = groupMatch ? groupMatch[1].trim() : null;
  const animeWords = significantTokens(
    title.replace(/^\[[^\]]*\]/, "").replace(/\bS\d{1,2}\s?E?\d{1,3}\b.*$/, "").replace(/\b\d{3,4}p\b/i, "").replace(/\bx26[45]\b/i, "").replace(/\.(mkv|mp4|avi|ts)\b/i, "")
  );
  const isMovie = /\bmovie\b|\bfilm\b/i.test(title) || /\.(mkv|mp4)$/i.test(title) && !ep.episode && !ep.isBatch && /movie/i.test(title);
  const isOva = /\b(OVA|OAD|Special)\b/i.test(title);
  return {
    ...ep,
    resolution,
    codec,
    container,
    releaseGroup,
    animeWords,
    spokenLanguages: langs.spoken,
    subtitleLanguages: langs.subs,
    isDub: langs.spoken.includes("en") && !langs.spoken.includes("ja"),
    isDualAudio: langs.spoken.includes("dual") || DUAL_AUDIO.test(title) || langs.spoken.includes("en") && langs.spoken.includes("ja"),
    isSubbed: SUBBED_TAGS.test(title) || langs.subs.length > 0,
    sourceTag: (title.match(/\b(BD|BluRay|Blu-Ray|Bluray|BDRip|DVDRip|DVD|WEB|WebRip|Web-DL|HDTV|TV|Netflix|Crunchyroll|CR|Remux|AMZN|ATSC|ATVP|NHK|AT-X|WOWOW)\b/i) || [])[1]?.toLowerCase(),
    confidence: ep.confidence
  };
}
function tagBranch(norm, canonical) {
  const animeWords = norm.anime || norm.animeWords;
  if (!canonical || !canonical.branches?.length || !animeWords?.length) {
    return { branch: null, overlap: 0 };
  }
  let best = null;
  for (const b of canonical.branches) {
    let overlap = 0;
    for (const w of animeWords) if (b.tokens.has(w)) overlap++;
    const seasonAgree = norm.season == null || b.seasonInFranchise == null || norm.season === b.seasonInFranchise;
    const score = overlap + (seasonAgree ? 0.25 : 0);
    if (!best || score > best.score) {
      best = { branch: b, overlap, score, seasonAgree };
    }
  }
  return best ? { branch: best.branch, overlap: best.overlap, seasonAgree: best.seasonAgree } : { branch: null, overlap: 0 };
}

// src/lib/filters.js
function gateFranchise(norm, { canonical, requestSeason, requestFormat }) {
  if (!canonical) return { pass: null };
  const tag = tagBranch(norm, canonical);
  if (!tag.branch) {
    return { pass: false, reason: "no franchise overlap" };
  }
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat);
  if (requested && tag.branch.anilist !== requested.anilist) {
    if (tag.branch.seasonInFranchise && requested.seasonInFranchise && tag.branch.seasonInFranchise !== requested.seasonInFranchise) {
      return { pass: false, reason: "different-franchise-branch(" + tag.branch.titles[0] + ")" };
    }
    if (RESOLVER_MOVIE_FORMATS.has(tag.branch.format) && RESOLVER_TV_FORMATS.has(requested.format)) {
      return { pass: false, reason: "movie-vs-tv-request" };
    }
    if (RESOLVER_SPECIAL_FORMATS.has(tag.branch.format) && RESOLVER_TV_FORMATS.has(requested.format)) {
      return { pass: false, reason: "special-vs-tv-request" };
    }
    if (tag.branch.format === "MOVIE" && requestFormat && requestFormat !== "MOVIE") {
      return { pass: false, reason: "wrong-format" };
    }
  }
  return { pass: true };
}
function gateBranch(norm, { canonical, requestSeason, requestFormat }) {
  if (!canonical) return { pass: null };
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat);
  if (!requested) return { pass: null };
  const tag = tagBranch(norm, canonical);
  if (!tag.branch) return { pass: null };
  if (tag.branch.anilist === requested.anilist) return { pass: true };
  if (tag.branch.format === requested.format && tag.branch.seasonInFranchise === requested.seasonInFranchise) {
    return { pass: true };
  }
  return { pass: false, reason: "wrong-branch" };
}
function gateMovieVsTv(norm, { requestFormat, mode }) {
  if (mode === "movie") {
    if (norm.isBatch && norm.episode == null) return { pass: false, reason: "batch-for-movie" };
    return { pass: null };
  }
  if (norm.isMovie && norm.episode == null && !norm.isBatch) {
    return { pass: false, reason: "movie-release-for-tv-request" };
  }
  return { pass: null };
}
function gateOvaVsSeason(norm, { canonical, requestFormat, requestSeason }) {
  if (!canonical) return { pass: null };
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat);
  if (!requested) return { pass: null };
  if (RESOLVER_TV_FORMATS.has(requested.format) && norm.isOva && !norm.isBatch) {
    if (canonical.byFormat.special.length > 0) {
      return { pass: false, reason: "ova-for-tv-request" };
    }
  }
  return { pass: null };
}
function gateEpisodeRange(norm, { canonical, requestSeason, requestFormat }) {
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat);
  if (!requested || !requested.episodeCount) return { pass: null };
  if (norm.episode != null && norm.episode > requested.episodeCount && !norm.isBatch) {
    return { pass: false, reason: "episode-exceeds-branch(" + norm.episode + ">" + requested.episodeCount + ")" };
  }
  return { pass: null };
}
function gateAirDate(norm, { canonical, requestSeason, requestFormat }) {
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat);
  if (!requested || !requested.startDate || !requested.startDate.year) return { pass: null };
  const start = new Date(
    requested.startDate.year,
    (requested.startDate.month || 1) - 1,
    requested.startDate.day || 1
  ).getTime();
  if (!Number.isFinite(start)) return { pass: null };
  const slack = 14n * 24n * 60n * 60n * 1000n;
  const releasedAt = BigInt(norm.date instanceof Date ? norm.date.getTime() : norm.date || 0);
  if (releasedAt < BigInt(start) - slack) {
    return { pass: false, reason: "airdate-impossible" };
  }
  return { pass: null };
}
function pickRequestedBranch(canonical, requestSeason, requestFormat) {
  if (!canonical) return null;
  if (requestFormat === "MOVIE") {
    return canonical.byFormat.movie[0] || null;
  }
  if (requestSeason != null) {
    const tv = canonical.byFormat.tv.find((b) => b.seasonInFranchise === requestSeason);
    if (tv) return tv;
  }
  return canonical.branches.find((b) => b.anilist === canonical.seedAnilist) || null;
}
function validate(norm, env) {
  const reasons = [];
  for (const gate of GATES) {
    let r;
    try {
      r = gate(norm, env);
    } catch {
      r = { pass: null };
    }
    if (r && r.pass === false) {
      reasons.push(r.reason || gate.name);
      return { ok: false, reasons };
    }
    if (r && r.reason) reasons.push(r.reason);
  }
  return { ok: true, reasons };
}
var GATES = [
  gateFranchise,
  gateMovieVsTv,
  gateOvaVsSeason,
  gateBranch,
  gateEpisodeRange,
  gateAirDate
];

// src/lib/scorer.js
var WEIGHTS = {
  branchOverlap: 6,
  branchMaxedAt: 6,
  episodeExact: 8,
  episodeWithinRange: 4,
  seasonMatch: 6,
  seasonMissing: -2,
  seasonMismatch: -10,
  resolutionPref: 3,
  resolutionOther: 0,
  resolutionNotWanted: -1,
  groupKnown: 4,
  groupAvoided: -6,
  groupUnknown: 0,
  confidence: 1,
  recency: 2,
  seeders200: 5,
  seeders50: 2,
  seedersLow: -1,
  batchVsSingle: -6,
  movieVsSingle: -8,
  branchExact: 10,
  ageStaleDays120: -1,
  sourceBD: 4,
  sourceWEB: 2,
  avoidBluRayPenalty: -12,
  dualAudio: 5,
  dub: 3,
  hevc: 2,
  avc: 0,
  prefsGroupMatch: 6,
  prefsSourceMatch: 3,
  prefsCodecMatch: 2,
  prefsDubExtra: 4,
  prefsDualAudioExtra: 3
};
var KNOWN_GROUPS = /* @__PURE__ */ new Set([
  "subsplease",
  "erai-raws",
  "judas",
  "ember",
  "asw",
  "scy",
  "varyg",
  "cleo",
  "beatrice-raws",
  "yakuboencodes",
  "anime time",
  "commie",
  "horriblesubs",
  "dmon",
  "yameii",
  "toonshub",
  "sumi",
  "aots",
  "asenshi",
  "nc-raws",
  "darksoul-sub",
  "kawaiika-raws",
  "shokoreya",
  "vortex",
  "animestuff",
  "raitti-davinci",
  "lodash",
  "sub",
  "etotires",
  "wbp",
  "tenki"
]);
function recencyBonus(norm, now = Date.now()) {
  if (!norm.date) return 0;
  const t = norm.date instanceof Date ? norm.date.getTime() : norm.date;
  const days = (now - t) / 864e5;
  if (days < 0) return WEIGHTS.recency;
  if (days < 60) return WEIGHTS.recency;
  if (days > 120) return WEIGHTS.ageStaleDays120;
  return 0;
}
function seedersBonus(norm) {
  const s = norm.seeders || 0;
  if (s >= 200) return WEIGHTS.seeders200;
  if (s >= 50) return WEIGHTS.seeders50;
  return WEIGHTS.seedersLow;
}
function groupBonus(norm, prefs) {
  const g = (norm.releaseGroup || "").toLowerCase().trim();
  if (!g) return WEIGHTS.groupUnknown;
  if (prefs && prefs.avoidGroups && prefs.avoidGroups.has(g)) return WEIGHTS.groupAvoided;
  if (prefs && prefs.knownGroups && prefs.knownGroups.has(g)) return WEIGHTS.prefsGroupMatch;
  if (KNOWN_GROUPS.has(g)) return WEIGHTS.groupKnown;
  return WEIGHTS.groupUnknown;
}
function resolutionBonus(norm, prefs) {
  const res = norm.resolution;
  if (!res) return WEIGHTS.resolutionOther;
  if (prefs && prefs.preferredResolutions && prefs.preferredResolutions.has(String(res))) return WEIGHTS.resolutionPref;
  return WEIGHTS.resolutionNotWanted;
}
function sourceBonus(norm, prefs) {
  const t = (norm.sourceTag || "").toLowerCase();
  let s = 0;
  const isBluRay = t === "bd" || t === "bdrip" || t === "bluray" || t === "remux";
  if (isBluRay) {
    if (prefs && prefs.avoidBluRay) s += WEIGHTS.avoidBluRayPenalty;
    else s += WEIGHTS.sourceBD;
  }
  if (t === "web" || t === "web-dl" || t === "webrip" || t === "netflix" || t === "crunchyroll") s += WEIGHTS.sourceWEB;
  if (prefs && prefs.preferredSource && t && prefs.preferredSource.has(t)) s += WEIGHTS.prefsSourceMatch;
  return s;
}
function codecBonus(norm, prefs) {
  const c = (norm.codec || "").toLowerCase();
  let s = c === "hevc" || c === "x265" || c === "h265" || c === "av1" || c === "vp9" ? WEIGHTS.hevc : WEIGHTS.avc;
  if (prefs && prefs.preferredCodecs && prefs.preferredCodecs.has(c)) s += WEIGHTS.prefsCodecMatch;
  return s;
}
function audioBonus(norm, prefs) {
  let s = 0;
  if (norm.isDualAudio) s += prefs && prefs.preferDualAudio ? WEIGHTS.dualAudio + WEIGHTS.prefsDualAudioExtra : WEIGHTS.dualAudio;
  if (norm.isDub) s += prefs && prefs.preferDub ? WEIGHTS.dub + WEIGHTS.prefsDubExtra : WEIGHTS.dub;
  return s;
}
function branchScore(norm, canonical, requested) {
  if (!canonical) return { score: 0, branch: null, seasonAgree: null };
  const tag = tagBranch(norm, canonical);
  if (!tag.branch) return { score: 0, branch: null, seasonAgree: null };
  let s = tag.overlap * WEIGHTS.branchOverlap;
  if (tag.overlap >= 3) s += WEIGHTS.branchMaxedAt;
  if (requested && tag.branch.anilist === requested.anilist) s += WEIGHTS.branchExact;
  return { score: s, branch: tag.branch, seasonAgree: tag.seasonAgree };
}
function episodeScore(norm, requestEpisode) {
  if (requestEpisode == null) return 0;
  if (norm.isBatch) {
    if (norm.episode != null && norm.absolute != null && norm.episode <= requestEpisode && requestEpisode <= norm.absolute) {
      return WEIGHTS.episodeWithinRange;
    }
    return WEIGHTS.batchVsSingle;
  }
  if (norm.episode === requestEpisode) return WEIGHTS.episodeExact;
  if (norm.episode != null) return -WEIGHTS.episodeExact;
  return 0;
}
function seasonScore(norm, requestSeason) {
  if (requestSeason == null) return 0;
  if (norm.season == null) return WEIGHTS.seasonMissing;
  if (norm.season === requestSeason) return WEIGHTS.seasonMatch;
  return WEIGHTS.seasonMismatch;
}
function scoreCandidate(norm, { canonical, requestSeason, requestEpisode, requestFormat, prefs = {}, mode }) {
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat);
  const branch = branchScore(norm, canonical, requested);
  const episode = episodeScore(norm, requestEpisode);
  const season = seasonScore(norm, requestSeason);
  const resolution = resolutionBonus(norm, prefs);
  const group = groupBonus(norm, prefs);
  const recency = recencyBonus(norm);
  const seeders = seedersBonus(norm);
  const source = sourceBonus(norm, prefs);
  const codec = codecBonus(norm, prefs);
  const audio = audioBonus(norm, prefs);
  const confidenceMul = Math.max(0.3, Math.min(1, norm.confidence || 0.5));
  let formatPenalty = 0;
  if (mode !== "movie" && norm.isMovie && norm.episode == null) {
    formatPenalty = WEIGHTS.movieVsSingle;
  }
  const raw = branch.score + episode + season + resolution + group + recency + seeders + source + codec + audio + formatPenalty;
  return {
    score: raw * confidenceMul,
    components: { branch: branch.score, episode, season, resolution, group, recency, seeders, formatPenalty },
    branch: branch.branch
  };
}
function rankCandidates(cands, env) {
  const scored = cands.map((c) => ({ c, s: scoreCandidate(c, env) }));
  scored.sort((a, b) => {
    if (b.s.score !== a.s.score) return b.s.score - a.s.score;
    const dA = a.c.date instanceof Date ? a.c.date.getTime() : a.c.date || 0;
    const dB = b.c.date instanceof Date ? b.c.date.getTime() : b.c.date || 0;
    if (dB !== dA) return dB - dA;
    if (b.c.seeders !== a.c.seeders) return (b.c.seeders || 0) - (a.c.seeders || 0);
    return (a.c.size || 0) - (b.c.size || 0);
  });
  return scored.map((x) => ({ norm: x.c, score: x.s.score, branch: x.s.branch, components: x.s.components }));
}

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
function effectiveAccuracy(base, releaseDateMs, profile) {
  const conf = profile.parserConfidence || 0.7;
  const band = conf >= 0.85 ? base : "medium";
  if (!releaseDateMs) return band;
  const ms = releaseDateMs instanceof Date ? releaseDateMs.getTime() : releaseDateMs;
  const days = (Date.now() - ms) / 864e5;
  if (days < 60) return band;
  if (days < 180) return "medium";
  return "low";
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
function scorerEnv(prefs, queryResolution) {
  const norm = resolve(prefs || {});
  return {
    resolution: queryResolution || null,
    preferredResolutions: new Set(norm.preferredResolution.map(String)),
    preferredCodecs: new Set(norm.preferredCodec.map((s) => s.toLowerCase())),
    knownGroups: new Set(norm.preferredGroups.map((s) => s.toLowerCase().trim())),
    avoidGroups: new Set(norm.avoidGroups.map((s) => s.toLowerCase().trim())),
    preferredAudio: new Set(norm.preferredAudio),
    preferredSubtitles: new Set(norm.preferredSubtitles),
    preferDualAudio: !!norm.preferDualAudio,
    preferDub: !!norm.preferDub,
    allowRaw: !!norm.allowRaw,
    avoidBluRay: !!norm.avoidBluRay,
    defaultBatch: !!norm.preferBatch,
    fallbackToBatch: !!norm.fallbackToBatch,
    preferredSource: new Set(norm.preferredSource.map((s) => s.toLowerCase())),
    maxResults: norm.maxResults && Number.isInteger(norm.maxResults) ? norm.maxResults : 0,
    exclusions: (norm.exclusions || []).slice(0, 20),
    maxFileSize: norm.maxFileSizeMB ? Number(norm.maxFileSizeMB) * 1e6 : 0
  };
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
var BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/xml, text/xml, text/html, application/json, */*"
};
function httpGet(url, opts = {}) {
  const { headers, ...rest } = opts;
  return fetch(url, { headers: { ...BROWSER_HEADERS, ...headers }, ...rest });
}
async function checkNyaaFeed(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6e3);
  let res;
  try {
    res = await httpGet(url, { signal: ctrl.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("nyaa.si is slow to respond right now. This is temporary and usually clears in a minute. Searches will still work; the extension is fine, no reinstall needed.");
    }
    throw new Error("nyaa.si is currently unreachable. The extension will work again once the site is back, nothing to fix on your end.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    throw new Error("nyaa.si is rate-limiting requests. Wait a minute and toggle this extension off and on.");
  }
  if (!res.ok) {
    throw new Error("nyaa.si returned HTTP " + res.status + ". The extension will work again once the site is back.");
  }
  const text = await res.text();
  if (!text.includes("<rss") && !text.includes("<item>")) {
    throw new Error("nyaa.si returned an unexpected response (likely a ddos-guard challenge). Try again in a minute; the extension will keep working when it clears.");
  }
  return true;
}
var TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "http://nyaa.tracker.wf:7777/announce"
];
var BATCH_PATTERNS = [
  /\bbatch\b/i,
  /\bcomplete\b/i,
  /\bseason\s*\d+\b/i,
  /\bs\d{1,2}\b(?!\s*e\d)/i,
  /\b\d{1,3}\s*[-~]\s*\d{1,3}\b/
];
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "her",
  "his",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "who",
  "what",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "one",
  "two",
  "season",
  "episode",
  "part",
  "arc",
  "movie",
  "film",
  "ova",
  "special",
  // Japanese romanization noise: grammatical particles, pronouns, honorifics,
  // copula, common verbs, and arc/chapter markers that romanize to short tokens
  // and appear across unrelated shows ("-hen" arc suffix, "na Ken", "boku/ore"
  // pronouns, "-sama/-san/-kun/-chan" honorifics). Never show-identifying.
  "hen",
  "boku",
  "ore",
  "kimi",
  "sama",
  "san",
  "kun",
  "chan",
  "suru",
  "naru",
  "nani",
  "desu",
  "dake",
  "made",
  "demo",
  "inai",
  "koi",
  "ken",
  "shi",
  // "dan" leaked "Grow Up Show: Himawari no Circus-dan" (Japanese for "troupe")
  // into every Dandadan search. Dandadan self-match is unaffected because the
  // canonical title tokens to "dandadan" (14 chars, kept), not "dan".
  "dan"
]);
function escapeQuery(str) {
  return String(str || "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}
function significantTokens(title) {
  return escapeQuery(title).toLowerCase().split(/\s+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+(st|nd|rd|th)$/.test(t));
}
function buildTitleTokens(titles) {
  const tokens = /* @__PURE__ */ new Set();
  for (const t of titles || []) {
    for (const tok of significantTokens(t)) tokens.add(tok);
  }
  return tokens;
}
function tokenInTitle(tok, lower) {
  return new RegExp("\\b" + tok + "\\b").test(lower);
}
function stripLangCodes(title) {
  return String(title).replace(/\[[A-Z]{2,3}(?:-[A-Z]{2,3})?\]/g, " ");
}
function resultMatchesShow(title, tokens, minHits = 1) {
  if (!tokens.size) return true;
  const lower = stripLangCodes(title).toLowerCase();
  let hits = 0;
  for (const tok of tokens) {
    if (tokenInTitle(tok, lower)) {
      hits++;
      if (hits >= minHits) return true;
    }
  }
  return false;
}
var ROMAN_SEASON = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
function detectResultSeason(title) {
  const t = String(title || "");
  let m = t.match(/\bS(\d{1,2})(?:E\d|\b)/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/\b(?:Season\s+(\d+)|(\d+)(?:st|nd|rd|th)\s+Season)\b/i);
  if (m) return parseInt(m[1] || m[2], 10);
  m = t.match(/\b[A-Za-z]+\s+(II|III|IV|V|VI|VII|VIII|IX|X)(?=\s|:|\.|-|$|\[|\()/);
  if (m) return ROMAN_SEASON[m[1]];
  const digitRE = /\b([2-9])(?=\s*$|\s*[:\-|(\[])/g;
  let dm;
  while ((dm = digitRE.exec(t)) !== null) {
    const before = t.slice(Math.max(0, dm.index - 8), dm.index).toLowerCase();
    if (/\bpart\s+$/.test(before)) continue;
    return parseInt(dm[1], 10);
  }
  return null;
}
function detectShowSeason(titles) {
  let max = 0;
  for (const t of titles || []) {
    const n = detectResultSeason(t);
    if (n && n > max) max = n;
  }
  return max || 1;
}
function resultMatchesSeason(title, showSeason) {
  const rs = detectResultSeason(title);
  if (showSeason > 1) return rs === showSeason;
  return !rs || rs === 1;
}
var YEAR_RE = /(?:^|[\s._\[(\-])(19[3-9]\d|20\d{2})(?=[\s._\])\-]|$)/g;
function detectYears(text) {
  const s = String(text || "");
  const years = /* @__PURE__ */ new Set();
  YEAR_RE.lastIndex = 0;
  let m;
  while ((m = YEAR_RE.exec(s)) !== null) years.add(m[1]);
  return years;
}
function detectShowYears(titles) {
  const years = /* @__PURE__ */ new Set();
  for (const t of titles || []) for (const y of detectYears(t)) years.add(y);
  return years;
}
function resultMatchesYear(title, showYears) {
  if (!showYears || !showYears.size) return true;
  const rYears = detectYears(title);
  if (!rYears.size) return true;
  for (const y of rYears) if (showYears.has(y)) return true;
  return false;
}
function titleHasEpisode(title, ep) {
  if (ep == null) return true;
  const n = String(ep).replace(/^0+/, "") || "0";
  const patterns = [
    new RegExp("\\b(?:e|ep|episode\\s*|s\\d{1,2}e)0*" + n + "\\b(?!\\d)", "i"),
    new RegExp("[\\s._][-~]\\s+0*" + n + "(?:v\\d)?(?=[\\s\\[\\(]|$)", "i"),
    new RegExp("[\\[\\(]0*" + n + "(?:v\\d)?[\\]\\)]", "i")
  ];
  return patterns.some((re) => re.test(title));
}
function looksLikeBatch(title) {
  if (/\bs\d{1,2}e\d{1,3}\s*[-~]\s*(?:s\d{1,2})?e?\d{1,3}\b/i.test(title)) return true;
  if (/\bs\d{1,2}e\d{1,3}\b/i.test(title)) return false;
  if (/\s-\s*\d{1,4}(?:v\d)?\s*(?:\[|\(|$)/.test(title)) return false;
  return BATCH_PATTERNS.some((re) => re.test(title));
}
function tagAccuracy(tier, dateMs, sourceDefault) {
  if (tier === "A") return sourceDefault;
  if (tier === "B") return "low";
  const days = (Date.now() - (dateMs || 0)) / 864e5;
  if (days < 60) return sourceDefault;
  if (days < 180) return "medium";
  return "low";
}
function buildQueries(titles, opts = {}) {
  const limit = opts.limit || 3;
  const bases = [];
  const seen = /* @__PURE__ */ new Set();
  for (const title of rankTitlesForQuery(titles || [])) {
    const q = trimTitleForQuery(title);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    bases.push(q);
    if (bases.length >= limit) break;
  }
  if (opts.episode == null) return bases;
  const numbered = bases.map((b) => b + " " + pad(opts.episode));
  return [...bases, ...numbered].slice(0, opts.maxQueries || 4);
}
var ANILIST_API2 = "https://graphql.anilist.co";
var offsetCache = /* @__PURE__ */ new Map();
async function fetchPrequelChain(anilistId) {
  const seen = /* @__PURE__ */ new Set();
  const counts = [];
  let current = Number(anilistId);
  for (let depth = 0; depth < 12 && current && !seen.has(current); depth++) {
    seen.add(current);
    const body = JSON.stringify({
      query: "query($id:Int){Media(id:$id){episodes format relations{edges{relationType node{id episodes format}}}}}",
      variables: { id: current }
    });
    let media;
    try {
      const res = await fetch(ANILIST_API2, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body
      });
      if (!res.ok) break;
      media = (await res.json())?.data?.Media;
    } catch {
      break;
    }
    if (!media) break;
    const prequel = (media.relations?.edges || []).filter((e) => e.relationType === "PREQUEL").map((e) => e.node).filter((n) => n && (n.format === "TV" || n.format === "ONA" || n.format === "TV_SHORT")).sort((a, b) => (b.episodes || 0) - (a.episodes || 0))[0];
    if (!prequel || !prequel.episodes) break;
    counts.push(prequel.episodes);
    current = prequel.id;
  }
  return counts;
}
async function resolveEpisodeCandidates(query) {
  const ep = Number(query.episode);
  if (!Number.isInteger(ep) || !query.anilistId) return null;
  const key = String(query.anilistId);
  if (!offsetCache.has(key)) {
    offsetCache.set(key, fetchPrequelChain(query.anilistId).catch(() => []));
  }
  const counts = await offsetCache.get(key);
  const candidates = /* @__PURE__ */ new Set([ep]);
  let running = 0;
  for (const c of counts || []) {
    running += c;
    if (running >= 10) candidates.add(ep + running);
  }
  return candidates;
}
function searchContext(query, mode) {
  const titles = query.titles || [];
  const primary = rankTitlesForQuery(titles)[0];
  const primaryTokens = primary ? buildTitleTokens([primary]) : /* @__PURE__ */ new Set();
  return {
    mode,
    showTokens: buildTitleTokens(titles),
    showSeason: detectShowSeason(titles),
    showYears: detectShowYears(titles),
    minHits: primaryTokens.size >= 3 ? 2 : 1,
    episode: query.episode,
    episodeCandidates: query.episodeCandidates || null,
    exclusions: query.exclusions || [],
    resolution: query.resolution || "",
    _prefs: query._prefs || {}
  };
}
function shapeResult(r, ctx, sourceDefault) {
  const tier = classifyResult(r.title, ctx);
  if (tier === null) return null;
  const out = { ...r, _tier: tier, accuracy: tagAccuracy(tier, r.date?.getTime?.(), sourceDefault) };
  if (tier === "B") out.type = "batch";
  return out;
}
function shapeAll(items, ctx, sourceDefault) {
  const shape = (c) => {
    const out = [];
    for (const r of items) {
      const s = shapeResult(r, c, sourceDefault);
      if (s) out.push(s);
    }
    return out;
  };
  const exact = shape({ ...ctx, episodeCandidates: null });
  if (!ctx.episodeCandidates || ctx.episodeCandidates.size <= 1) return exact;
  let best = null;
  for (const n of ctx.episodeCandidates) {
    const shaped = shape({ ...ctx, episodeCandidates: /* @__PURE__ */ new Set([n]) });
    const newest = newestOf(shaped);
    if (newest == null) continue;
    if (!best || newest > best.newest) best = { newest, shaped };
  }
  return best ? best.shaped : exact;
}
function newestOf(results) {
  let newest = null;
  for (const r of results) {
    if (r._tier !== "A") continue;
    const t = r.date?.getTime?.() || 0;
    if (newest == null || t > newest) newest = t;
  }
  return newest;
}
function pipelineEnv(ctx, canonical) {
  return {
    canonical,
    requestSeason: ctx.showSeason != null ? ctx.showSeason : null,
    requestEpisode: ctx.episode != null ? Number(ctx.episode) : null,
    requestFormat: ctx.mode === "movie" ? "MOVIE" : "TV",
    mode: ctx.mode,
    prefs: scorerEnv(ctx._prefs, ctx.resolution)
  };
}
function normToResult(norm, score, sourceDefault) {
  const raw = {
    title: norm.title,
    link: norm.link,
    hash: norm.hash,
    seeders: norm.seeders,
    leechers: norm.leechers,
    downloads: norm.downloads,
    size: norm.size,
    date: norm.date,
    uploader: norm.uploader || "",
    tracker: norm.tracker || sourceDefault,
    codec: norm.codec || "",
    sourceTag: norm.sourceTag || "",
    resolution: norm.resolution,
    releaseGroup: norm.releaseGroup || "",
    isDualAudio: !!norm.isDualAudio,
    isDub: !!norm.isDub,
    subtitleLanguages: norm.subtitleLanguages || [],
    spokenLanguages: norm.spokenLanguages || [],
    accuracy: effectiveAccuracy(
      accuracyBand(score, norm, sourceDefault),
      norm.date instanceof Date ? norm.date.getTime() : 0,
      { accuracy: sourceDefault, parserConfidence: norm.confidence || 0.5 }
    )
  };
  const result = formatResult(raw, { accuracy: sourceDefault, parserConfidence: norm.confidence || 0.5, earlyExit: 0 }, {});
  if (!result) return null;
  result._score = score;
  result._normalized = norm;
  return result;
}
function accuracyBand(score, norm, sourceDefault) {
  if (score >= 12 || score >= 6 && norm.confidence >= 0.7) return sourceDefault;
  if (score >= 3) return "medium";
  return "low";
}
function assignTiers(results) {
  if (!results.length) return results;
  const scores = results.map((r) => r._score || 0).sort((a, b) => b - a);
  const max = scores[0];
  const min = scores[scores.length - 1];
  const aThreshold = max - (max - min) * 0.25;
  const bThreshold = max - (max - min) * 0.6;
  for (const r of results) {
    const s = r._score || 0;
    if (s >= aThreshold) r._tier = "A";
    else if (s >= bThreshold) r._tier = "B";
    else r._tier = "C";
  }
  return results;
}
async function canonicalShapeAll(items, ctx, sourceDefault, query) {
  const anilistId = query && (query.anilistId || query.anilist);
  if (!anilistId || !Number.isInteger(Number(anilistId)) || Number(anilistId) <= 0) {
    return shapeAll(items, ctx, sourceDefault);
  }
  let canonical;
  try {
    const ctxWithEntity = await attachCanonical(query, ctx);
    canonical = ctxWithEntity.canonical;
  } catch {
    canonical = null;
  }
  if (!canonical) return shapeAll(items, ctx, sourceDefault);
  const env = pipelineEnv(ctx, canonical);
  const norms = [];
  for (const r of items) {
    if (!r || !r.title) continue;
    const norm = normalizeTorrent({ ...r, tracker: ctx._tracker || "", source: r.source || "" });
    if (!norm.hash && !norm.title) continue;
    const verdict = validate(norm, env);
    if (!verdict.ok) continue;
    norms.push(norm);
  }
  if (!norms.length) {
    return shapeAll(items, ctx, sourceDefault);
  }
  const ranked = rankCandidates(norms, env);
  const out = ranked.map((x) => normToResult(x.norm, x.score, sourceDefault));
  assignTiers(out);
  return out;
}
async function shapeAny(items, ctx, sourceDefault, query) {
  if (query && (query.anilistId || query.anilist)) {
    return canonicalShapeAll(items, ctx, sourceDefault, query);
  }
  return shapeAll(items, ctx, sourceDefault);
}
function sortResults(results, resolution) {
  const hasExact = results.some((r) => r._tier === "A");
  return results.sort((a, b) => {
    if (hasExact && a._tier !== b._tier) return a._tier < b._tier ? -1 : 1;
    const dt = (b.date?.getTime?.() || 0) - (a.date?.getTime?.() || 0);
    if (dt !== 0) return dt;
    if (resolution) {
      const am = matchesResolution(a.title, resolution) ? 1 : 0;
      const bm = matchesResolution(b.title, resolution) ? 1 : 0;
      if (am !== bm) return bm - am;
    }
    const sd = (b.seeders || 0) - (a.seeders || 0);
    if (sd !== 0) return sd;
    return (a.size || 0) - (b.size || 0);
  });
}
function finalize(results, resolution, limit = 30, prefs = {}) {
  const kept = results.some((r) => r._tier === "A") ? results.filter((r) => r._tier !== "C") : results;
  const cap = prefs && prefs.maxResults && Number.isInteger(prefs.maxResults) && prefs.maxResults > 0 ? Math.min(prefs.maxResults, limit) : limit;
  return sortResults(kept, resolution).slice(0, cap).map(({ _tier, _score, _normalized, ...rest }) => rest);
}
async function withEpisodeCandidates(query) {
  try {
    const episodeCandidates = await resolveEpisodeCandidates(query);
    if (!episodeCandidates || episodeCandidates.size <= 1) return query;
    return { ...query, episodeCandidates };
  } catch {
    return query;
  }
}
var GENERIC_QUERY_WORDS = /* @__PURE__ */ new Set([
  "monster",
  "level",
  "hero",
  "world",
  "girl",
  "boy",
  "demon",
  "devil",
  "dragon",
  "angel",
  "king",
  "queen",
  "story",
  "magic",
  "school",
  "love",
  "life",
  "club",
  "sword",
  "blood",
  "dark",
  "light",
  "night",
  "master",
  "star",
  "moon",
  "witch",
  "ghost",
  "dead",
  "zombie",
  "idol",
  "club"
]);
function trimTitleForQuery(title) {
  const colon = title.indexOf(":");
  const base = colon > 0 ? title.slice(0, colon) : title;
  return significantTokens(base).slice(0, 4).join(" ") || escapeQuery(title);
}
function rankTitlesForQuery(titles) {
  const list = (titles || []).map((t, i) => {
    const stripped = String(t).replace(/\s/g, "");
    const ascii = escapeQuery(t).replace(/\s/g, "");
    const queryToks = trimTitleForQuery(t).split(/\s+/).filter(Boolean);
    return {
      t,
      i,
      tokens: significantTokens(t).length,
      // A query is "degenerate" when it collapses to a single word that is
      // too generic to search: very short ("Orb: ..." -> "orb") or a common
      // word ("Ore dake Level Up na Ken" -> "level", "Monster #8" -> "monster").
      // A specific single token ("bakemonogatari", "noragami", "kaiju") is
      // fine. Degenerate titles get demoted so a better title is queried first.
      degenerate: queryToks.length <= 1 && ((queryToks[0] || "").length < 4 || GENERIC_QUERY_WORDS.has(queryToks[0])),
      asciiRatio: stripped.length ? ascii.length / stripped.length : 0
    };
  }).filter((x) => x.tokens > 0);
  const latin = list.filter((x) => x.asciiRatio >= 0.5);
  const pool = latin.length ? latin : list;
  return pool.sort((a, b) => a.degenerate - b.degenerate || a.i - b.i).map((x) => x.t);
}
function pad(n) {
  const s = String(n);
  return s.length < 2 ? "0" + s : s;
}
function classifyResult(title, opts) {
  const showTokens = opts.showTokens;
  const minHits = opts.minHits != null ? opts.minHits : showTokens && showTokens.size >= 3 ? 2 : 1;
  if (!resultMatchesShow(title, showTokens, minHits)) return null;
  const seasonOk = resultMatchesSeason(title, opts.showSeason);
  const yearOk = resultMatchesYear(title, opts.showYears);
  const isBatch = looksLikeBatch(title);
  if (opts.mode === "batch") {
    return seasonOk && yearOk && isBatch ? "A" : "C";
  }
  if (opts.mode === "movie") {
    return seasonOk && yearOk ? "A" : "C";
  }
  const epOk = opts.episode == null || matchesAnyEpisode(title, opts);
  if (seasonOk && yearOk && epOk) {
    return isBatch ? "B" : "A";
  }
  return "C";
}
function matchesAnyEpisode(title, opts) {
  const candidates = opts.episodeCandidates;
  if (candidates && candidates.size) {
    for (const n of candidates) if (titleHasEpisode(title, n)) return true;
    return false;
  }
  return titleHasEpisode(title, opts.episode);
}
function matchesResolution(title, resolution) {
  if (!resolution) return true;
  return title.includes(resolution + "p") || title.includes(resolution);
}
function hitsExclusion(title, exclusions) {
  if (!exclusions || !exclusions.length) return false;
  const lower = title.toLowerCase();
  return exclusions.some((kw) => kw && lower.includes(String(kw).toLowerCase()));
}
function buildMagnet(hash, name) {
  const trackers = TRACKERS.map((t) => "tr=" + encodeURIComponent(t)).join("&");
  const dn = name ? "&dn=" + encodeURIComponent(name) : "";
  return "magnet:?xt=urn:btih:" + String(hash).toLowerCase() + dn + "&" + trackers;
}
function parseSize(text) {
  if (!text) return 0;
  const m = text.match(/([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = {
    b: 1,
    kib: 1024,
    kb: 1e3,
    mib: 1024 ** 2,
    mb: 1e3 ** 2,
    gib: 1024 ** 3,
    gb: 1e3 ** 3,
    tib: 1024 ** 4,
    tb: 1e3 ** 4
  }[unit] || 1;
  return Math.round(value * mult);
}
function pickTag(xml, tag) {
  const open = "<" + tag + ">";
  const close = "</" + tag + ">";
  const i = xml.indexOf(open);
  if (i === -1) return "";
  const j = xml.indexOf(close, i + open.length);
  if (j === -1) return "";
  let val = xml.slice(i + open.length, j);
  if (val.startsWith("<![CDATA[") && val.endsWith("]]>")) {
    val = val.slice(9, -3);
  }
  return val.trim();
}
function pickItems(xml) {
  const out = [];
  let cursor = 0;
  while (true) {
    const start = xml.indexOf("<item>", cursor);
    if (start === -1) break;
    const end = xml.indexOf("</item>", start);
    if (end === -1) break;
    out.push(xml.slice(start + 6, end));
    cursor = end + 7;
  }
  return out;
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

// src/toonshub.js
var PROFILE = SOURCE_PROFILES.toonshub;
var NYAA_BASE = "https://nyaa.si";
var TITLE_PREFIX = "[ToonsHub]";
var ANIME_CATEGORY = "1_2";
async function rssSearch(query) {
  const q = TITLE_PREFIX + (query ? " " + query : "");
  const url = NYAA_BASE + "/?page=rss&q=" + encodeURIComponent(q) + "&c=" + ANIME_CATEGORY + "&s=id&o=desc";
  let res;
  try {
    res = await httpGet(url);
  } catch (err) {
    throw new Error("Cannot reach nyaa.si. Check your internet connection or try again later.");
  }
  if (res.status === 429) {
    const err = new Error("429");
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error("Nyaa returned HTTP " + res.status + " for the ToonsHub feed. The site may be down or blocked on your network.");
  }
  const text = await res.text();
  if (!text.includes("<rss") && !text.includes("<item>")) {
    throw new Error("Nyaa returned an unexpected response for the ToonsHub feed.");
  }
  return pickItems(text);
}
async function rssSearchWithRetry(query) {
  try {
    return await rssSearch(query);
  } catch (err) {
    if (err.rateLimited) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        return await rssSearch(query);
      } catch (retryErr) {
        if (retryErr.rateLimited) {
          throw new Error("Nyaa is rate limiting requests for the ToonsHub feed. Wait a moment and try again.");
        }
        throw retryErr;
      }
    }
    throw err;
  }
}
function itemToResult(raw, opts) {
  const title = pickTag(raw, "title");
  const hash = pickTag(raw, "nyaa:infoHash").toLowerCase();
  if (!title || !hash) return null;
  if (!title.includes(TITLE_PREFIX)) return null;
  if (hitsExclusion(title, opts.exclusions)) return null;
  const seeders = parseInt(pickTag(raw, "nyaa:seeders"), 10) || 0;
  const leechers = parseInt(pickTag(raw, "nyaa:leechers"), 10) || 0;
  const downloads = parseInt(pickTag(raw, "nyaa:downloads"), 10) || 0;
  const size = parseSize(pickTag(raw, "nyaa:size"));
  const pubDate = pickTag(raw, "pubDate");
  const date = pubDate ? new Date(pubDate) : /* @__PURE__ */ new Date();
  return formatResult({
    title,
    hash,
    link: hash,
    seeders,
    leechers,
    downloads,
    size,
    date,
    uploader: "ToonsHub",
    tracker: PROFILE.name,
    accuracy: PROFILE.accuracy
  }, PROFILE, { batch: opts.batch });
}
async function runSearch(query, opts) {
  if (!query.titles || !query.titles.length) return [];
  const mode = opts.batch ? "batch" : opts.movie ? "movie" : "single";
  const ctx = searchContext(query, mode);
  ctx._tracker = PROFILE.name;
  const seen = /* @__PURE__ */ new Set();
  const collected = [];
  let shaped = [];
  for (const q of buildQueries(query.titles, { limit: 2, episode: opts.episode })) {
    let items;
    try {
      items = await rssSearchWithRetry(q);
    } catch (err) {
      if (collected.length) break;
      throw err;
    }
    for (const raw of items) {
      const r = itemToResult(raw, { exclusions: ctx.exclusions });
      if (!r || seen.has(r.hash)) continue;
      seen.add(r.hash);
      collected.push(r);
    }
    shaped = await shapeAny(collected, ctx, PROFILE.accuracy, query);
    if (shaped.filter((r) => r._tier === "A").length >= 10) break;
  }
  return finalize(shaped, ctx.resolution, 30, ctx._prefs);
}
var toonshub_default = new class ToonsHub {
  async single(query) {
    if (query.episodeCount === 1) return runSearch(query, { movie: true });
    return runSearch(await withEpisodeCandidates(query), { episode: query.episode });
  }
  async batch(query) {
    const results = await runSearch(query, { batch: true });
    return results.filter((r) => looksLikeBatch(r.title)).map((r) => ({ ...r, type: "batch", accuracy: "low" }));
  }
  async movie(query) {
    return runSearch(query, { movie: true });
  }
  async test() {
    return checkNyaaFeed(NYAA_BASE + "/?page=rss&q=" + encodeURIComponent(TITLE_PREFIX) + "&c=" + ANIME_CATEGORY);
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
  toonshub_default as default
};
