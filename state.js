export const state = {
  activeEvents: [],
  allLeagues: [],
  favorites: JSON.parse(localStorage.getItem('favoriteLeagues') || '[]'),
  currentLeagueCode: null,
  previousOdds: {},
  drawerEventId: null,
  detailedOdds: {},
  activeCategory: 'MAIN MARKETS',
  activeMarketId: null,
  expandedGroups: JSON.parse(localStorage.getItem('expandedGroups') || '[]'),
};

export function toggleFavorite(code) {
  const index = state.favorites.indexOf(code);
  if (index > -1) state.favorites.splice(index, 1);
  else state.favorites.push(code);
  localStorage.setItem('favoriteLeagues', JSON.stringify(state.favorites));
}

export function toggleGroup(groupName) {
  const index = state.expandedGroups.indexOf(groupName);
  if (index > -1) state.expandedGroups.splice(index, 1);
  else state.expandedGroups.push(groupName);
  localStorage.setItem('expandedGroups', JSON.stringify(state.expandedGroups));
}

export function snapshotOdds() {
  const snap = {};
  state.activeEvents.forEach(event => {
    let matchPeriod;
    if (event.periods && !Array.isArray(event.periods)) {
      matchPeriod = event.periods['0'];
    } else {
      const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
      matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    }
    if (!matchPeriod) return;
    const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
    if (!ml) return;
    snap[event.id] = {
      home: parseFloat(ml.homePrice || ml.home) || null,
      draw: parseFloat(ml.drawPrice || ml.draw) || null,
      away: parseFloat(ml.awayPrice || ml.away) || null,
    };
  });
  return snap;
}

// ── Manual price overrides ─────────────────────────────────
const _overrides = JSON.parse(localStorage.getItem('priceOverrides') || '{}');

export function getOverride(key) { return _overrides[key] || null; }

export function setOverride(key, val) {
  _overrides[key] = parseFloat(val).toFixed(3);
  localStorage.setItem('priceOverrides', JSON.stringify(_overrides));
}

export function clearOverride(key) {
  delete _overrides[key];
  localStorage.setItem('priceOverrides', JSON.stringify(_overrides));
}

export function clearAllOverridesForEvent(eventId) {
  const prefix = `${eventId}|`;
  Object.keys(_overrides).forEach(k => { if (k.startsWith(prefix)) delete _overrides[k]; });
  localStorage.setItem('priceOverrides', JSON.stringify(_overrides));
  Object.keys(_overrideMeta).forEach(k => { if (k.startsWith(prefix)) delete _overrideMeta[k]; });
  localStorage.setItem('overrideMeta', JSON.stringify(_overrideMeta));
  delete _overriddenLambdas[String(eventId)];
  localStorage.setItem('overriddenLambdas', JSON.stringify(_overriddenLambdas));
}

export function hasAnyOverrideForEvent(eventId) {
  const prefix = `${eventId}|`;
  return Object.keys(_overrides).some(k => k.startsWith(prefix));
}

// ── Trading mode (auto / manual) per event ─────────────────
const _tradingModes = JSON.parse(localStorage.getItem('tradingModes') || '{}');

export function getTradingMode(eventId) {
  return _tradingModes[String(eventId)] || 'auto';
}

export function setTradingMode(eventId, mode) {
  if (mode === 'auto') delete _tradingModes[String(eventId)];
  else _tradingModes[String(eventId)] = mode;
  localStorage.setItem('tradingModes', JSON.stringify(_tradingModes));
}

// ── Market / event suspension ──────────────────────────────
// Keys: `${eventId}|event` for whole event, `${eventId}|${marketId}` for a single market
const _suspensions = JSON.parse(localStorage.getItem('suspensions') || '{}');

export function isSuspended(eventId, marketId = 'event') {
  if (_suspensions[`${eventId}|event`] === 'suspended') return true; // event-level overrides all
  if (marketId === 'event') return false;
  return _suspensions[`${eventId}|${marketId}`] === 'suspended';
}

export function setSuspension(eventId, marketId, status) {
  const key = `${eventId}|${marketId}`;
  if (status === 'open') delete _suspensions[key];
  else _suspensions[key] = status;
  localStorage.setItem('suspensions', JSON.stringify(_suspensions));
}

