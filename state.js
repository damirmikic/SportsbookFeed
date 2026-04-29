export const state = {
  activeEvents: [],
  allLeagues: [],
  favorites: JSON.parse(localStorage.getItem('favoriteLeagues') || '[]'),
  currentLeagueCode: null,
  previousOdds: {},
  drawerEventId: null,
};

export function toggleFavorite(code) {
  const index = state.favorites.indexOf(code);
  if (index > -1) state.favorites.splice(index, 1);
  else state.favorites.push(code);
  localStorage.setItem('favoriteLeagues', JSON.stringify(state.favorites));
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

export function getOverride(key) {
  return _overrides[key] || null;
}

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
