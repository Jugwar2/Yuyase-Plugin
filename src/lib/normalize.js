// NormalizedTorrent schema + branch-signature extractor.
// Invariant 2: every source parser must output the same NormalizedTorrent
// object. Nothing downstream is allowed to inspect raw tracker titles.

import { significantTokens } from './shared.js'

// Parse one raw torrent title into a NormalizedTorrent.
// `branch` is the branch descriptor from the canonical entity that the *search*
// believes this release might belong to; we don't decide here whether it
// truly belongs — filters do. We just extract every signal.
export function normalizeTorrent (raw) {
  const title = String(raw.title || '')
  const parsed = parseTitle(title)
  return {
    // identity
    title,
    link: raw.link || '',
    hash: String(raw.hash || '').toLowerCase(),
    tracker: raw.tracker || raw.source || 'unknown',
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
    date: raw.date instanceof Date ? raw.date : (raw.date ? new Date(raw.date) : new Date(0)),
    accuracy: raw.accuracy || 'medium',
    // parser confidence: how strongly the title parser believes its own
    // extraction (1.0 = every field parsed cleanly, 0.5 = episode inferred from
    // bare numeral, 0.3 = title only). Scorer weighs this.
    confidence: parsed.confidence
  }
}

const RES_RE = /\b(\d{3,4})p\b/i
const RES_NAMED = { '4k': 2160, '2160p': 2160, '1080p': 1080, '1080i': 1080, '720p': 720, '540p': 540, '480p': 480 }
const CODEC_RE = /\b(x264|x265|h\.?264|h\.?265|avc|hevc|hevc1|hev1|vp9|av1|dv|vvc|mpeg-?2)\b/i
const CONTAINER_RE = /\.(mkv|mp4|avi|ts|mov|m2ts)\b/i
// Release group: first bracketed group at start, or bracketed at end, or after
// "]" at start. Handles [SubsPlease], [Erai-raws], [Group] etc.
const GROUP_RE = /^\s*\[([^\]]+)\]/
const GROUP_END_RE = /\[([^\]]+)\]\s*$/

const DUB_TAGS = /\b(dub|dubbed|eng\s*dub|english\s*dub)\b/i
const DUAL_AUDIO = /\b(dual[-\s]?audio|multi[-\s]?audio)\b/i
const SUBBED_TAGS = /\b(sub|subbed|eng\s*sub|english\s*sub|multisub|multi[-\s]?sub)\b/i

const LANG_CODES = {
  ENG: 'en', JPN: 'ja', JAP: 'ja', POR: 'pt', PORBR: 'pt-BR', BR: 'pt-BR',
  SPA: 'es', SPALA: 'es-419', LAT: 'es-419', FRE: 'fr', FRA: 'fr', GER: 'de',
  ITA: 'it', DUT: 'nl', RUS: 'ru', KOR: 'ko', CHI: 'zh', HUN: 'hu', POL: 'pl',
  DAN: 'da', NOR: 'no', SWE: 'sv', FIN: 'fi', CZE: 'cs', ROM: 'ro', HEB: 'he',
  ARA: 'ar', HIN: 'hi', THA: 'th', IND: 'id', MAY: 'ms', VIE: 'vi', TUR: 'tr',
  UKR: 'uk', GRE: 'el'
}

function extractLanguages (title) {
  const spoken = new Set()
  const subs = new Set()
  // Bracketed language codes — [ENG][POR-BR] etc.
  const codeRE = /\[([A-Z]{2,3}(?:-[A-Z]{2,3})?)\]/g
  let m
  while ((m = codeRE.exec(title)) !== null) {
    const key = m[1].toUpperCase().replace('-', '')
    const iso = LANG_CODES[key] || LANG_CODES[m[1].toUpperCase()]
    if (iso) spoken.add(iso)
  }
  if (DUAL_AUDIO.test(title)) spoken.add('dual')
  if (DUB_TAGS.test(title)) spoken.add('en')
  if (SUBBED_TAGS.test(title) || /Multi[-\s]?Sub/i.test(title)) subs.add('multi')
  if (/eng\s*sub/i.test(title)) subs.add('en')
  return {
    spoken: [...spoken],
    subs: [...subs]
  }
}