export function clearSuspensionsForEvent(eventId) {
  const prefix = `${eventId}|`;
  Object.keys(_suspensions).forEach(k => { if (k.startsWith(prefix)) delete _suspensions[k]; });
  localStorage.setItem('suspensions', JSON.stringify(_suspensions));
}

export function hasAnySuspension(eventId) {
  return Object.keys(_suspensions).some(k => k.startsWith(`${eventId}|`));
}

// ── Timeline nodes (INST → kick-off) ──────────────────────
export const TIMELINE_NODES = [
  { id: 'INST', label: 'INST' }, { id: '240D', label: '240D' }, { id: '120D', label: '120D' },
  { id: '60D',  label: '60D'  }, { id: '30D',  label: '30D'  }, { id: '15D',  label: '15D'  },
  { id: '10D',  label: '10D'  }, { id: '9D',   label: '9D'   }, { id: '8D',   label: '8D'   },
  { id: '7D',   label: '7D'   }, { id: '6D',   label: '6D'   }, { id: '5D',   label: '5D'   },
  { id: '4D',   label: '4D'   }, { id: '3D',   label: '3D'   }, { id: '2.5D', label: '2.5D' },
  { id: '2D',   label: '2D'   }, { id: '36h',  label: '36h'  }, { id: '24h',  label: '24h'  },
  { id: '18h',  label: '18h'  }, { id: '12h',  label: '12h'  }, { id: '6h',   label: '6h'   },
  { id: '3h',   label: '3h'   }, { id: '2h',   label: '2h'   }, { id: '1h',   label: '1h'   },
  { id: '30m',  label: '30m'  }, { id: '15m',  label: '15m'  },
];

// ── Market definitions (shared across templates) ──────────
// Markets are ordered and grouped — group field drives the form UI
export const MARKET_DEFS = [
  // Match Result
  { id: '1x2',         group: 'Match Result',  name: 'Match Result (1x2)',    outcomes: 3,  defaultMargin: 5.5,  defaultMaxBet: 5000,  defaultEnabled: true  },
  { id: 'dc',          group: 'Match Result',  name: 'Double Chance',          outcomes: 3,  defaultMargin: 6.5,  defaultMaxBet: 2000,  defaultEnabled: true  },
  { id: 'dnb',         group: 'Match Result',  name: 'Draw No Bet',            outcomes: 2,  defaultMargin: 5.5,  defaultMaxBet: 3000,  defaultEnabled: true  },
  // Asian Markets
  { id: 'asian_hcp',   group: 'Asian Markets', name: 'Asian Handicap',         outcomes: 2,  defaultMargin: 3.5,  defaultMaxBet: 8000,  defaultEnabled: true  },
  { id: 'asian_tot',   group: 'Asian Markets', name: 'Asian Totals',           outcomes: 2,  defaultMargin: 4.0,  defaultMaxBet: 5000,  defaultEnabled: false },
  // Totals
  { id: 'ou15',        group: 'Totals',        name: 'Over/Under 1.5',         outcomes: 2,  defaultMargin: 6.0,  defaultMaxBet: 2000,  defaultEnabled: false },
  { id: 'ou25',        group: 'Totals',        name: 'Over/Under 2.5',         outcomes: 2,  defaultMargin: 5.0,  defaultMaxBet: 3000,  defaultEnabled: true  },
  { id: 'ou35',        group: 'Totals',        name: 'Over/Under 3.5',         outcomes: 2,  defaultMargin: 6.0,  defaultMaxBet: 2000,  defaultEnabled: false },
  // Goals
  { id: 'btts',        group: 'Goals',         name: 'Both Teams to Score',    outcomes: 2,  defaultMargin: 7.0,  defaultMaxBet: 2000,  defaultEnabled: true  },
  { id: 'btts_ou',     group: 'Goals',         name: 'BTTS & Over/Under',      outcomes: 4,  defaultMargin: 9.0,  defaultMaxBet: 1000,  defaultEnabled: false },
  { id: 'cs',          group: 'Goals',         name: 'Correct Score',          outcomes: 12, defaultMargin: 12.0, defaultMaxBet: 500,   defaultEnabled: true  },
  { id: 'exact_goals', group: 'Goals',         name: 'Exact Goals',            outcomes: 6,  defaultMargin: 10.0, defaultMaxBet: 500,   defaultEnabled: false },
  { id: 'win_nil',     group: 'Goals',         name: 'Win to Nil',             outcomes: 2,  defaultMargin: 10.0, defaultMaxBet: 1000,  defaultEnabled: false },
  // Specials
  { id: 'htft',        group: 'Specials',      name: 'HT / Full Time',         outcomes: 9,  defaultMargin: 15.0, defaultMaxBet: 200,   defaultEnabled: false },
];

