# Sportsbook Feed

A local odds feed server that ingests Pinnacle (p4578) and Tipsport odds, computes a Dixon-Coles probability model, and exposes a Betradar-style event/market feed over SSE for a browser UI.

---

## Quick start

**Start the dev server (recommended):**
```
node server.js --source p4578 --p4578-fetch-events --p4578-max-leagues 12
```
Open `http://localhost:3000`. Odds refresh every 30 s and are pushed to the UI via Server-Sent Events.

**Generate `odds.json` once (static file mode):**
```
node fetch-odds.js --p4578-sport-id 29 --p4578-league-code brazil-serie-a --out odds.json
```

**Serve the static UI without `server.js`:**
```
npx serve .
```
Then open the URL shown and load `sportsbook.html`.

---

## Architecture

```
fetch-odds.js  →  raw matches  →  lib/provider-feed.js  →  providerFeed  →  SSE / odds.json
```

| File | Role |
|---|---|
| `fetch-odds.js` | Ingestion. Fetches p4578/Pinnacle live and optionally replays Tipsport from a HAR file. Normalizes both into a common match shape. |
| `lib/lambda.js` | Math engine. Poisson / Shin / Dixon-Coles logic. |
| `lib/provider-feed.js` | Feed builder. Enriches matches with lambdas, builds Betradar-style `{ templates, events, markets, timelines, incidents }`. |
| `server.js` | HTTP + SSE server. Spawns `fetch-odds.js`, hydrates with `buildProviderFeed`, broadcasts to SSE clients. |
| `lib/manual-odds.js` | JSON persistence for trader manual price overrides (`manual-odds.json`). |
| `lib/market-state.js` | JSON persistence for market/event suspension state (`market-state.json`). |
| `lib/feed-settings.js` | JSON persistence for feed-wide settings (`feed-settings.json`). |
| `sportsbook.html` / `sportsbook-app.js` / `sportsbook.css` | Browser UI. |

### Data sources

- **p4578 / Pinnacle** — live HTTP. Returns 1x2 + over/under lines → lambdas computed → derived markets generated (BTTS, DNB, double chance, team totals, correct score).
- **Tipsport** — HAR replay only, no live fetch. Returns 1x2 without totals → no derived markets.

---

## Server API

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serves `sportsbook.html` |
| GET | `/events` | SSE stream — pushes full `providerFeed` on each refresh |
| POST | `/refresh` | Trigger an immediate odds fetch |
| GET/POST | `/manual-odds` | Read or write trader manual price overrides |
| GET/POST | `/market-state` | Read or suspend/open individual markets |
| GET/POST | `/event-state` | Read or suspend/open whole events |
| GET/POST | `/feed-settings` | Read or update feed-wide settings (e.g. first-half ratio) |
| GET | `/debug` | Summary of current cache structure |

POST bodies are JSON. Market/event status values: `"open"` or `"suspended"`.

The `reprice_market` mode on `/manual-odds` recalculates all other selections to maintain a balanced book when one price is edited.
