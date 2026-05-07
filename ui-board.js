import { state, snapshotOdds, getOverride, getAllOverrideMeta, getTradingMode, isSuspended, hasAnySuspension, clearOverride, clearOverrideMetaSelection, hasAnyOverrideForEvent, setTradingMode, clearOverriddenLambdas } from './state.js';
import { fetchOdds } from './api.js';
import { evaluateOverrides, resolveTemplate, getMarketConfig, resolveActiveKey } from './pricing.js';
import { openDrawer, updateModeButton, renderDrawerMarkets } from './ui-drawer.js';
import { getTeamNames } from './utils.js';
import { calculateShinNoVig, applyMarginAndLadder } from './math.js';

// ── Override expiry processing ────────────────────────────────────────────────

function processOverrideExpiries(expiries) {
  if (!expiries.length) return;
  const affectedEvents = new Set();
  expiries.forEach(({ eventId, marketId, label }) => {
    clearOverride(`${eventId}|${marketId}|${label}`);
    clearOverrideMetaSelection(eventId, marketId, label);
    if (!hasAnyOverrideForEvent(eventId)) {
      setTradingMode(eventId, 'auto');
      clearOverriddenLambdas(eventId);
      affectedEvents.add(eventId);
    }
  });
  affectedEvents.forEach(eventId => {
    const boardRow = document.querySelector(`tr[data-event-id="${eventId}"]`);
    if (boardRow) {
      boardRow.classList.remove('manual-row');
      boardRow.querySelector('.manual-row-badge')?.remove();
    }
    if (state.drawerEventId?.toString() === eventId) {
      updateModeButton(eventId);
      const ev = state.activeEvents.find(e => e.id.toString() === eventId);
      if (ev) renderDrawerMarkets(ev);
    }
  });
}

// ── Odds loading ──────────────────────────────────────────────────────────────

export async function loadOdds(leagueCode, silent = false) {
  const oddsContainer = document.getElementById('odds-container');
  if (!silent) {
    oddsContainer.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading odds...</p></div>`;
  }
  try {
    state.previousOdds = snapshotOdds();
    const data = await fetchOdds(leagueCode);
    renderOdds(data);
    processOverrideExpiries(evaluateOverrides(state.activeEvents));
    if (state.drawerEventId) {
      const freshEv = state.activeEvents.find(e => e.id.toString() === state.drawerEventId.toString());
      if (freshEv) renderDrawerMarkets(freshEv);
    }
  } catch (error) {
    console.error('Error fetching odds', error);
    if (!silent) {
      oddsContainer.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load odds.</div>`;
    }
  }
}

// ── Event table rendering ─────────────────────────────────────────────────────

function eventMatchesSearch(event, term) {
  const home = (event.home || event.homeTeam?.name || '').toLowerCase();
  const away = (event.away || event.awayTeam?.name || '').toLowerCase();
  if (home.includes(term) || away.includes(term)) return true;
  if (event.participants) {
    return event.participants.some(p => (p.name || p.englishName || '').toLowerCase().includes(term));
  }
  return false;
}

