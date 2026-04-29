export const LEAGUES_URL = 'https://www.pinnacle888.com/sports-service/sv/euro/leagues?sportId=29&locale=en_US&withCredentials=true';
export const ODDS_URL_TEMPLATE = 'https://www.pinnacle888.com/sports-service/sv/euro/odds/league?sportId=29&oddsType=1&version=0&periodNum=-1&locale=en_US&leagueCode={CODE}&isHlE=true&isLive=false&eventType=0&withCredentials=true';

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
