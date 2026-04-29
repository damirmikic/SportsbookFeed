export const LEAGUES_URL = '/api/leagues';
export const ODDS_URL_TEMPLATE = '/api/odds/{CODE}';

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
