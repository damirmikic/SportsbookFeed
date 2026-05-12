# SportsbookFeed

A browser-based sportsbook trading terminal for live football odds management. Fetches live data from the Pinnacle feed, runs a Dixon-Coles probability model, applies configurable pricing templates with margin and ladder controls, and surfaces a full market board for manual trading across 10+ market categories.

---

## Running the App

**Full stack — Netlify Functions + Turso (recommended):**
```bash
npm install
netlify dev
# Opens at http://localhost:8888
# Login at login.html, then trades at index.html
```

**Frontend only — no functions, mock auth:**
```bash
npx serve .
# Opens at http://localhost:3000
# login.js uses localStorage mock when hostname is localhost/127.0.0.1
```

No build step. All JS is ES modules served directly — no bundler, no transpilation.

---

## Environment Variables

Required for Netlify Functions (`.env` locally, Netlify dashboard in production):

```
TURSO_CONNECTION_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=<token>
```

---

## Architecture

Pure browser ES module app. No framework. Entry points: `login.html` → `login.js` (auth) and `index.html` → `app.js` (trading terminal).

```
app.js                          ← bootstrap, polling, view switching
├── api.js                      ← all fetch calls (Pinnacle + Turso)
├── state.js                    ← singleton state, localStorage, Turso sync
├── ui.js                       ← barrel: re-exports from ui-* modules
│   ├── ui-leagues.js           ← left sidebar (league list, search, favorites)
│   ├── ui-board.js             ← main event table (odds, trend arrows, offered prices)
│   ├── ui-drawer.js            ← right-side detail drawer (market cards, lambda UI)
│   ├── ui-market-table.js      ← comparison table (Shin|Model|API|Offer|Override)
│   ├── ui-helpers.js           ← margin badge HTML, effective period computation
│   └── ui-market-groups.js     ← market card grouping for drawer categories
├── admin.js                    ← Admin > Tournaments panel
└── templates-admin.js          ← Admin > Templates panel

pricing.js                      ← template resolution + override expiry/alert evaluation
math.js                         ← Shin no-vig, Dixon-Coles model, Asian odds, ladder rounding
markets.js                      ← core market builders from score grid (BTTS, DC, DNB, CS)
utils.js                        ← getTeamNames() helper
solver.worker.js                ← Web Worker: off-thread lambda solver

netlify/functions/
├── db.js                       ← shared Turso client, schema, audit log helper
├── traders.js                  ← trader CRUD + PIN auth
├── shared-state.js             ← global state: templates, league-settings, match-templates,
│                                  suspensions, pending-overrides
├── trader-state.js             ← per-trader state: overrides, modes, lambdas, favorites, prefs
├── trader-presence.js          ← real-time active trader tracking
├── audit-log.js                ← audit log reader
└── odds-history.js             ← 24-hour price history per event/market
```

### Pinnacle API Proxy

`netlify.toml` reverse-proxies `/api/leagues`, `/api/odds/:code`, and `/api/odds/event/:id` to `pinnacle888.com` — no CORS issues. Running without Netlify (`npx serve .`) hits Pinnacle directly from the browser.

---

## Features

### Authentication & Trader Profiles

- PIN-based login (4–6 digit PIN, SHA-256 hashed server-side)
- Brute-force protection: account locks for 5 minutes after 5 failed attempts
- Session TTL: 8 hours by default; configurable via `localStorage.sessionTtlMs` or `localStorage.sessionTtlMode = "end-of-day"`
- Multiple named trader profiles, each with a display colour

### Trader Roles & Permissions

Three-tier role hierarchy enforced across the UI:

| Role | Set price overrides | Manage leagues & templates | Manage trader roles |
|---|---|---|---|
| **Monitor** | — | — | — |
| **Trader** | ✓ | — | — |
| **Senior** | ✓ | ✓ | ✓ |

Senior traders assign roles to other traders via the **Trader Management** section in the Admin panel. Controls that exceed the current trader's role are disabled with a tooltip.

### League Browser

- Searchable, grouped by country, with collapsible groups
- Favorites pinning — persisted per trader in Turso
- Active league highlighted with current event count shown
- **Handover note banner**: when a league with a shift note is selected, a dismissable amber banner appears above the board

### Odds Board

- Live Pinnacle odds polled every 30 seconds per league
- Trend arrows for price movement vs previous poll snapshot (home/draw/away, over/under)
- Per-event offered price column (AUTO or MANUAL mode indicator)
- Per-event badges for suspension, manual overrides, and assigned template
- Keyboard navigation:

| Key | Action |
|---|---|
| `↑` / `←` | Previous event row |
| `↓` / `→` | Next event row |
| `Space` | Open event detail drawer |
| `S` | Suspend / publish selected event |
| `M` | Toggle manual / auto mode |
| `?` | Show keyboard shortcuts overlay |

### Event Detail Drawer

Right-side panel opened per event showing the full market breakdown. Each market row displays:

**Shin fair** (devigged from Pinnacle) | **Model fair** (Dixon-Coles) | **API price** (raw Pinnacle) | **Offered price** (post-margin+ladder) | **Override** (editable)

