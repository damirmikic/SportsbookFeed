# SportsbookFeed

Browser-based football trading terminal for managing sportsbook prices against the Pinnacle feed. The app runs as plain ES modules in the browser, uses Netlify Functions for persistence, and stores shared and per-trader state in Turso.

## What It Does

- Fetches football leagues and odds from Pinnacle
- Prices markets with Dixon-Coles and Shin no-vig calculations
- Applies per-market templates with margin, ladder, and timeline controls
- Supports manual overrides, suspensions, approval workflows, and odds history
- Includes operator login, role-based permissions, audit logging, and trader presence

## Tech Stack

- Frontend: vanilla HTML, CSS, and browser ES modules
- Backend: Netlify Functions
- Database: Turso / libSQL
- No bundler, no framework, no build step

## Running Locally

### Full stack

Recommended when you want Turso-backed state and Netlify Functions available locally.

```bash
npm install
netlify dev
```

Open `http://localhost:8888/login.html`.

### Frontend only

Useful for quick UI work. On `localhost`, the login flow falls back to a mock operator store in `localStorage`.

```bash
npx serve .
```

Open `http://localhost:3000/login.html`.

## Environment Variables

Create a local `.env` for Netlify Functions:

```env
TURSO_CONNECTION_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
```

## App Structure

### Entry points

- `login.html` -> `login.js`: operator setup, login, PIN verification
- `index.html` -> `app.js`: trading terminal, polling, admin navigation

### Core frontend modules

- `api.js`: fetch helpers for Pinnacle and Netlify Function endpoints
- `state.js`: app state, permissions, persistence, template defaults
- `pricing.js`: template resolution, pricing rules, override alerts/expiry
- `math.js`: Shin no-vig, Dixon-Coles solver helpers, ladder math
- `markets.js`: derived market builders
- `solver.worker.js`: off-thread solver work

### UI modules

- `ui-leagues.js`: league sidebar
- `ui-board.js`: event board
- `ui-drawer.js`: event details drawer
- `ui-market-table.js`: market comparison and editing table
- `ui-market-groups.js`: drawer grouping logic
- `templates-admin.js`: template management UI
- `admin.js`: tournaments, operators, approvals, and presence
- `audit-admin.js`: audit log view

### Netlify Functions

- `netlify/functions/traders.js`: operator CRUD and PIN verification
- `netlify/functions/shared-state.js`: global shared entities
- `netlify/functions/trader-state.js`: per-trader entities
- `netlify/functions/trader-presence.js`: active trader tracking
- `netlify/functions/audit-log.js`: audit log reads
- `netlify/functions/odds-history.js`: odds history reads/writes
- `netlify/functions/db.js`: Turso client, schema bootstrapping, helpers

## Roles And Permissions

The app currently supports four roles:

- `owner`: full access, including operator management
- `senior`: manage leagues and templates, review approvals
- `trader`: set price overrides and trade normally
- `monitor`: read-only access

`owner` is treated as a superset role in the permission checks.

## Key Features

### Trading board

- League browser with search and favorites
- Live odds polling every 30 seconds
- Per-event AUTO / MANUAL state
- Keyboard shortcuts for navigation and suspension
- Shift note banner when a league has a handover note

### Pricing

- Dixon-Coles based fair pricing
- Shin no-vig normalization
- Margin application plus EU/US ladder rounding
- Template timelines for tightening or widening by time to kickoff
- League feed timelines that switch whole templates automatically

### Manual trading

- Inline offered-price overrides
- Market rebalance after manual edits
- Override expiry when the fair price moves through threshold
- Value-bet alerting
- Optional approval workflow for high-risk or flagged markets

### Admin

- Tournament template assignment and activation controls
- Approval threshold and handover note management
- Pending approvals queue
- Operator management
- Active trader presence
- Audit log panel

## Local Development Notes

- `api.js` hits Pinnacle directly when running on `localhost` or `127.0.0.1`
- In Netlify environments, `netlify.toml` rewrites `/api/*` routes to Pinnacle or local functions
- Session expiry is controlled by `localStorage.sessionTtlMs` or `localStorage.sessionTtlMode`
- The first-run login flow creates an `owner` account

## Related Docs

- [`TURSO_SETUP.md`](./TURSO_SETUP.md): Turso setup and schema notes
- [`DATABASE_PLAN.md`](./DATABASE_PLAN.md): data model planning
- [`OVERRIDE_PLAN.md`](./OVERRIDE_PLAN.md): override workflow notes

