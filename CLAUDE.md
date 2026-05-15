# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Running the App

**Local dev (full stack — Netlify Functions + Turso):**
```bash
netlify dev
# Opens at http://localhost:8888
# Entry point is index.html directly (login is disabled — see Auth section)
```

**Frontend only (no functions, mock auth):**
```bash
npx serve .
# Opens at http://localhost:3000
# 404/405 errors on API calls are expected in this mode
```

**No build step.** All JS is ES modules served directly. No bundler, no transpilation.

**Install dependencies** (only needed for Netlify Functions — `@libsql/client`):
```bash
npm install
```

---

## Architecture

Pure browser ES module app. No framework, no build tool. Entry points: `login.html` → `login.js` (currently a pass-through — see Auth) and `index.html` → `app.js` (trading terminal).

### Module Dependency Tree

```
app.js                          ← bootstrap, polling, view switching
├── auth-session.js             ← session read/write/expiry helpers (localStorage only)
├── api.js                      ← all fetch calls (Pinnacle + Turso + manual-data)
├── state.js                    ← singleton state, localStorage, Turso sync
├── ui.js                       ← barrel: re-exports from ui-* modules
│   ├── ui-leagues.js           ← left sidebar (league list, search, favorites)
│   ├── ui-board.js             ← main event table (odds, trend arrows, offered prices)
│   ├── ui-drawer.js            ← right-side detail drawer (market cards, lambda UI)
│   ├── ui-market-table.js      ← comparison table inside drawer (Shin|Model|API|Offer|Override)
│   ├── ui-helpers.js           ← margin badge HTML, effective period computation
│   └── ui-market-groups.js     ← market card grouping for drawer categories
├── admin.js                    ← Admin > Tournaments panel
├── templates-admin.js          ← Admin > Templates panel (template CRUD, market discovery)
├── audit-admin.js              ← Admin > Audit Log panel
├── manual-leagues-admin.js     ← Admin > Custom Leagues panel (manual league/event CRUD)
└── odds-history-ui.js          ← per-selection price history modal

pricing.js                      ← template resolution + override expiry/alert evaluation
math.js                         ← Shin no-vig, Dixon-Coles model, Asian odds, ladder rounding, clampOdds
markets.js                      ← core market builders from score grid (BTTS, DC, DNB, CS)
utils.js                        ← getTeamNames() helper
solver.worker.js                ← Web Worker: off-thread lambda solver
```

### Data Flow

**Odds pipeline (every 30s poll):**
1. `fetchOdds(leagueCode)` → raw Pinnacle odds (skipped for manual leagues — loads from `fetchManualEvents` instead)
2. `renderOdds()` in `ui-board.js` → snapshot previous odds, render event rows
3. Per-event: resolve template → `applyMarginAndLadder(shinFair, margin, ladder)` → `clampOdds(offered, minOdds, maxOdds)` for AUTO mode offered price
4. Trend arrows compare **raw Pinnacle prices** against `previousOdds` snapshot (not offered prices)

**Manual leagues:**
- `isManualLeague(code)` in `state.js` checks `state.manualLeagues`
- `formatManualEvent(row)` in `ui-board.js` converts a DB row → Pinnacle event shape, computing odds from either lambdas (`dcMatchProbs`/`dcOverProb`) or direct odds entry
- Manual leagues skip the 30s polling interval entirely

**Price editing (MANUAL mode in drawer):**
1. User edits a cell in `ui-market-table.js` → `setOverride(key, value)` in `state.js`
2. `repriceOthers()` back-solves remaining outcomes to maintain book sum
3. `scheduleSync('overrides')` fires 400ms debounce → Turso
4. `solveLambdasAsync()` runs off-thread via `solver.worker.js`

**Startup hydration:**
```
DOMContentLoaded
  → auto-create synthetic session { id: 'default-trader', role: 'owner' } if none exists
  → Promise.allSettled([fetchSharedState(), fetchTraderState(traderId)])
      → hydrateSharedState() / hydrateTraderState()
  → fetchLeagues() → renderLeagues()
  → fetchManualLeagues() → merge into state.allLeagues with isManual: true flag
```

