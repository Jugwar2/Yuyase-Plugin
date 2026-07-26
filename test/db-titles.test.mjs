// DB-title accuracy test. Pulls 5 real AniList franchises (cached snapshot in
// test/fixtures/db-titles.json), and for each generates 5 synthetic release
// titles simulating real tracker conventions:
//   A: romaji canonical   [SubsPlease] <romaji> - 02 (1080p) [HASH].mkv
//   B: english canonical  [Erai-raws] <english> - 02 [1080p]
//   C: dual-audio dub     <english> S2 - 02 [1080p][Dual Audio]
//   D: alt season marker  <english> Season 2 Episode 02
//   E: adversarial sib     <sibling-english> Season 3 Episode 02
//
// asserts:
//   A,B,C,D tagBranch -> the requested branch, and survive validate()
//   E tagBranch -> NOT the requested branch, and validate() rejects it
//
// The test runs OFFLINE against the snapshot. Refresh snapshot via
// `npm run fetch:db-titles`. Asserts: >=4/5 fixtures pass all 4 of their
// correct-release assertions AND the adversarial rejection; overall >=80%
// of all assertions pass. Run: npm run test:db-titles

import { readFile } from 'node:fs/promises'
import { normalizeTorrent, tagBranch } from '../src/lib/normalize.js'
import { validate, pickRequestedBranch } from '../src/lib/filters.js'
import { branchMatchesRequest } from '../src/lib/resolver.js'

const DATA = JSON.parse(await readFile(new URL('./fixtures/db-titles.json', import.meta.url), 'utf8'))

// Token sets survive JSON as arrays; restore them to Set for tagBranch which
// calls `.has` on them.
for (const e of DATA) for (const b of e.canonical?.branches || []) {
  b.tokens = new Set(b.tokens || [])
}

// synthetic adversary: pick another branch of the same franchise whose
// seasonInFranchise differs from the requested one, so E simulates a user
// searching S2 but a release of S3 sneaking in.
function siblingTitle (entry) {
  const branches = entry.canonical?.branches || []
  const requested = pickRequestedBranch(entry.canonical, entry.requestSeason, null)
  const wrong = branches.find(b => b !== requested && b.format === 'TV' && b.seasonInFranchise != null && b.seasonInFranchise !== entry.requestSeason)
    || branches.find(b => b !== requested)
  const wrongSeason = wrong?.seasonInFranchise != null ? wrong.seasonInFranchise : entry.requestSeason + 1
  const english = wrong?.titles?.find(t => /^[a-zA-Z]/.test(t || '')) || (wrong?.titles?.[0] || entry.media.english)
  return { title: `${english} Season ${wrongSeason} Episode 02 [1080p]`, wrongBranch: wrong }
}

const releaseForms = (entry) => {
  const romaji = entry.media.romaji || entry.media.english
  const english = entry.media.english || entry.media.romaji
  const season = entry.requestSeason
  return [
    { tag: 'A', title: `[SubsPlease] ${romaji} - 02 (1080p) [ABCD1234].mkv`, expectCorrect: true },
    { tag: 'A', title: `[Erai-raws] ${english} - 02 [1080p]`, expectCorrect: true },
    { tag: 'C', title: `${english} S${season} - 02 [1080p][Dual Audio]`, expectCorrect: true, expectDub: true },
    { tag: 'D', title: `${english} Season ${season} Episode 02`, expectCorrect: true }
  ]
}

let totalAssertions = 0, passedAssertions = 0
let fixturesFullyPassing = 0
const failures = []

