# Manual Override Expiry & Alerting System

## Overview

Enhances the existing manual price override system with two new capabilities:
- **Automatic expiry** when the market (via Shin fair) moves to agree with the override
- **Real-time alerting** when a published override price exceeds fair value (value bet exposure)

All tracking and logic operates **per market**, checked on every API poll cycle.

---

## Core Concepts

### Two Roles for Shin Fair Odds
Shin-devigged fair probabilities serve dual purpose in this system:

| Role | What it does |
|---|---|
| **Expiry trigger** | Shin crossing the override threshold auto-reverts the market to AUTO |
| **Alert trigger** | `overridePrice > shinFairOdds` signals the book is offering above fair value |

Published offer prices always use **raw odds** (override or margin-applied). Shin is never shown to bettors — it is a back-office risk signal only.

### Override Directions

When a user sets a manual override, the system immediately classifies direction:

- **DOWN** (`overridePrice < currentAPIPrice`): user is more bullish than the market — pricing the outcome as more likely. Protective positioning.
- **UP** (`overridePrice > currentAPIPrice`): user is more bearish than the market — pricing the outcome as less likely. Exposes the book if market disagrees.

---

## Expiry Logic

### Threshold
At override time, capture:
```
overrideImpliedProb = 1 / overridePrice
```
This becomes the static expiry threshold for the lifetime of the override.

### Poll-Cycle Condition

On each API poll, after Shin fair is recomputed:

```
DOWN override → expire when: currentShinFairProb >= overrideImpliedProb
UP override   → expire when: currentShinFairProb <= overrideImpliedProb
```

When the condition is met:
1. Clear override for all selections in the market
2. Revert trading mode to AUTO
3. Set alert state to EXPIRED
4. Log: timestamp, direction, overridePrice, shinFairOddsAtExpiry

### Rationale
Shin removes vig noise from the comparison. Waiting for exact raw API odds to match is brittle — Shin crossing the implied probability threshold is a cleaner, more reliable signal that market consensus has reached the user's position.

---

## Alert System

### Tier 1 — VALUE_BET (RED, urgent)

**Condition:** `overridePrice > shinFairOdds` for any selection in the market

Fires **immediately** when the override is set, if the condition is true. User is informed at the moment of entry and accepts the risk consciously. Alert persists on every subsequent poll while condition holds.

Gap magnitude drives badge severity:
```
valueBetGap = overridePrice - shinFairOdds
```

| Gap | Severity |
|---|---|
| 0.01 – 0.05 | Low (dim red) |
| 0.06 – 0.15 | Medium (red) |
| > 0.15 | High (bright red, pulsing) |

DOWN overrides cannot produce a VALUE_BET alert by definition — offering below fair is always safe.

### Tier 2 — DIVERGENCE (YELLOW, informational)

**Condition:** market moved **away** from the override and gap exceeds a configurable threshold (e.g. 0.10 raw odds)

- DOWN override + API/Shin rising: informational only — book is conservative, no exposure
- UP override + API/Shin falling: likely already in VALUE_BET state; DIVERGENCE is secondary context

### Tier 3 — EXPIRED (INFO)

Override was automatically cleared because Shin crossed the threshold. Brief badge shown, no action required. Logged for audit.

---

## Alert State Machine (Per Market)

```
[Override set]
      │
      ├── overridePrice > shinFairOdds? ──YES──→ VALUE_BET (RED)
      │                                               │
      │   NO                                          ├── gap grows each poll → escalate intensity
      │   │                                           └── shin crosses threshold → EXPIRED → AUTO
      ▼   ▼
    CLEAN
      │
      ├── market diverges beyond threshold → DIVERGENCE (YELLOW)
      │
      └── shin crosses expiry threshold → EXPIRED → AUTO
```

---

## Per-Market Override State

New fields added to the existing override record per market:

```javascript
{
  // existing
  selections: { [label]: overridePrice },
  tradingMode: "MANUAL",

  // new
  direction: "UP" | "DOWN",
  overrideImpliedProb: number,       // 1 / overridePrice, expiry threshold
  shinFairAtOverrideTime: number[],  // snapshot per selection (audit/context only)
  setAt: timestamp,                  // when override was set
  alertState: "CLEAN" | "VALUE_BET" | "DIVERGENCE" | "EXPIRED",
  valueBetGap: number                // overridePrice - shinFairOdds, updated each poll
}
```

---

## Implementation Steps

### 1. State Layer (`state.js`)
- Extend override storage to include `direction`, `overrideImpliedProb`, `shinFairAtOverrideTime`, `setAt`, `alertState`, `valueBetGap`
- Add `setOverrideWithMeta(eventId, marketId, selections, shinFairProbs, apiOdds)` — sets override and computes all metadata at entry time
- Add `clearOverride(eventId, marketId, reason)` — clears override, logs reason (`"MANUAL"` | `"EXPIRED"`)
- Add `getOverrideAlertState(eventId, marketId)` — returns current alert state and gap

### 2. Expiry + Alert Evaluation (`pricing.js`)
- Add `evaluateOverrides(eventId, markets, shinFairProbsMap)` — called on each poll after Shin recomputation
- Per market with active MANUAL override:
  - Run expiry condition → call `clearOverride` if triggered
  - Run VALUE_BET condition → update `alertState` and `valueBetGap`
  - Run DIVERGENCE condition → update `alertState` if not already VALUE_BET
- Returns list of state changes for UI to consume

### 3. UI Layer (`ui.js`)
- On override set: call `setOverrideWithMeta`, immediately evaluate alert state, show VALUE_BET badge if triggered
- On each render cycle: read `alertState` and `valueBetGap` per market, render appropriate badge
- Badge states:
  - No override: nothing
  - CLEAN override: small MANUAL indicator (existing)
  - VALUE_BET: red badge with gap value (e.g. `▲ +0.09`)
  - DIVERGENCE: yellow badge
  - EXPIRED: brief flash, then clears to AUTO render
- When VALUE_BET fires on set: show inline confirmation — "Override is above fair value (Shin: X.XX). Confirm?" — user clicks confirm to accept risk

### 4. Poll Integration (`app.js`)
- After each successful API fetch + Shin recomputation, call `evaluateOverrides` for all active events
- Pass Shin fair probs from the freshly computed market data
- Consume returned state changes, trigger UI re-render for affected markets only

---

## Boundaries & Non-Goals

- **No per-selection expiry tracking** — expiry and alerts operate at market level. If any selection in a market hits the condition, the whole market's override clears.
- **No model-based alerts in this phase** — VALUE_BET uses Shin only. Dixon-Coles model blend is a separate future feature.
- **No time-based expiry in this phase** — expiry is purely Shin-crossing-based. Kick-off time expiry can be added later.
- **No automatic suspension** — VALUE_BET alert is informational with user confirmation on set. The system does not auto-suspend markets. Trader retains control.

---

## Open Questions (Resolved)

| Question | Decision |
|---|---|
| Raw odds or Shin for expiry comparison? | Shin (removes vig noise) |
| Exact match or threshold crossing? | Shin threshold crossing |
| Absolute or delta-based VALUE_BET alert? | Absolute — alert fires immediately, user accepts risk |
| Per-selection or per-market? | Per-market |
| Expiry as background or event-driven? | Background, checked on each poll cycle |
