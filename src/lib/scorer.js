// Bayesian-flavoured scorer.
// Invariant 3 (second half): the scorer only ranks candidates that survived
// the hard gates. Each signal contributes log-probability; the sum determines
// rank order. No fixed numeric threshold ("score>70"). The user's preferences
// are folded in last, not as a gate.
//
// Signals (each adds weight):
//   + alias / branch-signature overlap     strong evidence
//   + episode number exact match          strong evidence
//   + season marker match                 strong evidence
//   + resolution match to user pref       medium
//   + release-group reputation            medium (per-source allowlist)
//   + parser confidence                   scales everything else
//   + recency / freshness                  small bonus for currently airing
//   + seeders                             popularity tiebreaker
//
//   - season-marker mismatch (when both sides speak)    strong penalty
//   - episode-mismatch                                    strong penalty
//   - release much older than branch air date             small penalty
//   - batch when single was requested                       penalty
//
// Penalties are still bounded: a per-match score can go negative, but
// survivors already passed the gates so the floor is just "lowest of the
// kept set" — they will not be returned above a higher-scored candidate.

import { tagBranch } from './normalize.js'
import { pickRequestedBranch } from './filters.js'

const WEIGHTS = {
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
}

// Allowlist of well-known release groups per anime-friendly source mix. Used
// only as a small bonus, never as a gate.
const KNOWN_GROUPS = new Set([
  'subsplease', 'erai-raws', 'judas', 'ember', 'asw', 'scy', 'varyg', 'cleo',
  'beatrice-raws', 'yakuboencodes', 'anime time', 'commie', 'horriblesubs',
  'dmon', 'yameii', 'toonshub', 'sumi', 'aots', 'asenshi', 'nc-raws',
  'darksoul-sub', 'kawaiika-raws', 'shokoreya', 'vortex', 'animestuff',
  'raitti-davinci', 'lodash', 'sub', 'etotires', 'wbp', 'tenki'
])

function recencyBonus (norm, now = Date.now()) {
  if (!norm.date) return 0
  const t = norm.date instanceof Date ? norm.date.getTime() : norm.date
  const days = (now - t) / 86400000
  if (days < 0) return WEIGHTS.recency      // future-dated leak -> same bonus
  if (days < 60) return WEIGHTS.recency
  if (days > 120) return WEIGHTS.ageStaleDays120
  return 0
}

function seedersBonus (norm) {
  const s = norm.seeders || 0
  if (s >= 200) return WEIGHTS.seeders200
  if (s >= 50) return WEIGHTS.seeders50
  return WEIGHTS.seedersLow
}

function groupBonus (norm, prefs) {
  const g = (norm.releaseGroup || '').toLowerCase().trim()
  if (!g) return WEIGHTS.groupUnknown
  if (prefs && prefs.avoidGroups && prefs.avoidGroups.has(g)) return WEIGHTS.groupAvoided
  if (prefs && prefs.knownGroups && prefs.knownGroups.has(g)) return WEIGHTS.prefsGroupMatch
  if (KNOWN_GROUPS.has(g)) return WEIGHTS.groupKnown
  return WEIGHTS.groupUnknown
}

function resolutionBonus (norm, prefs) {
  const res = norm.resolution
  if (!res) return WEIGHTS.resolutionOther
  if (prefs && prefs.requestedResolutions && prefs.requestedResolutions.has(String(res))) return WEIGHTS.resolutionPref
  return WEIGHTS.resolutionNotWanted
}

function sourceBonus (norm, prefs) {
  const t = (norm.sourceTag || '').toLowerCase()
  let s = 0
  const isBluRay = t === 'bd' || t === 'bdrip' || t === 'bluray' || t === 'remux'
  if (isBluRay) {
    if (prefs && prefs.avoidBluRay) s += WEIGHTS.avoidBluRayPenalty
    else s += WEIGHTS.sourceBD
  }
  if (t === 'web' || t === 'web-dl' || t === 'webrip' || t === 'netflix' || t === 'crunchyroll') s += WEIGHTS.sourceWEB
  if (prefs && prefs.preferredSource && t && prefs.preferredSource.has(t)) s += WEIGHTS.prefsSourceMatch
  return s
}

function codecBonus (norm, prefs) {
  const c = (norm.codec || '').toLowerCase()
  let s = (c === 'hevc' || c === 'x265' || c === 'h265' || c === 'av1' || c === 'vp9') ? WEIGHTS.hevc : WEIGHTS.avc
  if (prefs && prefs.preferredCodecs && prefs.preferredCodecs.has(c)) s += WEIGHTS.prefsCodecMatch
  return s
}

