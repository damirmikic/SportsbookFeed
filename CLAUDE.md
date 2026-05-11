# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Running the App

**Local dev (full stack — Netlify Functions + Turso):**
```powershell
netlify dev
# Opens at http://localhost:8888
# login.html first, then index.html
```

**Frontend only (no functions, mock auth):**
```powershell
npx serve .
# Opens at http://localhost:3000
# login.js uses localStorage mock when hostname is localhost/127.0.0.1
```

**No build step.** All JS is ES modules served directly. No bundler, no transpilation.

**Install dependencies** (only needed for Netlify Functions — `@libsql/client`):
```powershell
npm install
```

---

## Architecture

Pure browser ES module app. No framework, no build tool. The entry points are `login.html` → `login.js` (auth) and `index.html` → `app.js` (trading terminal).

### Module Dependency Tree

```
app.js                          ← bootstrap, polling, view switching
├── api.js                      ← all fetch calls (Pinnacle + Turso)
├── state.js                    ← singleton state, localStorage, Turso sync
├── ui.js                       ← barrel: re-exports from ui-* modules
│   ├── ui-leagues.js           ← left sidebar (league list, search, favorites)
│   ├── ui-board.js             ← main event table (odds, trend arrows, offered prices)
│   ├── ui-drawer.js            ← right-side detail drawer (market cards, lambda UI)
│   ├── ui-market-table.js      ← comparison table inside drawer (Shin|Model|API|Offer|Override)
│   ├── ui-helpers.js           ← margin badge HTML, effective period computation
│   └── ui-market-groups.js     ← market card grouping for drawer categories
├── admin.js                    ← Admin > Tournaments panel
└── templates-admin.js          ← Admin > Templates panel (template CRUD, market discovery)

pricing.js                      ← template resolution + override expiry/alert evaluation
math.js                         ← Shin no-vig, Dixon-Coles model, Asian odds, ladder rounding
markets.js                      ← market builders from score grid (BTTS, CS, DNB, HTFT, etc.)
utils.js                        ← getTeamNames() helper
solver.worker.js                ← Web Worker: off-thread lambda solver
```

### Data Flow

**Odds pipeline (every 30s poll):**
1. `fetchOdds(leagueCode)` → raw Pinnacle odds
2. `renderOdds()` in `ui-board.js` → snapshot previous odds, render event rows
3. Per-event: resolve template → `computeOffer()` (in `ui-board.js`) calls `applyMarginAndLadder(shinFair, margin, ladder)` for AUTO mode offered price
4. Trend arrows compare **raw Pinnacle prices** against `previousOdds` snapshot (not offered prices)

**Price editing (MANUAL mode in drawer):**
1. User edits a cell in `ui-market-table.js` → `setOverride(key, value)` in `state.js`
2. `repriceOthers()` (in `ui-market-table.js`) back-solves remaining outcomes to maintain book sum
3. `scheduleSync('overrides')` fires 400ms debounce → `pushTraderState(traderId, 'overrides', data)` → Turso
4. `solveLambdasAsync()` runs off-thread via `solver.worker.js` → updates Dixon-Coles λ display

**Startup hydration:**
```
DOMContentLoaded
  → guard: no currentTraderId → redirect login.html
  → Promise.allSettled([fetchSharedState(), fetchTraderState(traderId)])
      → hydrateSharedState() / hydrateTraderState()  ← writes back to localStorage
  → fetchLeagues() → renderLeagues()
```

### Pinnacle API Proxy

In production (`netlify dev` or deployed), `netlify.toml` reverse-proxies `/api/leagues`, `/api/odds/:code`, and `/api/odds/event/:id` to `pinnacle888.com` — no CORS issue. When running locally without Netlify (`npx serve .`), `api.js` detects `IS_LOCAL` and hits Pinnacle directly (relies on browser CORS policy or extension).

---

## State Architecture (`state.js`)

All mutable state lives in `state.js`. The `state` object holds transient runtime data (activeEvents, allLeagues, previousOdds). Private `_variables` hold persisted data:

