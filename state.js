import { pushSharedState, pushTraderState } from './api.js';
import { clearTraderSession, getValidTraderSession, setTraderSession } from './auth-session.js';

const SHARED_ENTITY_KEYS = {
  templates: 'templates',
  'league-settings': 'leagueSettings',
  'match-templates': 'matchTemplates',
  suspensions: 'suspensions',
};

const TRADER_ENTITY_KEYS = {
  overrides: 'priceOverrides',
  meta: 'overrideMeta',
  modes: 'tradingModes',
  lambdas: 'overriddenLambdas',
  favorites: 'favoriteLeagues',
  prefs: 'expandedGroups',
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function replaceObject(target, source) {
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source || {});
}

function replaceArray(target, source) {
  target.splice(0, target.length, ...(source || []));
}

const currentTraderProfile = getValidTraderSession();

export const state = {
  activeEvents: [],
  allLeagues: [],
  activeTraders: [],
  favorites: readJson('favoriteLeagues', []),
  currentLeagueCode: null,
  currentLeagueName: null,
  previousOdds: {},
  drawerEventId: null,
  detailedOdds: {},
  activeCategory: 'MAIN MARKETS',
  activeMarketId: null,
  sharedSyncLastPushedAt: null,
  sharedSyncStatus: 'unknown',
  expandedGroups: readJson('expandedGroups', []),
  currentTraderId: currentTraderProfile?.id || null,
  currentTraderProfile,
};

let isHydrating = false;
const syncTimers = new Map();
const pendingWrites = new Map();
let syncVersion = 0;

const SYNC_DEBOUNCE_MS = 400;
const SYNC_BACKOFF_MS = [2000, 4000, 8000];
const DETAILED_ODDS_TTL_MS = 60 * 1000;

function emitSyncStatus(status, extra = {}) {
  state.sharedSyncStatus = status;
  window.dispatchEvent(new CustomEvent('sync:status', { detail: { status, ...extra } }));
}

function persistTraderProfile(profile) {
  state.currentTraderProfile = profile || null;
  if (profile) writeJson('currentTraderProfile', profile);
  else localStorage.removeItem('currentTraderProfile');
}

function withHydration(fn) {
  isHydrating = true;
  try {
    fn();
  } finally {
    isHydrating = false;
  }
}

function getEntityData(entity) {
  switch (entity) {
    case 'templates': return _templates;
    case 'league-settings': return _leagueSettings;
    case 'match-templates': return _matchTemplates;
    case 'suspensions': return _suspensions;
    case 'overrides': return _overrides;
    case 'meta': return _overrideMeta;
    case 'modes': return _tradingModes;
    case 'lambdas': return _overriddenLambdas;
    case 'favorites': return state.favorites;
    case 'prefs': return { expandedGroups: state.expandedGroups };
    default: return null;
  }
}