### Pinnacle API Proxy

In production (`netlify dev` or deployed), `netlify.toml` reverse-proxies `/api/leagues`, `/api/odds/:code`, and `/api/odds/event/:id` to `pinnacle888.com`. When running without Netlify (`npx serve .`), `api.js` detects `IS_LOCAL` and hits Pinnacle directly.

---

## Auth

Login is **disabled**. `login.js` immediately sets a synthetic session and redirects to `index.html`. `app.js` auto-creates `{ id: 'default-trader', name: 'Trader', color: '#3b82f6', role: 'owner' }` if no valid session exists.

`canDo(_permission)` in `state.js` always returns `true` — all permission gates are bypassed.

`updateTraderPresence()` in `app.js` skips the API call when `traderId === 'default-trader'` to avoid a FOREIGN KEY constraint (the synthetic ID has no row in the `traders` table).

---

## State Architecture (`state.js`)

All mutable state lives in `state.js`. The `state` object holds transient runtime data (`activeEvents`, `allLeagues`, `previousOdds`, `manualLeagues`). Private `_variables` hold persisted data:

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
| `_pendingOverrides` | `pendingOverrides` | `pending-overrides` | **Global** |

**Write pattern**: every setter calls `persistTraderEntity(entity, data)` or `persistSharedEntity(entity, data)` which does: `localStorage.setItem` (sync) + `scheduleSync(entity)` (debounced 400ms async Turso write).

**Hydration guard**: `isHydrating = true` during `hydrateSharedState()` / `hydrateTraderState()` — prevents `scheduleSync()` from firing during startup population.

**Template versioning**: `TEMPLATE_VERSION` constant in `state.js` (currently `7`). If the stored version doesn't match, `_templates` resets to `DEFAULT_TEMPLATES`. **Bump this constant whenever `DEFAULT_TEMPLATES` or `MARKET_DEFS` change.**

---

## Pricing Engine (`pricing.js`)

**Template resolution order** (first match wins):
1. Match-level override: `matchTemplates[eventId]`
2. Feed timeline: `leagueSettings[leagueCode].templateTimeline` (array of `{ nodeId, templateId }`)
3. League default: `leagueSettings[leagueCode].template`
4. `null` — no pricing applied, raw Pinnacle odds shown

**Timeline nodes** (`TIMELINE_NODES` in `state.js`): 26 nodes from `INST` (infinity, always active) down to `15m`. `resolveActiveKey(marketConfig, eventStartTime)` returns `{ key: timelineEntry, node, minutesToKickoff }` where `key` is the full timeline entry object `{ margin, enabled, maxBet }`. Callers must read `tl.key.margin`, not `tl.key`, to get the margin value.

**Override expiry / value-bet alerts** (`evaluateOverrides()` in `pricing.js`): called during each `renderOdds()` cycle. Compares current Shin fair against the stored `shinFairAtTime` in `_overrideMeta`.

---

## Odds Laddering & Capping (`math.js`)

**`applyMarginAndLadder(fairOdds, marginPct, ladder)`**:
1. Divide fair price by `(1 + margin/100)` to get margined price
2. Snap to ladder (`'eu'` floors to standard decimal steps; `'us'` snaps to 5-unit American increments)
3. Always **floors** (never rounds up) to preserve bookmaker edge

