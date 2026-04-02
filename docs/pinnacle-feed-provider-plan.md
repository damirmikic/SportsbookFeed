# Pinnacle Feed Provider Plan

## Goal

Create a feed provider that behaves more like a Betradar-style supplier while using Pinnacle odds as the pricing source.

The provider should not just expose raw bookmaker prices. It should produce a normalized event feed with:

- stable event and competitor identifiers
- market templates
- timeline state and booking events
- lambda-driven derived markets
- a manual odds override path

## Core Direction

Use Pinnacle as the source of truth for base pricing, then translate it into an internal feed contract that downstream code consumes.

The internal feed must be provider-agnostic. Pinnacle is only one upstream source.

## Recommended Architecture

### 1. Ingestion Layer

Responsibility:

- fetch raw Pinnacle fixtures, markets, and odds
- map upstream fields into a Pinnacle-specific raw model
- preserve upstream ids and timestamps for traceability

Suggested module:

- `src/providers/pinnacle-ingestor.js`

Output:

- raw events
- raw market prices
- upstream metadata

### 2. Canonical Translation Layer

Responsibility:

- convert raw Pinnacle payloads into normalized feed entities
- assign internal ids for sport, competition, teams, and events
- enforce a single feed schema independent of the upstream source

Suggested module:

- `src/feed/translate-pinnacle.js`

Output contract:

- `feed`
- `events`
- `markets`
- `templates`
- `timelines`
- `incidents`

### 3. Market Engine Layer

Responsibility:

- reuse existing lambda logic from `fetch-odds.js`
- compute expected goals from 1x2 and totals
- derive secondary markets from lambda values

Suggested module:

- `src/feed/market-engine.js`

Derived markets can include:

- correct score
- team totals
- both teams to score
- double chance
- draw no bet
- asian totals
- alternate totals
- win to nil

This should produce both:

- the derived price
- the provenance of the price, for example `source: "lambda-derived"`

### 4. Timeline Layer

Responsibility:

- maintain match state over time
- attach incidents such as kickoff, goal, half-time, full-time, cards, substitutions, and suspensions
- support booking events as first-class timeline incidents

Suggested module:

- `src/feed/timeline-engine.js`

Important note:

If Pinnacle does not supply live incidents directly, the system should still support timeline objects. In that case:

- pre-match events use a default template-driven timeline
- live incidents can come from manual input or a second feed later

### 5. Manual Odds Override Layer

Responsibility:

- allow traders to replace provider odds with manual odds
- allow partial override by event, market, selection, or time window
- keep a clear flag showing whether a price is upstream, derived, or manual

Suggested module:

- `src/feed/manual-odds-store.js`
- `src/feed/apply-overrides.js`

Manual pricing should support:

- full market replacement
- single selection override
- suspend market
- restore provider prices
- trader notes and audit metadata

## Feed Model

### Event

Each event should include:

```json
{
  "eventId": "ev:football:england-premier-league:arsenal-chelsea:2026-04-12T15:30:00Z",
  "sourceEventId": "pinnacle:123456789",
  "sport": {
    "id": "sport:football",
    "name": "Football"
  },
  "competition": {
    "id": "comp:england-premier-league",
    "name": "England - Premier League"
  },
  "participants": [
    { "id": "team:arsenal", "role": "home", "name": "Arsenal" },
    { "id": "team:chelsea", "role": "away", "name": "Chelsea" }
  ],
  "scheduledStart": "2026-04-12T15:30:00.000Z",
  "status": "not_started",
  "tradingStatus": "open",
  "coverage": {
    "timeline": true,
    "bookingEvents": true,
    "derivedMarkets": true,
    "manualOdds": true
  }
}
```

### Market

Each market should separate identity from price origin:

```json
{
  "marketId": "mkt:ev123:match_winner",
  "eventId": "ev123",
  "type": "match_winner",
  "specifier": null,
  "status": "open",
  "templateId": "tmpl:match_winner:3way",
  "selections": [
    { "id": "sel:home", "name": "Home", "odds": 1.91, "origin": "provider" },
    { "id": "sel:draw", "name": "Draw", "odds": 3.65, "origin": "provider" },
    { "id": "sel:away", "name": "Away", "odds": 4.2, "origin": "provider" }
  ],
  "pricingContext": {
    "source": "pinnacle",
    "lambdaHome": 1.42,
    "lambdaAway": 1.08,
    "mu": 2.5
  }
}
```