Markets are grouped into categories:

| Category | Contents |
|---|---|
| **MATCH ODDS** | 1x2, Double Chance, Draw No Bet, BTTS (model) |
| **HANDICAP** | Asian Handicap — 5 closest lines |
| **GOALS** | All OU lines, Correct Score, BTTS, Both-Halves OU |
| **TEAM GOALS** | Home team totals, Away team totals |
| **1ST HALF** | H1 1x2, H1 total, H1 team totals, H1 BTTS, H1 result combos |
| **2ND HALF** | Model H2 1x2, H2 total, H2 team totals, Pinnacle 2nd-half specials |
| **CORNERS** | Pinnacle corner specials |
| **BOOKINGS** | Pinnacle card/booking specials |
| **TEAM PROPS** | Win both halves, score both halves, win either half |
| **SPECIALS** | HT/FT, winning margin, other Pinnacle specials |
| **PLAYER PROPS** | Goalscorer, anytime scorer specials |

---

## Pricing Engine

### Template Resolution

Every event is priced through a resolved template. Resolution order (first match wins):

1. **Match-level override** — `matchTemplates[eventId]` (set per-event from the drawer)
2. **Feed timeline** — league-level time-based template switching (see below)
3. **League default** — `leagueSettings[leagueCode].template`
4. **None** — raw Pinnacle prices shown, no offered price computed

### Dixon-Coles λ Solver

- Warm-start from analytical estimate derived from 1x2 and OU implied probabilities
- Adam gradient descent, ≤300 iterations, tolerance 1×10⁻¹¹
- Joint loss function over 1x2, OU lines, and Asian Handicap inputs
- Runs off-thread via `solver.worker.js` to avoid UI jank
- **Adaptive grid size**: `max(8, ceil(λ + 4√λ + 1))` — not a fixed 10×10
- H1/H2 grids use `rho = 0` and split-λ values; H1 split fraction calibrated from 1st-half OU lines (default 0.45)

### Shin No-Vig

`calculateShinNoVig(oddsArray, targetSum)` removes bookmaker margin using the Shin algorithm. Supports arbitrary outcome counts and configurable target sums — e.g. `2.0` for Double Chance markets to maintain mathematical integrity.

### Margin & Ladder

`applyMarginAndLadder(fairOdds, marginPct, ladder)`:
1. Divide fair price by `(1 + margin/100)` → margined price
2. Snap down to nearest ladder step (always floors to preserve bookmaker edge):
   - `'eu'`: standard EU decimal steps (0.01 below 2.0, 0.02 in 2–3, 0.05 in 3–4, etc.)
   - `'us'`: nearest 5-unit increment in American odds

### Pricing Templates

Each template contains per-market configuration for 14 market types:

`1x2` · `dc` · `dnb` · `asian_hcp` · `asian_tot` · `ou15` · `ou25` · `ou35` · `btts` · `btts_ou` · `cs` · `exact_goals` · `win_nil` · `htft`

Per-market settings:

| Field | Description |
|---|---|
| `enabled` | Whether this market is offered |
| `margin` | Base margin % applied to Shin fair |
| `maxBet` | Maximum stake for this market |
| `ladder` | `'eu'` or `'us'` rounding ladder |
| `rangeLimit` | Optional spread cap for handicap/total lines |
| `requiresApproval` | Manual overrides require a second trader's approval |
| `timeline` | Per-node margin/enabled/maxBet overrides (see below) |

Three built-in default templates: **Elite Default**, **Medium Default**, **Low Default**.

### Timeline Nodes

26 nodes from `INST` (infinity — always active) down to `15m`:

```
INST → 240D → 120D → 60D → 30D → 15D → 10D → 9D → 8D → 7D → 6D → 5D → 4D →
3D → 2.5D → 2D → 36h → 24h → 18h → 12h → 6h → 3h → 2h → 1h → 30m → 15m
```

`resolveActiveKey` walks nodes nearest-to-kick-off first and returns the first node whose threshold the current time satisfies and that has a key configured in the market's timeline. This drives automatic margin tightening as kick-off approaches.

### Feed Timeline

A per-league configuration that switches the entire active template based on time to kick-off. Each configured node maps to a different template:

```
240D before KO → "Prematch Wide"   (higher margins, limited markets)
  24h before KO → "Prematch Sharp"  (tighter margins, more markets)
   2h before KO → "Live Aggressive" (live-style margins, full market set)
```

Nodes reuse the same 26 TIMELINE_NODES. The first node whose threshold is satisfied (nearest-first) selects the template. Falls back to the league default if no node matches. Configured per league in Admin > Tournaments via the **Feed Timeline** modal.

---

## Manual Trading

### Override Workflow

1. Click any price cell in the drawer market table to enter edit mode
2. Type a new price; `Enter` or blur to confirm
3. **Reprice others**: remaining outcomes in the market are back-solved to preserve the book sum at the configured margin
4. Dixon-Coles lambdas are re-solved off-thread from the new implied prices
5. The event enters **MANUAL** mode; the board shows the override badge

