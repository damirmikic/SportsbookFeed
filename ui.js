import { state, toggleFavorite, toggleGroup, snapshotOdds, getOverride, setOverride, clearOverride, clearAllOverridesForEvent, getTradingMode, setTradingMode, isSuspended, setSuspension, hasAnySuspension } from './state.js';
import { fetchOdds, fetchEventOdds } from './api.js';
import { calculateTeamLambdas, calculateShinNoVig, scoreProb, dcAsianHandicapOdds, dcAsianTotalOdds, dcAsianTeamTotalOdds } from './math.js';
import { buildAllMarkets } from './markets.js';

// Sum of inverse prices → book percentage (e.g. 1.05 = 105%)
function calcMargin(rows) {
  let sum = 0, count = 0;
  rows.forEach(r => {
    const v = parseFloat(r.value);
    if (!isNaN(v) && v > 1) { sum += 1 / v; count++; }
  });
  return count >= 2 ? sum : null;
}

function marginBadgeHTML(margin) {
  if (margin === null) return '';
  const pct = (margin * 100).toFixed(1);
  const cls = margin < 1.03 ? 'margin-green' : margin < 1.07 ? 'margin-yellow' : 'margin-red';
  return `<span class="margin-badge ${cls}">${pct}%</span>`;
}

// Build a matchPeriod copy with overridden prices substituted in
function getEffectiveMatchPeriod(matchPeriod, eventId, homeTeam, awayTeam) {
  const get = (mktId, label, original) => {
    const ov = getOverride(`${eventId}|${mktId}|${label}`);
    return ov ? parseFloat(ov) : (parseFloat(original) || original);
  };
  const r = JSON.parse(JSON.stringify(matchPeriod));
  const ml = r.moneyLine || r.moneyline;
  if (ml) {
    const h = get('ml', homeTeam, ml.homePrice || ml.home);
    const d = get('ml', 'Draw',   ml.drawPrice || ml.draw);
    const a = get('ml', awayTeam, ml.awayPrice || ml.away);
    if (r.moneyLine) r.moneyLine = { ...r.moneyLine, homePrice: h, home: h, drawPrice: d, draw: d, awayPrice: a, away: a };
    if (r.moneyline) r.moneyline = { ...r.moneyline, homePrice: h, home: h, drawPrice: d, draw: d, awayPrice: a, away: a };
  }
  if (r.overUnder && Array.isArray(r.overUnder)) {
    r.overUnder = r.overUnder.map(ou => ({
      ...ou,
      overOdds:  get('ou', `Over ${ou.points}`,  ou.overOdds),
      underOdds: get('ou', `Under ${ou.points}`, ou.underOdds),
    }));
  }
  return r;
}

// Update the suspend-event button in the drawer header
function updateSuspendButton(eventId) {
  const btn = document.getElementById('suspend-event-btn');
  if (!btn) return;
  const suspended = isSuspended(eventId, 'event');
  btn.innerHTML = suspended ? '<span>🔒</span> SUSPENDED' : '<span>🔓</span> PUBLISHED';
  btn.className   = `suspend-btn ${suspended ? 'suspended' : 'open'}`;
  btn.title       = suspended ? 'Event SUSPENDED — click to publish' : 'Click to suspend entire event';
  btn.onclick = () => {
    const nowSuspended = isSuspended(eventId, 'event');
    setSuspension(eventId, 'event', nowSuspended ? 'open' : 'suspended');
    updateSuspendButton(eventId);
    // Update the board row immediately
    const row = document.querySelector(`tr[data-event-id="${eventId}"]`);
    if (row) row.className = row.className
      .replace(/\bevent-suspended\b/g, '').trim()
      + (!nowSuspended ? ' event-suspended' : '');
    const ev = state.activeEvents.find(e => e.id.toString() === String(eventId));
    if (ev) renderDrawerMarkets(ev);
  };
}

// Update the trading-mode toggle button in the drawer header
function updateModeButton(eventId) {
  const btn = document.getElementById('trading-mode-btn');
  if (!btn) return;
  const isManual = getTradingMode(eventId) === 'manual';
  btn.textContent = isManual ? 'MANUAL' : 'AUTO';
  btn.className   = `mode-btn ${isManual ? 'manual' : 'auto'}`;
  btn.title       = isManual
    ? 'Switch back to AUTO (clears all manual overrides)'
    : 'Edit any price to enter MANUAL mode';
  btn.onclick = () => {
    if (isManual) {
      clearAllOverridesForEvent(eventId);
      setTradingMode(eventId, 'auto');
      updateModeButton(eventId);
      const ev = state.activeEvents.find(e => e.id.toString() === String(eventId));
      if (ev) renderDrawerMarkets(ev);
    }
  };
}

export function renderLeagues(leaguesToRender) {
  const leaguesContainer   = document.getElementById('leagues-container');
  const favoritesContainer = document.getElementById('favorites-container');
  const leagueSearchInput  = document.getElementById('league-search');

  const searchTerm = (leagueSearchInput.value || '').toLowerCase();
  const filtered   = leaguesToRender.filter(league =>
    (league.name || league.leagueName || '').toLowerCase().includes(searchTerm)
  );

  leaguesContainer.innerHTML   = '';
  favoritesContainer.innerHTML = '';

  if (!filtered.length && !searchTerm) {
    leaguesContainer.innerHTML = `<div class="empty-state">No leagues found.</div>`;
    return;
  }

  // 1. Render Favorites (at the top, always expanded if they exist)
  const favoriteLeagues = filtered.filter(l => state.favorites.includes(l.code || l.leagueCode || l.id));
  if (favoriteLeagues.length > 0) {
    favoriteLeagues.forEach(league => {
      const name = league.name || league.leagueName || 'Unknown League';
      const code = league.code || league.leagueCode || league.id;
      favoritesContainer.appendChild(createLeagueElement(name, code, true));
    });
  }

  // 2. Group Remaining Leagues by Country
  const groups = {};
  filtered.forEach(league => {
    const name = league.name || league.leagueName || 'Unknown League';
    const country = name.includes(' - ') ? name.split(' - ')[0] : 'International';
    if (!groups[country]) groups[country] = [];
    groups[country].push(league);
  });

  const sortedCountries = Object.keys(groups).sort();
  sortedCountries.forEach(country => {
    const groupLeagues = groups[country];
    const isExpanded = state.expandedGroups.includes(country) || (searchTerm !== '');
    leaguesContainer.appendChild(createLeagueGroup(country, groupLeagues, isExpanded));
  });
}

function createLeagueGroup(country, leagues, isExpanded) {
  const group = document.createElement('div');
  group.className = `league-group ${isExpanded ? 'expanded' : ''}`;
  
  const header = document.createElement('div');
  header.className = 'league-group-header';
  header.innerHTML = `
    <span class="group-toggle-icon">${isExpanded ? '▼' : '▶'}</span>
    <span class="group-name">${country}</span>
    <span class="group-count">${leagues.length}</span>
  `;
  
  header.onclick = (e) => {
    e.stopPropagation();
    toggleGroup(country);
    renderLeagues(state.allLeagues);
  };
  
  const content = document.createElement('div');
  content.className = 'league-group-content';
  
  leagues.forEach(league => {
    const name = league.name || league.leagueName || 'Unknown League';
    const code = league.code || league.leagueCode || league.id;
    const isFav = state.favorites.includes(code);
    content.appendChild(createLeagueElement(name, code, isFav));
  });
  
  group.appendChild(header);
  group.appendChild(content);
  return group;
}

