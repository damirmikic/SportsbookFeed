import { fetchLeagues, fetchSharedState, fetchTraderState, pushTraderPresence, fetchManualLeagues } from './api.js';
import { state, hydrateSharedState, hydrateTraderState, getLeagueSetting, canDo, isManualLeague } from './state.js';
import { renderLeagues, closeDrawer, loadOdds, filterAndRenderBoard } from './ui.js';
import { renderAdminPanel, renderOperatorsPanel } from './admin.js';
import { renderTemplatesSection, openTemplateById } from './templates-admin.js';
import { renderAuditPanel } from './audit-admin.js';
import { renderManualLeaguesPanel } from './manual-leagues-admin.js';
import { clearTraderSession, getSessionExpiresAt, getValidTraderSession, setTraderSession } from './auth-session.js';

let refreshInterval = null;
let sessionExpiryTimer = null;
let presenceInterval = null;

// Module-level league loader — called on startup AND on-demand when the
// Basketball Prematch admin section is opened for the first time.
async function _loadSportLeagues(sportId) {
  const leaguesContainer = document.getElementById('leagues-container');
  if (leaguesContainer) {
    leaguesContainer.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading leagues...</p></div>`;
  }

  let leaguesData = [];
  try {
    leaguesData = await fetchLeagues(sportId);
  } catch (error) {
    console.error('Error fetching leagues', error);
    if (leaguesContainer) {
      leaguesContainer.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load leagues. CORS issue or network error.</div>`;
    }
    return;
  }

  try {
    const manualLeagues = await fetchManualLeagues();
    state.manualLeagues.splice(0, state.manualLeagues.length, ...manualLeagues);
    const filteredManual = manualLeagues
      .filter(l => {
        if (sportId === 4) {
          return l.sport === 'basketball' || String(l.name).toLowerCase().includes('basketball') || String(l.name).toLowerCase().includes('nba');
        } else if (sportId === 33) {
          return l.sport === 'tennis' || String(l.name).toLowerCase().includes('tennis');
        } else {
          return !l.sport || l.sport === 'soccer' || l.sport === 'football' || (!String(l.name).toLowerCase().includes('basketball') && !String(l.name).toLowerCase().includes('nba') && !String(l.name).toLowerCase().includes('tennis'));
        }
      })
      .map(l => ({ ...l, isManual: true }));
    state.allLeagues = [...leaguesData, ...filteredManual];
    if (sportId === 4) {
      state.basketballLeagues = state.allLeagues.slice();
    } else if (sportId === 33) {
      state.tennisLeagues = state.allLeagues.slice();
    } else {
      state.soccerLeagues = state.allLeagues.slice();
    }
    if (leaguesContainer) renderLeagues(state.allLeagues);
  } catch (error) {
    console.warn('Failed to load custom leagues:', error);
    state.allLeagues = leaguesData;
    if (sportId === 4) {
      state.basketballLeagues = state.allLeagues.slice();
    } else if (sportId === 33) {
      state.tennisLeagues = state.allLeagues.slice();
    } else {
      state.soccerLeagues = state.allLeagues.slice();
    }
    if (leaguesContainer) renderLeagues(state.allLeagues);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showHandoverNoteBanner(code) {
  const existing = document.getElementById('handover-banner');
  if (existing) existing.remove();
  const note = getLeagueSetting(code)?.handoverNote;
  if (!note) return;
  const banner = document.createElement('div');
  banner.id = 'handover-banner';
  banner.className = 'handover-banner';
  banner.innerHTML = `
    <div class="handover-banner-content">
      <span class="handover-banner-label">Shift Note</span>
      <span class="handover-banner-text">${escapeHtml(note)}</span>
    </div>
    <button class="handover-banner-close" title="Dismiss">&times;</button>
  `;
  banner.querySelector('.handover-banner-close').addEventListener('click', () => banner.remove());
  const boardEl = document.getElementById('board') || document.querySelector('.board-wrap') || document.querySelector('main');
  boardEl?.prepend(banner);
}

function scheduleSessionExpiry(session) {
  if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);

  const delay = getSessionExpiresAt(session) - Date.now();
  sessionExpiryTimer = setTimeout(() => {
    clearTraderSession();
    window.location.replace('login.html');
  }, Math.max(0, delay));
}

