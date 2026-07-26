import { normalizeTorrent, tagBranch } from '../../src/lib/normalize.js'
import { validate, pickRequestedBranch, gateFranchise } from '../../src/lib/filters.js'
import { readFile } from 'node:fs/promises'

const f = JSON.parse(await readFile(new URL('../../test/golden/frieren-s1-tv.json', import.meta.url), 'utf8'))
for (const b of f.canonical.branches) b.tokens = new Set(b.tokens || [])

// Show branch tokens
console.log('Branches:')
for (const b of f.canonical.branches) {
  console.log(' ', b.anilist, b.format || '', 'S' + (b.seasonInFranchise || '-'), 'tokens:', [...b.tokens].join(','))
}

const env = { canonical: f.canonical, requestSeason: 1, requestFormat: null, requestEpisode: 2, mode: 'single' }
const requested = pickRequestedBranch(f.canonical, 1, null)
console.log('requested:', requested?.anilist, requested?.titles?.[0])

const adversarial = f.releases.find(r => !r.expectCorrect)
if (adversarial) {
  const norm = normalizeTorrent({ title: adversarial.title, tracker: 't', seeders: 10, date: '2024-01-01' })
  const tag = tagBranch(norm, f.canonical)
  console.log('\nAdversarial:', adversarial.title)
  console.log('  norm.anime:', norm.anime)
  console.log('  norm.season:', norm.season)
  console.log('  tagBranch ->', tag.branch?.anilist, tag.branch?.titles?.[0], 'overlap:', tag.overlap)
  console.log('  gateFranchise:', gateFranchise(norm, env))
  console.log('  validate:', validate(norm, env))
}