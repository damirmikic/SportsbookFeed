const PINNACLE_ODDS_URL = 'https://www.pinnacle888.com/sports-service/sv/euro/odds/league';

const DEFAULT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
}

function leagueCodeFromPath(path = '') {
  const marker = '/.netlify/functions/odds/';
  if (!path.includes(marker)) return null;
  const code = path.slice(path.indexOf(marker) + marker.length).split('/')[0];
  return code ? decodeURIComponent(code) : null;
}

function emptyOddsResponse(leagueCode, extra = {}) {
  return json(200, { events: [], leagueCode, ...extra });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: DEFAULT_HEADERS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const leagueCode = params.leagueCode || params.code || leagueCodeFromPath(event.path);

  if (!leagueCode) {
    return json(400, { error: 'leagueCode required' });
  }

  const upstreamParams = new URLSearchParams({
    sportId: params.sportId || '29',
    oddsType: params.oddsType || '1',
    version: params.version || '0',
    periodNum: params.periodNum || '-1',
    locale: params.locale || 'en_US',
    leagueCode,
    isHlE: params.isHlE || 'true',
    isLive: params.isLive || 'false',
    eventType: params.eventType || '0',
    withCredentials: params.withCredentials || 'true',
  });

  try {
    const response = await fetch(`${PINNACLE_ODDS_URL}?${upstreamParams.toString()}`, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'SportsbookFeed/1.0',
      },
    });
    const text = await response.text();

    if (!response.ok) {
      console.warn(`Pinnacle odds returned ${response.status} for league ${leagueCode}: ${text.slice(0, 300)}`);
      if ([403, 404, 429].includes(response.status) || response.status >= 500) {
        return emptyOddsResponse(leagueCode, { upstreamStatus: response.status });
      }
      return {
        statusCode: response.status,
        headers: DEFAULT_HEADERS,
        body: text || JSON.stringify({ error: `Pinnacle returned ${response.status}` }),
      };
    }

    return {
      statusCode: 200,
      headers: DEFAULT_HEADERS,
      body: text || '{}',
    };
  } catch (error) {
    console.error('Pinnacle odds proxy failed:', error);
    return emptyOddsResponse(leagueCode, { upstreamError: error.message });
  }
};
