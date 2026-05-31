import { state, getTradingMode, clearAllOverridesForEvent, setTradingMode, isSuspended, setSuspension, getLeagueSetting, getTemplates, setMatchTemplate, getOverriddenLambdas, getDetailedOdds, isDetailedOddsFresh, setDetailedOdds } from './state.js';
import { fetchEventOdds } from './api.js';
import { resolveTemplate } from './pricing.js';
import { calculateTeamLambdasAsync } from './math.js';
import { getEffectiveMatchPeriod } from './ui-helpers.js';
import { groupMarketsByCategory } from './ui-market-groups.js';
import { renderMarketTable, createLambdaSection } from './ui-market-table.js';
import { getTeamNames } from './utils.js';

// Maps drawer market IDs to MARKET_DEFS template IDs for template-assignment indicators
export const DRAWER_TO_TPL_ID = {
  // Match Result
  'ml':  '1x2',
  'dc':  'dc',
  'dnb': 'dnb',
  // Handicap
  'hdp':         'asian_hcp',
  '3way_hdp_-3': '3way_hdp', '3way_hdp_-2': '3way_hdp', '3way_hdp_-1': '3way_hdp',
  '3way_hdp_0':  '3way_hdp',
  '3way_hdp_1':  '3way_hdp', '3way_hdp_2':  '3way_hdp', '3way_hdp_3':  '3way_hdp',
  // Totals
  'ou': 'ou25',
  // Goals
  'btts':             'btts',
  'btts_ou':          'btts_ou',
  'cs':               'cs',
  'exact_goals':      'exact_goals',
  'win_nil':          'win_nil',
  'goal_both_halves': 'goal_both_halves',
  'both_halves_over15':  'both_halves_over15',
  'both_halves_under15': 'both_halves_under15',
  'h1h2_btts':        'h1h2_btts',
  // Team Goals
  'tt_home':         'team_total',      'tt_away':         'team_total',
  'home_multigoals': 'team_multigoals', 'away_multigoals': 'team_multigoals',
  // 1st Half
  'h1_ml':           'h1_1x2',
  'h1_ou':           'h1_ou',
  'h1_main_ml':      'h1_main',
  'h1_main_hdp':     'h1_main',
  'h1_main_ou':      'h1_main',
  'h1_tt_home':      'h1_team_total',   'h1_tt_away':      'h1_team_total',
  'h1_btts':         'h1_btts',
  'h1_result_btts':  'h1_result_btts',
  'h1_result_ou_15': 'h1_result_ou',    'h1_result_ou_25': 'h1_result_ou',
  'h1_dc_total_05':  'h1_dc_total',     'h1_dc_total_15':  'h1_dc_total',     'h1_dc_total_25': 'h1_dc_total',
  // 2nd Half
  'h2_ml':      'h2_1x2',
  'h2_ou':      'h2_ou',
  'h2_main_ml':  'h2_main',
  'h2_main_hdp': 'h2_main',
  'h2_main_ou':  'h2_main',
  'h2_tt_home': 'h2_team_total',        'h2_tt_away': 'h2_team_total',
  // Corners
  'corner_ou':      'corner_ou',
  'corner_hdp':     'corner_hdp',
  'corner_tt_home': 'corner_team_total', 'corner_tt_away': 'corner_team_total',
  'h1_corner_ou':   'h1_corner_ou',
  'h1_corner_hdp':  'h1_corner_hdp',
  // Bookings
  'booking_ou':      'booking_ou',
  'booking_hdp':     'booking_hdp',
  'booking_tt_home': 'booking_team_total', 'booking_tt_away': 'booking_team_total',
  'h1_booking_ou':   'h1_booking_ou',
  'h1_booking_hdp':  'h1_booking_hdp',
  // Team Props
  'home_score_both_halves': 'score_both_halves', 'away_score_both_halves': 'score_both_halves',
  'home_win_both_halves':   'win_both_halves',   'away_win_both_halves':   'win_both_halves',
  'home_win_either_half':   'win_either_half',   'away_win_either_half':   'win_either_half',
  // Specials
  'htft':          'htft',
  'dc_total_15':   'dc_total',    'dc_total_25':   'dc_total',    'dc_total_35':   'dc_total',
  'dc_btts':       'dc_btts',
  'home_or_btts':  'result_or_btts',  'away_or_btts':  'result_or_btts',
  'home_or_over25':'result_or_over25','away_or_over25':'result_or_over25',
  'htft_total_15': 'htft_total',  'htft_total_25': 'htft_total',  'htft_total_35': 'htft_total',
  'h1_or_ft':      'h1_or_ft',
};

