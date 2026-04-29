import { state, toggleFavorite, snapshotOdds, getOverride, setOverride, clearOverride, clearAllOverridesForEvent, getTradingMode, setTradingMode } from './state.js';
import { fetchOdds } from './api.js';
import { calculateTeamLambdas, calculateShinNoVig } from './math.js';
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

// Update the trading-mode toggle button in the drawer header
function updateModeButton(eventId) {
  const btn = document.getElementById('trading-mode-btn');
  if (!btn) return;
  const isManual = getTradingMode(eventId) === 'manual';
  btn.textContent = isManual ? '⚡ MANUAL' : '● AUTO';
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

  filtered.forEach(league => {
    const name  = league.name || league.leagueName || 'Unknown League';
    const code  = league.code || league.leagueCode || league.id;
    const isFav = state.favorites.includes(code);

    if (isFav) favoritesContainer.appendChild(createLeagueElement(name, code, isFav));
    leaguesContainer.appendChild(createLeagueElement(name, code, isFav));
  });
}

export function createLeagueElement(name, code, isFav) {
  const el = document.createElement('div');
  el.className = 'league-item';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:0.5rem;flex:1;overflow:hidden;">
      <span class="favorite-star ${isFav ? 'active' : ''}" data-code="${code}">★</span>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</span>
    </div>
    <span style="font-size:0.8em;color:var(--text-secondary)">›</span>
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

    // Price-move detection
    const prev = state.previousOdds[event.id] || {};
    const trend = (val, prevVal) => {
      if (!prevVal || val === '-') return '';
      const diff = parseFloat(val) - prevVal;
      if (Math.abs(diff) < 0.001) return '';
      return diff > 0 ? ' price-up' : ' price-down';
    };
    const t1 = trend(odds1, prev.home);
    const tX = trend(oddsX, prev.draw);
    const t2 = trend(odds2, prev.away);

    html += `<tr data-event-id="${event.id}">
      <td>
        <div class="match-time">${time}</div>
        <div class="match-teams">${homeTeam} vs ${awayTeam}</div>
      </td>
      <td><button class="odds-btn${t1}">${odds1}${t1 === ' price-up' ? ' ▲' : t1 === ' price-down' ? ' ▼' : ''}</button></td>
      <td><button class="odds-btn${tX}">${oddsX}${tX === ' price-up' ? ' ▲' : tX === ' price-down' ? ' ▼' : ''}</button></td>
      <td><button class="odds-btn${t2}">${odds2}${t2 === ' price-up' ? ' ▲' : t2 === ' price-down' ? ' ▼' : ''}</button></td>
      <td><button class="odds-btn" style="border-color:var(--accent-color)">${oddsOver}</button></td>
      <td><button class="odds-btn" style="border-color:var(--accent-color)">${oddsUnder}</button></td>
    </tr>`;
  });

  html += `</tbody></table>`;
  oddsContainer.innerHTML = html;

  oddsContainer.querySelectorAll('tr[data-event-id]').forEach(tr => {
    tr.addEventListener('click', () => openDrawer(tr.getAttribute('data-event-id')));
  });
}