function mkMarkets(overrides = {}) {
  return MARKET_DEFS.map(m => ({
    id:         m.id,
    enabled:    overrides[m.id]?.enabled    ?? m.defaultEnabled,
    margin:     overrides[m.id]?.margin     ?? m.defaultMargin,
    maxBet:     overrides[m.id]?.maxBet     ?? m.defaultMaxBet,
    ladder:     overrides[m.id]?.ladder     ?? 'eu',
    rangeLimit: overrides[m.id]?.rangeLimit ?? null,
    timeline:   overrides[m.id]?.timeline   ?? {},
  }));
}

const _now = new Date().toISOString();
const DEFAULT_TEMPLATES = [
  { id: 'elite',  name: 'Elite Default',  sport: 'soccer', type: 'prematch', active: true, createdAt: _now, updatedAt: _now,
    markets: mkMarkets({ '1x2': { margin: 2.5, maxBet: 20000 }, 'asian_hcp': { margin: 2.0, maxBet: 30000 }, 'ou25': { margin: 2.5, maxBet: 15000 }, 'asian_tot': { enabled: true }, 'ou15': { enabled: true }, 'ou35': { enabled: true }, 'btts_ou': { enabled: true }, 'exact_goals': { enabled: true }, 'win_nil': { enabled: true }, 'htft': { enabled: true } }) },
  { id: 'medium', name: 'Medium Default', sport: 'soccer', type: 'prematch', active: true, createdAt: _now, updatedAt: _now,
    markets: mkMarkets({ 'asian_tot': { enabled: true }, 'ou15': { enabled: true }, 'ou35': { enabled: true }, 'btts_ou': { enabled: true } }) },
  { id: 'low',    name: 'Low Default',    sport: 'soccer', type: 'prematch', active: true, createdAt: _now, updatedAt: _now,
    markets: mkMarkets({ '1x2': { margin: 8.0, maxBet: 2000 }, 'ou25': { margin: 8.0, maxBet: 2000 }, 'asian_hcp': { margin: 6.0, maxBet: 3000 }, 'cs': { enabled: false }, 'htft': { enabled: false }, 'exact_goals': { enabled: false }, 'win_nil': { enabled: false } }) },
];

// Version bump forces a one-time reset when market structure changes
const TEMPLATE_VERSION = 4;
const _storedVersion = parseInt(localStorage.getItem('templateVersion') || '0');
const _storedTpl     = JSON.parse(localStorage.getItem('templates') || 'null');
const _needsReset    = !_storedTpl || !_storedTpl[0]?.markets || _storedVersion !== TEMPLATE_VERSION;
const _templates     = _needsReset ? JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)) : _storedTpl;
if (_needsReset) {
  localStorage.setItem('templates',       JSON.stringify(_templates));
  localStorage.setItem('templateVersion', String(TEMPLATE_VERSION));
}

export function getTemplates() { return _templates; }

export function addTemplate(tpl) {
  _templates.push(tpl);
  localStorage.setItem('templates', JSON.stringify(_templates));
}

export function updateTemplate(id, updates) {
  const idx = _templates.findIndex(t => t.id === id);
  if (idx > -1) {
    _templates[idx] = { ..._templates[idx], ...updates, updatedAt: new Date().toISOString() };
    localStorage.setItem('templates', JSON.stringify(_templates));
  }
}

export function deleteTemplate(id) {
  const idx = _templates.findIndex(t => t.id === id);
  if (idx > -1) {
    _templates.splice(idx, 1);
    localStorage.setItem('templates', JSON.stringify(_templates));
  }
}

export function saveTemplates(templates) {
  _templates.length = 0;
  _templates.push(...templates);
  localStorage.setItem('templates', JSON.stringify(_templates));
}

