import { state, snapshotOdds, getOverride, getAllOverrideMeta, getTradingMode, isSuspended, hasAnySuspension, clearOverride, clearOverrideMetaSelection, hasAnyOverrideForEvent, setTradingMode, clearOverriddenLambdas, clearAllOverridesForEvent, setSuspension, getLeagueSetting, isManualLeague, getOverriddenLambdas } from './state.js';
import { fetchOdds, pushOddsHistory, fetchManualEvents, pushOfferSnapshot } from './api.js';
import { dcMatchProbs, dcOverProb, calculateShinNoVig, applyMarginAndLadder, clampOdds, calculateTeamLambdasAsync } from './math.js';
import { evaluateOverrides, resolveTemplate, getMarketConfig, resolveActiveKey } from './pricing.js';
import { openDrawer, updateModeButton, updateSuspendButton, renderDrawerMarkets, DRAWER_TO_TPL_ID } from './ui-drawer.js';
import { getTeamNames } from './utils.js';
import { groupMarketsByCategory } from './ui-market-groups.js';
import { openOddsHistory } from './odds-history-ui.js';

// ── Override expiry processing ────────────────────────────────────────────────

let focusedEventId = null;
let shortcutsInstalled = false;
let _bulkCacheInProgress = false;
let _bulkCacheSearchTerm = null;

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

let moveAlertAudio = null;

function getMoveAlertThreshold() {
  const factor = Number(getLeagueSetting(state.currentLeagueCode)?.alertFactor ?? 1);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return 0.1 / factor;
}

function playMoveAlertSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  moveAlertAudio ||= new AudioContext();
  const ctx = moveAlertAudio;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const now = ctx.currentTime;
  osc.type = 'sine';
  osc.frequency.setValueAtTime(740, now);
  osc.frequency.exponentialRampToValueAtTime(520, now + 0.14);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.035, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.18);
}

