import { state, toggleFavorite } from './state.js';
import { fetchOdds } from './api.js';
import { calculateTeamLambdas, calculateShinNoVig } from './math.js';

export function renderLeagues(leaguesToRender) {
  const leaguesContainer = document.getElementById('leagues-container');
  const favoritesContainer = document.getElementById('favorites-container');
  const leagueSearchInput = document.getElementById('league-search');
  
  const searchTerm = (leagueSearchInput.value || '').toLowerCase();
  
  const filtered = leaguesToRender.filter(league => {
    const name = (league.name || league.leagueName || '').toLowerCase();
    return name.includes(searchTerm);
  });

  leaguesContainer.innerHTML = '';
  favoritesContainer.innerHTML = '';

  if (!filtered.length && !searchTerm) {
    leaguesContainer.innerHTML = `<div class="empty-state">No leagues found.</div>`;
    return;
  }

  filtered.forEach(league => {
    const name = league.name || league.leagueName || 'Unknown League';
    const code = league.code || league.leagueCode || league.id;
    const isFav = state.favorites.includes(code);

    const el = createLeagueElement(name, code, isFav);
    
    if (isFav) {
      const favEl = createLeagueElement(name, code, isFav, true);
      favoritesContainer.appendChild(favEl);
    }
    
    leaguesContainer.appendChild(el);
  });
}