// Extract episode numerals from common release title forms:
//   - "S02E03" / "S2 E3"        -> season 2, episode 3
//   - "- 03" / "- 03v2"         -> episode 3
//   - "[03]" / "(03)"            -> episode 3
//   - "03 - 12" (range, no S)   -> batch covering 03..12
//   - "E03" / "EP03" / "Episode 03" -> episode 3
//   - Bare " 05 " literal with surrounding separators
function parseEpisode (title) {
  let m
  // Combined SxxExx
  m = title.match(/\bS(\d{1,2})E(\d{1,3})\b/i)
  if (m) return { season: +m[1], episode: +m[2], absolute: null, isBatch: false, confidence: 1 }
  // Space separated "S2 - 3" or "S2 - 03v2" (SubsPlease style)
  m = title.match(/\bS(\d{1,2})\s*[-~]?\s*(\d{1,3})(?:v\d)?\b(?![\d\-])\b/i)
  if (m) return { season: +m[1], episode: +m[2], absolute: null, isBatch: false, confidence: 1 }
  // "Season 2" or "2nd Season" or "3rd Season" (catalogue-style)
  m = title.match(/\bSeason\s+(\d{1,2})\b(?:\s*Episode\s*(\d{1,3})\b)?/i)
    || title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b(?:\s*Episode\s*(\d{1,3})\b)?/i)
  if (m) return { season: +m[1], episode: m[2] ? +m[2] : null, absolute: null, isBatch: false, confidence: m[2] ? 0.95 : 0.6 }
  // Explicit EP / E / Episode
  m = title.match(/\b(?:Episode|E(?:P)?)\.?\s+0*(\d{1,3})(?:v\d)?\b/i)
  if (m) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 1 }
  // Range: "01 - 12" or "01-12" or "01~12" (batch)
  m = title.match(/\b0*(\d{1,3})\s*[-~]\s*0*(\d{1,3})\b(?![\d])/)
  if (m) return { season: null, episode: +m[1], absolute: +m[2], isBatch: true, confidence: 0.8 }
  // Bracketed [03] or (03)
  m = title.match(/[\[(]\s*0*(\d{1,3})(?:v\d)?\s*[\])]/)
  if (m) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 0.7 }
  // Bare trailing episode marker: " - 05", " - 05v2", "~05", " -05-"
  m = title.match(/[-~]\s*0*(\d{1,3})(?:v\d)?(?=\s*[\[(\.\-]|\s*$)/)
  if (m) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 0.7 }
  // Bare digit surrounded by word boundaries with context clues (last resort,
  // low confidence — 05 in "Bleach 05" is likely ep5, not S5)
  m = title.match(/(?<=\s)0*(\d{1,3})(?:\s*$|\s+[\[(\.]|\s+[a-z])/)
  if (m && +m[1] <= 99) return { season: null, episode: +m[1], absolute: null, isBatch: false, confidence: 0.5 }
  return { season: null, episode: null, absolute: null, isBatch: false, confidence: 0.3 }
}

function parseTitle (title) {
  const ep = parseEpisode(title)
  const langs = extractLanguages(title)
  const res = (title.match(RES_RE) || [])[1]
  const resolution = res ? +res : (RES_NAMED[title.toLowerCase().match(/\b(2160p|1080p|720p|540p|480p|4k)\b/i)?.[1]] || null)
  const codec = (title.match(CODEC_RE) || [])[1]?.toLowerCase()
  const container = (title.match(CONTAINER_RE) || [])[1]?.toLowerCase()
  const groupMatch = title.match(GROUP_RE) || title.match(GROUP_END_RE)
  const releaseGroup = groupMatch ? groupMatch[1].trim() : null
  // Pure title tokens — anime words (filter brackets, ep markers, etc.)
  const animeWords = significantTokens(
    title.replace(/^\[[^\]]*\]/, '')
         .replace(/\bS\d{1,2}\s?E?\d{1,3}\b.*$/, '')
         .replace(/\b\d{3,4}p\b/i, '')
         .replace(/\bx26[45]\b/i, '')
         .replace(/\.(mkv|mp4|avi|ts)\b/i, '')
  )
  // Movie / OVA hints: release titles usually say "Movie" or "OAD"/"OVA" right
  // in the episode slot.
  const isMovie = /\bmovie\b|\bfilm\b/i.test(title) || /\.(mkv|mp4)$/i.test(title) && !ep.episode && !ep.isBatch && /movie/i.test(title)
  const isOva = /\b(OVA|OAD|Special)\b/i.test(title)
  return {
    ...ep,
    resolution,
    codec,
    container,
    releaseGroup,
    animeWords,
    spokenLanguages: langs.spoken,
    subtitleLanguages: langs.subs,
    isDub: langs.spoken.includes('en') && !langs.spoken.includes('ja'),
    isDualAudio: langs.spoken.includes('dual') || DUAL_AUDIO.test(title) || (langs.spoken.includes('en') && langs.spoken.includes('ja')),
    isSubbed: SUBBED_TAGS.test(title) || langs.subs.length > 0,
    sourceTag: (title.match(/\b(BD|BluRay|Blu-Ray|Bluray|BDRip|DVDRip|DVD|WEB|WebRip|Web-DL|HDTV|TV|Netflix|Crunchyroll|CR|Remux|AMZN|ATSC|ATVP|NHK|AT-X|WOWOW)\b/i) || [])[1]?.toLowerCase(),
    confidence: ep.confidence
  }
}

// Tag a release with which canonical branch it claims to be. Returns
// { branch, signatureTokens } where signatureTokens are the words the release
// shares with that branch's titles. Filters then accept by branch signature
// overlapping above a threshold.
export function tagBranch (norm, canonical) {
  const animeWords = norm.anime || norm.animeWords
  if (!canonical || !canonical.branches?.length || !animeWords?.length) {
    return { branch: null, overlap: 0 }
  }
  let best = null
  for (const b of canonical.branches) {
    let overlap = 0
    for (const w of animeWords) if (b.tokens.has(w)) overlap++
    // Season marker must agree when both branches and the release speak.
    const seasonAgree = norm.season == null || b.seasonInFranchise == null || norm.season === b.seasonInFranchise
    const score = overlap + (seasonAgree ? 0.25 : 0)
    if (!best || score > best.score) {
      best = { branch: b, overlap, score, seasonAgree }
    }
  }
  return best ? { branch: best.branch, overlap: best.overlap, seasonAgree: best.seasonAgree } : { branch: null, overlap: 0 }
}