// Mirrors computeOffer logic: returns true if at least one row would produce a price.
function marketHasOffer(market, activeTpl) {
  const tplMarketId = DRAWER_TO_TPL_ID[market.id] ?? market.id;
  const tplMarket   = activeTpl?.markets?.find(m => m.id === tplMarketId);
  return market.rows.some(row => {
    if (tplMarket?.enabled) {
      const shin  = parseFloat(row.shinFair);
      const model = parseFloat(row.modelFair);
      if ((!isNaN(shin) && shin > 1) || (!isNaN(model) && model > 1)) return true;
    }
    // api fallback — same as computeOffer's last line
    const api = parseFloat(row.value);
    return !isNaN(api) && api > 1;
  });
}

// ── Drawer header controls ────────────────────────────────────────────────────

export function updateSuspendButton(eventId) {
  const btn = document.getElementById('suspend-event-btn');
  if (!btn) return;
  const suspended = isSuspended(eventId, 'event');
  btn.innerHTML  = suspended ? '<span>🔒</span> SUSPENDED' : '<span>🔓</span> PUBLISHED';
  btn.className  = `suspend-btn ${suspended ? 'suspended' : 'open'}`;
  btn.title      = suspended ? 'Event SUSPENDED — click to publish' : 'Click to suspend entire event';
  btn.onclick = () => {
    const nowSuspended = isSuspended(eventId, 'event');
    setSuspension(eventId, 'event', nowSuspended ? 'open' : 'suspended');
    updateSuspendButton(eventId);
    const row = document.querySelector(`tr[data-event-id="${eventId}"]`);
    if (row) row.className = row.className
      .replace(/\bevent-suspended\b/g, '').trim()
      + (!nowSuspended ? ' event-suspended' : '');
    const ev = state.activeEvents.find(e => e.id.toString() === String(eventId));
    if (ev) renderDrawerMarkets(ev);
  };
}

export function updateModeButton(eventId) {
  const btn = document.getElementById('trading-mode-btn');
  if (!btn) return;
  const isManual  = getTradingMode(eventId) === 'manual';
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

// ── Template bar ──────────────────────────────────────────────────────────────

function renderTemplateBar(event, drawerContent) {
  const { template: activeTpl, source } = resolveTemplate(event.id, state.currentLeagueCode);
  const isOverride   = source === 'match';
  const leagueTplId  = getLeagueSetting(state.currentLeagueCode)?.template || null;
  const templates    = getTemplates();

  const bar = document.createElement('div');
  bar.className = 'drawer-tpl-bar';
  bar.innerHTML = `
    <div class="dtpl-left">
      <span class="dtpl-icon">⬡</span>
      <div class="dtpl-info">
        <span class="dtpl-label">Template</span>
        ${activeTpl
          ? `<button class="dtpl-name dtpl-name-link" data-tpl-id="${activeTpl.id}">${activeTpl.name}</button>`
          : `<span class="dtpl-name">None assigned</span>`}
      </div>
      ${activeTpl
        ? `<span class="dtpl-badge ${isOverride ? 'dtpl-override' : 'dtpl-league'}">${isOverride ? 'MATCH OVERRIDE' : 'LEAGUE'}</span>`
        : `<span class="dtpl-badge dtpl-none">NO TEMPLATE</span>`}
    </div>
    <div class="dtpl-right">
      <select class="dtpl-select" id="drawer-tpl-sel">
        <option value="">— league default${leagueTplId ? '' : ' (none)'} —</option>
        ${templates.map(t => `<option value="${t.id}" ${isOverride && activeTpl?.id === t.id ? 'selected' : ''}>${t.name}${!t.active ? ' (inactive)' : ''}</option>`).join('')}
      </select>
      ${isOverride ? `<button class="dtpl-reset-btn" id="drawer-tpl-reset" title="Revert to league template">Reset</button>` : ''}
    </div>`;

  bar.querySelector('#drawer-tpl-sel').addEventListener('change', (e) => {
    setMatchTemplate(event.id, e.target.value || null);
    renderDrawerMarkets(event);
  });
  bar.querySelector('#drawer-tpl-reset')?.addEventListener('click', () => {
    setMatchTemplate(event.id, null);
    renderDrawerMarkets(event);
  });
  bar.querySelector('.dtpl-name-link')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('navigate:template', { detail: { id: activeTpl.id } }));
  });

  drawerContent.appendChild(bar);
}