function hasSignificantMove(rawVal, prevVal, threshold) {
  if (threshold == null || prevVal == null || rawVal === '-') return false;
  const current = parseFloat(rawVal);
  return Number.isFinite(current) && Math.abs(current - prevVal) > threshold;
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function persistOddsHistory(data) {
  pushOddsHistory(data).catch(error => {
    console.warn('Odds history snapshot failed:', error);
  });
}

function visibleEventRows() {
  return Array.from(document.querySelectorAll('#odds-container tr[data-event-id]'));
}

function setFocusedEventRow(eventId, { scroll = true, focus = true } = {}) {
  const rows = visibleEventRows();
  if (!rows.length) {
    focusedEventId = null;
    return;
  }

  const row = rows.find(r => r.dataset.eventId === String(eventId)) || rows[0];
  focusedEventId = row.dataset.eventId;
  rows.forEach(r => {
    const active = r === row;
    r.classList.toggle('keyboard-focused-row', active);
    r.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (focus && !isTypingTarget(document.activeElement)) {
    try {
      row.focus({ preventScroll: true });
    } catch {
      row.focus();
    }
  }
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

function moveFocusedEventRow(delta) {
  const rows = visibleEventRows();
  if (!rows.length) return;
  const currentIndex = Math.max(0, rows.findIndex(r => r.dataset.eventId === String(focusedEventId)));
  const nextIndex = Math.min(rows.length - 1, Math.max(0, currentIndex + delta));
  setFocusedEventRow(rows[nextIndex].dataset.eventId);
}

function focusedEvent() {
  return state.activeEvents.find(e => String(e.id) === String(focusedEventId));
}

function rerenderBoardPreservingFocus() {
  const current = focusedEventId;
  filterAndRenderBoard();
  if (current) setFocusedEventRow(current, { scroll: false });
}

function openFocusedDrawer() {
  if (focusedEventId) openDrawer(focusedEventId);
}

function toggleFocusedSuspension() {
  if (!focusedEventId) return;
  const suspended = isSuspended(focusedEventId, 'event');
  setSuspension(focusedEventId, 'event', suspended ? 'open' : 'suspended');
  rerenderBoardPreservingFocus();
  if (state.drawerEventId?.toString() === String(focusedEventId)) {
    const ev = focusedEvent();
    if (ev) renderDrawerMarkets(ev);
    updateSuspendButton(focusedEventId);
  }
}

function toggleFocusedManualMode() {
  if (!focusedEventId) return;
  const isManual = getTradingMode(focusedEventId) === 'manual';
  if (isManual) {
    clearAllOverridesForEvent(focusedEventId);
    setTradingMode(focusedEventId, 'auto');
  } else {
    setTradingMode(focusedEventId, 'manual');
  }
  rerenderBoardPreservingFocus();
  if (state.drawerEventId?.toString() === String(focusedEventId)) {
    updateModeButton(focusedEventId);
    const ev = focusedEvent();
    if (ev) renderDrawerMarkets(ev);
  }
}

function isTypingTarget(target) {
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;
}

function isModalOpen() {
  return !!document.querySelector('.tpl-modal-backdrop.visible, .odds-history-backdrop.visible, .shortcut-overlay.visible');
}

function ensureShortcutOverlay() {
  let overlay = document.getElementById('shortcut-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'shortcut-overlay';
  overlay.className = 'shortcut-overlay';
  overlay.innerHTML = `
    <div class="shortcut-panel" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
      <div class="shortcut-header">
        <h3 id="shortcut-title">Keyboard Shortcuts</h3>
        <button type="button" class="shortcut-close" aria-label="Close shortcuts">&times;</button>
      </div>
      <div class="shortcut-list">
        <div class="double-key"><kbd>↑</kbd><kbd>←</kbd><span>Previous event row</span></div>
        <div class="double-key"><kbd>↓</kbd><kbd>→</kbd><span>Next event row</span></div>
        <div class="single-key"><kbd>Space</kbd><span>Open selected event drawer</span></div>
        <div class="single-key"><kbd>S</kbd><span>Suspend / publish selected event</span></div>
        <div class="single-key"><kbd>M</kbd><span>Toggle selected event manual / auto</span></div>
        <div class="single-key"><kbd>?</kbd><span>Show this overlay</span></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('visible');
  });
  overlay.querySelector('.shortcut-close').addEventListener('click', () => overlay.classList.remove('visible'));
  return overlay;
}

function toggleShortcutOverlay(show = true) {
  ensureShortcutOverlay().classList.toggle('visible', show);
}

function installKeyboardShortcuts() {
  if (shortcutsInstalled) return;
  shortcutsInstalled = true;
  document.addEventListener('keydown', e => {
    if (isTypingTarget(e.target)) return;

    if (e.key === 'Escape') {
      document.getElementById('shortcut-overlay')?.classList.remove('visible');
      return;
    }

    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      e.preventDefault();
      toggleShortcutOverlay(true);
      return;
    }

    if (isModalOpen()) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveFocusedEventRow(1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      moveFocusedEventRow(-1);
    } else if (e.key === ' ') {
      e.preventDefault();
      openFocusedDrawer();
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleFocusedSuspension();
    } else if (e.key.toLowerCase() === 'm') {
      e.preventDefault();
      toggleFocusedManualMode();
    }
  });
}

function formatManualEvent(row) {
  let homePrice, drawPrice, awayPrice, overOdds, underOdds;
  const ouLine = parseFloat(row.ou_line ?? 2.5);

  if (row.input_mode === 'lambdas') {
    const lh = parseFloat(row.lh);
    const la = parseFloat(row.la);
    const rho = parseFloat(row.rho ?? 0);
    if (!isNaN(lh) && !isNaN(la)) {
      const { pH, pD, pA } = dcMatchProbs(lh, la, rho);
      const pOver = dcOverProb(lh, la, rho, ouLine);
      homePrice  = 1 / pH;
      drawPrice  = 1 / pD;
      awayPrice  = 1 / pA;
      overOdds   = 1 / pOver;
      underOdds  = 1 / (1 - pOver);
    }
  } else {
    homePrice  = parseFloat(row.home_odds);
    drawPrice  = parseFloat(row.draw_odds);
    awayPrice  = parseFloat(row.away_odds);
    overOdds   = parseFloat(row.over_odds);
    underOdds  = parseFloat(row.under_odds);
  }

  return {
    id:        row.id,
    home:      row.home,
    away:      row.away,
    starts:    row.starts,
    isManual:  true,
    _manualRow: row,
    periods: {
      '0': {
        moneyLine: { homePrice, drawPrice, awayPrice },
        overUnder: [{ points: String(ouLine), overOdds, underOdds }],
        spreads:   [],
      },
    },
  };
}

export async function loadOdds(leagueCode, silent = false) {
  const oddsContainer = document.getElementById('odds-container');
  if (!silent) {
    oddsContainer.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading odds...</p></div>`;
  }

  if (isManualLeague(leagueCode)) {
    try {
      const rows = await fetchManualEvents(leagueCode);
      const events = rows.map(formatManualEvent);
      state.activeEvents = events;
      const _mlName = state.allLeagues.find(l => (l.code || l.leagueCode || l.id) === String(leagueCode))?.name || String(leagueCode);
      state.eventCache[leagueCode] = { leagueName: _mlName, events };
      document.dispatchEvent(new CustomEvent('odds:loaded', { detail: { count: events.length } }));
      renderOdds({ events }, { alertMoves: false });
      processOverrideExpiries(evaluateOverrides(state.activeEvents));
      buildOfferSnapshot().then(pushOfferSnapshot).catch(() => {});
      if (state.drawerEventId) {
        const freshEv = state.activeEvents.find(e => e.id.toString() === state.drawerEventId.toString());
        if (freshEv) renderDrawerMarkets(freshEv);
      }
    } catch (error) {
      console.error('Error loading manual events', error);
      if (!silent) {
        oddsContainer.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load events.</div>`;
      }
    }
    return;
  }

  try {
    state.previousOdds = snapshotOdds();
    const data = await fetchOdds(leagueCode);
    persistOddsHistory(data);
    renderOdds(data, { alertMoves: true });
    processOverrideExpiries(evaluateOverrides(state.activeEvents));
    buildOfferSnapshot().then(pushOfferSnapshot).catch(() => {});
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
    if (event.participants.some(p => (p.name || p.englishName || '').toLowerCase().includes(term))) return true;
  }
  // Fallback: event title / name fields (some sources carry these)
  const title = (event.name || event.eventName || event.matchName || '').toLowerCase();
  return title.includes(term);
}

function renderEventTable(eventsToRender, { alertMoves = false, crossLeague = false } = {}) {
  const oddsContainer = document.getElementById('odds-container');

  if (!eventsToRender.length) {
    const matchTerm = (document.getElementById('league-search')?.value || '').trim();
    oddsContainer.innerHTML = matchTerm
      ? `<div class="empty-state">No matches found for "<strong>${matchTerm}</strong>".</div>`
      : `<div class="empty-state">No odds available for this league.</div>`;
    return;
  }

  const isBasketball = state.currentSportId === 4;
  const isTennis = state.currentSportId === 33;
  let html = `<table class="market-table ${isBasketball ? 'basketball-active' : ''} ${isTennis ? 'tennis-active' : ''}">
    <thead><tr>
      <th style="width:30%">Match</th>
      <th>1</th>${isTennis ? '' : `<th>X</th>`}<th>2</th>
      <th>Over${isBasketball ? '' : isTennis ? ' (Games)' : ' 2.5'}</th><th>Under${isBasketball ? '' : isTennis ? ' (Games)' : ' 2.5'}</th>
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
      rawX = isTennis ? null : (ml.drawPrice || ml.draw || '-');
      raw2 = ml.awayPrice || ml.away || '-';
    }
    let odds1 = raw1, oddsX = rawX, odds2 = raw2;

    let rawOver = '-', rawUnder = '-';
    let oddsOver = '-', oddsUnder = '-';
    let ouLineLabel = isBasketball ? '220.5' : isTennis ? '22.5' : '2.5';
    if (matchPeriod?.overUnder) {
      const defaultLine = isTennis ? 22.5 : 2.5;
      const ouMain = matchPeriod.overUnder.find(ou => ou.isMain)
        || matchPeriod.overUnder.find(ou => parseFloat(ou.points) === defaultLine)
        || matchPeriod.overUnder[0];
      if (ouMain) {
        rawOver = ouMain.overOdds || ouMain.over || '-';
        rawUnder = ouMain.underOdds || ouMain.under || '-';
        oddsOver = rawOver;
        oddsUnder = rawUnder;
        if (ouMain.points != null) ouLineLabel = String(ouMain.points);
      }
    }

    const isManual = getTradingMode(event.id) === 'manual';

    // Compute offered prices (AUTO mode, template assigned) — margin + ladder applied
    if (!isManual && matchPeriod) {
      const { template: offerTpl } = resolveTemplate(event.id, state.currentLeagueCode);
      if (offerTpl) {
        const eventStart = event.starts || event.startTime || event.time;
        // For tennis use tennis_ml; for others use 1x2
        const mlTplId = isTennis ? 'tennis_ml' : '1x2';
        const mlConf = getMarketConfig(offerTpl, mlTplId);
        if (mlConf?.enabled && (matchPeriod.moneyLine || matchPeriod.moneyline)) {
          const ml   = matchPeriod.moneyLine || matchPeriod.moneyline;
          const priceArr = isTennis
            ? [ml.homePrice || ml.home, ml.awayPrice || ml.away]
            : [ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away];
          const shin = calculateShinNoVig(priceArr);
          let margin = mlConf.margin;
          const tl = eventStart ? resolveActiveKey(mlConf, eventStart) : null;
          if (tl?.key != null) margin = tl.key;
          const ladder = mlConf.ladder || 'eu';
          const mlMin = mlConf.minOdds ?? offerTpl.minOdds ?? null;
          const mlMax = mlConf.maxOdds ?? offerTpl.maxOdds ?? null;
          const o1 = clampOdds(applyMarginAndLadder(parseFloat(shin[0]), margin, ladder), mlMin, mlMax);
          const o2 = clampOdds(applyMarginAndLadder(parseFloat(shin[isTennis ? 1 : 2]), margin, ladder), mlMin, mlMax);
          if (o1 > 1) odds1 = o1.toFixed(2);
          if (!isTennis) {
            const oX = clampOdds(applyMarginAndLadder(parseFloat(shin[1]), margin, ladder), mlMin, mlMax);
            if (oX > 1) oddsX = oX.toFixed(2);
          }
          if (o2 > 1) odds2 = o2.toFixed(2);
        }
        // For tennis use tennis_tot; for others use ou25/asian_tot
        const ouTplId = isTennis ? 'tennis_tot' : null;
        const ouConf = ouTplId
          ? getMarketConfig(offerTpl, ouTplId)
          : (getMarketConfig(offerTpl, 'ou25') || getMarketConfig(offerTpl, 'asian_tot'));
        if (ouConf?.enabled && Array.isArray(matchPeriod.overUnder)) {
          const ouMain = matchPeriod.overUnder.find(ou => ou.isMain)
            || matchPeriod.overUnder.find(ou => parseFloat(ou.points) === (isTennis ? 22.5 : 2.5))
            || matchPeriod.overUnder[0];
          if (ouMain) {
            const shin = calculateShinNoVig([ouMain.overOdds, ouMain.underOdds]);
            let margin = ouConf.margin;
            const tl = eventStart ? resolveActiveKey(ouConf, eventStart) : null;
            if (tl?.key != null) margin = tl.key;
            const ladder = ouConf.ladder || 'eu';
            const ouMin = ouConf.minOdds ?? offerTpl.minOdds ?? null;
            const ouMax = ouConf.maxOdds ?? offerTpl.maxOdds ?? null;
            const oOver = clampOdds(applyMarginAndLadder(parseFloat(shin[0]), margin, ladder), ouMin, ouMax);
            const oUnd  = clampOdds(applyMarginAndLadder(parseFloat(shin[1]), margin, ladder), ouMin, ouMax);
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
      const oOver = getOverride(`${event.id}|ou|Over ${ouLineLabel}`);
      const oUnd  = getOverride(`${event.id}|ou|Under ${ouLineLabel}`);
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
    const alertThreshold = alertMoves ? getMoveAlertThreshold() : null;
    const trend = (rawVal, prevVal, isManualCell) => {
      if (isManualCell || !prevVal || rawVal === '-') return '';
      const diff = parseFloat(rawVal) - prevVal;
      if (Math.abs(diff) < 0.001) return '';
      return diff > 0 ? ' price-up' : ' price-down';
    };
    const t1 = trend(raw1, prev.home, m1);
    const tX = trend(rawX, prev.draw, mX);
    const t2 = trend(raw2, prev.away, m2);
    const hasMoveAlert = [
      [raw1, prev.home],
      [rawX, prev.draw],
      [raw2, prev.away],
      [rawOver, prev.over25],
      [rawUnder, prev.under25],
    ].some(([raw, previous]) => hasSignificantMove(raw, previous, alertThreshold));

    const allMeta = getAllOverrideMeta();
    const hasValueBet = isManual && Object.keys(allMeta).some(
      k => k.startsWith(`${event.id}|`) && allMeta[k]?.alertState === 'VALUE_BET'
    );
    const manualBadge = isManual
      ? `<span class="manual-row-badge${hasValueBet ? ' value-bet-badge' : ''}">${hasValueBet ? 'M⚠' : 'M'}</span>`
      : '';
    const suspBadge = anySusp && !evtSuspended ? '<span class="susp-badge">SUSP</span>' : '';
    const rowClass  = [isManual ? 'manual-row' : '', evtSuspended ? 'event-suspended' : '', hasMoveAlert ? 'move-alert-row' : ''].filter(Boolean).join(' ');
    const matchName = `${homeTeam} vs ${awayTeam}`;
    const leagueAttr = event._leagueCode ? `data-league-code="${escapeAttr(event._leagueCode)}" data-league-name="${escapeAttr(event._leagueName || '')}"` : '';
    const leagueBadge = crossLeague && event._leagueName
      ? `<span class="cross-league-badge">${escapeAttr(event._leagueName)}</span>` : '';

    html += `<tr data-event-id="${event.id}" data-match-name="${escapeAttr(matchName)}" ${leagueAttr} class="${rowClass}" tabindex="0">
      <td>
        <div class="match-time">${time}${manualBadge}${suspBadge}</div>
        ${leagueBadge}
        <div class="match-teams">${homeTeam} vs ${awayTeam}</div>
      </td>
      <td class="${mlSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${m1 ? ' manual-price' : t1}" data-history-market="moneyline" data-history-side="home" data-history-label="${escapeAttr(homeTeam)}">${evtSuspended || mlSuspended ? 'SUSP' : odds1}${!m1 && t1 === ' price-up' ? ' ▲' : !m1 && t1 === ' price-down' ? ' ▼' : ''}</button></td>
      ${isTennis ? '' : `<td class="${mlSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${mX ? ' manual-price' : tX}" data-history-market="moneyline" data-history-side="draw" data-history-label="Draw">${evtSuspended || mlSuspended ? 'SUSP' : oddsX}${!mX && tX === ' price-up' ? ' ▲' : !mX && tX === ' price-down' ? ' ▼' : ''}</button></td>`}
      <td class="${mlSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${m2 ? ' manual-price' : t2}" data-history-market="moneyline" data-history-side="away" data-history-label="${escapeAttr(awayTeam)}">${evtSuspended || mlSuspended ? 'SUSP' : odds2}${!m2 && t2 === ' price-up' ? ' ▲' : !m2 && t2 === ' price-down' ? ' ▼' : ''}</button></td>
      <td class="${ouSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${mOver ? ' manual-price' : ''}" data-history-market="total" data-history-side="over" data-history-points="${ouLineLabel}" data-history-label="Over ${ouLineLabel}" style="border-color:${mOver ? '#fbbf24' : 'var(--accent-color)'}">${evtSuspended || ouSuspended ? 'SUSP' : oddsOver}${isTennis || ouLineLabel !== '2.5' ? `<span class="ou-line-tag">${ouLineLabel}</span>` : ''}</button></td>
      <td class="${ouSuspended || evtSuspended ? 'susp-cell' : ''}"><button class="odds-btn${mUnder ? ' manual-price' : ''}" data-history-market="total" data-history-side="under" data-history-points="${ouLineLabel}" data-history-label="Under ${ouLineLabel}" style="border-color:${mUnder ? '#fbbf24' : 'var(--accent-color)'}">${evtSuspended || ouSuspended ? 'SUSP' : oddsUnder}${isTennis || ouLineLabel !== '2.5' ? `<span class="ou-line-tag">${ouLineLabel}</span>` : ''}</button></td>
    </tr>`;
  });

  html += `</tbody></table>`;
  oddsContainer.innerHTML = html;
  if (alertMoves && oddsContainer.querySelector('.move-alert-row')) playMoveAlertSound();
  installKeyboardShortcuts();

  oddsContainer.querySelectorAll('tr[data-event-id]').forEach(tr => {
    tr.addEventListener('click', async () => {
      const eventId = tr.getAttribute('data-event-id');
      const leagueCode = tr.dataset.leagueCode;
      if (leagueCode && leagueCode !== String(state.currentLeagueCode)) {
        state.currentLeagueCode = leagueCode;
        const leagueName = tr.dataset.leagueName || leagueCode;
        document.getElementById('current-league').textContent = `– ${leagueName}`;
        document.querySelectorAll('.league-item').forEach(i => i.classList.remove('active'));
        document.querySelector(`.league-item[data-league-code="${leagueCode}"]`)?.classList.add('active');
        await loadOdds(leagueCode);
      }
      setFocusedEventRow(eventId, { scroll: false });
      openDrawer(eventId);
    });
    tr.addEventListener('focus', () => setFocusedEventRow(tr.getAttribute('data-event-id'), { scroll: false, focus: false }));
  });
  oddsContainer.querySelectorAll('.odds-btn[data-history-market]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('tr[data-event-id]');
      openOddsHistory({
        eventId: row?.dataset.eventId,
        period: '0',
        market: btn.dataset.historyMarket,
        side: btn.dataset.historySide,
        points: btn.dataset.historyPoints,
        title: btn.dataset.historyLabel,
        subtitle: row?.dataset.matchName,
      });
    });
  });
  const rows = visibleEventRows();
  if (rows.length) {
    const nextFocus = rows.find(r => r.dataset.eventId === String(focusedEventId))?.dataset.eventId || rows[0].dataset.eventId;
    setFocusedEventRow(nextFocus, { scroll: false, focus: false });
  }
}

function getPeriodsForSnapshot(event) {
  let matchPeriod = null, h1Period = null;
  if (event.periods && !Array.isArray(event.periods)) {
    matchPeriod = event.periods['0'];
    h1Period    = event.periods['1'];
  } else if (event.periodOdds && !Array.isArray(event.periodOdds)) {
    matchPeriod = event.periodOdds['0'];
  } else {
    const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
    matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    h1Period    = arr.find(p => p.num === 1 || p.periodNumber === 1);
  }
  return { matchPeriod, h1Period };
}

function applyOffer(fairStr, tplConf, offerTpl, eventStart) {
  const fair = parseFloat(fairStr);
  if (!fair || fair <= 1 || !tplConf?.enabled) return null;
  const tl     = eventStart ? resolveActiveKey(tplConf, eventStart) : null;
  const tlKey  = tl?.key;
  const margin = tlKey != null
    ? (typeof tlKey === 'object' ? tlKey.margin : tlKey)
    : tplConf.margin;
  const ladder = tplConf.ladder || 'eu';
  const min    = tplConf.minOdds ?? offerTpl?.minOdds ?? null;
  const max    = tplConf.maxOdds ?? offerTpl?.maxOdds ?? null;
  return clampOdds(applyMarginAndLadder(fair, margin, ladder), min, max);
}

export async function buildOfferSnapshot() {
  const leagueCode = state.currentLeagueCode;

  const results = await Promise.allSettled(
    state.activeEvents.map(async (event) => {
      if (isSuspended(event.id, 'event')) return null;
      const { matchPeriod, h1Period } = getPeriodsForSnapshot(event);
      if (!matchPeriod) return null;

      const { home: homeTeam, away: awayTeam } = getTeamNames(event);
      const eventStart = event.starts || event.startTime || event.time;
      const isManual   = getTradingMode(event.id) === 'manual';
      const { template: offerTpl } = resolveTemplate(event.id, leagueCode);

      // ── Manual mode: use stored overrides for board-visible markets only ──
      if (isManual) {
        const markets = [];
        if (!isSuspended(event.id, 'ml')) {
          const h = getOverride(`${event.id}|ml|${homeTeam}`);
          const d = getOverride(`${event.id}|ml|Draw`);
          const a = getOverride(`${event.id}|ml|${awayTeam}`);
          if (h && d && a) {
            markets.push({ id: '1x2', name: '1x2', selections: [
              { label: homeTeam, price: parseFloat(h) },
              { label: 'Draw',   price: parseFloat(d) },
              { label: awayTeam, price: parseFloat(a) },
            ] });
          }
        }
        if (!isSuspended(event.id, 'ou')) {
          const isBasketball = state.currentSportId === 4;
          const ouEntry = Array.isArray(matchPeriod.overUnder)
            ? (matchPeriod.overUnder.find(ou => ou.isMain) ||
               matchPeriod.overUnder.find(ou => parseFloat(ou.points) === 2.5) ||
               matchPeriod.overUnder[0])
            : null;
          if (ouEntry) {
            const lineLabel = String(ouEntry.points ?? (isBasketball ? 220.5 : 2.5));
            const lineVal = parseFloat(lineLabel);
            let allowed = true;
            if (isBasketball && offerTpl) {
              const showHalf = offerTpl.showHalf !== false;
              const showWhole = offerTpl.showWhole !== false;
              const rem = Math.abs(lineVal % 1);
              if (rem === 0 && !showWhole) allowed = false;
              if (rem === 0.5 && !showHalf) allowed = false;
            }
            if (allowed) {
              const ov = getOverride(`${event.id}|ou|Over ${lineLabel}`);
              const un = getOverride(`${event.id}|ou|Under ${lineLabel}`);
              if (ov && un) {
                markets.push({ id: 'ou25', name: `Over/Under ${lineLabel}`, line: lineVal, selections: [
                  { label: `Over ${lineLabel}`,  price: parseFloat(ov) },
                  { label: `Under ${lineLabel}`, price: parseFloat(un) },
                ] });
              }
            }
          }
        }
        if (!markets.length) return null;
        return { id: String(event.id), home: homeTeam, away: awayTeam, starts: eventStart || null, markets };
      }

      // ── Auto mode: run solver then price all template markets via groupMarketsByCategory ──
      if (!offerTpl) return null;

      let lambdaData = null;
      if (state.currentSportId !== 4 && state.currentSportId !== 33) {
        try {
          lambdaData = await calculateTeamLambdasAsync(matchPeriod, h1Period);
          const ovLambdas = getOverriddenLambdas(event.id);
          if (ovLambdas && lambdaData) {
            lambdaData = { ...lambdaData, ft: { lh: ovLambdas.lh, la: ovLambdas.la, rho: ovLambdas.rho, grid: ovLambdas.grid } };
          }
        } catch { /* model unavailable — proceed with Pinnacle-only fair prices */ }
      }

      const grouped = groupMarketsByCategory(event, matchPeriod, h1Period, lambdaData, {}, homeTeam, awayTeam, offerTpl);
      const markets = [];

      for (const marketList of Object.values(grouped)) {
        for (const market of marketList) {
          // Skip Pinnacle-only specials (no template config) and suspended markets
          if (market.id.startsWith('special_')) continue;
          if (isSuspended(event.id, market.id)) continue;

          const tplMarketId = DRAWER_TO_TPL_ID[market.id] ?? market.id;
          const tplConf     = getMarketConfig(offerTpl, tplMarketId);
          if (!tplConf?.enabled) continue;

          const selections = [];
          for (const row of market.rows) {
            if (!row.label) continue;
            // Prefer DC model fair (independent of Pinnacle); fall back to Shin devig when model has no data
            const fair = (parseFloat(row.modelFair) > 1 ? row.modelFair : null) ?? row.shinFair;
            const price = applyOffer(fair, tplConf, offerTpl, eventStart);
            if (price && price > 1) selections.push({ label: row.label, price });
          }

          if (selections.length > 0) {
            markets.push({ id: tplMarketId, name: market.name, selections });
          }
        }
      }

      if (!markets.length) return null;
      return { id: String(event.id), home: homeTeam, away: awayTeam, starts: eventStart || null, markets };
    })
  );

  const snapshotEvents = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  return { leagueCode: String(leagueCode), events: snapshotEvents };
}

// ── Tennis: merge sibling (Sets) / (Games) event pairs ───────────────────────
//
// Pinnacle exposes tennis matches as two separate events:
//   "Player A vs Player B (Sets)"  — has moneyline, handicap, set totals
//   "Player A vs Player B (Games)" — has game over/under lines
//
// This function detects those sibling pairs (same base name + same start time),
// copies the Games event's overUnder arrays into the Sets event's periods,
// strips the "(Sets)" suffix from the display name, and drops the Games event.
// Events that don't follow this pattern are passed through unchanged.

function normalizeTennisName(name) {
  // Strip (Sets) and (Games) from ANYWHERE in the string — Pinnacle appends
  // these to each individual player name, e.g. "Martin Damm (Sets) vs James McCabe (Sets)"
  return (name || '')
    .replace(/\s*\(Sets\)\s*/gi, ' ')
    .replace(/\s*\(Games\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPeriodMap(event) {
  if (event.periods && !Array.isArray(event.periods)) return event.periods;
  if (event.periodOdds && !Array.isArray(event.periodOdds)) return event.periodOdds;
  // Array-of-periods: index by num/periodNumber
  const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
  const map = {};
  arr.forEach(p => {
    const key = String(p.num ?? p.periodNumber ?? 0);
    map[key] = p;
  });
  return map;
}

function cleanTennisSetsEvent(ev) {
  // Strip "(Sets)" and "(Games)" from home/away names wherever they appear (global replace)
  const clean = { ...ev };
  const removeSuffixes = s => (s || '').replace(/\s*\(Sets\)\s*/gi, '').replace(/\s*\(Games\)\s*/gi, '').trim();
  
  if (clean.home) clean.home = removeSuffixes(clean.home);
  if (clean.away) clean.away = removeSuffixes(clean.away);
  if (clean.name) clean.name = removeSuffixes(clean.name);
  if (clean.eventName) clean.eventName = removeSuffixes(clean.eventName);
  
  if (clean.participants) {
    clean.participants = clean.participants.map(p => ({
      ...p,
      name: p.name ? removeSuffixes(p.name) : p.name,
      englishName: p.englishName ? removeSuffixes(p.englishName) : p.englishName
    }));
  }
  return clean;
}

function mergeTennisEvents(events) {
  const getEventName = ev => {
    const { home, away } = getTeamNames(ev);
    return `${home} vs ${away}`;
  };

  const primaryMap = new Map(); // id -> { setsEvent, gamesEvents: [] }
  const otherEvents = [];

  // First pass: identify sets (primary) events and initialize the primaryMap
  events.forEach(ev => {
    const rawName = getEventName(ev);
    const isSets = /\(Sets\)/i.test(rawName) || ev.resultingUnit === 'Sets' || !ev.parentId;
    if (isSets && (!ev.parentId || ev.parentId === 0)) {
      primaryMap.set(ev.id, { sets: ev, games: [] });
    }
  });

  // Create name|time key lookup for fallback matching
  const keyMap = new Map(); // normalizedName|startTime -> primaryMap entry
  primaryMap.forEach((entry) => {
    const rawName = getEventName(entry.sets);
    const normName = normalizeTennisName(rawName);
    const startTime = String(entry.sets.starts || entry.sets.startTime || entry.sets.time || '');
    const key = `${normName}|${startTime}`;
    keyMap.set(key, entry);
  });

  // Second pass: group games (secondary) events under their corresponding sets (primary) events
  events.forEach(ev => {
    const rawName = getEventName(ev);
    const isSets = /\(Sets\)/i.test(rawName) || ev.resultingUnit === 'Sets' || !ev.parentId;
    if (isSets && (!ev.parentId || ev.parentId === 0)) {
      // Primary event itself, already processed
      return;
    }

    const parentId = ev.parentId;
    if (parentId && primaryMap.has(parentId)) {
      primaryMap.get(parentId).games.push(ev);
    } else {
      // Fallback matching by normalized name and start time
      const normName = normalizeTennisName(rawName);
      const startTime = String(ev.starts || ev.startTime || ev.time || '');
      const key = `${normName}|${startTime}`;
      if (keyMap.has(key)) {
        keyMap.get(key).games.push(ev);
      } else {
        otherEvents.push(ev);
      }
    }
  });

  const merged = [];

  // Merge games events into their parent sets events
  primaryMap.forEach(({ sets, games }) => {
    const primary = cleanTennisSetsEvent(sets);
    const periodMap = getPeriodMap(primary);

    // For the primary Sets event, move its own period 0 handicap and overUnder to setHandicap and setOverUnder
    if (periodMap['0']) {
      if (periodMap['0'].handicap) {
        // Filter out unavailable lines
        const validSetHdps = periodMap['0'].handicap.filter(h => !h.unavailable && h.homeSpread !== undefined && h.homeSpread !== '');
        if (validSetHdps.length) {
          periodMap['0'].setHandicap = validSetHdps;
        }
        delete periodMap['0'].handicap;
      }
      if (periodMap['0'].overUnder) {
        // Filter out unavailable lines
        const validSetOus = periodMap['0'].overUnder.filter(ou => !ou.unavailable && ou.points !== undefined && ou.points !== '');
        if (validSetOus.length) {
          periodMap['0'].setOverUnder = validSetOus;
        }
        delete periodMap['0'].overUnder;
      }
    }

    // Now merge any secondary sibling Games events
    games.forEach(gamesEvent => {
      const gamesPeriodMap = getPeriodMap(gamesEvent);

      Object.entries(gamesPeriodMap).forEach(([key, gamesPeriod]) => {
        if (!periodMap[key]) {
          periodMap[key] = {};
        }

        // Merge handicap
        if (gamesPeriod?.handicap?.length) {
          const validHdps = gamesPeriod.handicap.filter(h => !h.unavailable && h.homeSpread !== undefined && h.homeSpread !== '');
          if (validHdps.length) {
            periodMap[key].handicap = [...(periodMap[key].handicap || []), ...validHdps];
          }
        }

        // Merge overUnder
        if (gamesPeriod?.overUnder?.length) {
          const validOus = gamesPeriod.overUnder.filter(ou => !ou.unavailable && ou.points !== undefined && ou.points !== '');
          if (validOus.length) {
            const existing = periodMap[key].overUnder || [];
            const existingPoints = new Set(existing.map(ou => String(parseFloat(ou.points))));
            const toAdd = validOus.filter(ou => !existingPoints.has(String(parseFloat(ou.points))));
            periodMap[key].overUnder = [...existing, ...toAdd];
          }
        }
      });
    });

    if (Array.isArray(primary.periods)) {
      primary.periods = periodMap;
    }

    merged.push(primary);
  });

  // Push any other unmatched events
  otherEvents.forEach(ev => {
    const cleaned = cleanTennisSetsEvent(ev);
    // If it's a Games event without a Sets sibling, keep its handicap/overUnder under the regular fields
    merged.push(cleaned);
  });

  // Maintain original order
  const orderMap = new Map(events.map((ev, i) => [ev.id, i]));
  merged.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  return merged;
}

export function renderOdds(data, options = {}) {
  let events = [];
  if (data.leagues && Array.isArray(data.leagues)) {
    data.leagues.forEach(l => { if (l.events) events.push(...l.events); });
  } else {
    events = data.events || data.matches || (Array.isArray(data) ? data : []);
  }

  // ── Tennis: merge (Sets) + (Games) sibling events into one ───────────────
  if (state.currentSportId === 33) {
    events = mergeTennisEvents(events);
  }

  state.activeEvents = events;
  if (state.currentLeagueCode) {
    const _ln = state.allLeagues.find(l => (l.code || l.leagueCode || l.id) === String(state.currentLeagueCode))?.name || String(state.currentLeagueCode);
    state.eventCache[state.currentLeagueCode] = { leagueName: _ln, events };
  }
  document.dispatchEvent(new CustomEvent('odds:loaded', { detail: { count: events.length } }));

  const matchTerm = (document.getElementById('league-search')?.value || '').toLowerCase().trim();
  renderEventTable(matchTerm ? events.filter(ev => eventMatchesSearch(ev, matchTerm)) : events, options);
}

function extractEvents(data) {
  if (data.leagues && Array.isArray(data.leagues)) {
    const evts = [];
    data.leagues.forEach(l => { if (l.events) evts.push(...l.events); });
    return evts;
  }
  return data.events || data.matches || (Array.isArray(data) ? data : []);
}

async function populateCacheForSearch(term) {
  _bulkCacheInProgress = true;
  _bulkCacheSearchTerm = term;

  const oddsContainer = document.getElementById('odds-container');
  if (oddsContainer) {
    oddsContainer.innerHTML = `<div class="empty-state search-loading">Searching all leagues for "<strong>${term}</strong>"…</div>`;
  }

  const uncached = state.allLeagues.filter(l => {
    const code = String(l.code || l.leagueCode || l.id);
    return !l.isManual && !state.eventCache[code];
  });

  const BATCH = 5;
  for (let i = 0; i < uncached.length; i += BATCH) {
    const activeTerm = (document.getElementById('league-search')?.value || '').toLowerCase().trim();
    if (!activeTerm || activeTerm !== _bulkCacheSearchTerm) break;

    await Promise.allSettled(uncached.slice(i, i + BATCH).map(async (league) => {
      const code = String(league.code || league.leagueCode || league.id);
      try {
        const data = await fetchOdds(code);
        state.eventCache[code] = { leagueName: league.name || code, events: extractEvents(data) };
      } catch { /* skip unreachable leagues */ }
    }));

    const currentTerm = (document.getElementById('league-search')?.value || '').toLowerCase().trim();
    if (!currentTerm || currentTerm !== _bulkCacheSearchTerm) break;

    const hasResults = Object.values(state.eventCache).some(({ events }) =>
      events.some(ev => eventMatchesSearch(ev, currentTerm))
    );
    if (hasResults) filterAndRenderBoard();
  }

  _bulkCacheInProgress = false;

  const finalTerm = (document.getElementById('league-search')?.value || '').toLowerCase().trim();
  if (finalTerm === term) filterAndRenderBoard();
}

export function filterAndRenderBoard() {
  const term = (document.getElementById('league-search')?.value || '').toLowerCase().trim();

  if (!term) {
    _bulkCacheSearchTerm = null;
    if (state.activeEvents.length) renderEventTable(state.activeEvents);
    return;
  }

  // Gather matching events from every cached league
  const results = [];
  for (const [code, { leagueName, events }] of Object.entries(state.eventCache)) {
    events.filter(ev => eventMatchesSearch(ev, term))
      .forEach(ev => results.push({ ...ev, _leagueCode: code, _leagueName: leagueName }));
  }

  if (results.length) {
    results.sort((a, b) => new Date(a.starts || 0) - new Date(b.starts || 0));
    renderEventTable(results, { crossLeague: true });
    return;
  }

  // No cached results — check if we need to bulk-load uncached leagues
  const uncachedCount = state.allLeagues.filter(l =>
    !l.isManual && !state.eventCache[String(l.code || l.leagueCode || l.id)]
  ).length;

  if (uncachedCount > 0) {
    if (_bulkCacheInProgress && _bulkCacheSearchTerm === term) return; // already loading
    populateCacheForSearch(term);
    return;
  }

  // All leagues cached, genuinely no results
  renderEventTable(state.activeEvents.filter(ev => eventMatchesSearch(ev, term)));
}
