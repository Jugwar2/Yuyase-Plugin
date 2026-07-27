# Yuyase Plugin

Torrent search extension pack for **Hayase**. Six auto-updating sources: **Nyaa**, **AnimeTosho**, **Seadex**, **SubsPlease**, **Yameii** (English dubs), and **ToonsHub** (dual-audio).

Works on Windows, macOS, Linux, and Hayase on Android. One install URL, no manual maintenance.

## Install in Hayase

Settings -> Extensions -> Repositories -> paste -> Import Extensions:

```
https://raw.githubusercontent.com/Jugwar2/Yuyase-Plugin/main/hayase/index.json
```

One-time action. Hayase auto-polls the manifest on every launch, so future releases flow in automatically.

### Shiru install URL (experimental)

```
https://raw.githubusercontent.com/Jugwar2/Yuyase-Plugin/main/shiru/index.json
```

## Sources

```text
+------------+----------+------------------------------------------+
| SOURCE     | ACCURACY | BEST FOR                                 |
+------------+----------+------------------------------------------+
| Nyaa       | medium   | raw firehose, every anime upload         |
| AnimeTosho | high     | anidb-mapped lookups, batch packs        |
| Seadex     | high     | community-curated best releases          |
| SubsPlease | high     | currently-airing weekly subs             |
| Yameii     | high     | single-uploader English dub re-encodes   |
| ToonsHub   | high     | dual-audio + multi-sub group releases    |
+------------+----------+------------------------------------------+
```

All six sources declare `media: "both"` in the manifest. Hayase shows Sub + Dub badges regardless; the badge is purely informational.

### About Yameii & ToonsHub

Personal picks that ship enabled by default but are entirely toggleable in Settings > Extensions.

- **Yameii** — narrow catalog, consistent quality. IRC: `#Yameii@irc.rizon.net`
- **ToonsHub** — covers many currently-airing shows. Telegram: [t.me/thtorrents](https://t.me/thtorrents)

## How It Works

When you open a torrent picker, Hayase sends the same query to every enabled source. They run in parallel, each filters its own results through shared matching logic, and Hayase merges everything and de-duplicates by infohash.

When the query carries an AniList ID, sources route results through the **canonical pipeline** — which uses AniList's franchise graph to *reject* wrong-franchise leaks (e.g., Uma Musume S2 no longer returns Cinderella Gray, Road to the Top, or Beginning of a New Era). Queries without an AniList ID fall through to the legacy token-based path.

### Canonical Pipeline

```
                     raw results
                         |
                Canonical Resolver (resolver.js)
              AniList GraphQL -> franchise graph + branches
                         |
                Normalizer (normalize.js)
              every release -> NormalizedTorrent schema
                         |
                Hard Validation Gates (filters.js)
              wrong-franchise, wrong-branch, movie-vs-TV,
              OVA-vs-season, episode-impossible, airdate
                         |
                Bayesian Scorer (scorer.js)
              alias, episode, season, group, recency, seeders
                         |
                   Hayase-ready result shape
```

### Preferences / Configuration

Every source exports a `config()` endpoint that Hayase's settings UI can render as a toggles form.

**Quick configure — no manual editing needed:**

1. Open **[configure.html](https://github.com/Jugwar2/Yuyase-Plugin/blob/main/configure.html)** in your browser
2. Select a source tab, set your preferences (resolution, codec, groups, languages, etc.)
3. **Copy** the generated install link
4. Paste it in Hayase → Settings → Extensions → Add Extension → From URL

Every setting change regenerates a **unique install link** with your config encoded directly in the URL (`?c=<base64>`). No login, no account, no editing the manifest manually.

Supported preferences:

- **Resolution** — 2160p, 1080p, 720p, 480p
- **Codec** — HEVC, AV1, VP9, AVC
- **Release Groups** — preferred and avoided
- **Audio/Subtitle Languages** — preferred audio and subtitle tracks
- **Dual Audio / Dubs** — boost dual audio or dub releases
- **Batches** — prefer batch releases and allow fallback
- **Max Results** — cap number of returned results
- **Max File Size** — reject torrents over a MB threshold
- **Exclusions** — keywords that filter out unwanted content

These preferences feed into the scorer, which dynamically adjusts weight—avoided groups get penalized, preferred groups get bonus scores, preferred codecs and sources get boosts, etc.

## Develop

```
npm install
npm run build
npm test
```

`src/lib/shared.js` holds all the matching/query logic shared across sources (single source of truth). Each source in `src/` imports from it and is bundled into a standalone `dist/*.js` by tsup. CI rebuilds `dist/` on every push.

Test suites:

- `npm test` — live relevance tests against nyaa.si (16 shows, zero off-show contamination gate)
- `npm run test:all` — 5 offline suites: franchise-leak regression, matching logic, DB-title snapshots, golden harness, invariant lint
- `npm run test:franchise` — Uma Musume S2 sibling-franchise leak regression
- `npm run test:matching` — offline 300-show cross-franchise contamination test
- `npm run test:golden` — golden fixture gate validation suite
- `npm run test:invariants` — source-specific logic-free lib/ assertions

## License

GPL-3.0. See [LICENSE](./LICENSE).