function cloneEntityData(entity) {
  const value = getEntityData(entity);
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function hasPendingWrites() {
  return pendingWrites.size > 0;
}

function syncStatusForWrite(entry) {
  return entry.attempt > 0 ? 'retrying' : 'saving';
}

async function flushPendingWrite(entity) {
  const entry = pendingWrites.get(entity);
  if (!entry || entry.inFlight) return;

  entry.inFlight = true;
  const payload = entry.data;
  const version = entry.version;
  emitSyncStatus(syncStatusForWrite(entry));

  try {
    if (entity in SHARED_ENTITY_KEYS) {
      const result = await pushSharedState(entity, payload, state.currentTraderId);
      if (result?.lastSharedPushAt) {
        state.sharedSyncLastPushedAt = result.lastSharedPushAt;
      }
    } else {
      await pushTraderState(state.currentTraderId, entity, payload);
    }

    const latest = pendingWrites.get(entity);
    if (latest?.version === version) {
      pendingWrites.delete(entity);
      if (!hasPendingWrites()) emitSyncStatus('saved', { lastSharedPushAt: state.sharedSyncLastPushedAt });
      return;
    }

    if (latest) {
      latest.inFlight = false;
      latest.attempt = 0;
      flushPendingWrite(entity);
    }
  } catch (error) {
    console.warn(`Background sync failed for ${entity}:`, error);
    const latest = pendingWrites.get(entity);
    if (!latest) return;

    latest.inFlight = false;
    latest.attempt += 1;
    const delay = SYNC_BACKOFF_MS[Math.min(latest.attempt - 1, SYNC_BACKOFF_MS.length - 1)];
    clearTimeout(latest.timer);
    latest.timer = setTimeout(() => flushPendingWrite(entity), delay);
    emitSyncStatus('retrying');
  }
}

function scheduleSync(entity) {
  if (isHydrating) return;
  const isTraderEntity = Object.prototype.hasOwnProperty.call(TRADER_ENTITY_KEYS, entity);
  if (isTraderEntity && !state.currentTraderId) return;

  const payload = cloneEntityData(entity);
  if (payload == null) return;

  const existing = pendingWrites.get(entity);
  if (existing?.timer) clearTimeout(existing.timer);

  const entry = {
    data: payload,
    attempt: 0,
    timer: null,
    inFlight: !!existing?.inFlight,
    version: ++syncVersion,
  };
  pendingWrites.set(entity, entry);
  emitSyncStatus('saving');

  const timer = setTimeout(() => flushPendingWrite(entity), SYNC_DEBOUNCE_MS);
  entry.timer = timer;
  syncTimers.set(entity, timer);
}

function persistSharedEntity(entity, value) {
  writeJson(SHARED_ENTITY_KEYS[entity], value);
  scheduleSync(entity);
}

function persistTraderEntity(entity, value) {
  writeJson(TRADER_ENTITY_KEYS[entity], value);
  scheduleSync(entity);
}

export function setCurrentTrader(trader) {
  state.currentTraderId = trader?.id || null;
  if (trader) persistTraderProfile(setTraderSession(trader));
  else {
    clearTraderSession();
    persistTraderProfile(null);
  }
}

export function getCurrentTrader() {
  return state.currentTraderProfile;
}

export function hydrateSharedState(sharedState = {}) {
  withHydration(() => {
    if (Array.isArray(sharedState.templates)) {
      replaceArray(_templates, sharedState.templates);
      writeJson('templates', _templates);
    }
    if (sharedState.leagueSettings && typeof sharedState.leagueSettings === 'object') {
      replaceObject(_leagueSettings, sharedState.leagueSettings);
      writeJson('leagueSettings', _leagueSettings);
    }
    if (sharedState.matchTemplates && typeof sharedState.matchTemplates === 'object') {
      replaceObject(_matchTemplates, sharedState.matchTemplates);
      writeJson('matchTemplates', _matchTemplates);
    }
    if (sharedState.suspensions && typeof sharedState.suspensions === 'object') {
      const normalized = {};
      Object.entries(sharedState.suspensions).forEach(([key, value]) => {
        normalized[key] = typeof value === 'string' ? value : (value?.status || 'suspended');
      });
      replaceObject(_suspensions, normalized);
      writeJson('suspensions', _suspensions);
    }
    if (sharedState.syncMeta?.lastSharedPushAt) {
      state.sharedSyncLastPushedAt = sharedState.syncMeta.lastSharedPushAt;
      state.sharedSyncStatus = 'saved';
      emitSyncStatus('saved', { lastSharedPushAt: state.sharedSyncLastPushedAt });
    }
  });
}

export function hydrateTraderState(traderState = {}) {
  withHydration(() => {
    replaceObject(_overrides, traderState.overrides || {});
    writeJson('priceOverrides', _overrides);

    replaceObject(_overrideMeta, traderState.overrideMeta || {});
    writeJson('overrideMeta', _overrideMeta);

    replaceObject(_tradingModes, traderState.modes || {});
    writeJson('tradingModes', _tradingModes);

    replaceObject(_overriddenLambdas, traderState.lambdas || {});
    writeJson('overriddenLambdas', _overriddenLambdas);

    replaceArray(state.favorites, traderState.favorites || []);
    writeJson('favoriteLeagues', state.favorites);

    replaceArray(state.expandedGroups, traderState.expandedGroups || []);
    writeJson('expandedGroups', state.expandedGroups);
  });
}

export function seedSharedTemplatesIfNeeded() {
  if (_templates.length) scheduleSync('templates');
}

export function toggleFavorite(code) {
  const index = state.favorites.indexOf(code);
  if (index > -1) state.favorites.splice(index, 1);
  else state.favorites.push(code);
  persistTraderEntity('favorites', state.favorites);
}

export function toggleGroup(groupName) {
  const index = state.expandedGroups.indexOf(groupName);
  if (index > -1) state.expandedGroups.splice(index, 1);
  else state.expandedGroups.push(groupName);
  persistTraderEntity('prefs', state.expandedGroups);
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
    const ou25 = Array.isArray(matchPeriod.overUnder)
      ? matchPeriod.overUnder.find(ou => parseFloat(ou.points) === 2.5)
      : null;
    if (!ml && !ou25) return;
    snap[event.id] = {
      home: ml ? parseFloat(ml.homePrice || ml.home) || null : null,
      draw: ml ? parseFloat(ml.drawPrice || ml.draw) || null : null,
      away: ml ? parseFloat(ml.awayPrice || ml.away) || null : null,
      over25: ou25 ? parseFloat(ou25.overOdds || ou25.over) || null : null,
      under25: ou25 ? parseFloat(ou25.underOdds || ou25.under) || null : null,
    };
  });
  return snap;
}