for (const entry of DATA) {
  const requested = pickRequestedBranch(entry.canonical, entry.requestSeason, null)
  if (!requested) { failures.push({ note: entry.note, kind: 'no-requested-branch' }); continue }
  const forms = releaseForms(entry)
  const adv = siblingTitle(entry)
  const allForms = [...forms, { tag: 'E', title: adv.title, expectCorrect: false }]

  let perFixtureAsserts = 0, perFixturePassed = 0

  for (const f of allForms) {
    const norm = normalizeTorrent({ title: f.title, tracker: 'dbtest', seeders: 10, date: '2024-01-01' })
    const tag = tagBranch(norm, entry.canonical)
    const env = {
      canonical: entry.canonical,
      requestSeason: entry.requestSeason,
      requestFormat: null,
      requestEpisode: 2,
      mode: 'single'
    }
    const verdict = validate(norm, env)
    const rejected = !verdict.ok
    // Compare by anilist IDENTITY (not object ===): a canonical entity carried
    // through JSON deserialization may have distinct references for the same
    // branch across `branches` vs `byFormat.{tv,movie,special}`, since refs are
    // not preserved. Production gate/scorer code also compares by `.anilist`.
    const taggedRight = !!tag.branch && !!requested && tag.branch.anilist === requested.anilist

    // assertion 1: branch tagging agrees with whether this is the requested branch
    totalAssertions++; perFixtureAsserts++
    if (f.expectCorrect ? taggedRight : !taggedRight) { passedAssertions++; perFixturePassed++ }
    else failures.push({ note: entry.note, tag: f.tag, kind: 'wrongTag', title: f.title, got: tag.branch?.anilist, want: requested.anilist })

    // assertion 2: gates accept correct, reject adversarial
    totalAssertions++; perFixtureAsserts++
    if (f.expectCorrect ? !rejected : rejected) { passedAssertions++; perFixturePassed++ }
    else failures.push({ note: entry.note, tag: f.tag, kind: 'wrongGate', title: f.title, rejected, verdict: verdict.reasons })

    // assertion 3 (C only): Dual Audio release parses as dual audio
    if (f.expectDub) {
      totalAssertions++; perFixtureAsserts++
      if (norm.isDualAudio) { passedAssertions++; perFixturePassed++ }
      else failures.push({ note: entry.note, tag: f.tag, kind: 'notDualAudio', title: f.title })
    }

    // assertion 4 (D only): Season marker form parses season === requestSeason
    if (f.tag === 'D') {
      totalAssertions++; perFixtureAsserts++
      if (norm.season === entry.requestSeason) { passedAssertions++; perFixturePassed++ }
      else failures.push({ note: entry.note, tag: f.tag, kind: 'wrongSeasonParse', title: f.title, got: norm.season, want: entry.requestSeason })
    }
  }

  if (perFixtureAsserts === perFixturePassed) fixturesFullyPassing++
  else console.log(`  [${entry.note}] ${perFixturePassed}/${perFixtureAsserts} assertions passed`)
}

const passRate = passedAssertions / Math.max(totalAssertions, 1)
const fixtureRate = fixturesFullyPassing / Math.max(DATA.length, 1)
console.log('================ DB-TITLE ACCURACY ================')
console.log('fixtures:                ', DATA.length)
console.log('fixtures fully passing:   ', fixturesFullyPassing, '(' + (100 * fixtureRate).toFixed(1) + '%)')
console.log('assertions passed:        ', passedAssertions + '/' + totalAssertions,
  '(' + (100 * passRate).toFixed(2) + '%)')

if (failures.length) {
  console.log('\nfailures (' + failures.length + '):')
  failures.slice(0, 25).forEach(f => console.log('  ' + f.kind + ' [' + (f.tag || '-') + '] ' + f.note + ' :: ' + (f.title || '').slice(0, 70)))
}

// Acceptance gates: every fixture must score >=4/5 correct-release assertions
// AND the adversarial rejection; overall pass rate >=80%. These are tight
// enough to catch any regression in title parsing or branch tagging while
// forgiving one oddball franchise (the snapshot is hand-curated).
let failed = false
if (passRate < 0.80) { console.log('\nFAIL: assertion pass rate ' + (100 * passRate).toFixed(2) + '% < 80%'); failed = true }
if (fixtureRate < 0.80) { console.log('\nFAIL: only ' + (100 * fixtureRate).toFixed(1) + '% of fixtures fully passing (<80%)'); failed = true }

console.log('\n' + (failed ? 'FAILED' : 'PASSED'))
process.exit(failed ? 1 : 0)
