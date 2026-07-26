// Refresh test/fixtures/db-titles.json: pulls 5 well-known multi-season /
// multi-branch franchises from AniList and snapshots BOTH the AniList media
// entry AND the canonical entity our resolver produces from it. The accuracy
// test (test/db-titles.test.mjs) then runs fully offline against the snapshot,
// so CI is deterministic. Run: npm run fetch:db-titles (network required).

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { resolveCanonical } from '../../src/lib/resolver.js'

// Five franchises chosen to exercise:
//   - long sequel chain (Frieren / Re:Zero / Demon Slayer)
//   - sibling TV spin-off (Uma Musume S2 vs Cinderella Gray)
//   - season-marker ambiguity (Bleach TYBW vs original Bleach)
//   - movie-vs-TV branches (Fate)
// Each entry is the SEASON the user would actually search for; the script
// resolves the full franchise graph from that entry's AniList ID.
const TARGETS = [
  { anilistId: 154587, note: 'Frieren S1 (TV)' },
  { anilistId: 124223, note: 'Uma Musume S2 (TV; sibling Cinderella Gray)' },
  { anilistId: 108632, note: 'Re:Zero S2 (TV)' },
  { anilistId: 116674, note: 'Bleach TYBW (TV; sequel of long S1 chain)' },
  { anilistId: 19603, note: 'Fate/stay night UBW (TV; sibling Fate/Zero)' }
]

const MEDIA_Q = `
query($id:Int){Media(id:$id,type:ANIME){
  id title{romaji english native} synonyms
  format episodes startDate{year month day}
}}`

async function fetchMedia (id) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: MEDIA_Q, variables: { id } })
  })
  if (!res.ok) { console.error('media fetch fail', id, res.status); return null }
  const j = await res.json()
  return j?.data?.Media || null
}

const out = []
const todo = process.env.TARGET_IDS
  ? TARGETS.filter(t => process.env.TARGET_IDS.split(',').map(Number).includes(t.anilistId))
  : TARGETS
for (const t of todo) {
  const media = await fetchMedia(t.anilistId)
  if (!media) continue
  const canonical = await resolveCanonical(t.anilistId)
  if (canonical?.branches) {
    for (const b of canonical.branches) {
      if (b.tokens instanceof Set) b.tokens = [...b.tokens]
    }
  }
  out.push({
    note: t.note,
    anilistId: t.anilistId,
    requestSeason: canonical?.branches?.find(b => b.anilist === t.anilistId)?.seasonInFranchise ?? 1,
    media: {
      id: media.id,
      romaji: media.title?.romaji || null,
      english: media.title?.english || null,
      native: media.title?.native || null,
      synonyms: media.synonyms || [],
      format: media.format,
      episodes: media.episodes,
      startDate: media.startDate
    },
    canonical
  })
  console.error('fetched', t.note, 'branches:', canonical?.branches?.length || 0)
  await new Promise(r => setTimeout(r, 1800))
}

// Merge with existing fixture so partial fetch is additive
let merged
try {
  const existing = JSON.parse(await readFile(new URL('../../test/fixtures/db-titles.json', import.meta.url), 'utf8'))
  const byId = new Map(existing.map(e => [e.anilistId, e]))
  for (const e of out) byId.set(e.anilistId, e)
  merged = [...byId.values()].sort((a, b) => a.anilistId - b.anilistId)
} catch {
  merged = out
}

await mkdir('test/fixtures', { recursive: true })
await writeFile('test/fixtures/db-titles.json', JSON.stringify(merged, null, 2))
console.error('WROTE', merged.length, 'franchises to test/fixtures/db-titles.json')