const _overrides = readJson('priceOverrides', {});
const _overrideMeta = readJson('overrideMeta', {});
const _overriddenLambdas = readJson('overriddenLambdas', {});

export function getOverride(key) { return _overrides[key] || null; }

export function getDetailedOdds(eventId) {
  const cached = state.detailedOdds[eventId];
  if (!cached) return null;

  if (cached.data && typeof cached.fetchedAt === 'number') {
    return cached.data;
  }
  return cached;
}

export function isDetailedOddsFresh(eventId, now = Date.now()) {
  const cached = state.detailedOdds[eventId];
  return !!cached?.data
    && typeof cached.fetchedAt === 'number'
    && now - cached.fetchedAt < DETAILED_ODDS_TTL_MS;
}

export function setDetailedOdds(eventId, data, fetchedAt = Date.now()) {
  state.detailedOdds[eventId] = { data, fetchedAt };
}

export function setOverride(key, val) {
  const price = parseFloat(val);
  if (!Number.isFinite(price) || price <= 1.0 || price >= 1000) {
    console.warn('Rejected invalid override value:', val);
    return false;
  }

  _overrides[key] = price.toFixed(3);
  persistTraderEntity('overrides', _overrides);
  return true;
}

export function clearOverride(key) {
  delete _overrides[key];
  persistTraderEntity('overrides', _overrides);
}

export function clearAllOverridesForEvent(eventId) {
  const prefix = `${eventId}|`;
  Object.keys(_overrides).forEach(k => { if (k.startsWith(prefix)) delete _overrides[k]; });
  persistTraderEntity('overrides', _overrides);
  Object.keys(_overrideMeta).forEach(k => { if (k.startsWith(prefix)) delete _overrideMeta[k]; });
  persistTraderEntity('meta', _overrideMeta);
  delete _overriddenLambdas[String(eventId)];
  persistTraderEntity('lambdas', _overriddenLambdas);
}

export function hasAnyOverrideForEvent(eventId) {
  const prefix = `${eventId}|`;
  return Object.keys(_overrides).some(k => k.startsWith(prefix));
}

const _tradingModes = readJson('tradingModes', {});

export function getTradingMode(eventId) {
  return _tradingModes[String(eventId)] || 'auto';
}

