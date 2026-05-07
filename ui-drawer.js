import { state, getTradingMode, clearAllOverridesForEvent, setTradingMode, isSuspended, setSuspension, getLeagueSetting, getTemplates, setMatchTemplate, getOverriddenLambdas } from './state.js';
import { fetchEventOdds } from './api.js';
import { resolveTemplate } from './pricing.js';
import { calculateTeamLambdas } from './math.js';
import { getEffectiveMatchPeriod } from './ui-helpers.js';
import { groupMarketsByCategory } from './ui-market-groups.js';
import { renderMarketTable, createLambdaSection } from './ui-market-table.js';

// ── Drawer header controls ────────────────────────────────────────────────────

function updateSuspendButton(eventId) {
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
        <span class="dtpl-name">${activeTpl ? activeTpl.name : 'None assigned'}</span>
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

  drawerContent.appendChild(bar);
}

// ── Drawer open / close ───────────────────────────────────────────────────────

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
    console.error('Failed to fetch detailed odds', e);
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

export function renderDrawerMarkets(event) {
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

  let homeTeam = event.home || 'Home';
  let awayTeam = event.away || 'Away';
  if (event.participants) {
    const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
    const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
    if (h) homeTeam = h.name || h.englishName;
    if (a) awayTeam = a.name || a.englishName;
  }

  const isManual        = getTradingMode(event.id) === 'manual';
  const effectivePeriod = isManual
    ? getEffectiveMatchPeriod(matchPeriod, event.id, homeTeam, awayTeam)
    : matchPeriod;
  const lambdaData      = calculateTeamLambdas(effectivePeriod, h1Period);

  const ovLambdas          = getOverriddenLambdas(event.id);
  const effectiveLambdaData = (ovLambdas && lambdaData)
    ? { ...lambdaData, ft: { lh: ovLambdas.lh, la: ovLambdas.la, rho: ovLambdas.rho, grid: ovLambdas.grid } }
    : lambdaData;

  if (effectiveLambdaData) {
    drawerContent.appendChild(createLambdaSection(effectiveLambdaData, homeTeam, awayTeam));
  }

  const detailedAll    = state.detailedOdds[event.id] || {};
  const groupedMarkets = groupMarketsByCategory(event, matchPeriod, h1Period, effectiveLambdaData, detailedAll, homeTeam, awayTeam);

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

  activeGroup.forEach(market => {
    const btn = document.createElement('button');
    btn.className   = `left-tab-btn ${state.activeMarketId === market.id ? 'active' : ''}`;
    btn.textContent = market.name;
    btn.onclick     = () => {
      state.activeMarketId = market.id;
      renderDrawerMarkets(event);
    };
    leftNav.appendChild(btn);
  });
  bodyLayout.appendChild(leftNav);

  const mainContent   = document.createElement('div');
  mainContent.className = 'drawer-main-content';
  const activeMarket  = activeGroup.find(m => m.id === state.activeMarketId);
  if (activeMarket) {
    mainContent.appendChild(renderMarketTable(activeMarket));
  } else {
    mainContent.innerHTML = '<div class="empty-state">Select a market</div>';
  }
  bodyLayout.appendChild(mainContent);
  drawerContent.appendChild(bodyLayout);
}
