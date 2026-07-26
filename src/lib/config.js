// Configuration helpers shared across all sources.
// Each source exports `.config()` which returns the JSON schema that a
// config UI renders as toggles. getInstallUrl() encodes user preferences
// into a Base64 query string suitable for a Hayase / Shiru install link.

import { CONFIG_SCHEMA, DEFAULTS, resolve } from './prefs.js'

/**
 * Return the config schema every source advertises.
 * @returns {object}
 */
export function configSchema () {
  return CONFIG_SCHEMA
}

/**
 * Return the current default preferences (what a fresh install uses).
 * @returns {object}
 */
export function configDefaults () {
  return DEFAULTS
}

/**
 * Produce an install url from the base manifest and a preferences object.
 * The preferences are JSON-stringified then base64-encoded and appended as
 * a `?config=` query parameter on the install manifest URL.
 *
 * Hayase/Shiru reads the manifest first; the config parameter is read
 * by the addon's own `config` endpoint at runtime.
 *
 * @param {string} baseInstallUrl — e.g. "stremio://.../manifest.json" or "https://hayase.example"
 * @param {object} prefs — partial user preferences
 * @returns {string}
 */
export function getInstallUrl (baseInstallUrl, prefs) {
  const merged = resolve(prefs)
  const encoded = btoa(JSON.stringify(merged))
  const sep = baseInstallUrl.includes('?') ? '&' : '?'
  return baseInstallUrl + sep + 'config=' + encoded
}