function showModelFallbackNotice(drawerContent) {
  const notice = document.createElement('div');
  notice.className = 'model-fallback-notice';
  notice.textContent = 'Model unavailable — showing Shin fair';
  drawerContent.appendChild(notice);
}

function applyShinAsModel(groupedMarkets) {
  Object.values(groupedMarkets).forEach(markets => {
    markets.forEach(market => {
      market.rows.forEach(row => {
        row.modelFair = row.shinFair || null;
      });
    });
  });
}

// ── Drawer open / close ───────────────────────────────────────────────────────

export async function openDrawer(eventId) {
  const event = state.activeEvents.find(e => e.id.toString() === eventId.toString());
  if (!event) return;
  const isNewEvent = state.drawerEventId !== eventId.toString();
  state.drawerEventId = eventId;
  if (isNewEvent) {
    state.activeCategory = 'MATCH ODDS';
    state.activeMarketId = null;
  }
  updateModeButton(eventId);
  updateSuspendButton(eventId);

  const { home: homeTeam, away: awayTeam } = getTeamNames(event);

  document.getElementById('drawer-match-name').textContent = `${homeTeam} vs ${awayTeam}`;
  const eventTime = event.starts || event.startTime || event.time;
  document.getElementById('drawer-match-time').textContent = eventTime
    ? new Date(eventTime).toLocaleString() : 'N/A';

  if (!isDetailedOddsFresh(eventId)) {
    try {
      const data = await fetchEventOdds(eventId);
      setDetailedOdds(eventId, data);
    } catch (e) {
      console.error('Failed to fetch detailed odds', e);
    }
  }

  renderDrawerMarkets(event);
  document.getElementById('side-drawer').classList.add('active');
  document.getElementById('drawer-overlay').classList.add('active');
}

export function closeDrawer() {
  document.getElementById('side-drawer').classList.remove('active');
  document.getElementById('drawer-overlay').classList.remove('active');
}

// ── Main drawer render ────────────────────────────────────────────────────────

