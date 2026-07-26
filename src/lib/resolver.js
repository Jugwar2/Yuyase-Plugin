// Canonical Resolver + Franchise Graph.
// Invariant 1: one canonical entity per anime. Every search starts from an
// AniList ID and resolves into a single canonical representation that includes
// every sibling branch (TV seasons, movies, OVAs, side stories). The branch
// list is what lets us REJECT a "Season 2" release of the wrong sibling
// (Cinderella Gray leak into a Pretty Derby S2 search) instead of merely
// down-ranking it.

import { httpGet } from './shared.js'

const ANILIST_API = 'https://graphql.anilist.co'

// Per-relation formats we treat as separate branches of the same franchise.
// SEQUEL/PREQUEL chains within TV/ONA/TV_SHORT are merged into one continuous
// branch with a rising "seasonInFranchise" counter, not separate branches, so
// "Uma Musume S2" and "Uma Musume S1" share a branch (the user's season number
// disambiguates). Spin-off TV entries (Cinderella Gray) are their OWN branch.
const TV_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA'])
const MOVIE_FORMATS = new Set(['MOVIE'])
const SPECIAL_FORMATS = new Set(['SPECIAL', 'OVA', 'ONA'])

// Relations that connect branches of the same franchise (so they belong in the
// graph at all). We exclude ADAPTATION/DRAFT/CHARACTER/etc — those are source
// material links, not in-universe branches.
const FRANCHISE_RELATIONS = new Set([
  'SEQUEL', 'PREQUEL', 'SIDE_STORY', 'PARENT_STORY', 'SPIN_OFF',
  'ALTERNATIVE', 'ALTERNATIVE_VERSION', 'OTHER', 'CHARACTER', 'COMPILATION'
])

const cache = new Map() // anilistId -> Promise<CanonicalEntity | null>

function gql (query, variables) {
  return httpGet(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables })
  }).then(res => res.ok ? res.json() : null).catch(() => null)
}

// Strip season/arc/year markers off a title so the *franchise* key is stable.
// "Uma Musume: Pretty Derby" and "Uma Musume: Pretty Derby Season 2" should
// both fold to "uma musume pretty derby".
export function franchiseKey (title) {
  return String(title || '')
    .replace(/:/g, ' ')
    .replace(/\bseason\s*\d+/gi, ' ')
    .replace(/\bS\d{1,2}(?:E\d|\b)/gi, ' ')
    .replace(/\b\d+(st|nd|rd|th)\s+season\b/gi, ' ')
    .replace(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/gi, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
}

// Normalize a list of titles into one normalized candidate set a release must
// match at least one token of to even be considered "this branch".
export function branchTokens (titles) {
  const out = new Set()
  for (const t of titles || []) {
    for (const tok of String(t).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)) {
      if (tok.length >= 3) out.add(tok)
    }
  }
  return out
}

// Trim a title down to its franchise-root form (no season markers, no
// subtitles), so S1 and S2 of the same TV branch share a root.
export function franchiseRoot (titles) {
  if (!titles || !titles.length) return ''
  // Pick the shortest title (usually the franchise name) and strip season/year
  const shortest = titles.slice().sort((a, b) => a.length - b.length)[0]
  return String(shortest)
    .replace(/\s*:\s*.*/, '')
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\b\d+(st|nd|rd|th)\s+season\b/gi, '')
    .replace(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
}

// Convert one AniList Media node into a branch descriptor.
function toBranch (media, seasonGuess) {
  const titles = [
    media?.title?.romaji, media?.title?.english, media?.title?.native,
    ...(media?.synonyms || [])
  ].filter(Boolean)
  return {
    anilist: media?.id,
    idMal: media?.idMal || null,
    anidb: null, // filled later from animetosho mapping if available
    format: media?.format || null,
    type: media?.type || 'ANIME',
    seasonInFranchise: seasonGuess || 1,
    episodeCount: media?.episodes || null,
    startDate: media?.startDate || null,
    titles,
    franchiseRoot: franchiseRoot(titles),
    tokens: branchTokens(titles)
  }
}

// Walk the AniList relation graph from a seed entry, BFS over
// FRANCHISE_RELATIONS, building a flat list of every connected branch. SEQUEL/
// PREQUEL runs between TV_FORMATS media are serialized into one branch with a
// rising season number; everything else becomes its own branch.
export async function resolveCanonical (anilistId) {
  const id = Number(anilistId)
  if (!Number.isInteger(id) || id <= 0) return null

  const key = String(id)
  if (cache.has(key)) return cache.get(key)

  cache.set(key, (async () => {
    const visited = new Set()
    const branches = []
    let queue = [{ id, depth: 0 }]

    const seed = await gql(
      'query($id:Int){Media(id:$id,type:ANIME){id idMal format episodes startDate{year month day} title{romaji english native} synonyms}}',
      { id }
    )
    if (!seed?.data?.Media) return null
    branches.push(toBranch(seed.data.Media, 1))
    visited.add(id)

    // BFS up to 2 hops — anything beyond is almost always an unrelated spinoff
    // (e.g. character cameos counted).
    while (queue.length) {
      const next = []
      for (const { id: cur, depth } of queue) {
        if (depth >= 2) continue
        const r = await gql(
          'query($id:Int){Media(id:$id,type:ANIME){id idMal format episodes startDate{year month day} title{romaji english native} synonyms relations{edges{relationType}relations:edges{node{id idMal type format episodes startDate{year month day} title{romaji english native} synonyms}}}}}',
          { id: cur }
        )
        const edges = r?.data?.Media?.relations?.relations || []
        for (const e of edges) {
          const sib = e?.node
          if (!sib || sib.type !== 'ANIME') continue
          if (visited.has(sib.id)) continue
          visited.add(sib.id)
          branches.push(toBranch(sib, 1))
          if (depth + 1 < 2) next.push({ id: sib.id, depth: depth + 1 })
        }
      }
      queue = next
    }

    // Serialize the TV SEQUEL/PREQUEL chain of the seed: walk PREQUEL up and
    // SEQUEL down, assigning seasonInFranchise so the user's season number
    // (which is the franchise-season, not the AniList cour) maps correctly.
    await annotateTvChain(branches, id)

    // Franchise key = most common franchiseRoot across branches (the seed wins
    // ties). This lets filters reject a release whose root doesn't agree.
    const franchiseRoot = pickFranchiseRoot(branches, id)

    return {
      anilist: id,
      titles: branches[0].titles,
      franchiseRoot,
      branches,
      seedAnilist: id,
      // Per-branch quick lookup tables reused by filters.
      byFormat: {
        tv: branches.filter(b => TV_FORMATS.has(b.format)),
        movie: branches.filter(b => MOVIE_FORMATS.has(b.format)),
        special: branches.filter(b => SPECIAL_FORMATS.has(b.format))
      }
    }
  })())

  return cache.get(key)
}