| Private var | localStorage key | Turso entity | Scope |
|---|---|---|---|
| `_overrides` | `priceOverrides` | `overrides` | Per-trader |
| `_overrideMeta` | `overrideMeta` | `meta` | Per-trader |
| `_tradingModes` | `tradingModes` | `modes` | Per-trader |
| `_overriddenLambdas` | `overriddenLambdas` | `lambdas` | Per-trader |
| `_suspensions` | `suspensions` | `suspensions` | **Global** |
| `_templates` | `templates` | `templates` | **Global** |
| `_matchTemplates` | `matchTemplates` | `match-templates` | **Global** |
| `_leagueSettings` | `leagueSettings` | `league-settings` | **Global** |

**Write pattern**: every setter calls `persistTraderEntity(entity, data)` or `persistSharedEntity(entity, data)` which does: `localStorage.setItem` (sync) + `scheduleSync(entity)` (debounced 400ms async Turso write).

**Hydration guard**: `isHydrating = true` during `hydrateSharedState()` / `hydrateTraderState()` — prevents `scheduleSync()` from firing during startup population.

**Template versioning**: `TEMPLATE_VERSION` constant in `state.js`. If the stored version doesn't match, defaults are reset. Bump this constant when changing `DEFAULT_TEMPLATES` or `MARKET_DEFS`.

---

## Pricing Engine (`pricing.js`)

**Template resolution order** (first match wins):
1. Match-level override: `matchTemplates[eventId]`
2. League default: `leagueSettings[leagueCode].template`
3. `null` — no pricing applied, raw Pinnacle odds shown

**Timeline nodes** (`TIMELINE_NODES` in `state.js`): 26 nodes from `INST` (infinity, always active) down to `15m`. `resolveActiveKey(template, marketId, kickoffTime)` walks nodes from most recent to oldest and returns the first one with a non-null margin configured. This is the active margin for that market right now.

**Override expiry / value-bet alerts** (`evaluateOverrides()` in `pricing.js`): called during each `renderOdds()` cycle. Compares current Shin fair against the stored `shinFairAtTime` in `_overrideMeta`. If drift exceeds `alertFactor × leagueSetting.alertFactor`, sets `alertState = 'VALUE_BET'` or `'STALE'`.

---

## Odds Laddering (`math.js`)

`applyMarginAndLadder(fairOdds, marginPct, ladder)`:
1. Divide fair price by `(1 + margin/100)` to get margined price
2. Snap to ladder:
   - `'eu'`: standard EU decimal steps (0.01 below 2.0, 0.02 in 2–3, 0.05 in 3–4, etc.)
   - `'us'`: snap to nearest 5-unit increment in American odds

Always **floors** (never rounds up) to preserve bookmaker edge.

---

## Template & Market Object Shapes

**Template** (stored in `_templates`):
```js
{
  id: string,
  name: string,
  sport: 'soccer',
  type: 'prematch' | 'live' | 'both',
  active: boolean,
  createdAt: ISO string,
  updatedAt: ISO string,
  markets: MarketConfig[]
}
```

**MarketConfig** (one entry per `MARKET_DEFS` id):
```js
{
  id: string,           // e.g. '1x2', 'asian_hcp', 'ou25'
  enabled: boolean,
  margin: number,       // base margin %, overridden per-node by timeline
  maxBet: number,
  ladder: 'eu' | 'us',
  rangeLimit: null | number,
  timeline: {           // per-node overrides; missing key = use base margin
    [nodeId]: { margin: number, enabled: boolean, maxBet: number }
  }
}
```

`MARKET_DEFS` in `state.js` is the canonical list of all market types with their defaults (`defaultMargin`, `defaultMaxBet`, `defaultEnabled`). The `DRAWER_TO_TPL_ID` map in `ui-drawer.js` translates drawer market IDs (e.g. `'ml'`) to their template IDs (e.g. `'1x2'`).

---

## Lambda Data Structure

`calculateTeamLambdasAsync()` (in `math.js`, called from `ui-drawer.js`) resolves λ values and returns:
```js
{
  ft: { lambdaH, lambdaA, rho, grid: [{home, away, prob}] },  // full-time 10×10 score grid
  h1: { lambdaH, lambdaA, rho, grid },                        // 1st half grid (half-λ)
  h2: { lambdaH, lambdaA, rho, grid },                        // 2nd half grid (half-λ)
}
```

