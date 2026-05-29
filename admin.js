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
  TIMELINE_NODES,
  canDo,
  getAllPendingOverrides,
  removePendingOverride,
  setPendingOverride,
  setOverride,
} from './state.js';
import { fetchActiveTraders, fetchTraders, createTrader, updateTrader, updateOrgName } from './api.js';
import { resolveTemplate } from './pricing.js';

// ── Filter state ──────────────────────────────────────────
const filters = { category: '', tournament: '', template: '', unassigned: false };

// ── Active sport ──────────────────────────────────────────
// Tracks which admin section is currently being rendered ('soccer' | 'basketball').
let currentAdminSport = 'soccer';

function getAdminLeagues() {
  if (currentAdminSport === 'basketball') return state.basketballLeagues.length ? state.basketballLeagues : state.allLeagues.filter(l => {
    const n = (l.name || l.leagueName || '').toLowerCase();
    return l.sport === 'basketball' || n.includes('basketball') || n.includes('nba');
  });
  return state.soccerLeagues.length ? state.soccerLeagues : state.allLeagues.filter(l => {
    const n = (l.name || l.leagueName || '').toLowerCase();
    return !l.sport || l.sport === 'soccer' || l.sport === 'football' || (!n.includes('basketball') && !n.includes('nba'));
  });
}

const SPORT_LABEL = { soccer: 'Soccer', basketball: 'Basketball' };

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

function pendingApprovalsHTML() {
  const all = getAllPendingOverrides();
  const myId = state.currentTraderId;
  const pending = Object.entries(all).filter(([, data]) => data.requestedById !== myId);
  if (!pending.length || !canDo('manage-leagues')) return '';

  const rows = pending.map(([key, data]) => {
    const timeAgo = data.requestedAt
      ? formatRelativeTime(data.requestedAt)
      : 'Unknown time';
    return `
      <div class="approval-row" data-key="${escapeHtml(key)}">
        <span class="approval-key">${escapeHtml(key)}</span>
        <span class="approval-price">${parseFloat(data.price).toFixed(3)}</span>
        <span class="approval-requester">by ${escapeHtml(data.requestedByName || 'Unknown')}</span>
        <span class="approval-time">${timeAgo}</span>
        <button class="approval-approve-btn" data-key="${escapeHtml(key)}">Approve</button>
        <button class="approval-reject-btn" data-key="${escapeHtml(key)}">Reject</button>
      </div>`;
  }).join('');

  return `
    <section class="admin-approvals">
      <h3 class="admin-approvals-title">Pending Approvals (${pending.length})</h3>
      <div class="admin-approvals-list">${rows}</div>
    </section>`;
}