**`clampOdds(offered, minOdds, maxOdds)`**: applied after `applyMarginAndLadder` in both `ui-board.js` and `ui-market-table.js`. Enforces per-market or template-level floor/ceiling. Market-level caps take priority over template-level (`market.minOdds ?? template.minOdds ?? null`).

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
  minOdds: number | null,   // global floor for all markets
  maxOdds: number | null,   // global ceiling for all markets
  createdAt: ISO string,
  updatedAt: ISO string,
  markets: MarketConfig[]
}
```

**MarketConfig** (one entry per `MARKET_DEFS` id):
```js
{
  id: string,
  enabled: boolean,
  margin: number,       // base margin % — e.g. 5 means 5%, NOT 0.05
  maxBet: number,
  ladder: 'eu' | 'us',
  rangeLimit: null | number,
  minOdds: null | number,   // market-level floor, overrides template global
  maxOdds: null | number,   // market-level ceiling, overrides template global
  timeline: {
    [nodeId]: { margin: number, enabled: boolean, maxBet: number }
  }
}
```

**`MARKET_DEFS` IDs** (canonical list in `state.js`):
`1x2`, `dc`, `dnb`, `asian_hcp`, `asian_tot`, `ou15`, `ou25`, `ou35`, `btts`, `btts_ou`, `cs`, `exact_goals`, `win_nil`, `htft`

The `DRAWER_TO_TPL_ID` map in `ui-drawer.js` translates drawer market IDs (e.g. `'ml'`) to template IDs (e.g. `'1x2'`).

---

## Lambda Data Structure

`calculateTeamLambdasAsync()` (in `math.js`, called from `ui-drawer.js`) returns:
```js
{
  ft: { lh, la, rho, grid: [{home, away, prob}] },
  h1: { lh, la, rho: 0, grid },
  h2: { lh, la, rho: 0, grid },
  splitFraction: number,
}
```

`grid` is adaptive-size: `max(8, ceil(λ + 4√λ + 1))`. H1/H2 grids use `rho = 0`.

**Solver** (`math.js`): warm-start + Adam gradient descent (≤300 iterations, tol 1e-11) against joint 1x2 + OU + Asian HCP loss. Async variant dispatches to `solver.worker.js`.

---

## Custom (Manual) Leagues

Custom leagues are stored in Turso and served by `netlify/functions/manual-data.js`. They appear in the sidebar alongside Pinnacle leagues.

**Event input modes:**
- `'odds'`: user enters raw 1x2 + OU prices directly
- `'lambdas'`: user enters λH, λA, ρ; prices computed via `dcMatchProbs` / `dcOverProb`

Each event has a configurable `ou_line` (not hardcoded to 2.5).

`formatManualEvent(row)` in `ui-board.js` converts DB rows to the standard Pinnacle event shape so the rest of the board pipeline (template pricing, drawer, etc.) works identically.

---

## Drawer Market Categories

`groupMarketsByCategory()` in `ui-market-groups.js` returns markets keyed by:

| Category | Contents |
|---|---|
| `MATCH ODDS` | 1x2, DC, DNB, derived BTTS |
| `HANDICAP` | Asian handicap (5 closest lines) |
| `GOALS` | All OU lines, CS, BTTS, Both Halves OU |
| `TEAM GOALS` | Home/away team totals |
| `1ST HALF` | H1 1x2, total, team totals, BTTS, result combos |
| `2ND HALF` | Model-only H2 1x2, total, team totals, Pinnacle 2nd-half specials |
| `CORNERS` | Pinnacle corner specials |
| `BOOKINGS` | Pinnacle card/booking specials |
| `TEAM PROPS` | Win/score both halves, win either half |
| `SPECIALS` | HTFT, winning margin, other Pinnacle specials |
| `PLAYER PROPS` | Goalscorer, anytime scorer |

---

## Netlify Functions (`netlify/functions/`)

All use CommonJS (`require`). `db.js` is a shared helper; all others are HTTP endpoints. Every function calls `initSchema(db)` on cold start (idempotent).

- **`db.js`**: Turso client (`@libsql/client/http`), schema SQL, `ok()`/`err()` helpers, `writeAuditLog()`
- **`traders.js`**: `GET/POST /api/traders`, `POST /api/traders?verify=1`, `PUT /api/traders?id=`
- **`shared-state.js`**: `GET/POST /api/shared-state?entity=templates|league-settings|match-templates|suspensions|pending-overrides`
- **`trader-state.js`**: `GET/POST /api/trader-state?traderId=&entity=overrides|meta|modes|lambdas|favorites|prefs`
- **`trader-presence.js`**: `GET/POST /api/trader-presence` (3-minute active window; skipped for `default-trader`)
- **`audit-log.js`**: `GET /api/audit-log[?limit=N]` (read-only, max 250 entries)
- **`odds-history.js`**: `GET/POST /api/odds-history?eventId=` (rolling 24h snapshots)
- **`manual-data.js`**: `GET/POST/PUT/DELETE /api/manual-data?type=leagues|events` — full CRUD for custom leagues and events; DELETE league cascades to delete its events

All POST writes use `db.batch(statements, 'write')` — full replace (DELETE + INSERT), not partial upsert.

---

## Environment Variables

Required for Netlify Functions (set in `.env` locally, Netlify dashboard in production):

```
TURSO_CONNECTION_URL=libsql://sportsbookfeed-damirmikic.aws-eu-west-1.turso.io
TURSO_AUTH_TOKEN=<token>
```

---

## Database Schema (Turso / SQLite)

All tables created by `initSchema()` in `netlify/functions/db.js`. Migrations run as idempotent `ALTER TABLE … ADD COLUMN`.

| Table | Key columns | Notes |
|---|---|---|
| `traders` | `id`, `name`, `color`, `pin_hash`, `role`, `active`, `deleted_at` | Soft-delete; `role` is `'trader'` or `'admin'` |
| `templates` | `id`, `data` (JSON), `deleted_at` | Soft-delete; `data` is the full Template object |
| `league_settings` | `league_code` PK, `data` (JSON) | One row per league |
| `match_templates` | `event_id` PK, `template_id`, `set_by` | Per-event template override |
| `suspensions` | `key` PK, `status`, `set_by` | Key: `"eventId\|marketId"` |
| `pending_overrides` | `key` PK, `data` (JSON) | Shared approval queue |
| `trader_overrides` | `(trader_id, key)` PK, `value` | Key: `"eventId\|marketId\|label"` |
| `trader_override_meta` | `(trader_id, key)` PK, `data` (JSON) | `shinFairAtTime`, `alertState`, expiry |
| `trader_modes` | `(trader_id, event_id)` PK, `mode` | Only `'manual'` rows stored |
| `trader_lambdas` | `(trader_id, event_id)` PK, `data` (JSON) | Overridden λ values |
| `trader_favorites` | `(trader_id, league_code)` PK | Starred leagues |
| `trader_prefs` | `trader_id` PK, `expanded_groups` (JSON) | UI preference state |
| `trader_presence` | `trader_id` PK, `league_code`, `league_name`, `last_seen` | 3-min active window; no FK to traders (synthetic IDs allowed) |
| `audit_log` | `id` UUID PK, `trader_id`, `entity`, `action`, `before_json`, `after_json`, `ts` | Append-only |
| `odds_history` | `event_id`, `period`, `market`, `prices` (JSON), `ts` | Rolling 24h; indexed on `(event_id, ts)` |
| `manual_leagues` | `id`, `name`, `code` UNIQUE, `created_by`, timestamps | Custom leagues |
| `manual_events` | `id`, `league_code`, `home`, `away`, `starts`, `input_mode`, `lh`, `la`, `rho`, `home_odds`, `draw_odds`, `away_odds`, `over_odds`, `under_odds`, `ou_line` | Custom events; `input_mode` is `'odds'` or `'lambdas'` |

---

## Key Conventions

- **Override key format**: `"eventId|marketId|label"` for price overrides, `"eventId|marketId"` for meta and suspensions
- **Trading mode**: `'auto'` is the default and is not stored (only `'manual'` entries exist in `_tradingModes`)
- **Suspension status**: `'suspended'` is stored; `'open'` deletes the key
- **Margin is a percentage**: `margin: 5` means 5%, giving `offer = fair / 1.05`. Never store as a decimal (0.05). The UI caps input at 50.
- **Pinnacle odds field names**: the API returns both `moneyLine`/`moneyline`, `homePrice`/`home`, `drawPrice`/`draw`, `awayPrice`/`away` — always coalesce both forms
- **Dixon-Coles grid**: adaptive-size, scaled by `dixonColesTau()` for low-score correlation. H1/H2 grids use half-λ and `rho = 0`
- **Search behaviour**: `renderLeagues()` falls back to showing all leagues when no league names match the search term (user is searching for a team in the board, not a league)
