# Sportsbook Feed

A browser-based sportsbook trading terminal. Fetches live football league and odds data directly from the Pinnacle feed, computes a Dixon-Coles probability model, and renders a clean market board UI — no backend or server required.

---

## Quick start

Open `index.html` in a browser, or serve locally to avoid CORS issues:

```bash
npx serve .
```

Then open `http://localhost:3000`.

> **Note:** Direct Pinnacle API calls may be blocked by CORS depending on your network/browser. Use a browser extension or proxy if needed.

---

## Architecture

Pure browser app — no Node.js server, no build step.

```
index.html
  └── app.js        ← bootstrap & event wiring
        ├── api.js  ← fetch leagues & odds from Pinnacle
        ├── state.js← in-memory app state (selected league, favourites)
        ├── ui.js   ← DOM rendering (leagues list, market board, drawer)
        └── math.js ← Dixon-Coles λ, Shin no-vig, probability grid
```

### File roles

| File | Role |
|---|---|
| `index.html` | Entry point and HTML shell |
| `index.css` | Styles — dark trading terminal theme, bento layout |
| `app.js` | Bootstraps the app, binds UI events, kicks off data fetch |
| `api.js` | `fetchLeagues()` and `fetchOdds(leagueCode)` — thin wrappers over Pinnacle endpoints |
| `state.js` | Shared mutable state: `allLeagues`, `selectedLeague`, `favourites` |
| `ui.js` | Renders leagues panel, market board, and side drawer with match details |
| `math.js` | Dixon-Coles attack/defence solve, Poisson score grid, Shin no-vig conversion |

---

## Data source

**Pinnacle (pinnacle888.com)** — live football data:
- `/leagues` — list of active football leagues
- `/odds/league` — 1x2, Over/Under lines per league

Derived markets computed client-side from raw odds: BTTS, DNB, double chance, correct score probabilities.

---

## Features

- 📋 **League browser** — searchable list of active leagues with favourites pinning
- 📊 **Market board** — live 1x2 and O/U odds per match
- 🧮 **Dixon-Coles model** — probability-implied xG lambdas and no-vig fair prices
- 🗂 **Match drawer** — click any match to expand full market detail
- ⭐ **Favourites** — pin leagues to the top, persisted in `localStorage`