// ── Discovered markets (from live feed) ───────────────────
// Shape: { source: { eventId, matchName, discoveredAt }, markets: [{id, group, name}] }
export function getDiscoveredMarkets() {
  return JSON.parse(localStorage.getItem('discoveredMarkets') || 'null');
}
export function setDiscoveredMarkets(data) {
  localStorage.setItem('discoveredMarkets', JSON.stringify(data));
}

// ── Match-level template overrides ────────────────────────
// Per-event template override: null means use league default
const _matchTemplates = JSON.parse(localStorage.getItem('matchTemplates') || '{}');

export function getMatchTemplate(eventId) {
  return _matchTemplates[String(eventId)] ?? null;
}

export function setMatchTemplate(eventId, templateId) {
  if (templateId === null || templateId === '') delete _matchTemplates[String(eventId)];
  else _matchTemplates[String(eventId)] = templateId;
  localStorage.setItem('matchTemplates', JSON.stringify(_matchTemplates));
}

// ── League Settings (template, activation, alertFactor) ───
const _leagueSettings = JSON.parse(localStorage.getItem('leagueSettings') || '{}');

export function getLeagueSetting(code) {
  return _leagueSettings[String(code)] || { template: null, activation: 'off', alertFactor: 1 };
}

export function setLeagueSetting(code, updates) {
  const current = _leagueSettings[String(code)] || { template: null, activation: 'off', alertFactor: 1 };
  _leagueSettings[String(code)] = { ...current, ...updates };
  localStorage.setItem('leagueSettings', JSON.stringify(_leagueSettings));
}

// ── Override metadata — per-market expiry tracking & alert state ──
// Key: `${eventId}|${marketId}`
// Value: { selections: { [label]: { overridePrice, direction, overrideImpliedProb, shinFairAtTime } }, alertState, valueBetGap, setAt }
const _overrideMeta = JSON.parse(localStorage.getItem('overrideMeta') || '{}');

export function setOverrideWithMeta(eventId, marketId, label, overridePrice, direction, shinFairAtTime) {
  const key = `${eventId}|${marketId}`;
  if (!_overrideMeta[key]) {
    _overrideMeta[key] = { selections: {}, alertState: 'CLEAN', valueBetGap: 0, setAt: Date.now() };
  }
  const price = parseFloat(overridePrice);
  _overrideMeta[key].selections[label] = {
    overridePrice: price,
    direction,
    overrideImpliedProb: 1 / price,
    shinFairAtTime: parseFloat(shinFairAtTime) || null,
  };
  localStorage.setItem('overrideMeta', JSON.stringify(_overrideMeta));
}

export function getOverrideMeta(eventId, marketId) {
  return _overrideMeta[`${eventId}|${marketId}`] ?? null;
}

export function getAllOverrideMeta() { return _overrideMeta; }

export function updateOverrideAlertState(eventId, marketId, alertState, valueBetGap) {
  const key = `${eventId}|${marketId}`;
  if (!_overrideMeta[key]) return;
  _overrideMeta[key].alertState = alertState;
  _overrideMeta[key].valueBetGap = valueBetGap;
  localStorage.setItem('overrideMeta', JSON.stringify(_overrideMeta));
}

export function clearOverrideMetaSelection(eventId, marketId, label) {
  const key = `${eventId}|${marketId}`;
  if (!_overrideMeta[key]) return;
  delete _overrideMeta[key].selections[label];
  if (Object.keys(_overrideMeta[key].selections).length === 0) delete _overrideMeta[key];
  localStorage.setItem('overrideMeta', JSON.stringify(_overrideMeta));
}

// ── Overridden lambdas (back-solved from 1x2/OU price overrides) ──────────
// Stores { lh, la, rho, grid } per event; drives all derived market offer prices.
const _overriddenLambdas = JSON.parse(localStorage.getItem('overriddenLambdas') || '{}');

export function getOverriddenLambdas(eventId) {
  return _overriddenLambdas[String(eventId)] ?? null;
}

export function setOverriddenLambdas(eventId, data) {
  _overriddenLambdas[String(eventId)] = data;
  localStorage.setItem('overriddenLambdas', JSON.stringify(_overriddenLambdas));
}

export function clearOverriddenLambdas(eventId) {
  delete _overriddenLambdas[String(eventId)];
  localStorage.setItem('overriddenLambdas', JSON.stringify(_overriddenLambdas));
}
