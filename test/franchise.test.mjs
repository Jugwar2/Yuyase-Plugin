// Offline regression test for the canonical pipeline (gates + scorer).
//
// Reproduces the Umamusume Pretty Derby S02E02 leak from the issue report:
// searching for season 2 episode 2 of Uma Musume: Pretty Derby must NOT return
// results from sibling branches of the same franchise — Uma Musume: Cinderella
// Gray (TV spinoff), Uma Musume: Pretty Derby - Road to the Top / BNW (OVAs),
// or any Uma Musume theatrical Movie. Only true Pretty Derby S2 E02 releases
// should survive the hard gates.
//
// Runs entirely offline by stubbing the resolver cache and feeding canned raw
// results directly through the new pipeline. Run: npm run test:franchise

import { canonicalShapeAll, searchContext } from '../src/lib/shared.js'
import { clearResolverCache, __setCanonicalForTest } from '../src/lib/resolver.js'

// ── Mock canonical entity for Uma Musume: Pretty Derby ──────
// This is a synthetic self-consistent entity injected via __setCanonicalForTest.
// The branch IDs and seedAnilist are internal mock values — the test exercises
// the gate/rejection pipeline offline; real AniList IDs differ and are covered
// by test:db-titles and test:golden.
const UMA_FRACTURE = {
  anilist: 12053,                 // Uma Musume: Pretty Derby (TV, 2021)
  titles: ['ウマ娘 プリティーダービー', 'Uma Musume: Pretty Derby', 'Uma Musume: Pretty Derby Season 2', 'Pretty Derby'],
  franchiseRoot: 'uma musume pretty derby',
  branches: [
    { anilist: 12053, idMal: 41491, anidb: null,
      format: 'TV', type: 'ANIME',
      seasonInFranchise: 2, episodeCount: 13,
      startDate: { year: 2021, month: 1, day: 5 },
      titles: ['ウマ娘 プリティーダービー Season 2', 'Uma Musume: Pretty Derby Season 2', 'Pretty Derby Season 2'],
      franchiseRoot: 'uma musume pretty derby',
      tokens: new Set(['uma', 'musume', 'pretty', 'derby', 'season']) },
    { anilist: 36790, idMal: 54930, anidb: null,
      format: 'TV', type: 'ANIME',
      seasonInFranchise: 1, episodeCount: 12,
      startDate: { year: 2025, month: 4, day: 6 },
      titles: ['ウマ娘 シンデレラグレイ', 'Uma Musume: Cinderella Gray', 'Cinderella Gray'],
      franchiseRoot: 'uma musume cinderella gray',
      tokens: new Set(['uma', 'musume', 'cinderella', 'gray']) },
    { anilist: 24715, idMal: 51674, anidb: null,
      format: 'OVA', type: 'ANIME',
      seasonInFranchise: 1, episodeCount: 1,
      startDate: { year: 2020, month: 3, day: 27 },
      titles: ['ウマ娘 プリティーダービー Road to the Top', 'Uma Musume: Pretty Derby - Road to the Top'],
      franchiseRoot: 'uma musume pretty derby road to the top',
      tokens: new Set(['uma', 'musume', 'pretty', 'derby', 'road', 'the', 'top']) },
    { anilist: 42867, idMal: 49591, anidb: null,
      format: 'MOVIE', type: 'ANIME',
      seasonInFranchise: 1, episodeCount: 1,
      startDate: { year: 2024, month: 5, day: 10 },
      titles: ['ウマ娘 プリティーダービー 新時代の扉', 'Uma Musume: Pretty Derby - Beginning of a New Era'],
      franchiseRoot: 'uma musume pretty derby beginning new era',
      tokens: new Set(['uma', 'musume', 'pretty', 'derby', 'beginning', 'new', 'era']) }
  ],
  seedAnilist: 12053,
  byFormat: {} // populated below
}
UMA_FRACTURE.byFormat.tv = UMA_FRACTURE.branches.filter(b => b.format === 'TV')
UMA_FRACTURE.byFormat.movie = UMA_FRACTURE.branches.filter(b => b.format === 'MOVIE')
UMA_FRACTURE.byFormat.special = UMA_FRACTURE.branches.filter(b => b.format === 'OVA')

clearResolverCache()
__setCanonicalForTest(UMA_FRACTURE)

