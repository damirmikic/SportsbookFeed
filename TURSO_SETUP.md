# Turso + Netlify Integration — Complete Setup Guide

Everything in this repo is already coded. This guide covers the one-time setup needed to connect it to a live Turso database and run it via Netlify Functions — both locally and in production.

---

## Prerequisites

Install three CLI tools (all global, one-time):

```powershell
# 1 — Turso CLI (Windows — PowerShell as admin)
winget install turso

# 2 — Netlify CLI
npm install -g netlify-cli

# 3 — Node dependencies for the functions
cd "C:\Users\kvoter2\Desktop\Projects\Betting\SportsbookFeed"
npm install
```

> **Node version**: Requires Node 18+. You have v24.15.0 — you're good.

---

## Step 1 — Create a Turso Database

```powershell
# Authenticate (opens browser)
turso auth login

# Create the database (name it anything, we use "sportsbook")
turso db create sportsbook

# Get the connection URL
turso db show sportsbook --url
# → libsql://sportsbook-<yourname>.turso.io

# Create an auth token (never expires — save this)
turso db tokens create sportsbook
# → eyJ...  (long JWT string)
```

Copy both values — you'll need them in the next step.

---

## Step 2 — Create the Local `.env` File

Create a file named `.env` in the project root (it is gitignored):

```
TURSO_CONNECTION_URL=libsql://sportsbook-<yourname>.turso.io
TURSO_AUTH_TOKEN=eyJ...your-token-here...
```

Replace the placeholders with the actual values from Step 1.

---

## Step 3 — Verify the Schema Initialises

The functions auto-create all 11 tables on their first request via `initSchema()`.
You can trigger it manually to verify the credentials work:

```powershell
# Start Netlify dev server (reads .env automatically)
netlify dev
```

Then in a second terminal:

```powershell
# Hit the traders endpoint — this creates all tables
curl http://localhost:8888/api/traders
# Expected: [] (empty array — no traders yet)
```

After this, check the Turso dashboard to confirm the tables exist:

```powershell
turso db shell sportsbook
# Inside the shell:
.tables
# Should list: traders, templates, league_settings, match_templates,
#              suspensions, trader_overrides, trader_override_meta,
#              trader_modes, trader_lambdas, trader_favorites, trader_prefs
.quit
```

---

## Step 4 — Test the Full Login Flow Locally

With `netlify dev` running at `http://localhost:8888`:

1. Open `http://localhost:8888/login.html`
2. Click **Create new operator**
3. Fill in name, pick a colour, set a PIN
4. Click **Create Profile** — you'll land on `index.html`

Verify the trader was written to Turso:

```powershell
turso db shell sportsbook "SELECT id, name, color FROM traders;"
```

Sign out (click the trader chip in the top nav), sign back in with your PIN — should work immediately.

> **Note**: `login.js` has `USE_MOCK = IS_LOCAL` which means on `localhost` it still uses the localStorage mock backend, **not** the real API. See the section below if you want to test the real API locally.

### Testing the real API locally (optional)

To force `login.js` to hit the real Netlify Functions instead of the mock:

```js
// login.js line 11 — temporarily change:
const USE_MOCK = false;  // was: IS_LOCAL
```

Revert after testing. The mock is intentional for offline-first local dev.

---

## Step 5 — Verify State Sync

After signing in via the real API:

1. Open any league → select a match → edit a price in the drawer
2. Wait 400ms (the debounce)
3. Check Turso:

```powershell
turso db shell sportsbook "SELECT * FROM trader_overrides LIMIT 5;"
```

You should see the override row. This confirms the write-through cache is working.

---

## Step 6 — Deploy to Netlify

### 6a — Link the site

```powershell
# From the project root
netlify link
# → Follow prompts to link to your existing Netlify site
#   (or "Create & configure a new site" if you haven't deployed yet)
```

### 6b — Set environment variables in Netlify