function audioBonus (norm, prefs) {
  let s = 0
  if (norm.isDualAudio) s += (prefs && prefs.preferDualAudio) ? (WEIGHTS.dualAudio + WEIGHTS.prefsDualAudioExtra) : WEIGHTS.dualAudio
  if (norm.isDub) s += (prefs && prefs.preferDub) ? (WEIGHTS.dub + WEIGHTS.prefsDubExtra) : WEIGHTS.dub
  return s
}

function branchScore (norm, canonical, requested) {
  if (!canonical) return { score: 0, branch: null, seasonAgree: null }
  const tag = tagBranch(norm, canonical)
  if (!tag.branch) return { score: 0, branch: null, seasonAgree: null }
  let s = tag.overlap * WEIGHTS.branchOverlap
  if (tag.overlap >= 3) s += WEIGHTS.branchMaxedAt
  // Exact branch (same AniList id) wins hardest — guarantees intra-franchise
  // ordering puts the right sibling above any other sibling leak that slipped
  // through (shouldn't happen after gates, but defensive).
  if (requested && tag.branch.anilist === requested.anilist) s += WEIGHTS.branchExact
  return { score: s, branch: tag.branch, seasonAgree: tag.seasonAgree }
}

function episodeScore (norm, requestEpisode) {
  if (requestEpisode == null) return 0
  if (norm.isBatch) {
    // Batch containing the requested absolute episode is a useful tier.
    if (norm.episode != null && norm.absolute != null &&
        norm.episode <= requestEpisode && requestEpisode <= norm.absolute) {
      return WEIGHTS.episodeWithinRange
    }
    return WEIGHTS.batchVsSingle
  }
  if (norm.episode === requestEpisode) return WEIGHTS.episodeExact
  if (norm.episode != null) return -WEIGHTS.episodeExact // wrong episode
  return 0 // unknown episode, let other signals arbitrate
}

function seasonScore (norm, requestSeason) {
  if (requestSeason == null) return 0
  if (norm.season == null) return WEIGHTS.seasonMissing
  if (norm.season === requestSeason) return WEIGHTS.seasonMatch
  return WEIGHTS.seasonMismatch
}

// One candidate's combined score.
export function scoreCandidate (norm, { canonical, requestSeason, requestEpisode, requestFormat, prefs = {}, mode }) {
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat)
  const branch = branchScore(norm, canonical, requested)
  const episode = episodeScore(norm, requestEpisode)
  const season = seasonScore(norm, requestSeason)
  const resolution = resolutionBonus(norm, prefs)
  const group = groupBonus(norm, prefs)
  const recency = recencyBonus(norm)
  const seeders = seedersBonus(norm)
  const source = sourceBonus(norm, prefs)
  const codec = codecBonus(norm, prefs)
  const audio = audioBonus(norm, prefs)
  const confidenceMul = Math.max(0.3, Math.min(1, norm.confidence || 0.5))

  let formatPenalty = 0
  if (mode !== 'movie' && norm.isMovie && norm.episode == null) {
    formatPenalty = WEIGHTS.movieVsSingle
  }

  const raw =
    branch.score + episode + season + resolution + group + recency + seeders + source + codec + audio + formatPenalty

  return {
    score: raw * confidenceMul,
    components: { branch: branch.score, episode, season, resolution, group, recency, seeders, formatPenalty },
    branch: branch.branch
  }
}

// Sort by score desc; tiebreak by date desc, then seeders desc, then size asc
// (smaller files surface first when all else is equal — prefers WEB over BD).
export function rankCandidates (cands, env) {
  const scored = cands.map(c => ({ c, s: scoreCandidate(c, env) }))
  scored.sort((a, b) => {
    if (b.s.score !== a.s.score) return b.s.score - a.s.score
    const dA = a.c.date instanceof Date ? a.c.date.getTime() : (a.c.date || 0)
    const dB = b.c.date instanceof Date ? b.c.date.getTime() : (b.c.date || 0)
    if (dB !== dA) return dB - dA
    if (b.c.seeders !== a.c.seeders) return (b.c.seeders || 0) - (a.c.seeders || 0)
    return (a.c.size || 0) - (b.c.size || 0)
  })
  return scored.map(x => ({ norm: x.c, score: x.s.score, branch: x.s.branch, components: x.s.components }))
}

export { WEIGHTS }