### Template

Templates define how a market is rendered and interpreted:

```json
{
  "templateId": "tmpl:totals:2way",
  "marketType": "total_goals",
  "selectionLayout": ["over", "under"],
  "supportsLine": true,
  "supportsSuspension": true,
  "group": "totals"
}
```

Templates matter because a Betradar-like feed is not just a flat market list. Consumers expect reusable market definitions.

### Timeline

Timeline should be event-centric and append-only:

```json
{
  "eventId": "ev123",
  "matchClock": {
    "period": "1h",
    "minute": 37,
    "second": 12,
    "running": true
  },
  "incidents": [
    {
      "incidentId": "inc:1",
      "type": "goal",
      "teamId": "team:arsenal",
      "player": "Player Name",
      "minute": 23
    },
    {
      "incidentId": "inc:2",
      "type": "booking",
      "teamId": "team:chelsea",
      "player": "Player Name",
      "card": "yellow",
      "minute": 31
    }
  ]
}
```

## Lambda Strategy

This repo already has reusable lambda estimation logic in `fetch-odds.js`. That logic should be extracted into a provider-independent utility so it can power the new feed.

Recommended refactor:

- move lambda and derived-market functions into `src/feed/math/lambda.js`
- keep fetch logic separate from market modeling

Use lambdas for:

- generated markets not available upstream
- fallback pricing when a market is missing from Pinnacle
- template expansion for alternate totals and score-based products

Every derived market should include:

- `origin: "lambda-derived"`
- `derivedFrom: ["match_winner", "total_goals"]`
- the lambda parameters used

## Timelines And Booking Events

Booking events should not be treated as UI-only metadata. They should be modeled as feed incidents because they affect:

- live display
- market suspension logic
- future derivative products
- settlement or validation workflows

Two supported modes:

1. Provider-backed timeline
If a live incident source exists, ingest and normalize it.

2. Template-backed timeline
If live incident coverage is not yet available, create the timeline object anyway and allow updates from:

- manual trader input
- admin tools
- another feed provider later

## Manual Odds Design

Manual odds should sit above provider odds and above lambda-derived odds in precedence.

Recommended price priority:

1. manual
2. provider
3. lambda-derived

Each selection should expose:

```json
{
  "odds": 1.84,
  "origin": "manual",
  "baseOrigin": "provider",
  "overrideReason": "Trader adjustment before kickoff",
  "updatedBy": "user:trader1",
  "updatedAt": "2026-04-02T09:15:00.000Z"
}
```

Manual odds need an audit trail. Without that, the feed becomes impossible to reason about once overrides start.

## Suggested Data Flow

```text
Pinnacle API
  -> pinnacle-ingestor
  -> translator
  -> canonical events and base markets
  -> lambda market engine
  -> template expander
  -> timeline engine
  -> manual override applicator
  -> final provider feed
```

## Suggested Phased Implementation

### Phase 1

Build a normalized pre-match feed from Pinnacle:

- events
- competitions
- participants
- match winner
- totals
- lambda values

### Phase 2

Extract lambda utilities and add derived markets:

- both teams to score
- double chance
- draw no bet
- correct score
- team totals

### Phase 3

Add market templates and reusable market metadata:

- template ids
- market grouping
- selection layouts
- line/specifier handling

### Phase 4

Add timelines and booking incidents:

- static timeline schema first
- live incident ingestion later
- manual incident entry as a fallback

### Phase 5

Add manual odds controls:

- override storage
- precedence rules
- audit log
- market suspension and restore

## Concrete Next Changes For This Repo

The cleanest next implementation step is:

1. Extract the lambda functions from `fetch-odds.js` into a reusable module.
2. Define a normalized `providerFeed` output schema.
3. Add a new builder that converts existing match objects into this schema.
4. Keep the current UI working by exposing both the old `matches` array and the new `providerFeed` block during migration.

## Important Constraint

Do not couple the UI directly to Pinnacle or to raw upstream fields.

If the UI binds to the normalized provider feed instead, then:

- upstream source changes remain isolated
- manual pricing can be layered cleanly
- timeline data can be added without changing the fetch contract again
- the project can later support multiple providers under one feed model
