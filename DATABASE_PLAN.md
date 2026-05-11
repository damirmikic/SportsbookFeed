# Database Plan — Turso Integration + Trader Profiles

## Overview

Replace browser-only `localStorage` with **Turso** (distributed SQLite) as the persistent source of truth, accessed through **Netlify Functions**. The frontend keeps `localStorage` as a fast local cache — all writes are synchronous to localStorage and fire-and-forget async to Turso.

---

## Architecture

```
UI Action
  └─► state.js setter
        ├─► localStorage.setItem()        ← immediate (no lag)
        └─► scheduleSync(entity, data)    ← debounced 400ms
              └─► POST /api/<function>    ← Netlify Function
                    └─► Turso SQL upsert

App Startup
  └─► fetchTraders()          → select / create trader + PIN
  └─► fetchSharedState()      → hydrate templates, settings, suspensions
  └─► fetchTraderState(id)    → hydrate overrides, modes, lambdas
  └─► continue with league load
```

**Resilience:** If Turso is unreachable, the app works fully from `localStorage`. Next successful sync brings Turso back in line.

---

## Ownership Model

| Data | Scope | Tables |
|------|-------|--------|
| Trader profiles | Global | `traders` |
| Audit history | Global | `audit_log` |
| Raw odds history | Global | `odds_history` |
| Templates | Global (shared) | `templates` |
| League settings | Global (shared) | `league_settings` |
| Match-level template overrides | Global (shared) | `match_templates` |
| Market suspensions | **Global** — one suspension affects all traders | `suspensions` |
| Price overrides + metadata | **Per-trader** | `trader_overrides`, `trader_override_meta` |
| Trading modes (auto/manual) | Per-trader | `trader_modes` |
| Back-solved lambdas | Per-trader | `trader_lambdas` |
| Favorite leagues | Per-trader | `trader_favorites` |
| Expanded UI groups | Per-trader | `trader_prefs` |

---

## Database Schema

### `traders`
Stores each trading desk member's profile.

```sql
CREATE TABLE IF NOT EXISTS traders (
  id         TEXT PRIMARY KEY,          -- UUID (crypto.randomUUID())
  name       TEXT NOT NULL UNIQUE,      -- Display name e.g. "Alice"
  color      TEXT NOT NULL DEFAULT '#3b82f6', -- UI accent color
  pin_hash   TEXT,                      -- SHA-256 hex of 4–6 digit PIN
  failed_attempts INTEGER NOT NULL DEFAULT 0, -- consecutive failed PIN checks
  locked_until    TEXT,                 -- ISO timestamp; lock clears after expiry
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TIMESTAMP,                 -- soft-delete marker; NULL means visible
  active     INTEGER DEFAULT 1          -- soft delete
);
```