function renderEventTable(eventsToRender) {
  const oddsContainer = document.getElementById('odds-container');

  if (!eventsToRender.length) {
    const matchTerm = (document.getElementById('league-search')?.value || '').trim();
    oddsContainer.innerHTML = matchTerm
      ? `<div class="empty-state">No matches found for "<strong>${matchTerm}</strong>".</div>`
      : `<div class="empty-state">No odds available for this league.</div>`;
    return;
  }

  let html = `<table class="market-table">
    <thead><tr>
      <th style="width:30%">Match</th>
      <th>1</th><th>X</th><th>2</th>
      <th>Over 2.5</th><th>Under 2.5</th>
    </tr></thead><tbody>`;

  eventsToRender.forEach(event => {
    const { home: homeTeam, away: awayTeam } = getTeamNames(event);

    const eventTime = event.starts || event.startTime || event.time;
    const time = eventTime
      ? new Date(eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'N/A';

    let matchPeriod;
    if (event.periods && !Array.isArray(event.periods)) {
      matchPeriod = event.periods['0'];
    } else if (event.periodOdds && !Array.isArray(event.periodOdds)) {
      matchPeriod = event.periodOdds['0'];
    } else {
      const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
      matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    }

    // Raw Pinnacle values — used for trend arrows regardless of display mode
    let raw1 = '-', rawX = '-', raw2 = '-';
    if (matchPeriod && (matchPeriod.moneyLine || matchPeriod.moneyline)) {
      const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
      raw1 = ml.homePrice || ml.home || '-';
      rawX = ml.drawPrice || ml.draw || '-';
      raw2 = ml.awayPrice || ml.away || '-';
    }
    let odds1 = raw1, oddsX = rawX, odds2 = raw2;

    let oddsOver = '-', oddsUnder = '-';
    if (matchPeriod?.overUnder) {
      const ou25 = matchPeriod.overUnder.find(ou => ou.points === '2.5' || ou.points === 2.5);
      if (ou25) { oddsOver = ou25.overOdds || ou25.over || '-'; oddsUnder = ou25.underOdds || ou25.under || '-'; }
    }

    const isManual = getTradingMode(event.id) === 'manual';

    // Compute offered prices (AUTO mode, template assigned) — margin + ladder applied
    if (!isManual && matchPeriod) {
      const { template: offerTpl } = resolveTemplate(event.id, state.currentLeagueCode);
      if (offerTpl) {
        const eventStart = event.starts || event.startTime || event.time;
        const mlConf = getMarketConfig(offerTpl, '1x2');
        if (mlConf?.enabled && (matchPeriod.moneyLine || matchPeriod.moneyline)) {
          const ml   = matchPeriod.moneyLine || matchPeriod.moneyline;
          const shin = calculateShinNoVig([ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away]);
          let margin = mlConf.margin;
          const tl = eventStart ? resolveActiveKey(mlConf, eventStart) : null;
          if (tl?.key != null) margin = tl.key;
          const ladder = mlConf.ladder || 'eu';
          const o1 = applyMarginAndLadder(parseFloat(shin[0]), margin, ladder);
          const oX = applyMarginAndLadder(parseFloat(shin[1]), margin, ladder);
          const o2 = applyMarginAndLadder(parseFloat(shin[2]), margin, ladder);
          if (o1 > 1) odds1 = o1.toFixed(2);
          if (oX > 1) oddsX = oX.toFixed(2);
          if (o2 > 1) odds2 = o2.toFixed(2);
        }
        const ouConf = getMarketConfig(offerTpl, 'ou25');
        if (ouConf?.enabled && Array.isArray(matchPeriod.overUnder)) {
          const ou25 = matchPeriod.overUnder.find(ou => parseFloat(ou.points) === 2.5);
          if (ou25) {
            const shin = calculateShinNoVig([ou25.overOdds, ou25.underOdds]);
            let margin = ouConf.margin;
            const tl = eventStart ? resolveActiveKey(ouConf, eventStart) : null;
            if (tl?.key != null) margin = tl.key;
            const ladder = ouConf.ladder || 'eu';
            const oOver = applyMarginAndLadder(parseFloat(shin[0]), margin, ladder);
            const oUnd  = applyMarginAndLadder(parseFloat(shin[1]), margin, ladder);
            if (oOver > 1) oddsOver  = oOver.toFixed(2);
            if (oUnd  > 1) oddsUnder = oUnd.toFixed(2);
          }
        }
      }
    }

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

    const evtSuspended = isSuspended(event.id, 'event');
    const mlSuspended  = isSuspended(event.id, 'ml');
    const ouSuspended  = isSuspended(event.id, 'ou');
    const anySusp = evtSuspended || mlSuspended || ouSuspended || hasAnySuspension(event.id);

    // Trend arrows compare raw Pinnacle prices to detect feed movement
    const prev = state.previousOdds[event.id] || {};
    const trend = (rawVal, prevVal, isManualCell) => {
      if (isManualCell || !prevVal || rawVal === '-') return '';
      const diff = parseFloat(rawVal) - prevVal;
      if (Math.abs(diff) < 0.001) return '';
      return diff > 0 ? ' price-up' : ' price-down';
    };
    const t1 = trend(raw1, prev.home, m1);
    const tX = trend(rawX, prev.draw, mX);
    const t2 = trend(raw2, prev.away, m2);

    const allMeta = getAllOverrideMeta();
    const hasValueBet = isManual && Object.keys(allMeta).some(
      k => k.startsWith(`${event.id}|`) && allMeta[k]?.alertState === 'VALUE_BET'
    );
    const manualBadge = isManual
      ? `<span class="manual-row-badge${hasValueBet ? ' value-bet-badge' : ''}">${hasValueBet ? 'M⚠' : 'M'}</span>`
      : '';
    const suspBadge = anySusp && !evtSuspended ? '<span class="susp-badge">SUSP</span>' : '';
    const rowClass  = [isManual ? 'manual-row' : '', evtSuspended ? 'event-suspended' : ''].filter(Boolean).join(' ');

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

export function renderOdds(data) {
  let events = [];
  if (data.leagues && Array.isArray(data.leagues)) {
    data.leagues.forEach(l => { if (l.events) events.push(...l.events); });
  } else {
    events = data.events || data.matches || (Array.isArray(data) ? data : []);
  }
  state.activeEvents = events;

  const matchTerm = (document.getElementById('league-search')?.value || '').toLowerCase().trim();
  renderEventTable(matchTerm ? events.filter(ev => eventMatchesSearch(ev, matchTerm)) : events);
}

export function filterAndRenderBoard() {
  if (!state.activeEvents.length) return;
  const matchTerm = (document.getElementById('league-search')?.value || '').toLowerCase().trim();
  renderEventTable(matchTerm ? state.activeEvents.filter(ev => eventMatchesSearch(ev, matchTerm)) : state.activeEvents);
}