export function createLeagueElement(name, code, isFav, isMinimal = false) {
  const el = document.createElement('div');
  el.className = 'league-item';
  el.innerHTML = `
    <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1; overflow: hidden;">
      <span class="favorite-star ${isFav ? 'active' : ''}" data-code="${code}">★</span>
      <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</span>
    </div>
    <span style="font-size: 0.8em; color: var(--text-secondary)">›</span>
  `;

  el.addEventListener('click', async (e) => {
    if (e.target.classList.contains('favorite-star')) {
      toggleFavorite(code);
      renderLeagues(state.allLeagues);
      return;
    }
    document.querySelectorAll('.league-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('current-league').textContent = `- ${name}`;
    
    await loadOdds(code);
  });

  return el;
}

export async function loadOdds(leagueCode) {
  const oddsContainer = document.getElementById('odds-container');
  oddsContainer.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading odds...</p></div>`;
  try {
    const data = await fetchOdds(leagueCode);
    renderOdds(data);
  } catch (error) {
    console.error("Error fetching odds", error);
    oddsContainer.innerHTML = `<div class="empty-state" style="color: #ef4444">Failed to load odds.</div>`;
  }
}

export function renderOdds(data) {
  const oddsContainer = document.getElementById('odds-container');
  let events = [];
  if (data.leagues && Array.isArray(data.leagues)) {
    data.leagues.forEach(l => {
      if (l.events) events.push(...l.events);
    });
  } else {
    events = data.events || data.matches || (Array.isArray(data) ? data : []);
  }
  
  state.activeEvents = events;
  
  if (!events.length) {
    oddsContainer.innerHTML = `<div class="empty-state">No odds available for this league.</div>`;
    return;
  }
  
  let html = `<table class="market-table">
    <thead>
      <tr>
        <th style="width: 30%">Match</th>
        <th>1</th>
        <th>X</th>
        <th>2</th>
        <th>Over 2.5</th>
        <th>Under 2.5</th>
      </tr>
    </thead>
    <tbody>`;
  
  events.forEach(event => {
    let homeTeam = event.home || event.homeTeam?.name;
    let awayTeam = event.away || event.awayTeam?.name;
    
    if (!homeTeam && event.participants) {
      const home = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
      if (home) homeTeam = home.name || home.englishName;
    }
    if (!awayTeam && event.participants) {
      const away = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
      if (away) awayTeam = away.name || away.englishName;
    }
    
    homeTeam = homeTeam || 'Home';
    awayTeam = awayTeam || 'Away';

    const eventTime = event.starts || event.startTime || event.time;
    const time = eventTime ? new Date(eventTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'N/A';
    
    let odds1 = '-', oddsX = '-', odds2 = '-';
    
    let matchPeriod;
    if (event.periods && !Array.isArray(event.periods)) {
      matchPeriod = event.periods['0'];
    } else if (event.periodOdds && !Array.isArray(event.periodOdds)) {
      matchPeriod = event.periodOdds['0'];
    } else {
      const periodsArr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
      matchPeriod = periodsArr.find(p => p.num === 0 || p.periodNumber === 0) || periodsArr[0];
    }

    if (matchPeriod && (matchPeriod.moneyLine || matchPeriod.moneyline)) {
      const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
      odds1 = ml.homePrice || ml.home || odds1;
      oddsX = ml.drawPrice || ml.draw || oddsX;
      odds2 = ml.awayPrice || ml.away || odds2;
    }

    let oddsOver = '-', oddsUnder = '-';
    if (matchPeriod && matchPeriod.overUnder) {
      const ou25 = matchPeriod.overUnder.find(ou => ou.points === "2.5" || ou.points === 2.5);
      if (ou25) {
        oddsOver = ou25.overOdds || ou25.over || '-';
        oddsUnder = ou25.underOdds || ou25.under || '-';
      }
    }

    html += `<tr data-event-id="${event.id}">
      <td>
        <div class="match-time">${time}</div>
        <div class="match-teams">${homeTeam} vs ${awayTeam}</div>
      </td>
      <td><button class="odds-btn">${odds1}</button></td>
      <td><button class="odds-btn">${oddsX}</button></td>
      <td><button class="odds-btn">${odds2}</button></td>
      <td><button class="odds-btn" style="border-color: var(--accent-color)">${oddsOver}</button></td>
      <td><button class="odds-btn" style="border-color: var(--accent-color)">${oddsUnder}</button></td>
    </tr>`;
  });

  html += `</tbody></table>`;
  oddsContainer.innerHTML = html;
  
  oddsContainer.querySelectorAll('tr[data-event-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      openDrawer(tr.getAttribute('data-event-id'));
    });
  });
}

export function openDrawer(eventId) {
  const event = state.activeEvents.find(e => e.id.toString() === eventId.toString());
  if (!event) return;

  const drawerMatchName = document.getElementById('drawer-match-name');
  const drawerMatchTime = document.getElementById('drawer-match-time');
  const sideDrawer = document.getElementById('side-drawer');
  const drawerOverlay = document.getElementById('drawer-overlay');

  let homeTeam = event.home || 'Home';
  let awayTeam = event.away || 'Away';
  if (event.participants) {
    const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
    const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
    if (h) homeTeam = h.name;
    if (a) awayTeam = a.name;
  }
  drawerMatchName.textContent = `${homeTeam} vs ${awayTeam}`;
  
  const eventTime = event.starts || event.startTime || event.time;
  drawerMatchTime.textContent = eventTime ? new Date(eventTime).toLocaleString() : 'N/A';

  renderDrawerMarkets(event);

  sideDrawer.classList.add('active');
  drawerOverlay.classList.add('active');
}

export function closeDrawer() {
  document.getElementById('side-drawer').classList.remove('active');
  document.getElementById('drawer-overlay').classList.remove('active');
}

export function renderDrawerMarkets(event) {
  const drawerContent = document.getElementById('drawer-content');
  drawerContent.innerHTML = '';
  
  let matchPeriod;
  if (event.periods && !Array.isArray(event.periods)) {
    matchPeriod = event.periods['0'];
  } else {
    const periodsArr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
    matchPeriod = periodsArr.find(p => p.num === 0 || p.periodNumber === 0) || periodsArr[0];
  }

  if (!matchPeriod) {
    drawerContent.innerHTML = '<div class="empty-state">No detailed markets available.</div>';
    return;
  }

  let homeTeam = event.home || 'Home';
  let awayTeam = event.away || 'Away';
  if (event.participants) {
    const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
    const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
    if (h) homeTeam = h.name || h.englishName;
    if (a) awayTeam = a.name || a.englishName;
  }

  const lambdaData = calculateTeamLambdas(matchPeriod);
  if (lambdaData) {
    drawerContent.appendChild(createLambdaSection(lambdaData, homeTeam, awayTeam));
  }

  if (matchPeriod.moneyLine || matchPeriod.moneyline) {
    const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
    const odds = [ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away];
    const fair = calculateShinNoVig(odds);
    
    drawerContent.appendChild(createMarketGroup('Money Line - Match', [
      { label: homeTeam, value: odds[0] || '-', fair: fair[0] },
      { label: 'Draw', value: odds[1] || '-', fair: fair[1] },
      { label: awayTeam, value: odds[2] || '-', fair: fair[2] }
    ], 'three-cols', true));
  }

  if (matchPeriod.handicap && Array.isArray(matchPeriod.handicap)) {
    const formatSpread = (s) => {
      if (s === 0 || s === "0") return "0";
      if (typeof s === 'string' && (s.startsWith('+') || s.startsWith('-'))) return s;
      return parseFloat(s) > 0 ? `+${s}` : s;
    };

    const hdpRows = [];
    matchPeriod.handicap.forEach(h => {
      const fair = calculateShinNoVig([h.homeOdds, h.awayOdds]);
      hdpRows.push({ label: formatSpread(h.homeSpread), value: h.homeOdds, fair: fair[0] });
      hdpRows.push({ label: formatSpread(h.awaySpread), value: h.awayOdds, fair: fair[1] });
    });
    drawerContent.appendChild(createMarketGroup('Handicap - Match', hdpRows));
  }

  if (matchPeriod.overUnder && Array.isArray(matchPeriod.overUnder)) {
    const sortedOU = [...matchPeriod.overUnder].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
    const ouRows = [];
    sortedOU.forEach(ou => {
      const fair = calculateShinNoVig([ou.overOdds, ou.underOdds]);
      ouRows.push({ label: `Over ${ou.points}`, value: ou.overOdds, fair: fair[0] });
      ouRows.push({ label: `Under ${ou.points}`, value: ou.underOdds, fair: fair[1] });
    });
    drawerContent.appendChild(createMarketGroup('Total - Match', ouRows));
  }
}

export function createMarketGroup(title, rows, extraClass = '', hasShowAll = false) {
  const group = document.createElement('div');
  group.className = 'market-group';
  
  group.innerHTML = `
    <div class="market-header">
      <h3>${title}</h3>
      <div class="market-header-actions">
        ${hasShowAll ? '<button class="show-all-btn">Show All</button>' : ''}
        <span style="font-size: 0.8rem; transform: rotate(0deg);">▼</span>
      </div>
    </div>
    <div class="market-grid ${extraClass}"></div>
  `;
  
  const grid = group.querySelector('.market-grid');
  
  rows.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'market-row';
    const noVigVal = row.fair;
    
    item.innerHTML = `
      <span class="market-label">${row.label}</span>
      <div class="odds-comparison">
        <div class="price-chip bookie">
          <span class="chip-label">API</span>
          <span class="market-value">${row.value}</span>
        </div>
        ${noVigVal && noVigVal !== '-' ? `
          <div class="price-chip fair">
            <span class="chip-label">Fair</span>
            <span class="fair-value">${noVigVal}</span>
          </div>
        ` : ''}
      </div>
    `;
    grid.appendChild(item);
  });
  
  return group;
}

export function createLambdaSection(data, homeTeam, awayTeam) {
  const section = document.createElement('div');
  section.className = 'lambda-section';
  const scoresHtml = data.scores.map(s =>
    `<div class="score-chip"><div class="score">${s.home}-${s.away}</div><div class="prob">${(s.prob*100).toFixed(1)}%</div></div>`
  ).join('');
  section.innerHTML = `
    <h3 class="lambda-title">⚽ Dixon-Coles Model</h3>
    <div class="lambda-cards">
      <div class="lambda-card">
        <div class="team-name">${homeTeam}</div>
        <div class="lambda-value">${data.lh.toFixed(2)}</div>
        <div class="lambda-label">λ (Expected Goals)</div>
      </div>
      <div class="lambda-card">
        <div class="team-name">${awayTeam}</div>
        <div class="lambda-value">${data.la.toFixed(2)}</div>
        <div class="lambda-label">λ (Expected Goals)</div>
      </div>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
      <div class="likely-scores-label" style="margin-bottom: 0;">Most Likely Scores</div>
      <div style="font-size: 0.7rem; color: #64748b;">ρ = ${data.rho.toFixed(3)}</div>
    </div>
    <div class="likely-scores">${scoresHtml}</div>
  `;
  return section;
}