export function setTradingMode(eventId, mode) {
  if (mode === 'auto') delete _tradingModes[String(eventId)];
  else _tradingModes[String(eventId)] = mode;
  persistTraderEntity('modes', _tradingModes);
}

const _suspensions = readJson('suspensions', {});

function leagueSuspensionKey(leagueCode) {
  return `league|${leagueCode}|event`;
}

function suspensionStatus(key) {
  const value = _suspensions[key];
  return typeof value === 'string' ? value : value?.status;
}

function getEventLeagueCode(eventId) {
  const event = state.activeEvents.find(e => String(e.id) === String(eventId));
  return event?.leagueCode || event?.league_code || event?.league?.code || state.currentLeagueCode;
}

export function isLeagueSuspended(leagueCode) {
  return !!leagueCode && suspensionStatus(leagueSuspensionKey(leagueCode)) === 'suspended';
}

export function isSuspended(eventId, marketId = 'event') {
  if (isLeagueSuspended(getEventLeagueCode(eventId))) return true;
  if (suspensionStatus(`${eventId}|event`) === 'suspended') return true;
  if (marketId === 'event') return false;
  return suspensionStatus(`${eventId}|${marketId}`) === 'suspended';
}

export function isSelectionSuspended(eventId, marketId, label) {
  if (isLeagueSuspended(getEventLeagueCode(eventId))) return true;
  if (suspensionStatus(`${eventId}|event`) === 'suspended') return true;
  if (suspensionStatus(`${eventId}|${marketId}`) === 'suspended') return true;
  return suspensionStatus(`${eventId}|${marketId}|${label}`) === 'suspended';
}

export function setLeagueSuspension(leagueCode, status) {
  if (!leagueCode) return;
  const key = leagueSuspensionKey(leagueCode);
  if (status === 'open') delete _suspensions[key];
  else _suspensions[key] = { status, set_at: new Date().toISOString() };
  persistSharedEntity('suspensions', _suspensions);
}

export function setSuspension(eventId, marketId, status) {
  const key = `${eventId}|${marketId}`;
  if (status === 'open') delete _suspensions[key];
  else _suspensions[key] = status;
  persistSharedEntity('suspensions', _suspensions);
}

export function clearSuspensionsForEvent(eventId) {
  const prefix = `${eventId}|`;
  Object.keys(_suspensions).forEach(k => { if (k.startsWith(prefix)) delete _suspensions[k]; });
  persistSharedEntity('suspensions', _suspensions);
}

export function hasAnySuspension(eventId) {
  return Object.keys(_suspensions).some(k => k.startsWith(`${eventId}|`));
}

export function getAllSuspensions() { return _suspensions; }

export const TIMELINE_NODES = [
  { id: 'INST', label: 'INST' }, { id: '240D', label: '240D' }, { id: '120D', label: '120D' },
  { id: '60D', label: '60D' }, { id: '30D', label: '30D' }, { id: '15D', label: '15D' },
  { id: '10D', label: '10D' }, { id: '9D', label: '9D' }, { id: '8D', label: '8D' },
  { id: '7D', label: '7D' }, { id: '6D', label: '6D' }, { id: '5D', label: '5D' },
  { id: '4D', label: '4D' }, { id: '3D', label: '3D' }, { id: '2.5D', label: '2.5D' },
  { id: '2D', label: '2D' }, { id: '36h', label: '36h' }, { id: '24h', label: '24h' },
  { id: '18h', label: '18h' }, { id: '12h', label: '12h' }, { id: '6h', label: '6h' },
  { id: '3h', label: '3h' }, { id: '2h', label: '2h' }, { id: '1h', label: '1h' },
  { id: '30m', label: '30m' }, { id: '15m', label: '15m' },
];