export async function renderDrawerMarkets(event) {
  const freshEvent = state.activeEvents.find(e => e.id.toString() === event.id.toString());
  if (freshEvent) event = freshEvent;

  const drawerContent = document.getElementById('drawer-content');
  drawerContent.innerHTML = '';

  renderTemplateBar(event, drawerContent);

  let matchPeriod, h1Period;
  if (event.periods && !Array.isArray(event.periods)) {
    matchPeriod = event.periods['0'];
    h1Period    = event.periods['1'];
  } else {
    const arr   = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
    matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    h1Period    = arr.find(p => p.num === 1 || p.periodNumber === 1);
  }

  if (!matchPeriod) {
    drawerContent.insertAdjacentHTML('beforeend', '<div class="empty-state">No detailed markets available.</div>');
    return;
  }

  const { home: homeTeam, away: awayTeam } = getTeamNames(event);

  const isManual        = getTradingMode(event.id) === 'manual';
  const effectivePeriod = isManual
    ? getEffectiveMatchPeriod(matchPeriod, event.id, homeTeam, awayTeam)
    : matchPeriod;
  let lambdaData = null;
  let modelUnavailable = false;
  if (state.currentSportId !== 4) {
    try {
      lambdaData = await calculateTeamLambdasAsync(effectivePeriod, h1Period);
    } catch (error) {
      console.warn('Model calculation failed:', error);
      modelUnavailable = true;
    }
  }

  const ovLambdas          = getOverriddenLambdas(event.id);
  const effectiveLambdaData = (ovLambdas && lambdaData)
    ? { ...lambdaData, ft: { lh: ovLambdas.lh, la: ovLambdas.la, rho: ovLambdas.rho, grid: ovLambdas.grid } }
    : lambdaData;

  if (effectiveLambdaData) {
    drawerContent.appendChild(createLambdaSection(effectiveLambdaData, homeTeam, awayTeam));
  }

  const detailedAll    = getDetailedOdds(event.id) || {};
  const { template: activeTplMarkets } = resolveTemplate(event.id, state.currentLeagueCode);
  const groupedMarkets = groupMarketsByCategory(event, matchPeriod, h1Period, effectiveLambdaData, detailedAll, homeTeam, awayTeam, activeTplMarkets);
  if (modelUnavailable) {
    showModelFallbackNotice(drawerContent);
    applyShinAsModel(groupedMarkets);
  }

  const categories = Object.keys(groupedMarkets);
  if (categories.length === 0) return;

  if (!state.activeCategory || !groupedMarkets[state.activeCategory]) {
    state.activeCategory = categories[0];
  }

  const topNav = document.createElement('div');
  topNav.className = 'drawer-nav-top';
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className   = `top-tab-btn ${state.activeCategory === cat ? 'active' : ''}`;
    btn.textContent = cat;
    btn.onclick     = () => {
      state.activeCategory  = cat;
      state.activeMarketId  = null;
      renderDrawerMarkets(event);
    };
    topNav.appendChild(btn);
  });
  drawerContent.appendChild(topNav);

  const bodyLayout = document.createElement('div');
  bodyLayout.className = 'drawer-body-layout';

  const leftNav    = document.createElement('div');
  leftNav.className = 'drawer-nav-left';
  const activeGroup = groupedMarkets[state.activeCategory] || [];

  if (activeGroup.length > 0 && !activeGroup.find(m => m.id === state.activeMarketId)) {
    state.activeMarketId = activeGroup[0].id;
  }

  let mainContentRef = null;

  activeGroup.forEach(market => {
    const btn = document.createElement('button');

    const tplMarketId = DRAWER_TO_TPL_ID[market.id];
    const tplMarket   = activeTplMarkets && tplMarketId
      ? activeTplMarkets.markets?.find(m => m.id === tplMarketId)
      : null;
    const dotClass = tplMarket
      ? (tplMarket.enabled ? 'mkt-tpl-on' : 'mkt-tpl-off')
      : '';
    const noOffer = !marketHasOffer(market, activeTplMarkets);

    btn.className = `left-tab-btn ${state.activeMarketId === market.id ? 'active' : ''} ${noOffer ? 'mkt-no-offer' : ''}`.trim();
    btn.innerHTML = dotClass
      ? `<span class="mkt-tpl-dot ${dotClass}"></span><span>${market.name}</span>`
      : `<span>${market.name}</span>`;
    btn.onclick = () => {
      state.activeMarketId = market.id;
      leftNav.querySelectorAll('.left-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const newContent = document.createElement('div');
      newContent.className = 'drawer-main-content';
      newContent.appendChild(renderMarketTable(market));
      if (mainContentRef) mainContentRef.replaceWith(newContent);
      mainContentRef = newContent;
    };
    leftNav.appendChild(btn);
  });
  bodyLayout.appendChild(leftNav);

  const mainContent   = document.createElement('div');
  mainContent.className = 'drawer-main-content';
  mainContentRef = mainContent;
  const activeMarket  = activeGroup.find(m => m.id === state.activeMarketId);
  if (activeMarket) {
    mainContent.appendChild(renderMarketTable(activeMarket));
  } else {
    mainContent.innerHTML = '<div class="empty-state">Select a market</div>';
  }
  bodyLayout.appendChild(mainContent);
  drawerContent.appendChild(bodyLayout);
}
