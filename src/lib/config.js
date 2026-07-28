// Configuration helpers shared across all sources.
// Hayase reads `options` from the manifest, renders a settings UI, and passes
// resolved values as the second argument to single(query, options) etc.
// resolveOptions() converts those flat key-value options into the
// UserPreferences shape the scorer expects.

import { CONFIG_SCHEMA, DEFAULTS, resolve } from './prefs.js'

export function configSchema() { return CONFIG_SCHEMA }
export function configDefaults() { return DEFAULTS }

/**
 * Merge Hayase-provided options into UserPreferences.
 * Maps manifest option keys (select/boolean/number/string) to the
 * structured prefs object that scorerEnv and finalize consume.
 */
export function resolveOptions(opts) {
  const raw = resolve({})
  if (!opts || typeof opts !== 'object') return raw

  if (opts.resolution && String(opts.resolution) !== 'any') {
    raw.preferredResolution = [String(opts.resolution)]
  }
  if (opts.codec && String(opts.codec) !== 'any') {
    raw.preferredCodec = [String(opts.codec).toLowerCase()]
  }
  if (typeof opts.preferDub === 'boolean') raw.preferDub = opts.preferDub
  if (typeof opts.avoidBluRay === 'boolean') raw.avoidBluRay = opts.avoidBluRay
  if (typeof opts.preferDualAudio === 'boolean') raw.preferDualAudio = opts.preferDualAudio
  if (typeof opts.preferredGroups === 'string' && opts.preferredGroups.trim()) {
    raw.preferredGroups = opts.preferredGroups.trim().split(',').map(s => s.trim()).filter(Boolean)
  }
  if (typeof opts.avoidGroups === 'string' && opts.avoidGroups.trim()) {
    raw.avoidGroups = opts.avoidGroups.trim().split(',').map(s => s.trim()).filter(Boolean)
  }
  if (typeof opts.maxResults === 'number' && Number.isInteger(opts.maxResults) && opts.maxResults > 0) {
    raw.maxResults = opts.maxResults
  }
  return resolve(raw)
}

// Kept for backward compat — no-op now that Hayase options drive config
export function getInstallUrl(baseUrl, prefs) { return baseUrl }
export function readInstallConfig(codeUrl) { return resolve({}) }