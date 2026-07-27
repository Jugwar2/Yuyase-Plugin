// User preferences engine.
// Consumed by the scorer to fold user-configurable weights into ranking,
// and by the formatter to enforce caps and filter rules.

/**
 * @typedef {Object} UserPreferences
 * @property {string[]}  [preferredResolution] — ordered list e.g. ['1080','2160']
 * @property {string[]}   [preferredCodec]     — ordered list e.g. ['hevc','av1','vp9']
 * @property {string[]}   [preferredGroups]    — release groups the user likes
 * @property {string[]}   [avoidGroups]        — release groups the user avoids
 * @property {string[]}   [preferredAudio]     — ISO 639-1 audio languages e.g. ['ja','en']
 * @property {string[]}   [preferredSubtitles] — ISO 639-1 sub languages e.g. ['en','es']
 * @property {boolean}    [preferDualAudio]    — boosts dual-audio releases
 * @property {boolean}    [preferDub]          — boosts English-dubbed releases
 * @property {boolean}    [allowRaw]           — when false, rejects raw (no-sub) releases
 * @property {boolean}    [preferBatch]        — when true, boosts batch releases
 * @property {boolean}    [fallbackToBatch]    — allows batch when no single exists
 * @property {string[]}   [preferredSource]    — e.g. ['bd', 'remux', 'web-dl']
 * @property {boolean}    [avoidBluRay]        — penalises BD/Remux/Bluray (they tend to be huge files)
 * @property {number}     [maxResults]       — max results the user wants (overrides SourceProfile earlyExit)
 * @property {string[]}   [exclusions]        — title keywords that should be filtered out
 * @property {number}     [maxFileSizeMB]     — max file size in MB the user accepts
 */

/** Sensible defaults — 1080p, dubs on, 9 results, Blu-ray deprioritised. */
export const DEFAULTS = {
  preferredResolution: ['1080'],
  preferredCodec: [],
  preferredGroups: [],
  avoidGroups: [],
  preferredAudio: [],
  preferredSubtitles: ['en'],
  preferDualAudio: false,
  preferDub: true,
  allowRaw: false,
  preferBatch: false,
  fallbackToBatch: true,
  preferredSource: [],
  avoidBluRay: true,
  maxResults: 9,
  exclusions: [],
  maxFileSizeMB: 0
}

/**
 * Merge a partial user config with the defaults. Unset fields are filled in.
 * @param {Partial<UserPreferences>} user
 * @returns {UserPreferences}
 */
export function resolve (user = {}) {
  return { ...DEFAULTS, ...user }
}

/**
 * Build a boost/penalty multiplier table for the scorer.
 * Returns a plain object consumed by scoreCandidate's `prefs` parameter.
 *
 * @param {UserPreferences} prefs
 * @param {string} eresolution - user's requested resolution from the query
 * @returns {object}
 */
export function scorerEnv (prefs, queryResolution) {
  const norm = resolve(prefs || {})
  return {
    resolution: queryResolution || null,
    preferredResolutions: new Set(norm.preferredResolution.map(String)),
    preferredCodecs: new Set(norm.preferredCodec.map(s => s.toLowerCase())),
    knownGroups: new Set(norm.preferredGroups.map(s => s.toLowerCase().trim())),
    avoidGroups: new Set(norm.avoidGroups.map(s => s.toLowerCase().trim())),
    preferredAudio: new Set(norm.preferredAudio),
    preferredSubtitles: new Set(norm.preferredSubtitles),
    preferDualAudio: !!norm.preferDualAudio,
    preferDub: !!norm.preferDub,
    allowRaw: !!norm.allowRaw,
    avoidBluRay: !!norm.avoidBluRay,
    defaultBatch: !!norm.preferBatch,
    fallbackToBatch: !!norm.fallbackToBatch,
    preferredSource: new Set(norm.preferredSource.map(s => s.toLowerCase())),
    maxResults: norm.maxResults && Number.isInteger(norm.maxResults) ? norm.maxResults : 0,
    exclusions: (norm.exclusions || []).slice(0, 20),
    maxFileSize: norm.maxFileSizeMB ? Number(norm.maxFileSizeMB) * 1000000 : 0
  }
}

/**
 * JSON Schema-like descriptor for Hayase (or any config UI) to render a form.
 * Returned by the /config endpoint; the app can map these fields to toggles.
 */
export const CONFIG_SCHEMA = {
  preferredResolution: { label: 'Preferred Resolution', type: 'multi', options: ['2160','1080','720','480'], default: ['1080'] },
  preferredCodec:      { label: 'Preferred Codec', type: 'multi', options: ['hevc','av1','vp9','avc','x264','x265'], default: [] },
  preferredGroups:     { label: 'Preferred Groups', type: 'text', placeholder: 'SubsPlease, Erai-raws, Judas', default: [] },
  avoidGroups:         { label: 'Avoid Groups', type: 'text', placeholder: 'SSA, Mini', default: [] },
  preferredAudio:      { label: 'Audio languages', type: 'multi', options: ['ja','en','pt-BR','es-419','fr','de','it','ru','ko','zh','ar'], default: [] },
  preferredSubtitles:  { label: 'Subtitle languages', type: 'multi', options: ['en','es','pt-BR','fr','de','it','ru','ar','ja','ko','zh'], default: ['en etc'] },
  preferOnAudio:     { label: 'Prefer Dual Audio', type: 'boolean', default: true },
  preferDub:           { label: 'Prioritise English Dubs', type: 'boolean', default: true },
  allowRaw:            { label: 'Allow raw (no subs)', type: 'boolean', default: true },
  avoidBluRay:         { label: 'Avoid Blu-ray / Remux (large files)', type: 'boolean', default: true },
  preferBatch:         { label: 'Prefer batches', type: 'boolean', default: false },
  fallbackToBatch:     { label: 'Fallback to batch', type: 'boolean', default: true },
  preferredSource:     { label: 'Preferred source', type: 'multi', options: ['bd','remux','web-dl','web','bluray','hdtv'], default: [] },
  maxResults:          { label: 'Max results', type: 'integer', default: 9, hint: 'max shown (0 = unlimited)' },
  exclusions:          { label: 'Exclude keywords', type: 'text', placeholder: 'pulp, shit, bad', default: [] },
  maxFileSizeMB:       { label: 'Max file size (MB)', type: 'integer', default: 0, hint: '0 = no limit' }
}