export function createLeagueElement(name, code, isFav) {
  const el = document.createElement('div');
  el.className = 'league-item';
  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:0.5rem;flex:1;">
      <span class="favorite-star ${isFav ? 'active' : ''}" data-code="${code}" style="margin-top: 0.2rem;">★</span>
      <span class="league-name">${name}</span>
    </div>
    <span style="font-size:0.8em;color:var(--text-secondary);margin-top: 0.3rem;">›</span>
  `;

  el.addEventListener('click', async (e) => {
    if (e.target.classList.contains('favorite-star')) {
      toggleFavorite(code);
      renderLeagues(state.allLeagues);
      return;
    }
    document.querySelectorAll('.league-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('current-league').textContent = `– ${name}`;

    // Signal app.js to start polling
    document.dispatchEvent(new CustomEvent('league:selected', { detail: { code } }));
    await loadOdds(code);
  });

  return el;
}

export async function loadOdds(leagueCode, silent = false) {
  const oddsContainer = document.getElementById('odds-container');
  if (!silent) {
    oddsContainer.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading odds...</p></div>`;
  }
  try {
    // snapshot current prices before replacing state.activeEvents
    state.previousOdds = snapshotOdds();
    const data = await fetchOdds(leagueCode);
    renderOdds(data);
  } catch (error) {
    console.error('Error fetching odds', error);
    if (!silent) {
      oddsContainer.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load odds.</div>`;
    }
  }
}

export function renderOdds(data) {
  const oddsContainer = document.getElementById('odds-container');

  let events = [];
  if (data.leagues && Array.isArray(data.leagues)) {
    data.leagues.forEach(l => { if (l.events) events.push(...l.events); });
  } else {
    events = data.events || data.matches || (Array.isArray(data) ? data : []);
  }

  state.activeEvents = events;

  if (!events.length) {
    oddsContainer.innerHTML = `<div class="empty-state">No odds available for this league.</div>`;
    return;
  }

  let html = `<table class="market-table">
    <thead><tr>
      <th style="width:30%">Match</th>
      <th>1</th><th>X</th><th>2</th>
      <th>Over 2.5</th><th>Under 2.5</th>
    </tr></thead><tbody>`;

  events.forEach(event => {
    let homeTeam = event.home || event.homeTeam?.name;
    let awayTeam = event.away || event.awayTeam?.name;

    if (!homeTeam && event.participants) {
      const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
      if (h) homeTeam = h.name || h.englishName;
    }
    if (!awayTeam && event.participants) {
      const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
      if (a) awayTeam = a.name || a.englishName;
    }
    homeTeam = homeTeam || 'Home';
    awayTeam = awayTeam || 'Away';

    const eventTime = event.starts || event.startTime || event.time;
    const time = eventTime
      ? new Date(eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'N/A';

    let odds1 = '-', oddsX = '-', odds2 = '-';
    let matchPeriod;
    if (event.periods && !Array.isArray(event.periods)) {
      matchPeriod = event.periods['0'];
    } else if (event.periodOdds && !Array.isArray(event.periodOdds)) {
      matchPeriod = event.periodOdds['0'];
    } else {
      const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
      matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    }

    if (matchPeriod && (matchPeriod.moneyLine || matchPeriod.moneyline)) {
      const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
      odds1 = ml.homePrice || ml.home || '-';
      oddsX = ml.drawPrice || ml.draw || '-';
      odds2 = ml.awayPrice || ml.away || '-';
    }

    let oddsOver = '-', oddsUnder = '-';
    if (matchPeriod?.overUnder) {
      const ou25 = matchPeriod.overUnder.find(ou => ou.points === '2.5' || ou.points === 2.5);
      if (ou25) { oddsOver = ou25.overOdds || ou25.over || '-'; oddsUnder = ou25.underOdds || ou25.under || '-'; }
    }

    // Board-level suspension indicators
    const evtSuspended = isSuspended(event.id, 'event');
    const mlSuspended  = isSuspended(event.id, 'ml');
    const ouSuspended  = isSuspended(event.id, 'ou');
    const anySusp = evtSuspended || mlSuspended || ouSuspended || hasAnySuspension(event.id);

    // Apply manual price overrides on the board
    const isManual = getTradingMode(event.id) === 'manual';
    let m1 = false, mX = false, m2 = false, mOver = false, mUnder = false;
    if (isManual) {
      const o1    = getOverride(`${event.id}|ml|${homeTeam}`);
      const oX    = getOverride(`${event.id}|ml|Draw`);
      const o2    = getOverride(`${event.id}|ml|${awayTeam}`);
      const oOver = getOverride(`${event.id}|ou|Over 2.5`);
      const oUnd  = getOverride(`${event.id}|ou|Under 2.5`);
      if (o1)    { odds1     = o1;    m1     = true; }
      if (oX)    { oddsX     = oX;    mX     = true; }
      if (o2)    { odds2     = o2;    m2     = true; }
      if (oOver) { oddsOver  = oOver; mOver  = true; }
      if (oUnd)  { oddsUnder = oUnd;  mUnder = true; }
    }

    // Price-move detection (suppress for manually-set cells)
    const prev = state.previousOdds[event.id] || {};
    const trend = (val, prevVal, isManualCell) => {
      if (isManualCell || !prevVal || val === '-') return '';
      const diff = parseFloat(val) - prevVal;
      if (Math.abs(diff) < 0.001) return '';
      return diff > 0 ? ' price-up' : ' price-down';
    };
    const t1 = trend(odds1, prev.home, m1);
    const tX = trend(oddsX, prev.draw, mX);
    const t2 = trend(odds2, prev.away, m2);

    const manualBadge = isManual ? '<span class="manual-row-badge">M</span>' : '';
    const suspBadge   = anySusp && !evtSuspended ? '<span class="susp-badge">SUSP</span>' : '';
    const rowClass = [isManual ? 'manual-row' : '', evtSuspended ? 'event-suspended' : ''].filter(Boolean).join(' ');

    html += `<tr data-event-id="${event.id}" class="${rowClass}">
      <td>
        <div class="match-time">${time}${manualBadge}${suspBadge}</div>
        <div class="match-teams">${homeTeam} vs ${awayTeam}</div>
      </td>
      <td class="${mlSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${m1 ? ' manual-price' : t1}">${evtSuspended || mlSuspended ? 'SUSP' : odds1}${!m1 && t1 === ' price-up' ? ' ▲' : !m1 && t1 === ' price-down' ? ' ▼' : ''}</button></td>
      <td class="${mlSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${mX ? ' manual-price' : tX}">${evtSuspended || mlSuspended ? 'SUSP' : oddsX}${!mX && tX === ' price-up' ? ' ▲' : !mX && tX === ' price-down' ? ' ▼' : ''}</button></td>
      <td class="${mlSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${m2 ? ' manual-price' : t2}">${evtSuspended || mlSuspended ? 'SUSP' : odds2}${!m2 && t2 === ' price-up' ? ' ▲' : !m2 && t2 === ' price-down' ? ' ▼' : ''}</button></td>
      <td class="${ouSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${mOver ? ' manual-price' : ''}" style="border-color:${mOver ? '#fbbf24' : 'var(--accent-color)'}">${evtSuspended || ouSuspended ? 'SUSP' : oddsOver}</button></td>
      <td class="${ouSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${mUnder ? ' manual-price' : ''}" style="border-color:${mUnder ? '#fbbf24' : 'var(--accent-color)'}">${evtSuspended || ouSuspended ? 'SUSP' : oddsUnder}</button></td>
    </tr>`;
  });

  html += `</tbody></table>`;
  oddsContainer.innerHTML = html;

  oddsContainer.querySelectorAll('tr[data-event-id]').forEach(tr => {
    tr.addEventListener('click', () => openDrawer(tr.getAttribute('data-event-id')));
  });
}

export async function openDrawer(eventId) {
  const event = state.activeEvents.find(e => e.id.toString() === eventId.toString());
  if (!event) return;
  state.drawerEventId = eventId;
  updateModeButton(eventId);
  updateSuspendButton(eventId);

  let homeTeam = event.home || 'Home';
  let awayTeam = event.away || 'Away';
  if (event.participants) {
    const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
    const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
    if (h) homeTeam = h.name;
    if (a) awayTeam = a.name;
  }

  document.getElementById('drawer-match-name').textContent = `${homeTeam} vs ${awayTeam}`;
  const eventTime = event.starts || event.startTime || event.time;
  document.getElementById('drawer-match-time').textContent = eventTime
    ? new Date(eventTime).toLocaleString() : 'N/A';

  try {
    const data = await fetchEventOdds(eventId);
    state.detailedOdds[eventId] = data;
  } catch (e) {
    console.error("Failed to fetch detailed odds", e);
  }

  renderDrawerMarkets(event);
  document.getElementById('side-drawer').classList.add('active');
  document.getElementById('drawer-overlay').classList.add('active');
}

export function closeDrawer() {
  document.getElementById('side-drawer').classList.remove('active');
  document.getElementById('drawer-overlay').classList.remove('active');
}

function groupMarketsByCategory(event, matchPeriod, h1Period, lambdaData, detailedAll, homeTeam, awayTeam) {
  const groups = {
    'MAIN MARKETS': [],
    'HANDICAP': [],
    'GOALS': [],
    'TEAM GOALS': [],
    'HALVES': [],
    'CORNERS': [],
    'BOOKINGS': [],
    'TEAM PROPS': [],
    'SPECIALS': [],
    'PLAYER MARKETS': []
  };

  // --- Main Markets ---
  let shin1X2 = null;
  if (matchPeriod.moneyLine || matchPeriod.moneyline) {
    const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
    const odds = [ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away];
    shin1X2 = calculateShinNoVig(odds);
    const shin = shin1X2;
    // Model 1x2 from lambdaData FT grid
    let modelRows = [null, null, null];
    if (lambdaData) {
      let pH = 0, pD = 0, pA = 0;
      lambdaData.ft.grid.forEach(({ home, away, prob }) => {
        if (home > away) pH += prob; else if (home === away) pD += prob; else pA += prob;
      });
      modelRows = [(1/pH).toFixed(3), (1/pD).toFixed(3), (1/pA).toFixed(3)];
    }
    groups['MAIN MARKETS'].push({
      id: 'ml',
      name: '1x2',
      rows: [
        { label: homeTeam, value: odds[0] || '-', shinFair: shin[0], modelFair: modelRows[0] },
        { label: 'Draw',   value: odds[1] || '-', shinFair: shin[1], modelFair: modelRows[1] },
        { label: awayTeam, value: odds[2] || '-', shinFair: shin[2], modelFair: modelRows[2] }
      ]
    });
  }

  if (matchPeriod.handicap && Array.isArray(matchPeriod.handicap)) {
    const fmt = s => { const n = parseFloat(s); return (n === 0 || isNaN(n)) ? '0' : (n > 0 ? `+${n}` : `${n}`); };
    let hdps = [...matchPeriod.handicap].sort((a, b) => parseFloat(a.homeSpread) - parseFloat(b.homeSpread));
    let minDiff = Infinity;
    let balancedIdx = 0;
    hdps.forEach((h, i) => {
      const diff = Math.abs(parseFloat(h.homeOdds) - parseFloat(h.awayOdds));
      if (diff < minDiff) { minDiff = diff; balancedIdx = i; }
    });
    
    let startIdx = Math.max(0, balancedIdx - 2);
    let endIdx = Math.min(hdps.length - 1, startIdx + 4);
    if (endIdx - startIdx < 4) startIdx = Math.max(0, endIdx - 4);
    const selectedHdps = hdps.slice(startIdx, endIdx + 1);

    const rows = [];
    selectedHdps.forEach(h => {
      const shin = calculateShinNoVig([h.homeOdds, h.awayOdds]);
      // Model handicap using exact Asian Handicap settlement rules on FT grid
      let mHome = null, mAway = null;
      if (lambdaData) {
        const homeOdds = dcAsianHandicapOdds(lambdaData.ft.grid, parseFloat(h.homeSpread), false);
        const awayOdds = dcAsianHandicapOdds(lambdaData.ft.grid, parseFloat(h.awaySpread), true);
        if (homeOdds) mHome = homeOdds.toFixed(3);
        if (awayOdds) mAway = awayOdds.toFixed(3);
      }
      rows.push({ label: `Home ${fmt(h.homeSpread)}`, value: h.homeOdds, shinFair: shin[0], modelFair: mHome });
      rows.push({ label: `Away ${fmt(h.awaySpread)}`, value: h.awayOdds, shinFair: shin[1], modelFair: mAway });
    });
    groups['HANDICAP'].push({ id: 'hdp', name: 'Handicap (Best 5)', rows });
  }

  if (matchPeriod.overUnder && Array.isArray(matchPeriod.overUnder)) {
    const rows = [];
    const ous = [...matchPeriod.overUnder].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
    ous.forEach(ou => {
        const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        // Model over prob using exact Asian Totals settlement rules on FT grid
        let mOver = null, mUnder = null;
        if (lambdaData) {
          const line = parseFloat(ou.points);
          const overOdds = dcAsianTotalOdds(lambdaData.ft.grid, line, true);
          const underOdds = dcAsianTotalOdds(lambdaData.ft.grid, line, false);
          if (overOdds) mOver = overOdds.toFixed(3);
          if (underOdds) mUnder = underOdds.toFixed(3);
        }
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
    });
    groups['GOALS'].push({ id: 'ou', name: 'Total (All Lines)', rows });
  }

  if (matchPeriod.teamTotal) {
    const processTeamTotal = (tt, labelPrefix, teamName, isAway) => {
      const ousArray = tt?.overUnder || (Array.isArray(tt) ? tt : null);
      if (!ousArray || !Array.isArray(ousArray)) return;
      const rows = [];
      const ous = [...ousArray].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
      ous.forEach(ou => {
          const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
          let mOver = null, mUnder = null;
          if (lambdaData) {
            const line = parseFloat(ou.points);
            const overOdds = dcAsianTeamTotalOdds(lambdaData.ft.grid, line, true, isAway);
            const underOdds = dcAsianTeamTotalOdds(lambdaData.ft.grid, line, false, isAway);
            if (overOdds) mOver = overOdds.toFixed(3);
            if (underOdds) mUnder = underOdds.toFixed(3);
          }
          rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
          rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
      });
      if (rows.length > 0) {
        groups['TEAM GOALS'].push({ id: `tt_${labelPrefix}`, name: `${teamName} Totals`, rows });
      }
    };
    processTeamTotal(matchPeriod.teamTotal.home, 'home', homeTeam, false);
    processTeamTotal(matchPeriod.teamTotal.away, 'away', awayTeam, true);
  }

  if (h1Period && h1Period.overUnder && Array.isArray(h1Period.overUnder)) {
    const rows = [];
    const ous = [...h1Period.overUnder].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
    ous.forEach(ou => {
        const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        let mOver = null, mUnder = null;
        if (lambdaData && lambdaData.h1) {
          const line = parseFloat(ou.points);
          const overOdds = dcAsianTotalOdds(lambdaData.h1.grid, line, true);
          const underOdds = dcAsianTotalOdds(lambdaData.h1.grid, line, false);
          if (overOdds) mOver = overOdds.toFixed(3);
          if (underOdds) mUnder = underOdds.toFixed(3);
        }
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
    });
    groups['HALVES'].push({ id: 'h1_ou', name: '1st Half Total', rows });
  }

  // --- Derived Markets ---
  if (lambdaData) {
    const derived = buildAllMarkets(lambdaData.ft.grid);
    const teamProps = detailedAll.specials?.find(s => s.code === 'team-props')?.events || [];
    const getPinnaclePrice = (marketId, label) => {
        let eventName = '';
        if (marketId === 'btts') eventName = 'Both Teams To Score?';
        else if (marketId === 'dnb') eventName = 'Draw No Bet';
        else if (marketId === 'dc') eventName = 'Double Chance';
        else if (marketId === 'cs') eventName = 'Correct Score';
        const mkt = teamProps.find(e => e.name === eventName);
        if (!mkt) return null;
        let pinLabel = label;
        if (marketId === 'dnb') {
          pinLabel = label === 'Home' ? homeTeam : awayTeam;
        } else if (marketId === 'dc') {
          if (label === '1X') pinLabel = `${homeTeam} Or Draw`;
          else if (label === 'X2') pinLabel = `Draw Or ${awayTeam}`;
          else if (label === '12') pinLabel = `${homeTeam} Or ${awayTeam}`;
        } else if (marketId === 'cs') {
           const parts = label.split('–');
           if (parts.length === 2) pinLabel = `${homeTeam} ${parts[0]}, ${awayTeam} ${parts[1]}`;
        }
        const contestant = mkt.contestants?.find(c => c.n === pinLabel);
        return contestant ? contestant.p : null;
    };

    derived.forEach(market => {
      const rows = market.selections.map(s => {
        const pinPrice = getPinnaclePrice(market.id, s.label);
        // Shin-devig the pinnacle price within its market group (approximate per-selection)
        return {
          label: s.label,
          value: pinPrice || null,          // raw Pinnacle price (or null if not available)
          shinFair: pinPrice ? null : null, // will be computed per-market below
          modelFair: s.price,               // Dixon-Coles model price
          prob: s.prob,
          isApiOnly: false
        };
      });
      // Apply Shin devig across all Pinnacle prices in this market where available
      const withPin = rows.filter(r => r.value);
      if (withPin.length >= 2) {
        if (market.id === 'dc' && shin1X2) {
          // Double Chance is a mathematically overlapping market (sums to 2). 
          // Shin devig fails on it, so we derive its fair odds from the devigged 1X2 market.
          const p1 = 1 / parseFloat(shin1X2[0]);
          const pX = 1 / parseFloat(shin1X2[1]);
          const p2 = 1 / parseFloat(shin1X2[2]);
          withPin.forEach(r => {
            if (r.label === '1X') r.shinFair = (1 / (p1 + pX)).toFixed(2);
            else if (r.label === '12') r.shinFair = (1 / (p1 + p2)).toFixed(2);
            else if (r.label === 'X2') r.shinFair = (1 / (pX + p2)).toFixed(2);
          });
        } else {
          // Standard mutually exclusive market devig
          const shinResults = calculateShinNoVig(withPin.map(r => r.value));
          withPin.forEach((r, i) => { r.shinFair = shinResults[i]; });
        }
      }
      const cat = market.id === 'cs' || market.id === 'btts' ? 'GOALS' : 'MAIN MARKETS';
      groups[cat].push({ id: market.id, name: market.name, rows });
    });
  }

  // --- Additional Pinnacle Markets ---
  if (detailedAll.specials && Array.isArray(detailedAll.specials)) {
    detailedAll.specials.forEach(category => {
      if (!category.events || category.events.length === 0) return;

      category.events.forEach(mkt => {
        // Skip markets already mapped to model-derived groups
        if (['Both Teams To Score?', 'Draw No Bet', 'Double Chance', 'Correct Score'].includes(mkt.name)) return;

        const allPrices = mkt.contestants.map(c => parseFloat(c.p)).filter(p => !isNaN(p) && p > 1);
        const targetSum = mkt.name.toLowerCase().includes('double chance') ? 2.0 : 1.0;
        const shinAll = allPrices.length >= 2 ? calculateShinNoVig(allPrices, targetSum) : allPrices.map(() => null);
        const rows = mkt.contestants.map((c, i) => ({
          label: c.n,
          value: c.p,
          shinFair: shinAll[i] ?? null,
          modelFair: getModelPriceForSpecial(mkt.name, c.n, lambdaData, homeTeam, awayTeam),
          isApiOnly: true
        }));

        const n = mkt.name.toLowerCase();
        let catName;

        // Priority order matters — check most specific first

        // 1. Halves (1st/2nd half anything)
        if (n.includes('1st half') || n.includes('2nd half') || n.includes('first half') || n.includes('second half')) {
          catName = 'HALVES';

        // 2. Corners
        } else if (n.includes('corner')) {
          catName = 'CORNERS';

        // 3. Bookings / Cards
        } else if (n.includes('booking') || n.includes('yellow card') || n.includes('red card') || n.includes('card')) {
          catName = 'BOOKINGS';

        // 4. Team-specific goal markets (e.g. "Leeds United Goals", "Burnley Goals Odd/Even")
        } else if (/^(home|away|[a-z ]+) goals/i.test(mkt.name) && !n.includes('total goals')) {
          catName = 'TEAM GOALS';

        // 5. All Handicap variants → dedicated HANDICAP tab
        } else if (n.includes('handicap') || n.includes('asian handicap') || n.includes('3-way handicap')) {
          catName = 'HANDICAP';

        // 6. Goal volume markets (total, exact, range, odd/even)
        } else if (
          n.includes('total goals') || n.includes('exact goals') || n.includes('goals range') ||
          n.includes('goals odd/even') || n.includes('odd/even') ||
          n.includes('either team to score') || n.includes('both teams to score') ||
          n.includes('anytime') || n.includes('over/under')
        ) {
          catName = 'GOALS';

        // 7. Team props (first/last scorer, clean sheet, win to nil, team to score?)
        } else if (
          n.includes('first team to score') || n.includes('last team to score') ||
          n.includes('clean sheet') || n.includes('win to nil') ||
          n.includes('to win to nil') || n.includes('both halves') ||
          (n.includes('to score') && !n.includes('player') && !n.includes('anytime'))
        ) {
          catName = 'TEAM PROPS';

        // 8. Player scorer markets
        } else if (category.code === 'player-props' || n.includes('anytime scorer') || n.includes('player to score')) {
          catName = 'PLAYER MARKETS';

        // 9. Combo / result markets → SPECIALS
        } else if (
          n.includes('half time') || n.includes('ht/ft') || n.includes('halftime/fulltime') ||
          n.includes('half-time/full-time') || n.includes('winning margin') ||
          n.includes('winner') || n.includes('3-way') || n.includes('draw no bet')
        ) {
          catName = 'SPECIALS';

        } else {
          // Fallback by API code
          if (category.code === 'halves') catName = 'HALVES';
          else if (category.code === 'player-props') catName = 'PLAYER MARKETS';
          else catName = 'SPECIALS';
        }

        groups[catName].push({ id: `special_${mkt.id}`, name: mkt.name, rows });
      });
    });
  }

  Object.keys(groups).forEach(k => { if (groups[k].length === 0) delete groups[k]; });
  return groups;
}

function getModelPriceForSpecial(marketName, selectionLabel, lambdaData, homeTeam, awayTeam) {
  if (!lambdaData || !lambdaData.ft || !lambdaData.ft.grid) return null;
  const n = marketName.toLowerCase();
  const label = selectionLabel.toLowerCase();

  // Determine period grid
  let grid = lambdaData.ft.grid;
  if (n.includes('1st half')) grid = lambdaData.h1.grid;
  else if (n.includes('2nd half')) grid = lambdaData.h2.grid;

  // Case 1: Joint BTTS & Total Goals
  if ((n.includes('both teams to score') || n.includes('btts')) && n.includes('total goals')) {
    const isYes = label.includes('yes');
    const isOver = label.includes('over');
    const lineMatch = label.match(/(over|under)\s+([0-9.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[2]) : 2.5;

    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const total = home + away;
      const bttsMatch = (home > 0 && away > 0) === isYes;
      const overMatch = (total > line) === isOver;
      if (bttsMatch && overMatch) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 2: Team to Score? (e.g., "Talleres de Cordoba to Score? 1st Half")
  if (n.includes('to score?') && !n.includes('both teams') && !n.includes('btts')) {
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    const isYes = label.includes('yes');

    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      let hasScored = false;
      if (isHomeMarket && !isAwayMarket) hasScored = (home > 0);
      else if (isAwayMarket && !isHomeMarket) hasScored = (away > 0);
      
      if (hasScored === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 3: Both Teams to Score? (e.g., "Both Teams to Score? 1st Half")
  if (n.includes('both teams to score?') || n.includes('btts?')) {
    const isYes = label.includes('yes');
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const btts = (home > 0 && away > 0);
      if (btts === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 4: HT/FT (Half-Time/Full-Time)
  if (n.includes('half-time/full-time') || n.includes('ht/ft')) {
    if (!lambdaData.h1 || !lambdaData.h2) return null;
    const h1Grid = lambdaData.h1.grid;
    const h2Grid = lambdaData.h2.grid;

    // Parse selection: "Home - Draw", "Central Cordoba - Draw", etc.
    const parts = selectionLabel.split('-').map(p => p.trim());
    if (parts.length !== 2) return null;

    const getRes = (txt) => {
      const t = txt.trim().toLowerCase();
      const h = homeTeam.trim().toLowerCase();
      const a = awayTeam.trim().toLowerCase();
      if (t === 'draw' || t === 'x') return 0;
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };

    const htRes = getRes(parts[0]);
    const ftRes = getRes(parts[1]);
    if (htRes === null || ftRes === null) return null;

    let prob = 0;
    h1Grid.forEach(s1 => {
      const s1Res = s1.home > s1.away ? 1 : (s1.home === s1.away ? 0 : 2);
      if (s1Res !== htRes) return;
      
      h2Grid.forEach(s2 => {
        const fHome = s1.home + s2.home;
        const fAway = s1.away + s2.away;
        const fRes = fHome > fAway ? 1 : (fHome === fAway ? 0 : 2);
        if (fRes === ftRes) prob += s1.prob * s2.prob;
      });
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 3: Exact Goals (e.g., "Exact Total Goals", "Home Team Exact Goals", "Union de Santa Fe Goals")
  if (n.includes('goals')) {
    const goalCount = parseInt(label);
    if (!isNaN(goalCount) && !n.includes('over/under') && !n.includes('asian') && !label.includes('-')) {
      const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
      const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
      
      let prob = 0;
      const isPlus = label.includes('+');
      
      grid.forEach(({ home, away, prob: p }) => {
        let val = home + away; // Default to match total
        if (isHomeMarket && !isAwayMarket) val = home;
        else if (isAwayMarket && !isHomeMarket) val = away;
        
        if (isPlus) {
          if (val >= goalCount) prob += p;
        } else {
          if (val === goalCount) prob += p;
        }
      });
      return prob > 0 ? (1 / prob).toFixed(3) : null;
    }
  }

  // Case 4: Win to Nil (e.g., "Win to Nil", "To Win to Nil? 1st Half")
  if (n.includes('win to nil')) {
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    const isYes = label.includes('yes');

    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      let condition = false;
      if (isHomeMarket && !isAwayMarket) condition = (home > 0 && away === 0);
      else if (isAwayMarket && !isHomeMarket) condition = (away > 0 && home === 0);
      
      if (condition === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 5: Total Goals Range (e.g., "Total Goals Range", "Goals Range")
  if (n.includes('goals range') || n.includes('total goals range')) {
    let prob = 0;
    
    if (label.includes('+')) {
      const minVal = parseInt(label);
      grid.forEach(({ home, away, prob: p }) => {
        if ((home + away) >= minVal) prob += p;
      });
    } else if (label.includes('-')) {
      const parts = label.split('-').map(p => parseInt(p.trim()));
      if (parts.length === 2) {
        grid.forEach(({ home, away, prob: p }) => {
          const total = home + away;
          if (total >= parts[0] && total <= parts[1]) prob += p;
        });
      }
    }
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 6: Draw No Bet (e.g., "Draw No Bet", "Draw No Bet 1st Half")
  if (n.includes('draw no bet') || n.includes('dnb')) {
    let pH = 0, pA = 0;
    grid.forEach(({ home, away, prob: p }) => {
      if (home > away) pH += p;
      else if (away > home) pA += p;
    });

    const getRes = (txt) => {
      const t = txt.toLowerCase();
      const h = homeTeam.toLowerCase();
      const a = awayTeam.toLowerCase();
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const target = getRes(selectionLabel);
    return target === 1 ? (1 / (pH / (pH + pA))).toFixed(3) : (target === 2 ? (1 / (pA / (pH + pA))).toFixed(3) : null);
  }

  // Case 7: Double Chance (e.g., "Double Chance", "Double Chance 1st Half")
  if (n.includes('double chance')) {
    let pH = 0, pD = 0, pA = 0;
    grid.forEach(({ home, away, prob: p }) => {
      if (home > away) pH += p;
      else if (home === away) pD += p;
      else pA += p;
    });

    const labelLower = selectionLabel.toLowerCase();
    const isHome = labelLower.includes(homeTeam.toLowerCase()) || labelLower.includes('home');
    const isAway = labelLower.includes(awayTeam.toLowerCase()) || labelLower.includes('away');
    const isDraw = labelLower.includes('draw') || labelLower.includes('x');

    let prob = 0;
    // 1X
    if (isHome && isDraw && !isAway) prob = pH + pD;
    // X2
    else if (isAway && isDraw && !isHome) prob = pD + pA;
    // 12
    else if (isHome && isAway) prob = pH + pA;
    
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 8: Joint BTTS & Winner (e.g., "Both Teams to Score/Winner")
  if ((n.includes('both teams to score') || n.includes('btts')) && (n.includes('winner') || n.includes('result'))) {
    const isYes = label.includes('yes');
    
    // Determine winner result from label: "Yes & Union de Santa Fe"
    const parts = selectionLabel.split('&').map(p => p.trim());
    if (parts.length !== 2) return null;
    const winnerTxt = parts[1];
    
    const getWinnerRes = (txt) => {
      const t = txt.toLowerCase();
      const h = homeTeam.toLowerCase();
      const a = awayTeam.toLowerCase();
      if (t === 'draw' || t === 'x') return 0;
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const targetRes = getWinnerRes(winnerTxt);
    if (targetRes === null) return null;

    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const bttsMatch = (home > 0 && away > 0) === isYes;
      const res = home > away ? 1 : (home === away ? 0 : 2);
      if (bttsMatch && res === targetRes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 9: Either Team to Score? (Yes = any goal, No = 0-0)
  if (n.includes('either team to score')) {
    const isYes = label.includes('yes');
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const anyGoal = (home + away) > 0;
      if (anyGoal === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 10: Joint Winner & Total Goals (e.g., "Winner/Total Goals")
  if (n.includes('winner') && n.includes('total goals')) {
    // Parse selection: "Union de Santa Fe & Over 2.5"
    const parts = selectionLabel.split('&').map(p => p.trim());
    if (parts.length !== 2) return null;
    
    const winnerTxt = parts[0];
    const ouTxt = parts[1].toLowerCase();
    
    const getWinnerRes = (txt) => {
      const t = txt.toLowerCase();
      const h = homeTeam.toLowerCase();
      const a = awayTeam.toLowerCase();
      if (t === 'draw' || t === 'x') return 0;
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const targetRes = getWinnerRes(winnerTxt);
    if (targetRes === null) return null;
    
    const isOver = ouTxt.includes('over');
    const lineMatch = ouTxt.match(/[0-9.]+/);
    const line = lineMatch ? parseFloat(lineMatch[0]) : 2.5;

    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const res = home > away ? 1 : (home === away ? 0 : 2);
      const total = home + away;
      const winnerMatch = (res === targetRes);
      const ouMatch = isOver ? (total > line) : (total < line);
      if (winnerMatch && ouMatch) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  // Case 11: Joint Odd/Even & Total Goals (e.g., "Odd/Even & Total Goals")
  if ((n.includes('odd/even') || n.includes('odd & even')) && n.includes('total goals') && (label.includes('over') || label.includes('under'))) {
    const isOdd = label.includes('odd');
    const isOver = label.includes('over');
    const lineMatch = label.match(/(over|under)\s+([0-9.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[2]) : 2.5;
    
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const total = home + away;
      const isTotalOdd = (total % 2 !== 0);
      const isTotalOver = (total > line);
      if (isTotalOdd === isOdd && isTotalOver === isOver) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }
  
  // Case 12: Simple Odd/Even (Match, Home, or Away)
  if (n.includes('odd/even') || n.includes('odd & even')) {
    const isOdd = label.includes('odd');
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));

    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      let val = home + away;
      if (isHomeMarket && !isAwayMarket) val = home;
      else if (isAwayMarket && !isHomeMarket) val = away;
      
      if ((val % 2 !== 0) === isOdd) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  return null;
}

function renderMarketTable(market) {
  const wrapper = document.createElement('div');
  wrapper.className = 'comparison-table-wrapper';
  
  const table = document.createElement('table');
  table.className = 'comparison-table';
  
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>${market.name}</th>
      <th style="text-align: right;">Shin (Fair)</th>
      <th style="text-align: right;">Model (Fair)</th>
      <th style="text-align: right;">Pinnacle (API)</th>
      <th style="text-align: right;">Bet365</th>
      <th style="text-align: right;">Dafabet</th>
      <th style="text-align: right; width: 100px;">Override</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  market.rows.forEach(row => {
    const tr = document.createElement('tr');

    const fmtPrice = v => {
      const n = parseFloat(v);
      return (!isNaN(n) && n > 1) ? n.toFixed(2) : '-';
    };

    const shinVal   = fmtPrice(row.shinFair);
    const modelVal  = fmtPrice(row.modelFair);
    const pinVal    = fmtPrice(row.value);

    const overrideKey = `${state.drawerEventId}|${market.id}|${row.label}`;
    const currentOverride = getOverride(overrideKey);
    const ovValue = currentOverride ? parseFloat(currentOverride).toFixed(2) : '';

    // Colour-code model vs shin disagreement
    const getEdgeClass = (model, shin) => {
      const nm = parseFloat(model), ns = parseFloat(shin);
      if (isNaN(nm) || isNaN(ns)) return '';
      const diff = nm - ns;
      // Model odds lower = Model thinks it's MORE likely = GREEN (Value signal)
      if (diff < -0.05) return 'price-higher'; // Using existing green class
      // Model odds higher = Model thinks it's LESS likely = RED
      if (diff > 0.05) return 'price-lower'; // Using existing red class
      return '';
    };

    const tdLabel = document.createElement('td');
    tdLabel.textContent = row.label;

    const tdShin = document.createElement('td');
    tdShin.className = shinVal !== '-' ? 'price-cell' : 'empty-cell';
    tdShin.textContent = shinVal;

    const tdModel = document.createElement('td');
    tdModel.className = `${modelVal !== '-' ? 'price-cell' : 'empty-cell'} ${getEdgeClass(modelVal, shinVal)}`;
    tdModel.textContent = modelVal;

    const tdPin = document.createElement('td');
    tdPin.className = pinVal !== '-' ? 'price-cell' : 'empty-cell';
    tdPin.textContent = pinVal;

    const tdBet365 = document.createElement('td');
    tdBet365.className = 'empty-cell';
    tdBet365.textContent = '-';

    const tdDafabet = document.createElement('td');
    tdDafabet.className = 'empty-cell';
    tdDafabet.textContent = '-';

    const tdOverride = document.createElement('td');
    tdOverride.className = 'override-input-cell';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'table-override-input';
    input.step = '0.01';
    input.min = '1.01';
    input.value = ovValue;
    input.placeholder = '-';
    
    const confirm = () => {
      const val = parseFloat(input.value);
      if (val > 1) {
        setOverride(overrideKey, val);
        setTradingMode(state.drawerEventId, 'manual');
        updateModeButton(state.drawerEventId);
        const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
        if (ev) renderDrawerMarkets(ev);
      }
    };
    
    input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
    input.addEventListener('blur', confirm);
    tdOverride.appendChild(input);

    tr.appendChild(tdLabel);
    tr.appendChild(tdShin);
    tr.appendChild(tdModel);
    tr.appendChild(tdPin);
    tr.appendChild(tdBet365);
    tr.appendChild(tdDafabet);
    tr.appendChild(tdOverride);
    
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  const tfoot = document.createElement('tfoot');
  const tfootTr = document.createElement('tr');
  tfootTr.className = 'margin-row';
  
  const getMarginHTML = (prop) => {
    let sum = 0, count = 0;
    market.rows.forEach(r => {
      let val = null;
      if (prop === 'override') {
        const overrideKey = `${state.drawerEventId}|${market.id}|${r.label}`;
        val = parseFloat(getOverride(overrideKey));
      } else {
        val = parseFloat(r[prop]);
      }
      if (!isNaN(val) && val > 1) { sum += 1 / val; count++; }
    });
    
    if (count === 0) return '<span class="empty-cell">-</span>';

    let expectedPairs = 1;
    if (market.id === 'hdp' || market.id === 'ou' || market.name.includes('Handicap') || market.name.includes('Total') || market.name.includes('Corners') || market.name.includes('Odd/Even') || market.name.includes('Bookings')) {
      if (count % 2 === 0) expectedPairs = count / 2;
    }
    if (market.name.includes('Double Chance')) expectedPairs = 2;
    
    return marginBadgeHTML(sum / expectedPairs);
  };

  tfootTr.innerHTML = `
    <td><span class="margin-label">Margin (Avg)</span></td>
    <td style="text-align: right;">${getMarginHTML('shinFair')}</td>
    <td style="text-align: right;">${getMarginHTML('modelFair')}</td>
    <td style="text-align: right;">${getMarginHTML('value')}</td>
    <td style="text-align: right;"><span class="empty-cell">-</span></td>
    <td style="text-align: right;"><span class="empty-cell">-</span></td>
    <td style="text-align: right; padding-right: 12px;">${getMarginHTML('override')}</td>
  `;
  tfoot.appendChild(tfootTr);
  table.appendChild(tfoot);

  wrapper.appendChild(table);
  return wrapper;
}

export function renderDrawerMarkets(event) {
  const drawerContent = document.getElementById('drawer-content');
  drawerContent.innerHTML = '';

  let matchPeriod, h1Period;
  if (event.periods && !Array.isArray(event.periods)) {
    matchPeriod = event.periods['0'];
    h1Period = event.periods['1'];
  } else {
    const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
    matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    h1Period = arr.find(p => p.num === 1 || p.periodNumber === 1);
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

  const isManual = getTradingMode(event.id) === 'manual';
  const effectivePeriod = isManual
    ? getEffectiveMatchPeriod(matchPeriod, event.id, homeTeam, awayTeam)
    : matchPeriod;
  const lambdaData = calculateTeamLambdas(effectivePeriod, h1Period);
  
  // --- Dixon-Coles section ---
  if (lambdaData) {
    drawerContent.appendChild(createLambdaSection(lambdaData, homeTeam, awayTeam));
  }

  const detailedAll = state.detailedOdds[event.id] || {};
  const groupedMarkets = groupMarketsByCategory(event, matchPeriod, h1Period, lambdaData, detailedAll, homeTeam, awayTeam);
  
  const categories = Object.keys(groupedMarkets);
  if (categories.length === 0) return;
  
  if (!state.activeCategory || !groupedMarkets[state.activeCategory]) {
    state.activeCategory = categories[0];
  }

  const topNav = document.createElement('div');
  topNav.className = 'drawer-nav-top';
  
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `top-tab-btn ${state.activeCategory === cat ? 'active' : ''}`;
    btn.textContent = cat;
    btn.onclick = () => {
      state.activeCategory = cat;
      state.activeMarketId = null;
      renderDrawerMarkets(event);
    };
    topNav.appendChild(btn);
  });
  drawerContent.appendChild(topNav);

  const bodyLayout = document.createElement('div');
  bodyLayout.className = 'drawer-body-layout';

  const leftNav = document.createElement('div');
  leftNav.className = 'drawer-nav-left';
  const activeGroup = groupedMarkets[state.activeCategory] || [];
  
  if (activeGroup.length > 0 && !activeGroup.find(m => m.id === state.activeMarketId)) {
    state.activeMarketId = activeGroup[0].id;
  }

  activeGroup.forEach(market => {
    const btn = document.createElement('button');
    btn.className = `left-tab-btn ${state.activeMarketId === market.id ? 'active' : ''}`;
    btn.textContent = market.name;
    btn.onclick = () => {
      state.activeMarketId = market.id;
      renderDrawerMarkets(event);
    };
    leftNav.appendChild(btn);
  });
  bodyLayout.appendChild(leftNav);

  const mainContent = document.createElement('div');
  mainContent.className = 'drawer-main-content';
  const activeMarket = activeGroup.find(m => m.id === state.activeMarketId);
  
  if (activeMarket) {
    mainContent.appendChild(renderMarketTable(activeMarket));
  } else {
    mainContent.innerHTML = '<div class="empty-state">Select a market</div>';
  }
  bodyLayout.appendChild(mainContent);
  drawerContent.appendChild(bodyLayout);
}

// Apply a target book % margin to all selections in a market.
// Uses current effective prices (overrides if set), normalises fair probs,
// then scales to the target margin and saves each new price as an override.
function applyTargetMargin(eventId, marketId, rows, targetMarginPct) {
  const M = targetMarginPct / 100;

  const effectivePrice = (row) => {
    const k = `${eventId}|${marketId}|${row.label}`;
    return parseFloat(getOverride(k) || row.value);
  };

  const applyToGroup = (group) => {
    const valid = group.filter(r => { const p = effectivePrice(r); return !isNaN(p) && p > 1; });
    if (valid.length < 2) return;
    const impProbs  = valid.map(r => 1 / effectivePrice(r));
    const total     = impProbs.reduce((a, b) => a + b, 0);
    const fairProbs = impProbs.map(q => q / total);  // normalise → sum = 1
    valid.forEach((row, i) => {
      const newPrice = 1 / (fairProbs[i] * M);
      if (newPrice > 1) setOverride(`${eventId}|${marketId}|${row.label}`, newPrice);
    });
  };

  // For paired markets (OU, HDP: row pairs of 2), apply per-pair
  if (rows.length > 3) {
    for (let i = 0; i < rows.length; i += 2) applyToGroup(rows.slice(i, i + 2));
  } else {
    applyToGroup(rows); // 1X2: apply to all 3 together
  }
}

// Proportionally redistribute implied probability to all other selections
// to keep total margin constant after one price is manually set.
function repriceOthers(changedKey, newPrice, rows, marketId) {
  const changedLabel = changedKey.split('|')[2];

  // Effective price for each row (override if set, else original API)
  const effectivePrice = (row) => {
    const k = `${state.drawerEventId}|${marketId}|${row.label}`;
    return parseFloat(getOverride(k) || row.value);
  };

  const valid = rows.filter(r => { const p = effectivePrice(r); return !isNaN(p) && p > 1; });
  if (valid.length < 2) return;

  const M        = valid.reduce((s, r) => s + 1 / effectivePrice(r), 0); // current total margin
  const q_new    = 1 / newPrice;                                          // new implied prob for changed selection
  const budget   = M - q_new;                                             // remaining for others
  const others   = valid.filter(r => r.label !== changedLabel);
  const otherSum = others.reduce((s, r) => s + 1 / effectivePrice(r), 0);

  if (budget <= 0 || otherSum <= 0) return;

  const scale = budget / otherSum;
  others.forEach(r => {
    const qNew = (1 / effectivePrice(r)) * scale;
    if (qNew > 0 && 1 / qNew > 1) {
      setOverride(`${state.drawerEventId}|${marketId}|${r.label}`, 1 / qNew);
    }
  });
}

function makeEditable(chip, priceSpan, key, currentVal, rows = [], marketId = '') {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.01';
  input.min = '1.01';
  input.value = currentVal;
  input.className = 'price-edit-input';
  priceSpan.replaceWith(input);
  input.focus();
  input.select();

  const confirm = () => {
    const val = parseFloat(input.value);
    if (val > 1) {
      setOverride(key, val);
      if (rows.length > 1 && marketId) repriceOthers(key, val, rows, marketId);
      // Auto-switch to MANUAL mode and update button
      setTradingMode(state.drawerEventId, 'manual');
      updateModeButton(state.drawerEventId);
      const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
      if (ev) renderDrawerMarkets(ev);
    } else {
      input.replaceWith(priceSpan);
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') input.replaceWith(priceSpan);
  });
  input.addEventListener('blur', confirm);
}

export function createMarketGroup(title, rows, extraClass = '', hasShowAll = false, margin = null, marketId = '') {
  const group = document.createElement('div');
  const mktSuspended = marketId ? isSuspended(state.drawerEventId, marketId) : false;
  const evtSuspended = state.drawerEventId ? isSuspended(state.drawerEventId, 'event') : false;
  const suspended    = mktSuspended || evtSuspended;
  group.className = `market-group${suspended ? ' market-suspended' : ''}`;
  group.innerHTML = `
    <div class="market-header">
      <h3>${title}</h3>
      <div class="market-header-actions">
        ${marginBadgeHTML(margin)}
        ${hasShowAll ? '<button class="show-all-btn">Show All</button>' : ''}
        ${marketId ? `<button class="suspend-market-btn ${suspended ? 'suspended' : 'open'}" title="${suspended ? 'Market suspended — click to publish' : 'Suspend this market'}">${suspended ? '🔒 SUSPENDED' : '🔓 PUBLISHED'}</button>` : ''}
        <span style="font-size:0.8rem">▼</span>
      </div>
    </div>
    <div class="market-grid ${extraClass}"></div>
  `;

  // Attach suspend toggle listener
  const suspendBtn = group.querySelector('.suspend-market-btn');
  if (suspendBtn && marketId) {
    suspendBtn.addEventListener('click', e => {
      e.stopPropagation();
      const nowSusp = isSuspended(state.drawerEventId, marketId);
      setSuspension(state.drawerEventId, marketId, nowSusp ? 'open' : 'suspended');
      // Update board cell immediately
      const row = document.querySelector(`tr[data-event-id="${state.drawerEventId}"]`);
      if (row) {
        const isMLmarket = ['ml'].includes(marketId);
        const isOUmarket = ['ou'].includes(marketId);
        row.querySelectorAll('td').forEach((td, i) => {
          if ((isMLmarket && i >= 1 && i <= 3) || (isOUmarket && i >= 4)) {
            td.classList.toggle('susp-cell', !nowSusp);
            const btn = td.querySelector('button');
            if (btn) btn.textContent = nowSusp ? (btn.dataset.orig || btn.textContent) : 'SUSP';
          }
        });
      }
      suspendBtn.innerHTML = !nowSusp ? '🔒 SUSPENDED' : '🔓 PUBLISHED';
      suspendBtn.className = `suspend-market-btn ${!nowSusp ? 'suspended' : 'open'}`;
      suspendBtn.title = !nowSusp ? 'Market suspended — click to publish' : 'Suspend this market';
      const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
      if (ev) renderDrawerMarkets(ev);
    });
  }

  const grid = group.querySelector('.market-grid');

  // ── Margin editor input ──────────────────────────────────
  // Show only on API markets (marketId set) and not when event is fully suspended
  if (marketId && !evtSuspended) {
    const actionsDiv  = group.querySelector('.market-header-actions');
    const marginInput = document.createElement('input');
    marginInput.type        = 'number';
    marginInput.className   = 'margin-target-input';
    marginInput.min         = '100';
    marginInput.max         = '120';
    marginInput.step        = '0.1';
    const curM = calcMargin(rows);
    marginInput.placeholder = curM ? `${(curM * 100).toFixed(1)}%` : '105.0%';
    marginInput.title       = 'Type target margin % and press Enter';

    const confirmMargin = () => {
      const val = parseFloat(marginInput.value);
      if (!isNaN(val) && val >= 100 && val <= 120) {
        applyTargetMargin(state.drawerEventId, marketId, rows, val);
        setTradingMode(state.drawerEventId, 'manual');
        updateModeButton(state.drawerEventId);
        const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
        if (ev) renderDrawerMarkets(ev);
      } else {
        marginInput.value = '';
      }
    };

    marginInput.addEventListener('click',   e => e.stopPropagation());
    marginInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); confirmMargin(); }
      if (e.key === 'Escape') { marginInput.value = ''; marginInput.blur(); }
    });
    marginInput.addEventListener('blur', () => { if (marginInput.value) confirmMargin(); });

    // Insert before the suspend toggle
    const suspBtn = actionsDiv.querySelector('.suspend-market-btn');
    if (suspBtn) actionsDiv.insertBefore(marginInput, suspBtn);
    else         actionsDiv.appendChild(marginInput);
  }

  rows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'market-row';

    const overrideKey = marketId ? `${state.drawerEventId}|${marketId}|${row.label}` : null;
    const overrideVal  = overrideKey ? getOverride(overrideKey) : null;
    const isOverridden = !!overrideVal;
    const displayPrice = overrideVal || row.value;

    const probBadge = row.prob != null
      ? `<span class="prob-badge">${(row.prob * 100).toFixed(1)}%</span>` : '';

    const labelEl = document.createElement('span');
    labelEl.className = 'market-label';
    labelEl.innerHTML = `${row.label}${probBadge}`;

    const oddsComp   = document.createElement('div');
    oddsComp.className = 'odds-comparison';

    // Main price chip (API or Override)
    const bookieChip = document.createElement('div');
    bookieChip.className = `price-chip bookie${isOverridden ? ' overridden' : ''}${overrideKey ? ' editable' : ''}`;
    bookieChip.title = overrideKey ? (isOverridden ? 'Click price to edit override' : 'Click to override price') : '';

    const chipLabel = document.createElement('span');
    chipLabel.className = 'chip-label';
    chipLabel.textContent = isOverridden ? 'M' : (row.fair || row.isApiOnly ? 'API' : 'Fair');

    const priceSpan = document.createElement('span');
    priceSpan.className = 'market-value';
    priceSpan.textContent = displayPrice;

    bookieChip.appendChild(chipLabel);
    bookieChip.appendChild(priceSpan);

    if (overrideKey) {
      if (isOverridden) {
        // Clear button
        const clearBtn = document.createElement('span');
        clearBtn.className = 'clear-override-btn';
        clearBtn.textContent = '×';
        clearBtn.title = 'Clear override';
        clearBtn.addEventListener('click', e => {
          e.stopPropagation();
          clearOverride(overrideKey);
          const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
          if (ev) renderDrawerMarkets(ev);
        });
        bookieChip.appendChild(clearBtn);
        // Click price to re-edit
        priceSpan.style.cursor = 'pointer';
        priceSpan.addEventListener('click', () => makeEditable(bookieChip, priceSpan, overrideKey, displayPrice, rows, marketId));
      } else {
        // Click anywhere on chip to open editor
        bookieChip.style.cursor = 'pointer';
        bookieChip.addEventListener('click', () => makeEditable(bookieChip, priceSpan, overrideKey, displayPrice, rows, marketId));
      }
    }

    oddsComp.appendChild(bookieChip);

    if (row.fair && row.fair !== '-') {
      const fairChip = document.createElement('div');
      fairChip.className = 'price-chip fair';
      fairChip.innerHTML = `<span class="chip-label">Fair</span><span class="fair-value">${row.fair}</span>`;
      oddsComp.appendChild(fairChip);
    }

    item.appendChild(labelEl);
    item.appendChild(oddsComp);
    grid.appendChild(item);
  });

  return group;
}

export function createLambdaSection(lambdaData, homeTeam, awayTeam) {
  const section = document.createElement('div');
  section.className = 'lambda-section';
  const data = lambdaData.ft;
  const topScores = [...data.grid].sort((a, b) => b.prob - a.prob).slice(0, 6);
  const scoresHtml = topScores.map(s =>
    `<div class="score-chip"><div class="score">${s.home}–${s.away}</div><div class="prob">${(s.prob * 100).toFixed(1)}%</div></div>`
  ).join('');
  const tPct = (lambdaData.splitFraction * 100).toFixed(1);
  section.innerHTML = `
    <h3 class="lambda-title">Dixon-Coles Model</h3>
    <div class="lambda-cards">
      <div class="lambda-card">
        <div class="team-name">${homeTeam}</div>
        <div class="lambda-value">${data.lh.toFixed(2)}</div>
        <div class="lambda-label">λ Expected Goals</div>
      </div>
      <div class="lambda-card">
        <div class="team-name">${awayTeam}</div>
        <div class="lambda-value">${data.la.toFixed(2)}</div>
        <div class="lambda-label">λ Expected Goals</div>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
      <div class="likely-scores-label" style="margin-bottom:0">Most Likely Scores</div>
      <div style="font-size:0.7rem;color:#64748b;text-align:right">
        <div>ρ = ${data.rho.toFixed(3)}</div>
        <div>H1 Split: ${tPct}%</div>
      </div>
    </div>
    <div class="likely-scores">${scoresHtml}</div>
  `;
  return section;
}