export function openDrawer(eventId) {
  const event = state.activeEvents.find(e => e.id.toString() === eventId.toString());
  if (!event) return;
  state.drawerEventId = eventId; // needed by override key generation
  updateModeButton(eventId);

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

  renderDrawerMarkets(event);
  document.getElementById('side-drawer').classList.add('active');
  document.getElementById('drawer-overlay').classList.add('active');
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
    const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
    matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
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

  // In MANUAL mode, re-solve lambdas from overridden prices so derived markets reflect the override
  const isManual = getTradingMode(event.id) === 'manual';
  const effectivePeriod = isManual
    ? getEffectiveMatchPeriod(matchPeriod, event.id, homeTeam, awayTeam)
    : matchPeriod;
  const lambdaData = calculateTeamLambdas(effectivePeriod);

  // --- Dixon-Coles section ---
  if (lambdaData) {
    drawerContent.appendChild(createLambdaSection(lambdaData, homeTeam, awayTeam));
  }

  // --- Raw API markets ---
  if (matchPeriod.moneyLine || matchPeriod.moneyline) {
    const ml   = matchPeriod.moneyLine || matchPeriod.moneyline;
    const odds = [ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away];
    const fair = calculateShinNoVig(odds);
    const mlRows = [
      { label: homeTeam, value: odds[0] || '-', fair: fair[0] },
      { label: 'Draw',   value: odds[1] || '-', fair: fair[1] },
      { label: awayTeam, value: odds[2] || '-', fair: fair[2] },
    ];
    drawerContent.appendChild(createMarketGroup('Money Line – Match', mlRows, 'three-cols', true, calcMargin(mlRows), 'ml'));
  }

  if (matchPeriod.handicap && Array.isArray(matchPeriod.handicap)) {
    const fmt = s => (s === 0 || s === '0') ? '0' : (parseFloat(s) > 0 ? `+${s}` : `${s}`);
    const rows = [];
    matchPeriod.handicap.forEach(h => {
      const fair = calculateShinNoVig([h.homeOdds, h.awayOdds]);
      rows.push({ label: fmt(h.homeSpread), value: h.homeOdds, fair: fair[0] });
      rows.push({ label: fmt(h.awaySpread), value: h.awayOdds, fair: fair[1] });
    });
    // Show margin for the first handicap line only
    const firstPair = rows.slice(0, 2);
    drawerContent.appendChild(createMarketGroup('Handicap – Match', rows, '', false, calcMargin(firstPair), 'hdp'));
  }

  if (matchPeriod.overUnder && Array.isArray(matchPeriod.overUnder)) {
    const rows = [];
    [...matchPeriod.overUnder]
      .sort((a, b) => parseFloat(a.points) - parseFloat(b.points))
      .forEach(ou => {
        const fair = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  fair: fair[0] });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, fair: fair[1] });
      });
    // Margin from the first O/U line (2.5)
    const firstPair = rows.slice(0, 2);
    drawerContent.appendChild(createMarketGroup('Total – Match', rows, '', false, calcMargin(firstPair), 'ou'));
  }

  // --- Derived markets from model ---
  if (lambdaData) {
    const derived = buildAllMarkets(lambdaData);
    if (derived.length) {
      const divider = document.createElement('div');
      divider.className = 'market-divider';
      divider.innerHTML = '<span>⚙️ Model-Derived Markets</span>';
      drawerContent.appendChild(divider);

      derived.forEach(market => {
        const rows = market.selections.map(s => ({
          label: s.label,
          value: s.price,
          fair: null,
          prob: s.prob,
        }));
        drawerContent.appendChild(createMarketGroup(market.name, rows, market.cols, false, null, market.id));
      });
    }
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
  group.className = 'market-group';
  group.innerHTML = `
    <div class="market-header">
      <h3>${title}</h3>
      <div class="market-header-actions">
        ${marginBadgeHTML(margin)}
        ${hasShowAll ? '<button class="show-all-btn">Show All</button>' : ''}
        <span style="font-size:0.8rem">▼</span>
      </div>
    </div>
    <div class="market-grid ${extraClass}"></div>
  `;

  const grid = group.querySelector('.market-grid');
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
    chipLabel.textContent = isOverridden ? 'M' : (row.fair ? 'API' : 'Fair');

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

export function createLambdaSection(data, homeTeam, awayTeam) {
  const section = document.createElement('div');
  section.className = 'lambda-section';
  const scoresHtml = data.scores.map(s =>
    `<div class="score-chip"><div class="score">${s.home}–${s.away}</div><div class="prob">${(s.prob * 100).toFixed(1)}%</div></div>`
  ).join('');
  section.innerHTML = `
    <h3 class="lambda-title">⚽ Dixon-Coles Model</h3>
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
      <div style="font-size:0.7rem;color:#64748b">ρ = ${data.rho.toFixed(3)}</div>
    </div>
    <div class="likely-scores">${scoresHtml}</div>
  `;
  return section;
}
