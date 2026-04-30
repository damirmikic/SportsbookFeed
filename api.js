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