### `audit_log`
Append-only record of durable POST writes.

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  trader_id   TEXT,
  entity      TEXT NOT NULL,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  ts          TEXT DEFAULT (datetime('now'))
);
```

### `odds_history`
Rolling 24-hour raw Pinnacle line snapshots from each poll.

```sql
CREATE TABLE IF NOT EXISTS odds_history (
  event_id TEXT NOT NULL,
  period   TEXT NOT NULL,
  market   TEXT NOT NULL,
  prices   TEXT NOT NULL,
  ts       TEXT DEFAULT (datetime('now'))
);
```

### `templates`
Full template JSON blobs — shared across all traders.

```sql
CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,   -- e.g. "elite", "medium", "low"
  data       TEXT NOT NULL,      -- full template JSON (name, sport, markets[], etc.)
  updated_at TEXT DEFAULT (datetime('now')),
  deleted_at TIMESTAMP           -- soft-delete marker; NULL means visible
);
```

### `league_settings`
Per-league configuration — which template, activation state, alert factor.

```sql
CREATE TABLE IF NOT EXISTS league_settings (
  league_code TEXT PRIMARY KEY,  -- Pinnacle league code
  data        TEXT NOT NULL,     -- JSON: { template, activation, alertFactor }
  updated_at  TEXT DEFAULT (datetime('now'))
);
```

### `match_templates`
Match-level template override (admin assigns a specific template to one event).

```sql
CREATE TABLE IF NOT EXISTS match_templates (
  event_id    TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  set_by      TEXT,              -- trader_id who set it
  updated_at  TEXT DEFAULT (datetime('now'))
);
```

### `suspensions`
Global market suspension state. One trader suspending a market suspends it for everyone.
League-wide suspensions use keys shaped like `league|{leagueCode}|event` and are checked before event or market keys.

```sql
CREATE TABLE IF NOT EXISTS suspensions (
  key    TEXT PRIMARY KEY,       -- "eventId|event" or "eventId|marketId"
  status TEXT NOT NULL DEFAULT 'suspended',
  set_by TEXT,                   -- trader_id
  set_at TEXT DEFAULT (datetime('now'))
);
```

### `trader_overrides`
Manual price overrides — each trader has their own set.

```sql
CREATE TABLE IF NOT EXISTS trader_overrides (
  trader_id TEXT NOT NULL,
  key       TEXT NOT NULL,       -- "eventId|marketId|label" e.g. "12345|ml|Home"
  value     TEXT NOT NULL,       -- price string, 3 decimal places e.g. "2.450"
  PRIMARY KEY (trader_id, key)
);
```

### `trader_override_meta`
Metadata for override expiry tracking and VALUE_BET alert state.

```sql
CREATE TABLE IF NOT EXISTS trader_override_meta (
  trader_id TEXT NOT NULL,
  key       TEXT NOT NULL,       -- "eventId|marketId"
  data      TEXT NOT NULL,       -- JSON: { selections, alertState, valueBetGap, setAt }
  PRIMARY KEY (trader_id, key)
);
```

**`data` shape:**
```json
{
  "selections": {
    "Home": {
      "overridePrice": 2.45,
      "direction": "UP",
      "overrideImpliedProb": 0.408,
      "shinFairAtTime": 2.40
    }
  },
  "alertState": "VALUE_BET",
  "valueBetGap": 0.05,
  "setAt": 1704067200000
}
```

### `trader_modes`
Whether each trader is in AUTO or MANUAL mode for a given event.

```sql
CREATE TABLE IF NOT EXISTS trader_modes (
  trader_id TEXT NOT NULL,
  event_id  TEXT NOT NULL,
  mode      TEXT NOT NULL DEFAULT 'manual',  -- only 'manual' stored; auto = absence
  PRIMARY KEY (trader_id, event_id)
);
```

### `trader_lambdas`
Back-solved Dixon-Coles parameters (λh, λa, ρ, score grid) derived from manual overrides.

```sql
CREATE TABLE IF NOT EXISTS trader_lambdas (
  trader_id TEXT NOT NULL,
  event_id  TEXT NOT NULL,
  data      TEXT NOT NULL,       -- JSON: { lh, la, rho, grid: [{home,away,prob},...] }
  PRIMARY KEY (trader_id, event_id)
);
```

### `trader_favorites`
Each trader's pinned leagues.

```sql
CREATE TABLE IF NOT EXISTS trader_favorites (
  trader_id   TEXT NOT NULL,
  league_code TEXT NOT NULL,
  PRIMARY KEY (trader_id, league_code)
);
```

### `trader_prefs`
Miscellaneous per-trader UI preferences (expanded groups, etc.).

```sql
CREATE TABLE IF NOT EXISTS trader_prefs (
  trader_id       TEXT PRIMARY KEY,
  expanded_groups TEXT DEFAULT '[]'   -- JSON array of expanded country/group names
);
```

---

## Netlify Functions

All functions are in `netlify/functions/`. They share a Turso client via `db.js` and auto-create the schema on first cold start.

### `db.js` — shared module
- `getClient()` — lazy singleton `@libsql/client/http` (no native binaries)
- `initSchema(db)` — runs all `CREATE TABLE IF NOT EXISTS` statements
- `ok(body, status)` / `err(message, status)` — response helpers

### `traders.js` — `/api/traders`

| Method | Query | Body | Action |
|--------|-------|------|--------|
| `GET` | — | — | List active traders `[{ id, name, color }]` |
| `POST` | — | `{ name, color, pin }` | Create trader → SHA-256 hash PIN |
| `POST` | `?verify=1` | `{ id, pin }` | Verify PIN → `{ ok: true/false }`; locks for 5 minutes after 5 failures |
| `PUT` | `?id=` | `{ name?, color?, pin? }` | Update trader |

### `audit-log.js` — `/api/audit-log`

| Method | Query | Body | Action |
|--------|-------|------|--------|
| `GET` | `?limit=100` | — | Return recent audit rows with trader, entity, action, before/after, timestamp |

### `odds-history.js` — `/api/odds-history`

| Method | Query | Body | Action |
|--------|-------|------|--------|
| `POST` | — | Raw league odds payload | Extract market snapshots, insert rows, prune data older than 24h |
| `GET` | `?eventId=` | — | Return last 24h of snapshots for one event |

### `shared-state.js` — `/api/shared-state`

| Method | Query | Action |
|--------|-------|--------|
| `GET` | — | Return `{ templates[], leagueSettings{}, matchTemplates{}, suspensions{} }` |
| `POST` | `?entity=templates` | Bulk upsert templates array |
| `POST` | `?entity=league-settings` | Bulk upsert `{ [code]: settingsObj }` |
| `POST` | `?entity=match-templates` | Bulk upsert `{ [eventId]: templateId }` |
| `POST` | `?entity=suspensions` | Bulk upsert `{ [key]: { status, set_by } }` — rows with `status='open'` are deleted |

### `trader-state.js` — `/api/trader-state`

| Method | Query | Action |
|--------|-------|--------|
| `GET` | `?traderId=` | Return `{ overrides{}, overrideMeta{}, modes{}, lambdas{}, favorites[], expandedGroups[] }` |
| `POST` | `?traderId=&entity=overrides` | Replace all overrides for trader |
| `POST` | `?traderId=&entity=meta` | Replace all override meta for trader |
| `POST` | `?traderId=&entity=modes` | Replace all trading modes for trader |
| `POST` | `?traderId=&entity=lambdas` | Replace all lambda data for trader |
| `POST` | `?traderId=&entity=favorites` | Replace all favorites for trader |
| `POST` | `?traderId=&entity=prefs` | Upsert expanded_groups preference |

---

## Frontend Changes

### New file: `package.json`
```json
{ "dependencies": { "@libsql/client": "^0.14.0" } }
```

### Modified: `netlify.toml`
```toml
[functions]
  directory = "netlify/functions"