// ── Synthetic raw results for a Uma Musume S2 E02 search ───────────────────
// These mirror real release-group title conventions (SubsPlease, Erai-raws,
// film groups). The hasher field is just a stable identifier for the test
// runner; the pipeline doesn't inspect it.
const recent = new Date(Date.now() - 7 * 86400000) // 7 days ago
const longAgo = new Date('2024-05-10T00:00:00Z')
const ovaAge = new Date('2020-05-01T00:00:00Z')
const s1Age = new Date('2018-10-15T00:00:00Z') // S1 aired 2018

const rawResults = [
  // ✅ legitimate: Pretty Derby Season 2, Episode 2 — MUST survive
  { title: '[SubsPlease] Uma Musume: Pretty Derby Season 2 - 02 (1080p) [HEVC]',
    hash: 'a'.repeat(40), seeders: 320, leechers: 14, downloads: 1200, size: 580_000_000,
    date: recent, accuracy: 'medium', source: 'nyaa' },

  // ❌ Cinderella Gray E02 — sibling TV spinoff, MUST be rejected
  { title: '[SubsPlease] Uma Musume: Cinderella Gray - 02 (1080p) [HEVC]',
    hash: 'b'.repeat(40), seeders: 280, leechers: 11, downloads: 900, size: 570_000_000,
    date: recent, accuracy: 'medium', source: 'nyaa' },

  // ❌ Pretty Derby Season 1 E02 — wrong season of the right branch
  { title: '[Erai-raws] Uma Musume: Pretty Derby - 02 [1080p][MultiSub]',
    hash: 'c'.repeat(40), seeders: 12, leechers: 1, downloads: 80, size: 600_000_000,
    date: s1Age, accuracy: 'medium', source: 'nyaa' },

  // ❌ Road to the Top (NEW ERA) OVA — wrong branch type
  { title: '[Group] Uma Musume: Pretty Derby - Road to the Top (1080p) [BD]',
    hash: 'd'.repeat(40), seeders: 50, leechers: 2, downloads: 400, size: 8_500_000_000,
    date: ovaAge, accuracy: 'medium', source: 'nyaa' },

  // ❌ Movie: Beginning of a New Era — wrong format
  { title: '[Kawaiika-Raws] Uma Musume: Pretty Derby - Beginning of a New Era (2024) [1080p].mkv',
    hash: 'e'.repeat(40), seeders: 70, leechers: 3, downloads: 600, size: 7_900_000_000,
    date: longAgo, accuracy: 'medium', source: 'nyaa' }
]

// ── Build the search context identical to nyaa.js ───────────────────────────
const query = {
  anilistId: 12053,
  titles: [
    'ウマ娘 プリティーダービー Season 2',
    'Uma Musume: Pretty Derby Season 2',
    'Pretty Derby Season 2'
  ],
  episode: 2,
  exclusions: [],
  resolution: '1080'
}

const ctx = searchContext(query, 'single')
const shaped = await canonicalShapeAll(rawResults, ctx, 'medium', query)

const expectedHash = 'a'.repeat(40)
const survivingTitles = shaped.map(r => r.title)
const survivingHashes = new Set(shaped.map(r => r.hash.toLowerCase()))
const keptS1 = survivingHashes.has('c'.repeat(40))
const keptCinderella = survivingHashes.has('b'.repeat(40))
const keptOva = survivingHashes.has('d'.repeat(40))
const keptMovie = survivingHashes.has('e'.repeat(40))
const keptReal = survivingHashes.has('a'.repeat(40))

let failures = []
function check (label, cond) {
  if (cond) {
    console.log('  PASS  ' + label)
  } else {
    console.log('  FAIL  ' + label)
    failures.push(label)
  }
}

console.log('\nUma Musume: Pretty Derby S2 E02 — gate rejection test\n')
check('correct S2E02 release survives', keptReal)
check('Cinderella Gray rejected', !keptCinderella)
check('Season 1 E02 (wrong season) rejected', !keptS1)
check('Road to the Top OVA rejected', !keptOva)
check('New Era Movie rejected', !keptMovie)

console.log('\nSurvivors:')
for (const t of survivingTitles) console.log('  - ' + t)

console.log('\n' + (failures.length ? 'FAILED: ' + failures.join(', ') : 'PASSED') + '\n')
process.exit(failures.length ? 1 : 0)
