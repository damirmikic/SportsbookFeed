import { state, snapshotOdds, getOverride, getAllOverrideMeta, getTradingMode, isSuspended, hasAnySuspension, clearOverride, clearOverrideMetaSelection, hasAnyOverrideForEvent, setTradingMode, clearOverriddenLambdas } from './state.js';
import { fetchOdds } from './api.js';
import { evaluateOverrides } from './pricing.js';
import { openDrawer, updateModeButton, renderDrawerMarkets } from './ui-drawer.js';
import { getTeamNames } from './utils.js';

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

    const evtSuspended = isSuspended(event.id, 'event');
    const mlSuspended  = isSuspended(event.id, 'ml');
    const ouSuspended  = isSuspended(event.id, 'ou');
    const anySusp = evtSuspended || mlSuspended || ouSuspended || hasAnySuspension(event.id);

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