```powershell
netlify env:set TURSO_CONNECTION_URL "libsql://sportsbook-<yourname>.turso.io"
netlify env:set TURSO_AUTH_TOKEN    "eyJ...your-token-here..."
```

Or set them in the Netlify dashboard:
**Site settings → Environment variables → Add variable**

### 6c — Deploy

```powershell
netlify deploy --prod
```

Netlify will bundle the functions in `netlify/functions/` and publish the static files from the project root.

---

## Step 7 — Smoke Test Production

Once deployed, open your Netlify site URL:

1. `https://your-site.netlify.app/login.html` — create an operator
2. Sign in → main terminal loads
3. Select a league, open the drawer, edit a price
4. Open the site in a second browser → sign in as the same operator
5. Verify the price override is there (hydrated from Turso on load)

---

## Architecture Recap

```
Browser (any device)
  │
  ├── login.html  →  POST /api/traders          (create / verify PIN)
  │
  └── index.html  →  GET  /api/shared-state     (templates, league settings, suspensions)
                  →  GET  /api/trader-state     (overrides, modes, lambdas, favorites)
                  →  Sync every 400ms on change
                       POST /api/shared-state?entity=suspensions
                       POST /api/trader-state?entity=overrides
                       ...etc

Netlify Functions  →  @libsql/client/http  →  Turso (distributed SQLite)
```

**Key properties:**
- `localStorage` is written first — zero UI lag
- Turso sync is fire-and-forget — network failure never blocks the UI
- Startup hydration (`Promise.allSettled`) fails silently — app works offline from localStorage
- Suspensions are **global** (all traders see the same suspension state)
- Overrides / modes / lambdas are **per-trader** (scoped by `trader_id`)

---

## Database Tables Reference

| Table | Scope | Description |
|-------|-------|-------------|
| `traders` | Global | Operator profiles, PIN hashes, failed-attempt locks |
| `audit_log` | Global | Append-only before/after log for durable POST writes |
| `templates` | Global | Pricing templates |
| `league_settings` | Global | Template assignment + activation per league |
| `match_templates` | Global | Per-match template overrides |
| `suspensions` | Global | Event / market suspensions |
| `trader_overrides` | Per-trader | Manual price overrides |
| `trader_override_meta` | Per-trader | Override context (direction, shin fair, alert state) |
| `trader_modes` | Per-trader | AUTO vs MANUAL per event |
| `trader_lambdas` | Per-trader | Back-solved Dixon-Coles λh/λa/ρ |
| `trader_favorites` | Per-trader | Pinned leagues |
| `trader_prefs` | Per-trader | Expanded UI groups |

---

## Troubleshooting

### `Error: TURSO_CONNECTION_URL and TURSO_AUTH_TOKEN env vars are required`
The `.env` file is missing or the variable names don't match exactly. Run `netlify dev` (not `node` directly) — it loads `.env` automatically.

### `HTTP 500` from `/api/traders` on first hit
Usually a bad auth token. Regenerate: `turso db tokens create sportsbook --expiration none`

### Functions return `Method not allowed`
The request is hitting a Pinnacle proxy redirect instead of the function. Check `netlify.toml` — the `/api/traders` redirect must come **after** the Pinnacle redirects and must not have `force = true`.

### Traders created locally don't appear on production
Local dev uses the mock backend (`USE_MOCK = IS_LOCAL`). Create traders in production via the deployed login page.

### Schema out of sync after adding a new table
`initSchema()` only runs `CREATE TABLE IF NOT EXISTS` — it won't alter existing tables. For schema changes, run the new SQL manually:
```powershell
turso db shell sportsbook "ALTER TABLE traders ADD COLUMN display_name TEXT;"
```

---

## Environment Variables Summary

| Variable | Where to get it |
|----------|----------------|
| `TURSO_CONNECTION_URL` | `turso db show sportsbook --url` |
| `TURSO_AUTH_TOKEN` | `turso db tokens create sportsbook` |

Set in:
- **Local**: `.env` file in project root (gitignored)
- **Production**: Netlify dashboard → Site settings → Environment variables