export const MARKET_DEFS = [
  { id: '1x2', group: 'Match Result', name: 'Match Result (1x2)', outcomes: 3, defaultMargin: 5.5, defaultMaxBet: 5000, defaultEnabled: true },
  { id: 'dc', group: 'Match Result', name: 'Double Chance', outcomes: 3, defaultMargin: 6.5, defaultMaxBet: 2000, defaultEnabled: true },
  { id: 'dnb', group: 'Match Result', name: 'Draw No Bet', outcomes: 2, defaultMargin: 5.5, defaultMaxBet: 3000, defaultEnabled: true },
  { id: 'asian_hcp', group: 'Asian Markets', name: 'Asian Handicap', outcomes: 2, defaultMargin: 3.5, defaultMaxBet: 8000, defaultEnabled: true },
  { id: 'asian_tot', group: 'Asian Markets', name: 'Asian Totals', outcomes: 2, defaultMargin: 4.0, defaultMaxBet: 5000, defaultEnabled: false },
  { id: 'ou15', group: 'Totals', name: 'Over/Under 1.5', outcomes: 2, defaultMargin: 6.0, defaultMaxBet: 2000, defaultEnabled: false },
  { id: 'ou25', group: 'Totals', name: 'Over/Under 2.5', outcomes: 2, defaultMargin: 5.0, defaultMaxBet: 3000, defaultEnabled: true },
  { id: 'ou35', group: 'Totals', name: 'Over/Under 3.5', outcomes: 2, defaultMargin: 6.0, defaultMaxBet: 2000, defaultEnabled: false },
  { id: 'btts', group: 'Goals', name: 'Both Teams to Score', outcomes: 2, defaultMargin: 7.0, defaultMaxBet: 2000, defaultEnabled: true },
  { id: 'btts_ou', group: 'Goals', name: 'BTTS & Over/Under', outcomes: 4, defaultMargin: 9.0, defaultMaxBet: 1000, defaultEnabled: false },
  { id: 'cs', group: 'Goals', name: 'Correct Score', outcomes: 12, defaultMargin: 12.0, defaultMaxBet: 500, defaultEnabled: true },
  { id: 'exact_goals', group: 'Goals', name: 'Exact Goals', outcomes: 6, defaultMargin: 10.0, defaultMaxBet: 500, defaultEnabled: false },
  { id: 'win_nil', group: 'Goals', name: 'Win to Nil', outcomes: 2, defaultMargin: 10.0, defaultMaxBet: 1000, defaultEnabled: false },
  { id: 'htft', group: 'Specials', name: 'HT / Full Time', outcomes: 9, defaultMargin: 15.0, defaultMaxBet: 200, defaultEnabled: false },
];

function mkMarkets(overrides = {}) {
  return MARKET_DEFS.map(m => ({
    id: m.id,
    enabled: overrides[m.id]?.enabled ?? m.defaultEnabled,
    margin: overrides[m.id]?.margin ?? m.defaultMargin,
    maxBet: overrides[m.id]?.maxBet ?? m.defaultMaxBet,
    ladder: overrides[m.id]?.ladder ?? 'eu',
    rangeLimit: overrides[m.id]?.rangeLimit ?? null,
    timeline: overrides[m.id]?.timeline ?? {},
  }));
}

const _now = new Date().toISOString();
const DEFAULT_TEMPLATES = [
  { id: 'elite', name: 'Elite Default', sport: 'soccer', type: 'prematch', active: true, createdAt: _now, updatedAt: _now,
    markets: mkMarkets({ '1x2': { margin: 2.5, maxBet: 20000 }, 'asian_hcp': { margin: 2.0, maxBet: 30000 }, 'ou25': { margin: 2.5, maxBet: 15000 }, 'asian_tot': { enabled: true }, 'ou15': { enabled: true }, 'ou35': { enabled: true }, 'btts_ou': { enabled: true }, 'exact_goals': { enabled: true }, 'win_nil': { enabled: true }, 'htft': { enabled: true } }) },
  { id: 'medium', name: 'Medium Default', sport: 'soccer', type: 'prematch', active: true, createdAt: _now, updatedAt: _now,
    markets: mkMarkets({ 'asian_tot': { enabled: true }, 'ou15': { enabled: true }, 'ou35': { enabled: true }, 'btts_ou': { enabled: true } }) },
  { id: 'low', name: 'Low Default', sport: 'soccer', type: 'prematch', active: true, createdAt: _now, updatedAt: _now,
    markets: mkMarkets({ '1x2': { margin: 8.0, maxBet: 2000 }, 'ou25': { margin: 8.0, maxBet: 2000 }, 'asian_hcp': { margin: 6.0, maxBet: 3000 }, 'cs': { enabled: false }, 'htft': { enabled: false }, 'exact_goals': { enabled: false }, 'win_nil': { enabled: false } }) },
];

