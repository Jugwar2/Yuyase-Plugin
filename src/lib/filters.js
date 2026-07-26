// Hard validation gates.
// Invariant 3: validate first, score second. These are YES/NO decisions run
// BEFORE the scorer sees anything. A candidate that fails any gate is dropped;
// the scorer only ranks candidates that could genuinely be correct.
//
// Gates intentionally stay conservative: when canonical entity resolution
// fails (no network, unknown AniList ID), we degrade to the legacy token logic
// from shared.js instead of rejecting everything.

import {
  RESOLVER_TV_FORMATS, RESOLVER_MOVIE_FORMATS, RESOLVER_SPECIAL_FORMATS,
  branchMatchesRequest
} from './resolver.js'
import { tagBranch } from './normalize.js'

// Each gate returns one of:
//   { pass: true }                        kept, no note
//   { pass: false, reason: '...' }        rejected, reason recorded
//   { pass: null }                         gate does not apply / unknown
// The runner stops at the first hard rejection; nulls and passes move on.

// Gate: franchise signature. The release's anime-words must overlap the
// canonical entity's franchise tokens meaningfully. If they match another
// branch better than the requested one (branch.score is higher than the
// requested branch score), and that other branch is NOT the requested one, we
// reject: this is the Cinderella-Gray-leaks-into-Pretty-Derby-S2 case.
export function gateFranchise (norm, { canonical, requestSeason, requestFormat }) {
  if (!canonical) return { pass: null }
  const tag = tagBranch(norm, canonical)
  if (!tag.branch) {
    // No branch signature overlap at all. Refuse when canonical entity was
    // resolved (we have a stronger opinion to act on); otherwise let legacy
    // token matching arbitrate.
    return { pass: false, reason: 'no franchise overlap' }
  }
  // Did a DIFFERENT branch score higher than the requested chain?
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat)
  if (requested && tag.branch.anilist !== requested.anilist) {
    // The release resolved to a sibling branch. That's a stray for our request.
    // Exception: sibling TV spinoffs share long tokens but the release may still
    // belong to the requested branch — only reject if the requested branch also
    // matched at all (avoid rejecting when canonical doesn't contain a real
    // branch for the requested season).
    if (tag.branch.seasonInFranchise && requested.seasonInFranchise &&
        tag.branch.seasonInFranchise !== requested.seasonInFranchise) {
      return { pass: false, reason: 'different-franchise-branch(' + tag.branch.titles[0] + ')' }
    }
    // Movie leaking into TV season request
    if (RESOLVER_MOVIE_FORMATS.has(tag.branch.format) && RESOLVER_TV_FORMATS.has(requested.format)) {
      return { pass: false, reason: 'movie-vs-tv-request' }
    }
    // OVA / Special leaking into TV season request
    if (RESOLVER_SPECIAL_FORMATS.has(tag.branch.format) && RESOLVER_TV_FORMATS.has(requested.format)) {
      return { pass: false, reason: 'special-vs-tv-request' }
    }
    // Alternative version leaking across request
    if (tag.branch.format === 'MOVIE' && requestFormat && requestFormat !== 'MOVIE') {
      return { pass: false, reason: 'wrong-format' }
    }
  }
  return { pass: true }
}

// Gate: branch match (requestAnimationFrame). For a TV season request, the
// branch we resolved the release to must be the requested branch (same AniList
// id), OR a TV branch whose seasonInFranchise matches requestSeason.
export function gateBranch (norm, { canonical, requestSeason, requestFormat }) {
  if (!canonical) return { pass: null }
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat)
  if (!requested) return { pass: null }
  const tag = tagBranch(norm, canonical)
  if (!tag.branch) return { pass: null }
  if (tag.branch.anilist === requested.anilist) return { pass: true }
  // Same format family AND season number aligned -> accept (handles per-cour
  // AniList splits that resolve to the same continuous TV chain we built).
  if (tag.branch.format === requested.format &&
      tag.branch.seasonInFranchise === requested.seasonInFranchise) {
    return { pass: true }
  }
  return { pass: false, reason: 'wrong-branch' }
}

