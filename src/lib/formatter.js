// Unified result formatter — the single entry point for building a Hayase
// result object, called by every source. Replaces per-source inline object
// construction with a single consistent schema.
//
// Invariant: no source-specific conditionals inside this file. All variation
// (parserConfidence, defaultAccuracy, earlyExit limit, fileSizeCap) comes from
// the SourceProfile object passed by the caller.

import { buildMagnet } from './shared.js'

/**
 * SourceProfile — per-source configuration that replaces the old SOURCE_DEFAULT
 * constant. Every src/*.js adapter passes one of these.
 * @typedef {Object} SourceProfile
 * @property {string}   name             — display name for logging
 * @property {string}   accuracy         — default accuracy band ('high'|'medium'|'low')
 * @property {number}   parserConfidence — 0–1 confidence in this tracker's metadata
 * @property {number}   earlyExit        — stop searching when >= this many tier‑A results accumulate
 * @property {number}   [fileSizeCap]    — optional max torrent size in bytes
 */

const DEFAULT_PROFILE = { name: 'unknown', accuracy: 'medium', parserConfidence: 0.7, earlyExit: 0 }

/**
 * Build a Hayase result from raw torrent metadata.
 *
 * @param {object} raw
 * @param {string}       raw.title           – release filename
 * @param {string}       raw.link             – magnet URI or hex infohash
 * @param {string}       [raw.tracker]       – source tracker name (e.g. "Nyaa")
 * @param {string}       [raw.uploader]      – uploader / creator handle from RSS
 * @param {number}       [raw.seeders=0]
 * @param {number}       [raw.leechers=0]
 * @param {number}       [raw.downloads=0]
 * @param {number|Date}  raw.date            – JS timestamp or Date
 * @param {string}       [raw.accuracy]      – caller-computed accuracy ('high'|'medium'|'low')
 * @param {SourceProfile} profile
 * @param {object}       [opts]
 * @param {boolean}      [opts.batch=false]
 * @param {boolean}      [opts.movie=false]
 * @param {boolean}      [opts.useMagnetRaw=false] — set true when raw.link is already a full magnet URI
 * @returns {object|null} Hayase result or null if invalid
 */
export function formatResult (raw, profile, opts = {}) {
  const date = raw.date instanceof Date ? raw.date : new Date(raw.date || 0)
  const hash = String(raw.hash || '').toLowerCase().trim()
  if (!hash || hash.length < 20) return null
  const title = String(raw.title || '').trim()
  if (!title) return null
  const size = Number(raw.size) || 0
  if (size < 10000) return null
  if (profile.fileSizeCap && size > profile.fileSizeCap) return null

  const link = opts.useMagnetRaw ? raw.link : buildMagnet(hash, title)
  const tracker = String(raw.tracker || profile.name || '').trim()
  const type = opts.type || (opts.batch ? 'batch' : (opts.movie ? 'movie' : undefined))

  return {
    title,
    size,
    tracker: tracker || '',
    uploader: String(raw.uploader || ''),
    date,
    link,
    hash,
    seeders: Math.max(0, Number(raw.seeders) || 0),
    leechers: Math.max(0, Number(raw.leechers) || 0),
    downloads: Math.max(0, Number(raw.downloads) || 0),
    accuracy: raw.accuracy || profile.accuracy || 'medium',
    type: type || undefined,
    // Metadata fields extracted from title by the parser
    codec: String(raw.codec || ''),
    source: String(raw.sourceTag || ''),
    resolution: raw.resolution || null,
    releaseGroup: String(raw.releaseGroup || ''),
    isDualAudio: !!raw.isDualAudio,
    isDub: !!raw.isDub,
    subtitleLanguages: Array.isArray(raw.subtitleLanguages) ? raw.subtitleLanguages : [],
    spokenLanguages: Array.isArray(raw.spokenLanguages) ? raw.spokenLanguages : []
  }
}

/**
 * Age‑aware accuracy band. Escalates based on release freshness.
 * @param {'high'|'medium'|'low'} base
 * @param {number|null|Date} releaseDateMs
 * @param {SourceProfile} profile
 * @returns {'high'|'medium'|'low'}
 */
export function effectiveAccuracy (base, releaseDateMs, profile) {
  const conf = profile.parserConfidence || 0.7
  const band = conf >= 0.85 ? base : 'medium'
  if (!releaseDateMs) return band
  const ms = releaseDateMs instanceof Date ? releaseDateMs.getTime() : releaseDateMs
  const days = (Date.now() - ms) / 86400000
  if (days < 60) return band
  if (days < 180) return 'medium'
  return 'low'
}

/** @type {Record<string, SourceProfile>} */
export const SOURCE_PROFILES = {
  nyaa:       { name: 'Nyaa',       accuracy: 'medium', parserConfidence: 0.80, earlyExit: 20 },
  animetosho: { name: 'AnimeTosho', accuracy: 'high',   parserConfidence: 1.00, earlyExit: 50 },
  seadex:     { name: 'Seadex',     accuracy: 'high',   parserConfidence: 0.98, earlyExit: 200 },
  subsplease: { name: 'SubsPlease', accuracy: 'high',   parserConfidence: 0.99, earlyExit: 200 },
  yameii:     { name: 'Yameii',     accuracy: 'high',   parserConfidence: 0.85, earlyExit: 10 },
  toonshub:   { name: 'ToonsHub',   accuracy: 'high',   parserConfidence: 0.85, earlyExit: 10 }
}