function showSyncFailureBanner() {
  const banner = document.getElementById('sync-failure-banner');
  const dismiss = document.getElementById('sync-failure-dismiss');
  if (!banner) return;

  banner.classList.remove('hidden');
  dismiss?.addEventListener('click', () => banner.classList.add('hidden'), { once: true });
}

function updateSyncStatus(status) {
  const el = document.getElementById('sync-status');
  if (!el) return;

  const labels = {
    saving: 'Saving…',
    saved: 'Saved',
    retrying: 'Sync error — retrying',
  };
  el.textContent = labels[status] || 'Saved';
  el.className = `sync-status ${status || 'saved'}`;
}

function refreshAdminOverviewIfVisible() {
  const adminView = document.getElementById('admin-view');
  const activeSection = document.querySelector('.admin-section-btn.active')?.dataset.section;
  const isTournamentsActive = activeSection === 'tournaments' || activeSection === 'tournaments-basketball' || activeSection === 'tournaments-tennis';
  if (adminView && !adminView.classList.contains('hidden') && isTournamentsActive) {
    const sport = activeSection === 'tournaments-basketball' ? 'basketball' : activeSection === 'tournaments-tennis' ? 'tennis' : 'soccer';
    renderAdminPanel(sport);
  }
}

async function updateTraderPresence() {
  if (!state.currentTraderId || state.currentTraderId === 'default-trader') return;
  try {
    await pushTraderPresence(state.currentTraderId, state.currentLeagueCode, state.currentLeagueName);
  } catch (error) {
    console.warn('Trader presence update failed:', error);
  }
}

function startPolling(leagueCode) {
  if (refreshInterval) clearInterval(refreshInterval);
  if (isManualLeague(leagueCode)) return; // manual leagues have no live feed
  refreshInterval = setInterval(async () => {
    try {
      await loadOdds(leagueCode, true);
      updateRefreshBadge();
    } catch (err) {
      console.warn('Auto-refresh failed:', err);
    }
  }, 30000);
}

