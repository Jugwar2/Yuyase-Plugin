import {
  looksLikeBatch, hitsExclusion, buildQueries, searchContext,
  shapeAny, finalize, withEpisodeCandidates
} from './lib/shared.js'
import { formatResult, SOURCE_PROFILES } from './lib/formatter.js'
import { configSchema, configDefaults, getInstallUrl } from './lib/config.js'

const PROFILE = SOURCE_PROFILES.animetosho

const BASE = 'https://feed.animetosho.org/json'
const MAPPING_URL = 'https://raw.githubusercontent.com/anh9000/anitorrent/main/data/anilist-to-anidb.json'

let mappingCache = null
let mappingPromise = null

function validId (v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0
}

async function getMapping () {
  if (mappingCache) return mappingCache
  if (!mappingPromise) {
    mappingPromise = (async () => {
      try {
        const r = await fetch(MAPPING_URL)
        if (!r.ok) return {}
        const data = await r.json()
        mappingCache = data && typeof data === 'object' ? data : {}
        return mappingCache
      } catch {
        return {}
      }
    })()
  }
  return mappingPromise
}

async function resolveAnidbAid (query) {
  if (validId(query.anidbAid)) return Number(query.anidbAid)
  if (!validId(query.anilistId)) return null
  const map = await getMapping()
  const aid = map[String(query.anilistId)]
  return validId(aid) ? Number(aid) : null
}

async function tryFetch (url) {
  let res
  try {
    res = await fetch(url)
  } catch (err) {
    throw new Error('Cannot reach AnimeTosho. Check your internet connection or try again later.')
  }
  if (!res.ok) {
    throw new Error('AnimeTosho returned HTTP ' + res.status + '. The site may be down or rate limiting your IP.')
  }
  let data
  try {
    data = await res.json()
  } catch (err) {
    throw new Error('AnimeTosho returned an unexpected response. The API may have changed.')
  }
  if (!Array.isArray(data)) return []
  return data
}

function toResult (item, accuracy) {
  const hash = String(item.info_hash || '').toLowerCase()
  if (!hash) return null
  return formatResult({
    title: item.title || item.torrent_name || '',
    link: item.magnet_uri || hash,
    hash,
    seeders: Number(item.seeders) || 0,
    leechers: Number(item.leechers) || 0,
    downloads: Number(item.torrent_downloaded_count) || 0,
    size: Number(item.total_size) || 0,
    date: item.timestamp ? new Date(item.timestamp * 1000) : new Date(),
    uploader: item.nickname || '',
    accuracy,
    tracker: PROFILE.name
  }, PROFILE, { useMagnetRaw: !!(item.magnet_uri) })
}

function dedupe (items) {
  const seen = new Set()
  const out = []
  for (const r of items) {
    if (!r || seen.has(r.hash)) continue
    seen.add(r.hash)
    out.push(r)
  }
  return out
}

async function fetchByEid (eid) {
  const items = await tryFetch(BASE + '?eid=' + encodeURIComponent(eid))
  return items.map(i => toResult(i, 'high')).filter(Boolean)
}

async function fetchByAid (aid) {
  const items = await tryFetch(BASE + '?aid=' + encodeURIComponent(aid))
  return items.map(i => toResult(i, 'high')).filter(Boolean)
}

async function fetchByText (titles) {
  const seen = new Map()
  for (const q of buildQueries(titles)) {
    let items
    try {
      items = await tryFetch(BASE + '?q=' + encodeURIComponent(q))
    } catch (err) {
      if (seen.size) break
      throw err
    }
    for (const i of items) {
      const r = toResult(i, 'medium')
      if (r && !seen.has(r.hash)) seen.set(r.hash, r)
    }
    if (seen.size >= 30) break
  }
  return [...seen.values()]
}

async function classifyAndTag (raw, ctx, query) {
  const items = dedupe(raw).filter(r => !hitsExclusion(r.title, ctx.exclusions))
  const out = await shapeAny(items, ctx, PROFILE.accuracy, query)
  if (ctx.mode === 'batch') {
    return out.filter(r => looksLikeBatch(r.title)).map(r => ({ ...r, type: 'batch', accuracy: 'low' }))
  }
  return out
}

async function search (query, mode) {
  if (!query) return []

  const ctx = searchContext(query, mode)
  ctx._tracker = PROFILE.name
  const resolvedAid = await resolveAnidbAid(query)

  let raw = []

  if (mode === 'single' && validId(query.anidbEid)) {
    try { raw = await fetchByEid(query.anidbEid) } catch (_) { raw = [] }
  } else if (resolvedAid) {
    try { raw = await fetchByAid(resolvedAid) } catch (_) { raw = [] }
  }

  let results = await classifyAndTag(raw, ctx, query)

  if (!results.some(r => r._tier === 'A') && (query.titles || []).length) {
    const seen = new Set(results.map(r => r.hash))
    for (const r of (await classifyAndTag(await fetchByText(query.titles), ctx, query))) {
      if (seen.has(r.hash)) continue
      seen.add(r.hash)
      results.push(r)
    }
  }

  return finalize(results, ctx.resolution, 30, ctx._prefs)
}

export default new class AnimeTosho {
  async single (query) {
    if (query.episodeCount === 1) return search(query, 'movie')
    return search(await withEpisodeCandidates(query), 'single')
  }
  async batch (query) { return search(query, 'batch') }
  async movie (query) { return search(query, 'movie') }

  async test () {
    let res
    try {
      res = await fetch(BASE + '?q=test')
    } catch (err) {
      throw new Error('Cannot reach AnimeTosho. Check your internet connection or try again later.')
    }
    if (!res.ok) {
      throw new Error('AnimeTosho returned HTTP ' + res.status + '. The site may be down.')
    }
    return true
  }
  config () { return configSchema() }
  defaults () { return configDefaults() }
  installUrl (baseUrl, prefs) { return getInstallUrl(baseUrl, prefs) }
}()
