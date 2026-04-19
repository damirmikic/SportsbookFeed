# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

**Start the dev server (SSE-based, no file polling needed):**
```
node server.js --source p4578 --p4578-fetch-events --p4578-max-leagues 12
```
Opens at `http://localhost:3000`. Refreshes odds every 30s and pushes via SSE.

**Generate `odds.json` once (static file mode):**
```
node fetch-odds.js --p4578-sport-id 29 --p4578-league-code brazil-serie-a --out odds.json
```

**Serve the static UI (no server.js):**
```
npx serve .
```
Then open the URL shown and load `index.html` or `sportsbook.html`.

**Auto-refresh `odds.json` on an interval:**
```
node auto-refresh-odds.js --interval 60 --p4578-fetch-events --p4578-max-leagues 12 --out odds.json
```

## Architecture

### Data flow

```
fetch-odds.js  →  raw matches  →  lib/provider-feed.js  →  providerFeed  →  SSE / odds.json
```

1. **`fetch-odds.js`** — ingestion. Reads Tipsport from a HAR file and fetches p4578/Pinnacle live. Normalizes both sources into a common match shape: `{ source, matchId, home, away, startsAt, odds: {1, X, 2}, mainTotals, totals25, lambdas? }`.

2. **`lib/lambda.js`** — math engine. All Poisson/Shin/Dixon-Coles logic lives here. Key exports:
   - `computeShinProbabilities(odds1x2)` — Shin (1993) devig via binary search on z
   - `estimateTotalLambda(totalsLine)` — inverts Poisson CDF to get total goals lambda from over/under line
   - `computeLambdas(match)` — fits Dixon-Coles model (grid search + coordinate descent) to produce `{ lambdaHome, lambdaAway, mu, rho, shinProbs, dixonColesProbs, totalsShare, fitError }`
   - `buildPoissonPMF(lambda)` — normalized PMF array
   - `computeDixonColesMatchProbs(lambdaHome, lambdaAway, rho)` — full score matrix + 1x2 probs + totalGoalsPMF
   - `dixonColesTotalGoalsMarketShare(points, lambdaHome, lambdaAway, rho)` — Asian-line-aware over share

3. **`lib/provider-feed.js`** — feed builder. `buildProviderFeed(snapshot, { manualOddsStore, marketStateStore })` calls `enrichMatch` (adds lambdas if missing via `computeLambdas`) then builds Betradar-style output: `{ templates, events, markets, timelines, incidents }`. Derived markets (BTTS, DNB, double chance, team totals, correct score) are built only when `lambdas` is present.

4. **`server.js`** — HTTP + SSE server. Spawns `fetch-odds.js` as a child process, parses its stdout, hydrates with `buildProviderFeed`, and broadcasts to SSE clients. Persists a warm cache to `odds.json` so the server can serve stale data on startup.

5. **`lib/manual-odds.js` / `lib/market-state.js`** — JSON file persistence for trader overrides (`manual-odds.json`) and market/event suspension state (`market-state.json`).

### ID conventions

- **Event ID:** `ev:{source}:{matchId}` or slug-based fallback `ev:{source}:{competition}:{home}:{away}:{time}`
- **Market ID:** `mkt:{eventId}:{type}` or `mkt:{eventId}:{type}:{specifier}` (e.g. `mkt:ev:p4578:123:total_goals:2_5`)
- **Selection key** in manual-odds store: `{marketId}::{selectionId}`

### Market propagation logic

When a manual odds override exists on any selection, `propagateRelatedMarketOverrides` re-prices linked derived markets (double chance, DNB) from the updated match-winner probabilities. When `deriveEventModelOverride` detects a manual override, it recalibrates the full Dixon-Coles model (`calibrateEventModel`) and reprices all derived markets consistently.

### Two data sources

- **Tipsport** — HAR replay only. No live fetch. Returns flat match list with 1x2 odds but no totals → `lambdas` will be null → no derived markets.
- **p4578 / Pinnacle** — live HTTP. Returns 1x2 + over/under lines → `lambdas` computed → derived markets generated.

### Important: duplicate lambda code in `fetch-odds.js`

`fetch-odds.js` contains a copy of `computeShinProbabilities`, `poissonPMF`, `computePoissonMatchProbs`, `estimateTotalLambda`, and `computeLambdas` added inline. These are currently **unused** — `normalizeEvent` does not call them. The canonical implementations are in `lib/lambda.js`. If lambda computation is wanted at the ingestion stage, call `require('./lib/lambda').computeLambdas` instead of duplicating.

## Server API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/events` | SSE stream — pushes full `providerFeed` on each refresh |
| GET | `/` | Serves `sportsbook.html` |
| POST | `/refresh` | Trigger immediate odds fetch |
| GET/POST | `/manual-odds` | Read or write trader manual price overrides |
| GET/POST | `/market-state` | Read or suspend/open individual markets |
| GET/POST | `/event-state` | Read or suspend/open whole events |
| GET | `/debug` | Summary of current cache structure |

POST bodies are JSON. Market/event status values: `"open"` or `"suspended"`. The `reprice_market` mode on `/manual-odds` recalculates all other selections to maintain a balanced book when one price is edited.