const TEMPLATE_VERSION = 4;
const _storedVersion = parseInt(localStorage.getItem('templateVersion') || '0', 10);
const _storedTpl = readJson('templates', null);
const _needsReset = !_storedTpl || !_storedTpl[0]?.markets || _storedVersion !== TEMPLATE_VERSION;
const _templates = _needsReset ? JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)) : _storedTpl;
if (_needsReset) {
  writeJson('templates', _templates);
  localStorage.setItem('templateVersion', String(TEMPLATE_VERSION));
}

export function getTemplates() { return _templates; }

export function addTemplate(tpl) {
  _templates.push(tpl);
  persistSharedEntity('templates', _templates);
}

export function updateTemplate(id, updates) {
  const idx = _templates.findIndex(t => t.id === id);
  if (idx > -1) {
    _templates[idx] = { ..._templates[idx], ...updates, updatedAt: new Date().toISOString() };
    persistSharedEntity('templates', _templates);
  }
}

export function deleteTemplate(id) {
  const idx = _templates.findIndex(t => t.id === id);
  if (idx > -1) {
    _templates.splice(idx, 1);
    persistSharedEntity('templates', _templates);
  }
}

export function saveTemplates(templates) {
  _templates.length = 0;
  _templates.push(...templates);
  persistSharedEntity('templates', _templates);
}

export function getDiscoveredMarkets() {
  return readJson('discoveredMarkets', null);
}

export function setDiscoveredMarkets(data) {
  writeJson('discoveredMarkets', data);
}

const _matchTemplates = readJson('matchTemplates', {});

export function getMatchTemplate(eventId) {
  return _matchTemplates[String(eventId)] ?? null;
}

export function setMatchTemplate(eventId, templateId) {
  if (templateId === null || templateId === '') delete _matchTemplates[String(eventId)];
  else _matchTemplates[String(eventId)] = templateId;
  persistSharedEntity('match-templates', _matchTemplates);
}

const _leagueSettings = readJson('leagueSettings', {});

export function getLeagueSetting(code) {
  return _leagueSettings[String(code)] || { template: null, activation: 'off', alertFactor: 1 };
}

export function getAllLeagueSettings() { return _leagueSettings; }

export function setLeagueSetting(code, updates) {
  const current = _leagueSettings[String(code)] || { template: null, activation: 'off', alertFactor: 1 };
  _leagueSettings[String(code)] = { ...current, ...updates };
  persistSharedEntity('league-settings', _leagueSettings);
}

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
  persistTraderEntity('meta', _overrideMeta);
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
  persistTraderEntity('meta', _overrideMeta);
}

export function clearOverrideMetaSelection(eventId, marketId, label) {
  const key = `${eventId}|${marketId}`;
  if (!_overrideMeta[key]) return;
  delete _overrideMeta[key].selections[label];
  if (Object.keys(_overrideMeta[key].selections).length === 0) delete _overrideMeta[key];
  persistTraderEntity('meta', _overrideMeta);
}

export function getOverriddenLambdas(eventId) {
  return _overriddenLambdas[String(eventId)] ?? null;
}

export function setOverriddenLambdas(eventId, data) {
  _overriddenLambdas[String(eventId)] = data;
  persistTraderEntity('lambdas', _overriddenLambdas);
}

export function clearOverriddenLambdas(eventId) {
  delete _overriddenLambdas[String(eventId)];
  persistTraderEntity('lambdas', _overriddenLambdas);
}