// Gate: movie vs TV. If the user asked for a TV episode, reject a release that
// is clearly a movie (Movie/Film keyword + no episode marker), and vice versa.
export function gateMovieVsTv (norm, { requestFormat, mode }) {
  if (mode === 'movie') {
    if (norm.isBatch && norm.episode == null) return { pass: false, reason: 'batch-for-movie' }
    return { pass: null }
  }
  // mode 'single' (TV episode) — reject releases that look like movies.
  // Be conservative: only reject if title literally says "movie"/"film" and
  // there's no episode number AND no batch range. A "movie 1 - 02" would still
  // pass this gate (admittedly weird case) and gets handled by the franchise
  // gate above.
  if (norm.isMovie && norm.episode == null && !norm.isBatch) {
    return { pass: false, reason: 'movie-release-for-tv-request' }
  }
  return { pass: null }
}

// Gate: OVA/special vs TV season (when the canonical entity has both, only
// accept releases from the branch the user actually wanted).
export function gateOvaVsSeason (norm, { canonical, requestFormat, requestSeason }) {
  if (!canonical) return { pass: null }
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat)
  if (!requested) return { pass: null }
  if (RESOLVER_TV_FORMATS.has(requested.format) && norm.isOva && !norm.isBatch) {
    // Only reject if OVA branches exist in the franchise (otherwise we'd nuke
    // legitimate OVA-only shows).
    if (canonical.byFormat.special.length > 0) {
      return { pass: false, reason: 'ova-for-tv-request' }
    }
  }
  return { pass: null }
}

// Gate: episode impossible. Reject when a release episode number is set but
// exceeds the requested branch's total episodeCount, or comes back as a
// negative / NaN.
export function gateEpisodeRange (norm, { canonical, requestSeason, requestFormat }) {
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat)
  if (!requested || !requested.episodeCount) return { pass: null }
  if (norm.episode != null && norm.episode > requested.episodeCount && !norm.isBatch) {
    return { pass: false, reason: 'episode-exceeds-branch(' + norm.episode + '>' + requested.episodeCount + ')' }
  }
  return { pass: null }
}

// Gate: air date impossible. If we know the requested branch started airing on
// a specific date, any release dated strictly before that date is impossible
// (negative 1-week slack covers pre-air leaks / preview screenings).
export function gateAirDate (norm, { canonical, requestSeason, requestFormat }) {
  const requested = pickRequestedBranch(canonical, requestSeason, requestFormat)
  if (!requested || !requested.startDate || !requested.startDate.year) return { pass: null }
  const start = new Date(
    requested.startDate.year,
    (requested.startDate.month || 1) - 1,
    requested.startDate.day || 1
  ).getTime()
  if (!Number.isFinite(start)) return { pass: null }
  const slack = 14n * 24n * 60n * 60n * 1000n
  const releasedAt = BigInt(norm.date instanceof Date ? norm.date.getTime() : (norm.date || 0))
  if (releasedAt < BigInt(start) - slack) {
    return { pass: false, reason: 'airdate-impossible' }
  }
  return { pass: null }
}

// Choose the canonical branch the request most likely refers to. Honours an
// explicit format when the source surfaces one (movie mode), and falls back to
// the season-in-franchise the user requested.
export function pickRequestedBranch (canonical, requestSeason, requestFormat) {
  if (!canonical) return null
  if (requestFormat === 'MOVIE') {
    return canonical.byFormat.movie[0] || null
  }
  if (requestSeason != null) {
    const tv = canonical.byFormat.tv
      .find(b => b.seasonInFranchise === requestSeason)
    if (tv) return tv
  }
  // Otherwise assume the seed (= the AniList ID the request was made for).
  return canonical.branches.find(b => b.anilist === canonical.seedAnilist) || null
}

// Run all gates. Returns the original normalized torrent if every gate either
// passed or did not apply; returns null with a reason when a gate rejected.
export function validate (norm, env) {
  const reasons = []
  for (const gate of GATES) {
    let r
    try { r = gate(norm, env) } catch { r = { pass: null } }
    if (r && r.pass === false) {
      reasons.push(r.reason || gate.name)
      return { ok: false, reasons }
    }
    if (r && r.reason) reasons.push(r.reason)
  }
  return { ok: true, reasons }
}

export const GATES = [
  gateFranchise,
  gateMovieVsTv,
  gateOvaVsSeason,
  gateBranch,
  gateEpisodeRange,
  gateAirDate
]

export { branchMatchesRequest }
