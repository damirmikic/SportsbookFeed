import { state } from './state.js';
import {
  getTemplates,
  getLeagueSetting,
  setLeagueSetting,
  isLeagueSuspended,
  setLeagueSuspension,
  isSuspended,
  hasAnySuspension,
  getTradingMode,
  hasAnyOverrideForEvent,
} from './state.js';
import { fetchActiveTraders } from './api.js';
import { resolveTemplate } from './pricing.js';

// ── Filter state ──────────────────────────────────────────
const filters = { category: '', tournament: '', template: '', unassigned: false };

// ── Helpers ───────────────────────────────────────────────
function getCountry(league) {
  const n = league.name || league.leagueName || '';
  return n.includes(' - ') ? n.split(' - ')[0].trim() : 'International';
}

function getLeagueName(league) {
  const n = league.name || league.leagueName || '';
  return n.includes(' - ') ? n.split(' - ').slice(1).join(' - ').trim() : n;
}

function getCode(league) {
  return league.code || league.leagueCode || league.id;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getEventLeagueCode(event) {
  return event.leagueCode || event.league_code || event.league?.code || state.currentLeagueCode;
}

function getEventStart(event) {
  const raw = event.starts || event.startTime || event.time || event.start;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isEventLive(event, now = Date.now()) {
  if (event.live === true || event.isLive === true) return true;
  const status = String(event.status || event.gameStatus || event.state || '').toLowerCase();
  if (['live', 'inplay', 'in-play', 'in progress', 'running'].includes(status)) return true;
  const start = getEventStart(event);
  return !!start && start.getTime() <= now && status && !['final', 'finished', 'ended', 'closed'].includes(status);
}

function isTodayEvent(event) {
  const start = getEventStart(event);
  if (!start) return isEventLive(event);
  const today = new Date();
  return start.getFullYear() === today.getFullYear()
    && start.getMonth() === today.getMonth()
    && start.getDate() === today.getDate();
}

function formatRelativeTime(iso) {
  if (!iso) return 'No Turso push recorded';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60 * 1000) return 'Just now';
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function computeAdminSummary() {
  const loadedEvents = state.activeEvents || [];
  const events = loadedEvents.filter(isTodayEvent);
  const now = Date.now();
  const inTwoHours = now + 2 * 60 * 60 * 1000;
  const unpricedSoon = [];

  const summary = events.reduce((acc, event) => {
    const leagueCode = getEventLeagueCode(event);
    const hasTemplate = !!resolveTemplate(event.id, leagueCode).template;
    const start = getEventStart(event);

    if (isEventLive(event, now)) acc.live += 1;
    if (hasTemplate) acc.priced += 1;
    if (isSuspended(event.id, 'event') || hasAnySuspension(event.id)) acc.suspended += 1;
    if (getTradingMode(event.id) === 'manual' || hasAnyOverrideForEvent(event.id)) acc.manual += 1;
    if (!hasTemplate && start && start.getTime() >= now && start.getTime() <= inTwoHours) {
      unpricedSoon.push(event);
    }
    return acc;
  }, { live: 0, priced: 0, suspended: 0, manual: 0 });

  return { ...summary, total: events.length, loadedTotal: loadedEvents.length, unpricedSoon };
}

function summaryHTML() {
  const summary = computeAdminSummary();
  const syncAt = state.sharedSyncLastPushedAt;
  const syncAgeMs = syncAt ? Date.now() - Date.parse(syncAt) : Infinity;
  const isSyncStale = !syncAt || syncAgeMs > 5 * 60 * 1000 || state.sharedSyncStatus === 'retrying';
  const scope = state.currentLeagueName || state.currentLeagueCode || 'selected league';

  return `
    <section class="admin-overview">
      <div class="admin-overview-head">
        <div>
          <h2>Today's Activity</h2>
          <p>${summary.loadedTotal ? `Today in loaded scope: ${escapeHtml(scope)}` : 'Select a league to populate event activity.'}</p>
        </div>
        <div class="admin-sync-card ${isSyncStale ? 'stale' : 'fresh'}">
          <span>Sync status</span>
          <strong>${formatRelativeTime(syncAt)}</strong>
          <small>${isSyncStale ? 'Shared state may be stale' : 'Shared state current'}</small>
        </div>
      </div>
      <div class="admin-metric-grid">
        <div class="admin-metric"><span>Live now</span><strong>${summary.live}</strong></div>
        <div class="admin-metric"><span>Priced</span><strong>${summary.priced}</strong></div>
        <div class="admin-metric"><span>Suspended</span><strong>${summary.suspended}</strong></div>
        <div class="admin-metric"><span>Manual overrides</span><strong>${summary.manual}</strong></div>
      </div>
      <div class="admin-alert ${summary.unpricedSoon.length ? 'critical' : 'clear'}">
        <strong>${summary.unpricedSoon.length} events start in the next 2 hours with no template assigned</strong>
        <span>${summary.unpricedSoon.length ? 'Critical pricing gap' : 'No immediate unpriced-event gap in the loaded scope'}</span>
      </div>
      <div class="admin-presence">
        <div class="admin-presence-head">
          <h3>Active traders</h3>
          <span id="admin-presence-updated">Refreshing…</span>
        </div>
        <div id="admin-active-traders" class="admin-trader-list">
          ${activeTradersHTML(state.activeTraders)}
        </div>
      </div>
    </section>`;
}

function activeTradersHTML(traders) {
  if (!traders?.length) return '<div class="admin-trader-empty">No active traders in the last 3 minutes.</div>';
  return traders.map((trader) => `
    <div class="admin-trader-row">
      <span class="admin-trader-dot" style="background:${escapeHtml(trader.color || '#64748b')}"></span>
      <strong>${escapeHtml(trader.name || 'Operator')}</strong>
      <span>${escapeHtml(trader.league_name || trader.leagueName || trader.league_code || trader.leagueCode || 'No league selected')}</span>
    </div>
  `).join('');
}

async function refreshActiveTraders() {
  try {
    state.activeTraders = await fetchActiveTraders();
    const list = document.getElementById('admin-active-traders');
    const updated = document.getElementById('admin-presence-updated');
    if (list) list.innerHTML = activeTradersHTML(state.activeTraders);
    if (updated) updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    console.warn('Failed to refresh active traders:', error);
    const updated = document.getElementById('admin-presence-updated');
    if (updated) updated.textContent = 'Unavailable';
  }
}

function filteredLeagues() {
  return state.allLeagues.filter(l => {
    const s = getLeagueSetting(getCode(l));
    if (filters.category && getCountry(l) !== filters.category) return false;
    if (filters.tournament && !getLeagueName(l).toLowerCase().includes(filters.tournament.toLowerCase())) return false;
    if (filters.template && s.template !== filters.template) return false;
    if (filters.unassigned && s.template) return false;
    return true;
  });
}

// ── HTML builders ─────────────────────────────────────────
function filterBarHTML(countries, templates) {
  return `
    <div class="admin-filter-bar">
      <div class="admin-filters-left">
        <div class="admin-sport-pill">
          <span class="asp-label">SPORT</span>
          <span class="asp-badge">1</span>
          <span class="asp-check">✓</span>
        </div>
        <select class="admin-sel" id="a-cat">
          <option value="">CATEGORY</option>
          ${countries.map(c => `<option value="${c}" ${filters.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <select class="admin-sel" id="a-trn">
          <option value="">TOURNAMENT</option>
          ${state.allLeagues.map(l => {
            const n = getLeagueName(l);
            return `<option value="${n}" ${filters.tournament === n ? 'selected' : ''}>${n}</option>`;
          }).join('')}
        </select>
        <select class="admin-sel" id="a-tpl">
          <option value="">TEMPLATE</option>
          ${templates.map(t => `<option value="${t.id}" ${filters.template === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
        </select>
        <label class="admin-cb-label">
          <input type="checkbox" id="a-uns" ${filters.unassigned ? 'checked' : ''}> Unassigned tournaments
        </label>
      </div>
      <div class="admin-filters-right">
        <button class="admin-act-btn" id="a-cat-assign">CATEGORY ASSIGNMENT</button>
        <button class="admin-act-btn admin-act-primary" id="a-change-all">CHANGE ALL TOURNAMENTS</button>
      </div>
    </div>`;
}

function chipsBarHTML(templates) {
  const extras = [];
  if (filters.category) extras.push({ key: 'category', label: filters.category });
  if (filters.tournament) extras.push({ key: 'tournament', label: filters.tournament });
  if (filters.template) {
    const t = templates.find(t => t.id === filters.template);
    if (t) extras.push({ key: 'template', label: t.name });
  }
  return `
    <div class="admin-chips-bar">
      <button class="admin-clear-btn" id="a-clear">REMOVE ALL FILTERS</button>
      <span class="admin-chip">× Soccer</span>
      ${extras.map(e => `<span class="admin-chip admin-chip-rm" data-key="${e.key}">× ${e.label}</span>`).join('')}
    </div>`;
}

function alertSliderHTML(code, af) {
  const steps = [0, 0.5, 1, 1.5, 2];
  const dots = steps.map(v =>
    `<button class="af-dot ${Math.abs(af - v) < 0.01 ? 'active' : ''}" data-code="${code}" data-v="${v}" title="${v}"></button>`
  ).join('');
  return `
    <div class="af-wrap">
      <div class="af-labels"><span>mute</span><span>medium</span><span>high</span></div>
      <div class="af-track">${dots}</div>
      <div class="af-nums"><span>0</span><span>1</span><span>2</span></div>
    </div>`;
}

function rowHTML(league, templates) {
  const code = getCode(league);
  const s    = getLeagueSetting(code);
  const act  = s.activation || 'off';
  const af   = s.alertFactor ?? 1;
  const leagueSuspended = isLeagueSuspended(code);

  return `
    <tr class="admin-row">
      <td class="atd-name">
        <span class="atd-crumb">Soccer › ${getCountry(league)}</span>
        <span class="atd-title">${getLeagueName(league)}</span>
      </td>
      <td class="atd-tmpl">
        <select class="a-tmpl-sel" data-code="${code}">
          <option value="">Select an option</option>
          ${templates.map(t => `<option value="${t.id}" ${s.template === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
        </select>
      </td>
      <td class="atd-act">
        <div class="act-group">
          <button class="act-seg ${act === 'ctrl' ? 'act-on' : ''}" data-code="${code}" data-m="ctrl">CTRL</button>
          <button class="act-seg ${act === 'mon'  ? 'act-on' : ''}" data-code="${code}" data-m="mon">MON</button>
          <button class="act-seg ${act === 'off'  ? 'act-inactive' : ''}" data-code="${code}" data-m="off">OFF</button>
        </div>
      </td>
      <td class="atd-bk">Soccer</td>
      <td class="atd-af">${alertSliderHTML(code, af)}</td>
      <td class="atd-susp">
        <button class="admin-league-suspend-btn ${leagueSuspended ? 'suspended' : 'open'}" data-code="${code}">
          ${leagueSuspended ? 'Publish league' : 'Suspend all'}
        </button>
      </td>
    </tr>`;
}

function tableHTML(leagues, templates) {
  return `
    <div class="admin-table-wrap">
      <table class="admin-tbl">
        <thead>
          <tr>
            <th>Tournament</th>
            <th>Templates</th>
            <th>Activation</th>
            <th>Bookmaker List</th>
            <th>Alert Factors</th>
            <th>League Suspension</th>
          </tr>
        </thead>
        <tbody>
          ${leagues.length
            ? leagues.map(l => rowHTML(l, templates)).join('')
            : '<tr><td colspan="6" class="admin-empty">No tournaments match the current filters.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// ── Main render ───────────────────────────────────────────
export function renderAdminPanel() {
  const panel = document.getElementById('admin-panel');
  if (!panel) return;

  const templates = getTemplates();
  const countries = [...new Set(state.allLeagues.map(getCountry))].sort();
  const leagues   = filteredLeagues();

  panel.innerHTML =
    summaryHTML() +
    filterBarHTML(countries, templates) +
    chipsBarHTML(templates) +
    tableHTML(leagues, templates);

  wirePanel(panel, templates);
  refreshActiveTraders();
}

// ── Event wiring ──────────────────────────────────────────
function wirePanel(panel, templates) {
  // Filter controls → full re-render
  panel.querySelector('#a-cat').addEventListener('change', e => { filters.category   = e.target.value; renderAdminPanel(); });
  panel.querySelector('#a-trn').addEventListener('change', e => { filters.tournament = e.target.value; renderAdminPanel(); });
  panel.querySelector('#a-tpl').addEventListener('change', e => { filters.template   = e.target.value; renderAdminPanel(); });
  panel.querySelector('#a-uns').addEventListener('change', e => { filters.unassigned = e.target.checked; renderAdminPanel(); });

  panel.querySelector('#a-clear').addEventListener('click', () => {
    Object.assign(filters, { category: '', tournament: '', template: '', unassigned: false });
    renderAdminPanel();
  });

  panel.querySelectorAll('.admin-chip-rm').forEach(chip =>
    chip.addEventListener('click', () => { filters[chip.dataset.key] = ''; renderAdminPanel(); })
  );

  // Bulk: apply selected template to all visible rows
  panel.querySelector('#a-change-all').addEventListener('click', () => {
    if (!filters.template) {
      showAdminToast('Select a template in the TEMPLATE filter first, then click CHANGE ALL TOURNAMENTS.');
      return;
    }
    filteredLeagues().forEach(l => setLeagueSetting(getCode(l), { template: filters.template }));
    renderAdminPanel();
  });

  // Category assignment (placeholder — will open modal in future)
  panel.querySelector('#a-cat-assign').addEventListener('click', () => {
    showAdminToast('Category Assignment: select a CATEGORY filter, then use CHANGE ALL TOURNAMENTS to bulk-assign a template.');
  });

  // Row: template select (no re-render needed)
  panel.querySelectorAll('.a-tmpl-sel').forEach(sel =>
    sel.addEventListener('change', e =>
      setLeagueSetting(e.target.dataset.code, { template: e.target.value || null })
    )
  );

  // Row: activation toggle
  panel.querySelectorAll('.act-seg').forEach(btn =>
    btn.addEventListener('click', () => {
      const { code, m: mode } = btn.dataset;
      setLeagueSetting(code, { activation: mode });
      btn.closest('.act-group').querySelectorAll('.act-seg').forEach(b => {
        b.classList.remove('act-on', 'act-inactive');
        if (b.dataset.m === mode) b.classList.add(mode === 'off' ? 'act-inactive' : 'act-on');
      });
    })
  );

  // Row: alert factor dots
  panel.querySelectorAll('.af-dot').forEach(dot =>
    dot.addEventListener('click', () => {
      const { code, v } = dot.dataset;
      setLeagueSetting(code, { alertFactor: parseFloat(v) });
      dot.closest('.af-track').querySelectorAll('.af-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
    })
  );

  panel.querySelectorAll('.admin-league-suspend-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const { code } = btn.dataset;
      const nextStatus = isLeagueSuspended(code) ? 'open' : 'suspended';
      setLeagueSuspension(code, nextStatus);
      renderAdminPanel();
      showAdminToast(nextStatus === 'suspended'
        ? `Suspended all markets in league ${code}.`
        : `Published league ${code}.`);
    })
  );
}

// ── Toast notification ────────────────────────────────────
function showAdminToast(msg) {
  let toast = document.getElementById('admin-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'admin-toast';
    toast.className = 'admin-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), 3500);
}
