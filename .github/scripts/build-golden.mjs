// Build test/golden/*.json from the db-titles snapshot.
// Each golden file is a self-contained test case: canonical entity (cached
// from AniList) + synthetic releases + expected correct/reject assertions.
// The harness in test/golden-harness.test.mjs reads all JSON in test/golden/
// and exercises the full normalize → tagBranch → validate pipeline.

import { readFile, writeFile, mkdir } from 'node:fs/promises'

const db = JSON.parse(await readFile(new URL('../../test/fixtures/db-titles.json', import.meta.url), 'utf8'))
const byId = new Map(db.map(e => [e.anilistId, e]))

function golden (anilistId, requestSeason, releases) {
  const entry = byId.get(anilistId)
  if (!entry) throw new Error('no fixture for anilistId=' + anilistId)
  const canonical = JSON.parse(JSON.stringify(entry.canonical))
  return {
    name: entry.note,
    query: { anilistId, episode: 2, season: requestSeason, resolution: '1080' },
    canonical,
    releases: releases.map(f => ({ title: f[0], expectCorrect: f[1] }))
  }
}

const cases = [
  // Uma Musume S2 — the original reason for the canonical pipeline
  [124223, 2, [
    ['[SubsPlease] Uma Musume: Pretty Derby Season 2 - 02 (1080p) [HASH].mkv', true],
    ['[SuPReqE] Uma Musume: Pretty Derby Season 2 - 02 (720p) [AVC].mkv', true],
    ['[Erai-raws] Umamusume: Pretty Derby S2 - 02 [1080p][MultiSub]', true],
    ['[EraRaw] Uma Musume: Cinderella Gray - 02 [1080p]', false],
    ['[SubsPlease] Uma Musume: Pretty Derby Season 1 - 02 (1080p) [HASH].mkv', false],
    ['Uma Musume: Pretty Derby ROAD TO THE TOP - 02 (2023) [HEVC].mkv', false],
    ['[MovieSource] Uma Musume: Pretty Derby - Shin Jidai no Tobira (2024) [HEVC].mkv', false]
  ]],
  // Fate UBW — sibling Fate/Zero, Fate/stay night 2006
  [19603, 3, [
    ['[SubsPlease] Fate/stay night: Unlimited Blade Works - 02 (1080p) [HASH].mkv', true],
    ['[EraRaw] Fate/stay night: Unlimited Blade Works S3 - 02 [1080p]', true],
    ['[SubsPlease] Fate/Zero - 02 (1080p) [HASH].mkv', false],
    ['[SubsPlease] Fate/stay night: Heaven\'s Feel I. presage flower - MOVIE [1080p].mkv', false]
  ]],
  // Re:Zero S2
  [108632, 2, [
    ['[SubsPlease] Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season - 02 (1080p) [CC6D217F].mkv', true],
    ['[EraRaw] Re:ZERO -Starting Life in Another World- Season 2 - 02 [1080p]', true],
    ['[SubsPlease] Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season - 02 (1080p) [HASH].mkv', false]
  ]],
  // Bleach TYBW — wrong season (original BLEACH, TYBW Part 2 at wrong ep)
  [116674, 2, [
    ['[SubsPlease] BLEACH: Sennen Kessen-hen - 02 (1080p) [HASH].mkv', true],
    ['[EraRaw] BLEACH: The Thousand-Year Blood War - 02 [1080p]', true],
    ['[SubsPlease] BLEACH: Sennen Kessen-hen - Ketsubetsu-tan - 02 (1080p) [HASH].mkv', false]
  ]],
  // Frieren S1
  [154587, 1, [
    ['[SubsPlease] Sousou no Frieren - 02 (1080p) [HASH].mkv', true],
    ['[EraRaw] Frieren: Beyond Journey\'s End - 02 [1080p]', true],
    ['[SubsPlease] Sousou no Frieren 2nd Season - 02 (1080p) [HASH].mkv', false]
  ]]
]

await mkdir('test/golden', { recursive: true })
for (const c of cases) {
  const g = golden(c[0], c[1], c[2])
  const clean = (g.name || 'case').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase().slice(0, 50)
  await writeFile('test/golden/' + clean + '.json', JSON.stringify(g, null, 2))
  console.error('wrote', g.name, '-', g.releases.length, 'releases')
}

console.error('DONE', cases.length, 'golden files')