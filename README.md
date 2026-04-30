# Sportsbook Feed

A browser-based sportsbook trading terminal. Fetches live football league and odds data directly from the Pinnacle feed, computes a Dixon-Coles probability model, and renders a clean market board UI — no backend or server required.

---

## Quick start

Open `index.html` in a browser, or serve locally to avoid CORS issues:

```bash
npx serve .
```

Then open `http://localhost:3000`.

---

## Architecture

Pure browser app — no Node.js server, no build step.

```
index.html
  └── app.js        ← bootstrap & event wiring
        ├── api.js  ← fetch leagues & odds from Pinnacle
        ├── state.js← in-memory app state (selected league, favourites)
        ├── ui.js   ← DOM rendering & advanced pricing engine
        └── math.js ← Dixon-Coles λ, Shin no-vig, probability grid
```

---

## Features

- 📋 **League browser** — Searchable list of active leagues with favorites pinning.
- 📊 **Market board** — Live 1x2 and Over/Under odds per match.
- 🧮 **Dixon-Coles Model** — High-precision Poisson-based probability engine.
- 💎 **Advanced Pricing Engine** — Model-derived fair prices for 20+ exotic markets.
- 🎯 **Shin Devigging** — Sophisticated margin removal supporting multi-sum markets (e.g., Double Chance).
- ✨ **Period-Awareness** — Automatic grid scaling for 1st Half, 2nd Half, and Full Match markets.
- ⭐ **Favourites** — Pin leagues to the top, persisted in `localStorage`.

---

## Advanced Pricing Engine

The system includes a custom-built orchestration engine in `ui.js` that derives fair prices from the underlying Dixon-Coles probability grid.

### 1. Period-Aware Calculations
The engine automatically detects the measurement period from market titles and switches between:
- **FT Grid**: Full match probabilities (10x10 goals matrix).
- **H1 Grid**: 1st Half specific probabilities.
- **H2 Grid**: 2nd Half specific probabilities (independent of H1).

### 2. Supported Markets
| Category | Supported Market Types |
|---|---|
| **Goal Markets** | Exact Goals (Match/Team), Total Goals Range, BTTS, Either Team to Score |
| **Combo Markets** | BTTS & Over/Under, BTTS & Winner, Winner & Total Goals, Odd/Even & Total Goals |
| **Outcomes** | Win to Nil, Draw No Bet, Double Chance, HT/FT, Correct Score |
| **Special** | Odd/Even (Match/Team) |

### 3. Math & Normalization
- **Shin (Fair)**: Implements the Shin algorithm for margin removal. For Double Chance markets, the engine uses a **2.0 target sum** normalization to maintain mathematical integrity.
- **Value Signaling**: The UI color-codes "Value" opportunities based on model discrepancy:
    - <span style="color: #4ade80">**Green**</span>: Model is more aggressive than market (Model Price < Market Price).
    - <span style="color: #f87171">**Red**</span>: Model is more conservative than market (Model Price > Market Price).

---

## Data Source

**Pinnacle (pinnacle888.com)** — live football data:
- `/leagues` — list of active football leagues
- `/odds/league` — 1x2, Over/Under lines per league
- Derived markets computed client-side from raw odds and probability grids.
