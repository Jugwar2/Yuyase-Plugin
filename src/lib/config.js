// Configuration helpers shared across all sources.
// Each source exports `.config()` which returns the JSON schema that a
// config UI renders as toggles. getInstallUrl() encodes user preferences
// into a base64 ?c= query parameter appended to the code bundle URL.
//
// The configure.html page uses the same encoding: user picks preferences,
// the page base64-encodes the full JSON config, and appends it as ?c=<b64>
// to the raw CDN URL of the selected source's dist bundle. Hayase caches
// this URL as the source's "code" and passes it to the extension worker.
// At runtime each source calls readInstallConfig(codeUrl) to recover the
// prefs and fold them into the query._prefs that the scorer consumes.

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
export function configDefaults() {
  return DEFAULTS
}

/**
 * Extract user preferences from a code bundle URL's `?c=` query parameter.
 * Returns a resolved preferences object, or the DEFAULTS if no config was
 * embedded (plain install with zero user selection, which is equivalent to
 * defaults).
 *
 * The encoding is: JSON.stringify(defaults+overrides) → btoa → ?c=<b64>
 * Both configure.html and the source's own test() block use this.
 *
 * @param {string} [codeUrl] — the bundle URL Hayase cached when installing
 * @returns {object} resolved UserPreferences
 */
export function readInstallConfig(codeUrl) {
  let prefs = {}
  try {
    const url = String(codeUrl || '')
    const q = url.indexOf('?')
    if (q < 0) return resolve({})
    const params = url.slice(q + 1).split('&')
    for (const p of params) {
      const eq = p.indexOf('=')
      if (eq < 0) continue
      if (p.slice(0, eq) === 'c') {
        const json = atob(decodeURIComponent(p.slice(eq + 1)))
        prefs = JSON.parse(json)
        break
      }
    }
  } catch (_) { /* stay on defaults */ }
  return resolve(prefs)
}

/**
 * Produce an install URL from the base code URL and preferences.
 * @param {string} baseUrl - code bundle URL
 * @param {object} prefs - partial user preferences
 * @returns {string}
 */
export function getInstallUrl(baseUrl, prefs) {
  const merged = resolve(prefs)
  const encoded = btoa(JSON.stringify(merged))
  const sep = baseUrl.includes('?') ? '&' : '?'
  return baseUrl + sep + 'c=' + encoded
}