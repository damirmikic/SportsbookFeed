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
import { fetchActiveTraders, fetchTraders, updateTrader } from './api.js';
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
  const timelineCount = (s.templateTimeline || []).length;
  const readonly = !canDo('manage-leagues');
  const approvalThreshold = s.approvalThresholdBet ?? '';

  return `
    <tr class="admin-row" data-code="${code}">
      <td class="atd-name">
        <span class="atd-crumb">Soccer › ${getCountry(league)}</span>
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
      <td class="atd-bk">Soccer</td>
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
export function renderAdminPanel() {
  const panel = document.getElementById('admin-panel');
  if (!panel) return;

  const templates = getTemplates();
  const countries = [...new Set(state.allLeagues.map(getCountry))].sort();
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