function updateRefreshBadge() {
  const el = document.getElementById('last-refresh');
  if (el) el.textContent = `↻ ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// ── Admin section switching ───────────────────────────────
function showAdminSection(section) {
  document.querySelectorAll('.admin-section-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.section === section)
  );
  const adminPanel        = document.getElementById('admin-panel');
  const templatesPanel    = document.getElementById('templates-panel');
  const auditPanel        = document.getElementById('audit-panel');
  const operatorsPanel    = document.getElementById('operators-panel');
  const manualLeaguesPanel = document.getElementById('manual-leagues-panel');
  [adminPanel, templatesPanel, auditPanel, operatorsPanel, manualLeaguesPanel].forEach(p => p?.classList.add('hidden'));
  if (section === 'templates') {
    templatesPanel.classList.remove('hidden');
    renderTemplatesSection();
  } else if (section === 'audit') {
    auditPanel.classList.remove('hidden');
    renderAuditPanel();
  } else if (section === 'operators') {
    operatorsPanel.classList.remove('hidden');
    renderOperatorsPanel();
  } else if (section === 'custom-leagues') {
    manualLeaguesPanel.classList.remove('hidden');
    renderManualLeaguesPanel();
  } else if (section === 'tournaments-basketball') {
    adminPanel.classList.remove('hidden');
    // If basketball leagues haven't been fetched yet, load them now
    if (!state.basketballLeagues.length) {
      _loadSportLeagues(4).then(() => renderAdminPanel('basketball'));
    } else {
      renderAdminPanel('basketball');
    }
  } else if (section === 'tournaments-tennis') {
    adminPanel.classList.remove('hidden');
    // If tennis leagues haven't been fetched yet, load them now
    if (!state.tennisLeagues.length) {
      _loadSportLeagues(33).then(() => renderAdminPanel('tennis'));
    } else {
      renderAdminPanel('tennis');
    }
  } else {
    adminPanel.classList.remove('hidden');
    renderAdminPanel('soccer');
  }
}

// ── Top-level view switching ──────────────────────────────
function switchView(view) {
  const tradingView = document.getElementById('trading-view');
  const adminView   = document.getElementById('admin-view');
  document.querySelectorAll('.view-nav-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.view === view)
  );
  if (view === 'admin') {
    tradingView.classList.add('hidden');
    adminView.classList.remove('hidden');
    // Show whichever admin section was last active
    const activeSection = document.querySelector('.admin-section-btn.active')?.dataset.section || 'tournaments';
    showAdminSection(activeSection);
  } else {
    adminView.classList.add('hidden');
    tradingView.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Auto-create a default session if none exists (login is disabled).
  let traderSession = getValidTraderSession();
  if (!traderSession) {
    traderSession = { id: 'default-trader', name: 'Trader', color: '#3b82f6', role: 'owner' };
    setTraderSession(traderSession);
  }
  scheduleSessionExpiry(traderSession);

  // Show org name in header
  const orgName = localStorage.getItem('orgName');
  if (orgName) {
    const orgEl = document.getElementById('org-name');
    if (orgEl) orgEl.textContent = orgName;
  }

  // Show Operators admin tab (all users have access)
  const operatorsBtn = document.querySelector('[data-section="operators"]');
  if (operatorsBtn) operatorsBtn.classList.remove('hidden');

  // Show active operator chip in header (role badge hidden)
  const traderName  = traderSession.name;
  const traderColor = traderSession.color;
  const chip = document.getElementById('trader-chip');
  if (chip) {
    chip.querySelector('.trader-chip-dot').style.background = traderColor;
    chip.querySelector('.trader-chip-name').textContent = traderName;
    chip.querySelector('.trader-chip-role')?.classList.add('hidden');
  }

  const leagueSearchInput = document.getElementById('league-search');
  const closeDrawerBtn    = document.getElementById('close-drawer');
  const drawerOverlay     = document.getElementById('drawer-overlay');

  closeDrawerBtn.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  leagueSearchInput.addEventListener('input', () => {
    renderLeagues(state.allLeagues);
    filterAndRenderBoard();
  });

  document.addEventListener('league:selected', (e) => {
    state.currentLeagueCode = e.detail.code;
    state.currentLeagueName = e.detail.name || e.detail.code;
    startPolling(e.detail.code);
    updateTraderPresence();
    showHandoverNoteBanner(e.detail.code);
  });

  // Top-level nav (Trading / Admin)
  document.querySelectorAll('.view-nav-btn').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );

  // Admin section sub-nav (Tournaments / Templates)
  document.querySelectorAll('.admin-section-btn').forEach(btn =>
    btn.addEventListener('click', () => showAdminSection(btn.dataset.section))
  );

  // Deep-link from drawer template badge → Admin > Templates editor
  document.addEventListener('navigate:template', (e) => {
    switchView('admin');
    showAdminSection('templates');
    openTemplateById(e.detail.id);
  });

  document.addEventListener('odds:loaded', refreshAdminOverviewIfVisible);

  window.addEventListener('sync:status', e => {
    updateSyncStatus(e.detail?.status);
    refreshAdminOverviewIfVisible();
  });

  // Hydrate from Turso in parallel — failures are non-fatal (localStorage remains source of truth)
  const traderId = traderSession.id;
  updateTraderPresence();
  presenceInterval = setInterval(updateTraderPresence, 60000);
  const syncResults = await Promise.allSettled([
    fetchSharedState().then(hydrateSharedState),
    fetchTraderState(traderId).then(hydrateTraderState),
  ]);
  const failedSyncs = syncResults.filter(result => result.status === 'rejected');
  if (failedSyncs.length) {
    failedSyncs.forEach(result => console.warn('State hydration failed:', result.reason));
    showSyncFailureBanner();
  }

  async function loadSportLeagues(sportId) {
    await _loadSportLeagues(sportId);
  }

  // Sport tabs switching
  document.querySelectorAll('.sport-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      if (tab.classList.contains('active')) return;
      
      document.querySelectorAll('.sport-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      const sportId = parseInt(tab.dataset.sportId, 10);
      state.currentSportId = sportId;
      
      // Clear league selections
      state.currentLeagueCode = null;
      state.currentLeagueName = null;
      document.getElementById('current-league').textContent = '';
      document.getElementById('odds-container').innerHTML = '<div class="empty-state">Select a league to view odds</div>';
      
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
      }
      
      await loadSportLeagues(sportId);
    });
  });

  // Initial load
  await loadSportLeagues(state.currentSportId || 29);
});
