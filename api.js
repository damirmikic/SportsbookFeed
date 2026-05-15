// When running locally (no Netlify proxy), hit Pinnacle directly.
// When deployed on Netlify, use proxy rewrites defined in netlify.toml.
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const PINNACLE_BASE = 'https://www.pinnacle888.com/sports-service/sv/euro';
const LEAGUES_URL       = IS_LOCAL
  ? `${PINNACLE_BASE}/leagues?sportId=29&locale=en_US&withCredentials=true`
  : '/api/leagues';
const ODDS_URL_TEMPLATE = IS_LOCAL
  ? `${PINNACLE_BASE}/odds/league?sportId=29&oddsType=1&version=0&periodNum=-1&locale=en_US&leagueCode={CODE}&isHlE=true&isLive=false&eventType=0&withCredentials=true`
  : '/api/odds/{CODE}';
const EVENT_ODDS_URL_TEMPLATE = IS_LOCAL
  ? `${PINNACLE_BASE}/odds/event?eventId={EVENT_ID}&oddsType=1&locale=en_US&withCredentials=true`
  : '/api/odds/event/{EVENT_ID}';

export async function fetchLeagues() {
  const response = await fetch(LEAGUES_URL);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  const leaguesData = await response.json();
  return leaguesData.leagues || leaguesData;
}

export async function fetchOdds(leagueCode) {
  const url = ODDS_URL_TEMPLATE.replace('{CODE}', leagueCode);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

export async function fetchEventOdds(eventId) {
  const url = EVENT_ODDS_URL_TEMPLATE.replace('{EVENT_ID}', eventId);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.json();
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP error! status: ${response.status}`);
  }
  return await response.json();
}

export async function fetchTraders() {
  return await jsonRequest('/api/traders');
}

export async function createTrader(name, color, pin, role = 'trader') {
  return await jsonRequest('/api/traders', {
    method: 'POST',
    body: JSON.stringify({ name, color, pin, role }),
  });
}

export async function updateTrader(id, updates) {
  return await jsonRequest(`/api/traders?id=${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function updateOrgName(name) {
  return await jsonRequest('/api/shared-state?entity=org-name', {
    method: 'POST',
    body: JSON.stringify({ value: name }),
  });
}

export async function verifyTraderPin(id, pin) {
  return await jsonRequest('/api/traders?verify=1', {
    method: 'POST',
    body: JSON.stringify({ id, pin }),
  });
}

export async function fetchSharedState() {
  return await jsonRequest('/api/shared-state');
}

export async function pushSharedState(entity, data, traderId = null) {
  const params = new URLSearchParams({ entity });
  if (traderId) params.set('traderId', traderId);
  return await jsonRequest(`/api/shared-state?${params.toString()}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function fetchTraderState(traderId) {
  return await jsonRequest(`/api/trader-state?traderId=${encodeURIComponent(traderId)}`);
}

export async function pushTraderState(traderId, entity, data) {
  return await jsonRequest(`/api/trader-state?traderId=${encodeURIComponent(traderId)}&entity=${encodeURIComponent(entity)}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function fetchActiveTraders() {
  return await jsonRequest('/api/trader-presence');
}

export async function pushTraderPresence(traderId, leagueCode = null, leagueName = null) {
  return await jsonRequest('/api/trader-presence', {
    method: 'POST',
    body: JSON.stringify({ traderId, leagueCode, leagueName }),
  });
}

export async function fetchAuditLog(limit = 100) {
  return await jsonRequest(`/api/audit-log?limit=${encodeURIComponent(limit)}`);
}

export async function pushOddsHistory(data) {
  return await jsonRequest('/api/odds-history', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function fetchOddsHistory(eventId) {
  return await jsonRequest(`/api/odds-history?eventId=${encodeURIComponent(eventId)}`);
}

export async function fetchManualLeagues() {
  return await jsonRequest('/api/manual-data?type=leagues');
}

export async function createManualLeague(name, createdBy) {
  return await jsonRequest('/api/manual-data?type=leagues', {
    method: 'POST',
    body: JSON.stringify({ name, created_by: createdBy }),
  });
}

export async function updateManualLeague(id, name) {
  return await jsonRequest(`/api/manual-data?type=leagues&id=${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
}

export async function deleteManualLeague(id) {
  return await jsonRequest(`/api/manual-data?type=leagues&id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchManualEvents(leagueCode) {
  return await jsonRequest(`/api/manual-data?type=events&leagueCode=${encodeURIComponent(leagueCode)}`);
}

export async function createManualEvent(data) {
  return await jsonRequest('/api/manual-data?type=events', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateManualEvent(id, data) {
  return await jsonRequest(`/api/manual-data?type=events&id=${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteManualEvent(id) {
  return await jsonRequest(`/api/manual-data?type=events&id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function pushOfferSnapshot(snapshot) {
  const url = IS_LOCAL ? 'http://localhost:8888/.netlify/functions/offer' : '/api/offer';
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
}