[[redirects]]
  from = "/api/traders"
  to   = "/.netlify/functions/traders"
  status = 200

[[redirects]]
  from = "/api/shared-state"
  to   = "/.netlify/functions/shared-state"
  status = 200

[[redirects]]
  from = "/api/trader-state"
  to   = "/.netlify/functions/trader-state"
  status = 200
```

### Modified: `api.js`
Seven new async functions added below existing Pinnacle fetchers:
- `fetchTraders()`
- `createTrader(name, color, pin)`
- `verifyTraderPin(id, pin)`
- `fetchSharedState()`
- `pushSharedState(entity, data)`
- `fetchTraderState(traderId)`
- `pushTraderState(traderId, entity, data)`

### Modified: `state.js`
1. `state.currentTraderId` added (reads from `localStorage`)
2. `scheduleSync(entity, data)` — debounced 400ms dispatcher
3. Each setter gets one `scheduleSync(...)` call after its `localStorage.setItem`

**Entity → function mapping:**

| `scheduleSync` entity | Function called | Trader-scoped? |
|-----------------------|-----------------|---------------|
| `'templates'` | `pushSharedState` | No |
| `'league-settings'` | `pushSharedState` | No |
| `'match-templates'` | `pushSharedState` | No |
| `'suspensions'` | `pushSharedState` | No |
| `'overrides'` | `pushTraderState` | Yes |
| `'meta'` | `pushTraderState` | Yes |
| `'modes'` | `pushTraderState` | Yes |
| `'lambdas'` | `pushTraderState` | Yes |
| `'favorites'` | `pushTraderState` | Yes |
| `'prefs'` | `pushTraderState` | Yes |

### Modified: `index.html`
- Trader chip added to header nav (name + color dot)
- `<div id="trader-modal">` with three screens: Select / Create / PIN Entry

### Modified: `app.js`
Startup sequence before league load:
```
1. fetchTraders()
   ├── empty → show Create screen
   └── has traders → check localStorage.currentTraderId
         ├── valid → show PIN entry → verify → load state
         └── invalid / missing → show Select screen → PIN entry → load state

2. [parallel] fetchSharedState() + fetchTraderState(traderId)
   → hydrate localStorage without triggering sync back to Turso

3. existing league/UI init
```

---

## Auth: PIN Flow

- PINs are 4–6 digits
- Stored as `SHA-256(pin)` hex string in `traders.pin_hash`
- Hashing done server-side in `traders.js` using Node.js `crypto.createHash('sha256')`
- `verifyTraderPin` computes hash server-side and compares — PIN never stored in plaintext
- No JWT / session tokens needed for an internal trading desk tool
- `currentTraderId` stored in `localStorage` after successful PIN verify

---

## Environment Variables

```
TURSO_CONNECTION_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQSJ9...
```

- **Local dev:** `.env` file in project root (gitignored)
- **Production:** Netlify dashboard → Site configuration → Environment variables

---

## Verification Checklist

| Step | How to test |
|------|-------------|
| Schema init | `GET /api/traders` on cold start → no error, returns `[]` |
| Create trader | POST `{ name: "Alice", color: "#ef4444", pin: "1234" }` → row in `traders` table |
| PIN verify | POST `{ id, pin: "1234" }` with `?verify=1` → `{ ok: true }` |
| Wrong PIN | POST `{ id, pin: "0000" }` → `{ ok: false }` |
| Shared state GET | GET `/api/shared-state` → `{ templates, leagueSettings, matchTemplates, suspensions }` |
| Template sync | Save template in UI → 400ms → row appears in `templates` table |
| Override sync | Set price override → 400ms → row in `trader_overrides` |
| Cross-device | Load app in second browser → same trader + PIN → overrides load correctly |
| Offline mode | Disconnect network → app still works from localStorage |
| Global suspension | Trader A suspends market → Trader B refreshes → sees SUSP |