`grid` is a flat array of `{ home: int, away: int, prob: float }` score-probability entries (scores 0–9 each). `h1`/`h2` are only present when the solver converges on both halves. All market builders in `markets.js` and `ui-market-groups.js` consume this structure.

---

## Drawer Market Categories

`groupMarketsByCategory()` in `ui-market-groups.js` returns markets keyed by these category names (empty categories are deleted before return):

| Category | Contents |
|---|---|
| `MATCH ODDS` | 1x2, DC, DNB, derived BTTS (from model) |
| `HANDICAP` | Asian handicap (5 closest lines) |
| `GOALS` | All OU lines, derived CS, BTTS, Both Halves OU |
| `TEAM GOALS` | Team totals (home/away) |
| `1ST HALF` | H1 1x2, H1 total, H1 team totals, H1 BTTS, H1 result combos |
| `2ND HALF` | Model-only H2 1x2, H2 total, H2 team totals, Pinnacle 2nd-half specials |
| `CORNERS` | Pinnacle corner specials |
| `BOOKINGS` | Pinnacle card/booking specials |
| `TEAM PROPS` | Win both halves, score both halves, win either half |
| `SPECIALS` | HTFT, winning margin, other Pinnacle specials |
| `PLAYER PROPS` | Goalscorer, anytime scorer specials |

Each market in a category is a **market row object**: `{ id, name, rows: [{ label, value (API price), shinFair, modelFair, isApiOnly }] }`. `isApiOnly: true` means the row came from Pinnacle specials and has no independently computed Shin (Shin is still computed from the API price if ≥2 rows exist).

---

## Netlify Functions (`netlify/functions/`)

Three functions, all use CommonJS (`require`), all call `initSchema(db)` on every cold start (idempotent `CREATE TABLE IF NOT EXISTS`).

- **`db.js`**: shared Turso client singleton (`@libsql/client/http` — no native binaries), schema SQL, `ok(body)`/`err(msg, status)` response helpers
- **`traders.js`**: `GET /api/traders`, `POST /api/traders`, `POST /api/traders?verify=1`, `PUT /api/traders?id=`
- **`shared-state.js`**: `GET /api/shared-state`, `POST /api/shared-state?entity=templates|league-settings|match-templates|suspensions`
- **`trader-state.js`**: `GET /api/trader-state?traderId=`, `POST /api/trader-state?traderId=&entity=overrides|meta|modes|lambdas|favorites|prefs`

All POST writes use `db.batch(statements, 'write')` — full replace (DELETE + INSERT), not partial upsert.

**Local mock**: `login.js` sets `USE_MOCK = IS_LOCAL` — on `localhost`/`127.0.0.1` auth uses `localStorage._mock_traders` instead of the functions. All other API calls (odds, state sync) always hit the real endpoints.

---

## Environment Variables

Required for Netlify Functions (set in `.env` locally, Netlify dashboard in production):

```
TURSO_CONNECTION_URL=libsql://sportsbookfeed-damirmikic.aws-eu-west-1.turso.io
TURSO_AUTH_TOKEN=<token>
```

---

## Key Conventions

- **Override key format**: `"eventId|marketId|label"` for price overrides, `"eventId|marketId"` for meta and suspensions
- **Trading mode**: `'auto'` is the default and is not stored (only `'manual'` entries exist in `_tradingModes`)
- **Suspension status**: `'suspended'` is stored; `'open'` deletes the key (open is the implicit default)
- **Markets module** (`markets.js`): exports individual market builders (`buildBTTS`, `buildCS`, `buildHTFT`, etc.) that accept a Dixon-Coles score grid and return `{ id, name, cols, selections[] }` objects — consumed by `ui-drawer.js`
- **Dixon-Coles grid**: 10×10 score probability matrix, computed in `math.js`, scaled by `dixonColesTau()` for low-score correlation. H1/H2 grids use half-λ values