**Value-bet alerts**: if the manual price exceeds Shin fair, an amber `VALUE_BET` badge appears on the market card.

**Override expiry**: on each 30-second poll, if Shin fair has moved past the override's implied probability threshold, the override is automatically reverted to AUTO.

### Override Approval Workflow

High-stakes overrides require a second trader to approve before going live:

- **Triggers**: market has `requiresApproval` set in its template config, **or** the market's `maxBet` ≥ the league's **Approval Threshold £** setting
- **Pending state**: proposed price shown in amber in the market table; live offered price unchanged until approved
- **Shared queue**: pending overrides sync to Turso and are visible across all trader sessions
- **Approval UI**: the **Pending Approvals** section at the top of the Admin panel (visible to senior traders) lists all pending items from other traders with Approve / Reject buttons

---

## Suspension Management

- **League suspension**: suspend all markets across all events in a league
- **Event suspension**: suspend all markets for a single event
- **Market/selection suspension**: suspend a specific market or selection within an event
- Suspended rows are visually flagged on the board; `S` shortcut toggles the focused event

---

## Shift Handover Notes

- Per-league free-text note field in Admin > Tournaments (📝 button per row, amber when a note exists)
- Stored in shared state — all traders see the same note
- When a trader selects a league with an active note, a dismissable amber banner appears above the odds board
- Banner clears automatically on league switch

---

## Odds History

- 24-hour rolling price history stored per event/market in Turso (`odds_history` table)
- Accessible per-selection from the drawer market table via the history icon
- Records auto-purged after 24 hours server-side

---

## Audit Log

Every shared-state write (template change, league assignment, suspension, pending-override, etc.) is logged to `audit_log` with before/after JSON and trader attribution. Accessible via `GET /api/audit-log`.

---

## Trader Presence

Active trader tracking updated on each poll cycle. Shows each trader's name, colour, and current league in the Admin overview. Presence records expire after 3 minutes of inactivity.

---

## Admin Panel

### Tournaments Tab

- Filter leagues by country, tournament name, assigned template, or unassigned status
- Per-league controls (senior traders only): assign template, set activation mode (CTRL/MON/OFF), configure alert factor, set feed timeline, set approval threshold, suspend/publish league, edit handover note
- **Bulk assignment**: "Change All Tournaments" applies the filter-selected template to all visible rows
- **Today's Activity** summary: live, priced, suspended, manual override counts; unpriced-in-2h alert; active trader list; sync status indicator
- **Pending Approvals** (senior only): review override approval queue
- **Trader Management** (senior only): view all traders, change roles

### Templates Tab

- Create, edit, duplicate, delete templates
- Per-market inline config: margin %, max stake, ladder, range limit, requires-approval flag
- Per-market timeline editor: configure margin/enabled/maxBet per timeline node
- Template comparison modal: side-by-side diff of two templates across all 14 markets
- Template preview modal: live rendered market table against a selected event
- Market discovery: auto-populates market list from a live Pinnacle event
- Lock/unlock: locked templates cannot be edited until unlocked

---

## State Architecture

| Private var | localStorage key | Turso entity | Scope |
|---|---|---|---|
| `_overrides` | `priceOverrides` | `overrides` | Per-trader |
| `_overrideMeta` | `overrideMeta` | `meta` | Per-trader |
| `_tradingModes` | `tradingModes` | `modes` | Per-trader |
| `_overriddenLambdas` | `overriddenLambdas` | `lambdas` | Per-trader |
| `_suspensions` | `suspensions` | `suspensions` | Global |
| `_templates` | `templates` | `templates` | Global |
| `_matchTemplates` | `matchTemplates` | `match-templates` | Global |
| `_leagueSettings` | `leagueSettings` | `league-settings` | Global |
| `_pendingOverrides` | `pendingOverrides` | `pending-overrides` | Global |

**Write pattern**: every setter calls `persistTraderEntity` or `persistSharedEntity`, which does `localStorage.setItem` (sync) + debounced 400 ms async Turso write. Failed writes retry with exponential backoff: 2s → 4s → 8s.

**Template versioning**: `TEMPLATE_VERSION = 4` in `state.js`. Version mismatch resets `_templates` to `DEFAULT_TEMPLATES`. Bump this constant whenever `DEFAULT_TEMPLATES` or `MARKET_DEFS` change.

---

## Key Conventions

- **Override key format**: `"eventId|marketId|label"` for prices, `"eventId|marketId"` for meta and suspensions
- **Trading mode**: `'auto'` is the default and is not stored — only `'manual'` entries exist in `_tradingModes`
- **Suspension status**: `'suspended'` is stored; deleting the key means open (open is implicit default)
- **Pinnacle field names**: API returns both `moneyLine`/`moneyline` and `homePrice`/`home` — always coalesce both forms
- **Market ID namespaces**: template IDs (`1x2`, `ou25`) differ from drawer IDs (`ml`, `ou`) — `DRAWER_TO_TPL` in `ui-market-table.js` maps between them