// Annotate the TV-format PREQUEL/SEQUEL chain containing the seed with rising
// seasonInFranchise counters, so a search for "season 2" can be matched against
// the right branch and rejected against a sibling TV spinoff (Cinderella Gray).
async function annotateTvChain (branches, seedId) {
  // We already gathered sibling media in the BFS pass; trust their format
  // annotations and walk PREQUEL from the seed upward.
  const byId = new Map(branches.map(b => [b.anilist, b]))
  const seed = byId.get(seedId)
  if (!seed || !TV_FORMATS.has(seed.format)) return

  // Walk PREQUEL chain from seed upward counting seasons back to 1.
  let cursor = seedId
  let backCount = 0
  const seen = new Set([seedId])
  while (backCount < 12) {
    const r = await gql(
      'query($id:Int){Media(id:$id,type:ANIME){id format relations{edges{relationType node{id format}}}}}',
      { id: cursor }
    )
    const prequel = (r?.data?.Media?.relations?.edges || [])
      .find(e => e.relationType === 'PREQUEL' && TV_FORMATS.has(e.node?.format) && !seen.has(e.node.id))
    if (!prequel) break
    seen.add(prequel.node.id)
    cursor = prequel.node.id
    backCount++
    const b = byId.get(prequel.node.id)
    if (b) b.seasonInFranchise = (b.seasonInFranchise || 1)
  }
  seed.seasonInFranchise = backCount + 1

  // Walk SEQUEL chain downward marking future seasons.
  cursor = seedId
  let fwdCount = 0
  const seenF = new Set([seedId])
  while (fwdCount < 12) {
    const r = await gql(
      'query($id:Int){Media(id:$id,type:ANIME){id format relations{edges{relationType node{id format}}}}}',
      { id: cursor }
    )
    const sequel = (r?.data?.Media?.relations?.edges || [])
      .find(e => e.relationType === 'SEQUEL' && TV_FORMATS.has(e.node?.format) && !seenF.has(e.node.id))
    if (!sequel) break
    seenF.add(sequel.node.id)
    cursor = sequel.node.id
    fwdCount++
    const b = byId.get(sequel.node.id)
    if (b) b.seasonInFranchise = seed.seasonInFranchise + fwdCount
  }
}

function pickFranchiseRoot (branches, seedId) {
  const seed = branches.find(b => b.anilist === seedId)
  if (seed && seed.franchiseRoot) return seed.franchiseRoot
  const counts = new Map()
  for (const b of branches) {
    if (!b.franchiseRoot) continue
    counts.set(b.franchiseRoot, (counts.get(b.franchiseRoot) || 0) + 1)
  }
  if (!counts.size) return ''
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// Truthy if the requested branch (by searchParams) is a TV branch whose
// franchise-season equals `season`. Used by filters to accept the right branch
// and reject sibling TV spinoffs that happen to share season numerals.
export function branchMatchesRequest (branch, { season, format }) {
  if (!branch) return false
  if (format && branch.format && branch.format !== format && !formatsCompatible(branch.format, format)) return false
  if (season != null && TV_FORMATS.has(branch.format)) {
    return branch.seasonInFranchise === season
  }
  return true
}

function formatsCompatible (a, b) {
  if (a === b) return true
  // TV/ONA/TV_SHORT collapse to one "TV-ish" bucket for branch acceptance.
  const tvIsh = new Set(['TV', 'TV_SHORT', 'ONA'])
  if (tvIsh.has(a) && tvIsh.has(b)) return true
  return false
}

// Public entry point used by shared.js's searchContext: resolve the canonical
// entity for the query and stash it on the context for filters to use later.
// Never throws; on failure returns null and filters gracefully fall back to
// the legacy token logic.
export async function attachCanonical (query, ctx) {
  try {
    const entity = query.anilistId
      ? await resolveCanonical(query.anilistId)
      : null
    return { ...ctx, canonical: entity }
  } catch {
    return ctx
  }
}

// Convenience for tests: clear the cache so a fresh GraphQL walk runs again.
export function clearResolverCache () { cache.clear() }

// Test-only helper: inject a precomputed canonical entity so tests can exercise
// the gates/scorer offline without hitting AniList GraphQL. The mock should
// contain the same shape resolveCanonical returns.
export function __setCanonicalForTest (entity) {
  if (!entity || !entity.anilist) return
  cache.set(String(entity.anilist), Promise.resolve(entity))
}

export const RESOLVER_TV_FORMATS = TV_FORMATS
export const RESOLVER_MOVIE_FORMATS = MOVIE_FORMATS
export const RESOLVER_SPECIAL_FORMATS = SPECIAL_FORMATS