function traderManagementHTML() {
  if (!canDo('manage-traders')) return '';
  return `
    <div class="admin-trader-mgmt" id="admin-trader-mgmt-section">
      <h3>Trader Management</h3>
      <div id="admin-trader-mgmt-list"><em>Loading traders…</em></div>
    </div>`;
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
      ${traderManagementHTML()}
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
  return getAdminLeagues().filter(l => {
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
  const sportLeagues = getAdminLeagues();
  return `
    <div class="admin-filter-bar">
      <div class="admin-filters-left">
        <div class="admin-sport-pill admin-sport-pill--${currentAdminSport}">
          <span class="asp-label">SPORT</span>
          <span class="asp-badge asp-badge--${currentAdminSport}">${SPORT_LABEL[currentAdminSport] || currentAdminSport}</span>
          <span class="asp-check">✓</span>
        </div>
        <select class="admin-sel" id="a-cat">
          <option value="">CATEGORY</option>
          ${countries.map(c => `<option value="${c}" ${filters.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <select class="admin-sel" id="a-trn">
          <option value="">TOURNAMENT</option>
          ${sportLeagues.map(l => {
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
  const sportLabel = SPORT_LABEL[currentAdminSport] || currentAdminSport;
  return `
    <div class="admin-chips-bar">
      <button class="admin-clear-btn" id="a-clear">REMOVE ALL FILTERS</button>
      <span class="admin-chip admin-chip--sport">× ${sportLabel}</span>
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
  const timelineCount = (s.templateTimeline || []).length;
  const readonly = !canDo('manage-leagues');
  const approvalThreshold = s.approvalThresholdBet ?? '';

  const sportLabel = SPORT_LABEL[currentAdminSport] || currentAdminSport;
  return `
    <tr class="admin-row" data-code="${code}">
      <td class="atd-name">
        <span class="atd-crumb">${sportLabel} › ${getCountry(league)}</span>
        <span class="atd-title">${getLeagueName(league)}</span>
        <button class="hn-edit-btn ${s.handoverNote ? 'has-note' : ''}" data-code="${code}" title="Shift note">📝</button>
      </td>
      <td class="atd-tmpl">
        <select class="a-tmpl-sel" data-code="${code}" ${readonly ? 'disabled title="Senior access required"' : ''}>
          <option value="">Select an option</option>
          ${templates.map(t => `<option value="${t.id}" ${s.template === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
        </select>
        <button class="feed-tl-btn ${timelineCount > 0 ? 'has-tl' : ''}"
                data-code="${code}"
                data-league-name="${escapeHtml(getLeagueName(league))}"
                ${readonly ? 'disabled title="Senior access required"' : ''}>
          ${timelineCount > 0 ? `Timeline (${timelineCount})` : '+ Feed Timeline'}
        </button>
      </td>
      <td class="atd-act">
        <div class="act-group">
          <button class="act-seg ${act === 'ctrl' ? 'act-on' : ''}" data-code="${code}" data-m="ctrl" ${readonly ? 'disabled title="Senior access required"' : ''}>CTRL</button>
          <button class="act-seg ${act === 'mon'  ? 'act-on' : ''}" data-code="${code}" data-m="mon" ${readonly ? 'disabled title="Senior access required"' : ''}>MON</button>
          <button class="act-seg ${act === 'off'  ? 'act-inactive' : ''}" data-code="${code}" data-m="off" ${readonly ? 'disabled title="Senior access required"' : ''}>OFF</button>
        </div>
      </td>
      <td class="atd-bk">${sportLabel}</td>
      <td class="atd-af">
        ${alertSliderHTML(code, af)}
        <div class="approval-threshold-wrap">
          <label class="approval-threshold-label" title="Overrides on markets with maxBet ≥ this value require senior approval">Approval threshold £</label>
          <input type="number" class="approval-threshold-input" data-code="${code}"
            value="${approvalThreshold}" placeholder="None" min="1" step="100"
            ${readonly ? 'disabled' : ''}>
        </div>
      </td>
      <td class="atd-susp">
        <button class="admin-league-suspend-btn ${leagueSuspended ? 'suspended' : 'open'}" data-code="${code}" ${readonly ? 'disabled title="Senior access required"' : ''}>
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

// ── Feed Timeline Modal ───────────────────────────────────
let _ftlCode = null;
let _ftlRows = [];

function ftlRowsHTML(rows, templates, usedNodes) {
  if (!rows.length) return '<tr><td colspan="3" class="feed-tl-empty">No nodes configured. Use the controls below to add one.</td></tr>';
  return rows.map((row, i) => {
    const node = TIMELINE_NODES.find(n => n.id === row.nodeId);
    const tpl  = templates.find(t => t.id === row.templateId);
    return `
      <tr class="feed-tl-row">
        <td class="ftl-node">${node ? node.label : row.nodeId}</td>
        <td class="ftl-tpl">${tpl ? escapeHtml(tpl.name) : '<em>Unknown template</em>'}</td>
        <td class="ftl-del"><button class="ftl-del-btn" data-idx="${i}" title="Remove">×</button></td>
      </tr>`;
  }).join('');
}

function ftlAvailableNodes(rows) {
  const used = new Set(rows.map(r => r.nodeId));
  return TIMELINE_NODES.filter(n => !used.has(n.id));
}

function openFeedTimelineModal(code, leagueName, templates) {
  closeFeedTimelineModal();
  _ftlCode = code;
  const s = getLeagueSetting(code);
  _ftlRows = JSON.parse(JSON.stringify(s.templateTimeline || []));

  const backdrop = document.createElement('div');
  backdrop.id = 'feed-tl-backdrop';
  backdrop.className = 'tpl-modal-backdrop';
  backdrop.innerHTML = `
    <div class="tpl-modal feed-tl-modal" role="dialog" aria-modal="true">
      <div class="tpl-modal-header">
        <h3>Feed Timeline &mdash; ${escapeHtml(leagueName)}</h3>
        <button class="tpl-modal-close" id="feed-tl-close">&times;</button>
      </div>
      <div class="tpl-modal-body">
        <p class="feed-tl-desc">Configure which template activates at each time threshold before kick-off. Nodes are evaluated nearest-to-kick-off first; the first matching node wins.</p>
        <table class="feed-tl-table">
          <thead>
            <tr><th>Node</th><th>Template</th><th></th></tr>
          </thead>
          <tbody id="feed-tl-rows"></tbody>
        </table>
        <div class="feed-tl-add-row">
          <select id="ftl-node-sel">
            <option value="">Select node&hellip;</option>
          </select>
          <select id="ftl-tpl-sel">
            <option value="">Select template&hellip;</option>
            ${templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
          </select>
          <button class="feed-tl-add-btn" id="ftl-add-btn">Add</button>
        </div>
      </div>
      <div class="tpl-modal-footer">
        <button class="feed-tl-save-btn" id="ftl-save">Save Timeline</button>
        <button class="feed-tl-cancel-btn" id="ftl-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('visible'));

  function refreshRows() {
    backdrop.querySelector('#feed-tl-rows').innerHTML = ftlRowsHTML(_ftlRows, templates);
    const nodeSel = backdrop.querySelector('#ftl-node-sel');
    const available = ftlAvailableNodes(_ftlRows);
    nodeSel.innerHTML = '<option value="">Select node…</option>'
      + available.map(n => `<option value="${n.id}">${n.label}</option>`).join('');
  }

  refreshRows();

  backdrop.querySelector('#feed-tl-close').addEventListener('click', closeFeedTimelineModal);
  backdrop.querySelector('#ftl-cancel').addEventListener('click', closeFeedTimelineModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeFeedTimelineModal(); });

  backdrop.querySelector('#feed-tl-rows').addEventListener('click', e => {
    const btn = e.target.closest('.ftl-del-btn');
    if (!btn) return;
    _ftlRows.splice(parseInt(btn.dataset.idx, 10), 1);
    refreshRows();
  });

  backdrop.querySelector('#ftl-add-btn').addEventListener('click', () => {
    const nodeId = backdrop.querySelector('#ftl-node-sel').value;
    const templateId = backdrop.querySelector('#ftl-tpl-sel').value;
    if (!nodeId || !templateId) {
      showAdminToast('Select both a node and a template before adding.');
      return;
    }
    if (_ftlRows.some(r => r.nodeId === nodeId)) {
      showAdminToast('That node is already in the timeline.');
      return;
    }
    _ftlRows.push({ nodeId, templateId });
    _ftlRows.sort((a, b) => TIMELINE_NODES.findIndex(n => n.id === a.nodeId) - TIMELINE_NODES.findIndex(n => n.id === b.nodeId));
    refreshRows();
  });

  backdrop.querySelector('#ftl-save').addEventListener('click', () => {
    setLeagueSetting(_ftlCode, { templateTimeline: _ftlRows });
    closeFeedTimelineModal();
    renderAdminPanel();
    showAdminToast(_ftlRows.length ? `Feed timeline saved (${_ftlRows.length} node${_ftlRows.length > 1 ? 's' : ''}).` : 'Feed timeline cleared.');
  });
}

function closeFeedTimelineModal() {
  const el = document.getElementById('feed-tl-backdrop');
  if (!el) return;
  el.classList.remove('visible');
  setTimeout(() => el.remove(), 200);
}

// ── Main render ───────────────────────────────────────────
export function renderAdminPanel(sport) {
  // Persist the sport context so all helper functions can read it.
  if (sport) currentAdminSport = sport;

  // When the sport changes, reset sport-specific filters that no longer make sense.
  if (sport) Object.assign(filters, { category: '', tournament: '', template: '', unassigned: false });

  const panel = document.getElementById('admin-panel');
  if (!panel) return;

  const allTemplates = getTemplates();
  // Filter templates to only show those relevant to the current sport.
  const templates = allTemplates.filter(t => !t.sport || t.sport === currentAdminSport);
  const sportLeagues = getAdminLeagues();
  const countries = [...new Set(sportLeagues.map(getCountry))].sort();
  const leagues   = filteredLeagues();

  panel.innerHTML =
    summaryHTML() +
    pendingApprovalsHTML() +
    filterBarHTML(countries, templates) +
    chipsBarHTML(templates) +
    tableHTML(leagues, templates);

  wirePanel(panel, templates);
  refreshActiveTraders();
  if (canDo('manage-traders')) loadTraderManagement();
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

  // Row: feed timeline button
  panel.querySelectorAll('.feed-tl-btn').forEach(btn =>
    btn.addEventListener('click', () =>
      openFeedTimelineModal(btn.dataset.code, btn.dataset.leagueName, templates)
    )
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

  // Approval threshold inputs
  panel.querySelectorAll('.approval-threshold-input').forEach(input =>
    input.addEventListener('change', () => {
      const { code } = input.dataset;
      const val = parseFloat(input.value);
      setLeagueSetting(code, { approvalThresholdBet: (!isNaN(val) && val > 0) ? val : null });
    })
  );

  // Pending approval buttons
  panel.querySelectorAll('.approval-approve-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      const data = getAllPendingOverrides()[key];
      if (!data) return;
      removePendingOverride(key);
      setOverride(key, data.price);
      renderAdminPanel();
      showAdminToast(`Override approved: ${key} → ${parseFloat(data.price).toFixed(3)}`);
    })
  );

  panel.querySelectorAll('.approval-reject-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      removePendingOverride(key);
      renderAdminPanel();
      showAdminToast(`Override rejected: ${key}`);
    })
  );

  // Handover note buttons
  panel.querySelectorAll('.hn-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { code } = btn.dataset;
      const existingRow = panel.querySelector(`.hn-row[data-code="${code}"]`);
      if (existingRow) { existingRow.remove(); return; }
      const mainRow = panel.querySelector(`tr.admin-row[data-code="${code}"]`);
      if (!mainRow) return;
      const s = getLeagueSetting(code);
      const hnRow = document.createElement('tr');
      hnRow.className = 'hn-row';
      hnRow.dataset.code = code;
      hnRow.innerHTML = `
        <td colspan="6">
          <div class="hn-row-inner">
            <textarea class="hn-textarea" placeholder="Shift handover note…">${escapeHtml(s.handoverNote || '')}</textarea>
            <button class="hn-save-btn">Save Note</button>
            <button class="hn-cancel-btn">Cancel</button>
          </div>
        </td>`;
      mainRow.insertAdjacentElement('afterend', hnRow);
      hnRow.querySelector('.hn-save-btn').addEventListener('click', () => {
        const text = hnRow.querySelector('.hn-textarea').value.trim() || null;
        setLeagueSetting(code, { handoverNote: text });
        hnRow.remove();
        // Update button state without full re-render
        btn.classList.toggle('has-note', !!text);
        showAdminToast(text ? 'Shift note saved.' : 'Shift note cleared.');
      });
      hnRow.querySelector('.hn-cancel-btn').addEventListener('click', () => hnRow.remove());
    });
  });
}

// ── Trader management (async) ─────────────────────────────
async function loadTraderManagement() {
  const container = document.getElementById('admin-trader-mgmt-list');
  if (!container) return;
  try {
    const traders = await fetchTraders();
    const ROLES = ['monitor', 'trader', 'senior'];
    container.innerHTML = `
      <table class="admin-tbl trader-mgmt-tbl">
        <thead><tr><th>Color</th><th>Name</th><th>Role</th><th></th></tr></thead>
        <tbody>
          ${traders.map(t => `
            <tr class="trader-mgmt-row" data-tid="${escapeHtml(t.id)}">
              <td><span class="admin-trader-dot" style="background:${escapeHtml(t.color || '#64748b')}"></span></td>
              <td>${escapeHtml(t.name)}</td>
              <td>
                <select class="trader-role-sel" data-tid="${escapeHtml(t.id)}">
                  ${ROLES.map(r => `<option value="${r}" ${(t.role || 'trader') === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`).join('')}
                </select>
              </td>
              <td><button class="trader-role-save-btn" data-tid="${escapeHtml(t.id)}">Save</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    container.querySelectorAll('.trader-role-save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { tid } = btn.dataset;
        const sel = container.querySelector(`.trader-role-sel[data-tid="${tid}"]`);
        if (!sel) return;
        try {
          await updateTrader(tid, { role: sel.value });
          showAdminToast('Trader role updated.');
        } catch (e) {
          showAdminToast(`Failed to update role: ${e.message}`);
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="admin-trader-empty">Failed to load traders: ${escapeHtml(e.message)}</div>`;
  }
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

// ── Operators panel ───────────────────────────────────────

const IS_LOCAL_ADMIN = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const ROLE_LABELS    = { owner: 'Owner', senior: 'Senior', trader: 'Trader', monitor: 'Monitor' };
const ADD_COLORS     = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#e11d48','#06b6d4'];

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function mockCreateOperator(name, color, pin, role) {
  const traders = JSON.parse(localStorage.getItem('_mock_traders') || '[]');
  if (traders.find(t => t.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('An operator with this name already exists.');
  }
  const trader = {
    id: crypto.randomUUID(), name, color,
    pin_hash: await sha256hex(pin), role,
    created_at: new Date().toISOString(), active: 1,
  };
  localStorage.setItem('_mock_traders', JSON.stringify([...traders, trader]));
  return { id: trader.id, name: trader.name, color: trader.color, role: trader.role };
}

async function mockResetPin(id, pin) {
  const traders = JSON.parse(localStorage.getItem('_mock_traders') || '[]');
  const t = traders.find(x => x.id === id);
  if (!t) throw new Error('Operator not found');
  t.pin_hash = await sha256hex(pin);
  t.failed_attempts = 0;
  t.locked_until = null;
  localStorage.setItem('_mock_traders', JSON.stringify(traders));
}

function operatorRolePill(role) {
  return `<span class="op-role-pill op-role-pill--${role}">${ROLE_LABELS[role] || role}</span>`;
}

function renderOperatorsRows(traders) {
  if (!traders.length) return `<div class="op-empty">No operators yet.</div>`;
  const currentId = state.currentTraderId;
  return traders.map(t => {
    const isMe    = t.id === currentId;
    const canEdit = canDo('manage-traders') && t.role !== 'owner';
    const roleCell = canEdit
      ? `<select class="op-role-select" data-id="${escapeHtml(t.id)}" data-orig="${t.role}">
           ${['trader','senior','monitor'].map(r =>
             `<option value="${r}" ${t.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`
           ).join('')}
         </select>`
      : operatorRolePill(t.role);
    return `
      <div class="op-row" data-id="${escapeHtml(t.id)}">
        <div class="op-row-avatar" style="background:${t.color}">${t.name.trim().charAt(0).toUpperCase()}</div>
        <div class="op-row-name">${escapeHtml(t.name)}${isMe ? ' <span class="op-you">you</span>' : ''}</div>
        <div class="op-row-role">${roleCell}</div>
        ${canEdit ? `<button class="op-pin-btn" data-id="${escapeHtml(t.id)}" title="Reset PIN">🔑 Reset PIN</button>` : ''}
      </div>
      ${canEdit ? `
      <div class="op-pin-form hidden" id="op-pin-form-${escapeHtml(t.id)}">
        <input class="op-input op-pin-input" type="password" placeholder="New PIN (4–6 digits)" maxlength="6" inputmode="numeric" autocomplete="new-password">
        <input class="op-input op-pin-input" type="password" placeholder="Confirm PIN" maxlength="6" inputmode="numeric" autocomplete="new-password">
        <div class="op-pin-form-actions">
          <button class="op-save-btn op-pin-save" data-id="${escapeHtml(t.id)}">Save</button>
          <button class="op-cancel-btn op-pin-cancel" data-id="${escapeHtml(t.id)}">Cancel</button>
        </div>
        <p class="op-add-error hidden"></p>
      </div>` : ''}`;
  }).join('');
}

export async function renderOperatorsPanel() {
  const panel = document.getElementById('operators-panel');
  if (!panel) return;

  panel.innerHTML = `<div class="op-loading">Loading…</div>`;

  let traders = [], orgName = localStorage.getItem('orgName') || '';
  try {
    const res = await fetchTraders();
    traders = res.traders ?? res;
    if (res.orgName) { orgName = res.orgName; localStorage.setItem('orgName', orgName); }
  } catch { /* use cached */ }

  const monogram = orgName ? orgName.trim().charAt(0).toUpperCase() : '?';
  const isOwner  = canDo('manage-traders');

  panel.innerHTML = `
    <div class="op-panel">

      <div class="op-section">
        <div class="op-section-head">
          <h3 class="op-section-title">Organisation</h3>
        </div>
        <div class="op-org-row">
          <div class="op-org-monogram">${monogram}</div>
          <div class="op-org-info">
            <div class="op-org-name">${escapeHtml(orgName || '—')}</div>
            <div class="op-org-hint">Shown on the login page</div>
          </div>
          ${isOwner ? `<button class="op-edit-btn" id="op-org-edit">Edit</button>` : ''}
        </div>
        <div class="op-org-edit hidden" id="op-org-edit-form">
          <input class="op-input" id="op-org-input" type="text" value="${escapeHtml(orgName)}" placeholder="e.g. Acme Sportsbook" maxlength="64">
          <div class="op-org-edit-actions">
            <button class="op-save-btn" id="op-org-save">Save</button>
            <button class="op-cancel-btn" id="op-org-cancel">Cancel</button>
          </div>
        </div>
      </div>

      <div class="op-section">
        <div class="op-section-head">
          <h3 class="op-section-title">Operators <span class="op-count">${traders.length}</span></h3>
          ${isOwner ? `<button class="op-add-btn" id="op-add-btn">+ Add Operator</button>` : ''}
        </div>

        <div class="op-list" id="op-list">
          ${renderOperatorsRows(traders)}
        </div>

        <!-- Add Operator form -->
        <div class="op-add-form hidden" id="op-add-form">
          <div class="op-add-form-header">New Operator</div>
          <div class="op-add-preview-row">
            <div class="op-add-avatar" id="op-add-avatar">A</div>
            <div class="op-add-swatches">
              ${ADD_COLORS.map((c, i) =>
                `<button type="button" class="op-swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`
              ).join('')}
            </div>
          </div>
          <div class="op-add-fields">
            <input class="op-input" type="text" id="op-add-name" placeholder="Display name" maxlength="32" autocomplete="off">
            <select class="op-role-select op-add-role-select" id="op-add-role">
              <option value="trader">Trader</option>
              <option value="senior">Senior</option>
              <option value="monitor">Monitor</option>
            </select>
          </div>
          <div class="op-add-fields">
            <input class="op-input" type="password" id="op-add-pin" placeholder="PIN (4–6 digits)" maxlength="6" inputmode="numeric" autocomplete="new-password">
            <input class="op-input" type="password" id="op-add-pin2" placeholder="Confirm PIN" maxlength="6" inputmode="numeric" autocomplete="new-password">
          </div>
          <p class="op-add-error hidden" id="op-add-error"></p>
          <div class="op-add-actions">
            <button class="op-save-btn" id="op-add-save">Add Operator</button>
            <button class="op-cancel-btn" id="op-add-cancel">Cancel</button>
          </div>
        </div>
      </div>

    </div>
  `;

  if (!isOwner) return;

  // ── Org name edit ──
  const orgEditBtn  = panel.querySelector('#op-org-edit');
  const orgEditForm = panel.querySelector('#op-org-edit-form');
  const orgInput    = panel.querySelector('#op-org-input');
  const orgSave     = panel.querySelector('#op-org-save');
  const orgCancel   = panel.querySelector('#op-org-cancel');

  orgEditBtn?.addEventListener('click', () => {
    orgEditForm.classList.remove('hidden');
    orgEditBtn.classList.add('hidden');
    orgInput.focus(); orgInput.select();
  });
  orgCancel?.addEventListener('click', () => {
    orgEditForm.classList.add('hidden');
    orgEditBtn.classList.remove('hidden');
  });
  orgSave?.addEventListener('click', async () => {
    const v = orgInput.value.trim();
    if (!v) return;
    orgSave.disabled = true; orgSave.textContent = 'Saving…';
    try {
      localStorage.setItem('orgName', v);
      const h = document.getElementById('org-name');
      if (h) h.textContent = v;
      await updateOrgName(v);
      renderOperatorsPanel();
    } catch {
      orgSave.disabled = false; orgSave.textContent = 'Save';
      showToast('Failed to save organisation name.');
    }
  });

  // ── Role selects ──
  panel.querySelectorAll('.op-role-select:not(.op-add-role-select)').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id; sel.disabled = true;
      try { await updateTrader(id, { role: sel.value }); }
      catch { sel.value = sel.dataset.orig; showToast('Failed to update role.'); }
      sel.disabled = false;
    });
  });

  // ── PIN reset ──
  panel.querySelectorAll('.op-pin-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id   = btn.dataset.id;
      const form = panel.querySelector(`#op-pin-form-${id}`);
      form?.classList.toggle('hidden');
      if (!form?.classList.contains('hidden')) form.querySelector('input')?.focus();
    });
  });
  panel.querySelectorAll('.op-pin-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelector(`#op-pin-form-${btn.dataset.id}`)?.classList.add('hidden');
    });
  });
  panel.querySelectorAll('.op-pin-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id    = btn.dataset.id;
      const form  = panel.querySelector(`#op-pin-form-${id}`);
      const [p1, p2] = [...form.querySelectorAll('.op-pin-input')].map(i => i.value.trim());
      const err   = form.querySelector('.op-add-error');
      if (!/^\d{4,6}$/.test(p1)) { err.textContent = 'PIN must be 4–6 digits.'; err.classList.remove('hidden'); return; }
      if (p1 !== p2)              { err.textContent = 'PINs do not match.';      err.classList.remove('hidden'); return; }
      err.classList.add('hidden');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (IS_LOCAL_ADMIN) await mockResetPin(id, p1);
        else await updateTrader(id, { pin: p1 });
        showToast('PIN updated.');
        form.classList.add('hidden');
      } catch (e) {
        err.textContent = e.message || 'Failed to reset PIN.';
        err.classList.remove('hidden');
      }
      btn.disabled = false; btn.textContent = 'Save';
    });
  });

  // ── Add Operator form ──
  let addColor = ADD_COLORS[0];
  const addBtn    = panel.querySelector('#op-add-btn');
  const addForm   = panel.querySelector('#op-add-form');
  const addAvatar = panel.querySelector('#op-add-avatar');
  const addName   = panel.querySelector('#op-add-name');
  const addSave   = panel.querySelector('#op-add-save');
  const addCancel = panel.querySelector('#op-add-cancel');
  const addError  = panel.querySelector('#op-add-error');

  addAvatar.style.background = addColor;

  addBtn.addEventListener('click', () => {
    addForm.classList.remove('hidden');
    addBtn.classList.add('hidden');
    addName.focus();
  });

  addCancel.addEventListener('click', () => {
    addForm.classList.add('hidden');
    addBtn.classList.remove('hidden');
    addError.classList.add('hidden');
    addName.value = '';
    panel.querySelector('#op-add-pin').value  = '';
    panel.querySelector('#op-add-pin2').value = '';
  });

  panel.querySelectorAll('.op-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      panel.querySelectorAll('.op-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      addColor = sw.dataset.color;
      addAvatar.style.background = addColor;
    });
  });

  addName.addEventListener('input', () => {
    const v = addName.value.trim();
    addAvatar.textContent = v ? v.charAt(0).toUpperCase() : 'A';
  });

  addSave.addEventListener('click', async () => {
    const name = addName.value.trim();
    const role = panel.querySelector('#op-add-role').value;
    const pin  = panel.querySelector('#op-add-pin').value.trim();
    const pin2 = panel.querySelector('#op-add-pin2').value.trim();

    addError.classList.add('hidden');
    if (!name)                    { addError.textContent = 'Name is required.';         addError.classList.remove('hidden'); return; }
    if (!/^\d{4,6}$/.test(pin))   { addError.textContent = 'PIN must be 4–6 digits.';   addError.classList.remove('hidden'); return; }
    if (pin !== pin2)              { addError.textContent = 'PINs do not match.';        addError.classList.remove('hidden'); return; }

    addSave.disabled = true; addSave.textContent = 'Adding…';
    try {
      if (IS_LOCAL_ADMIN) await mockCreateOperator(name, addColor, pin, role);
      else await createTrader(name, addColor, pin, role);
      renderOperatorsPanel();
    } catch (e) {
      addError.textContent = e.message || 'Failed to add operator.';
      addError.classList.remove('hidden');
      addSave.disabled = false; addSave.textContent = 'Add Operator';
    }
  });
}
