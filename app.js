import { fetchLeagues, fetchSharedState, fetchTraderState } from './api.js';
import { state, hydrateSharedState, hydrateTraderState } from './state.js';
import { renderLeagues, closeDrawer, loadOdds, filterAndRenderBoard } from './ui.js';
import { renderAdminPanel } from './admin.js';
import { renderTemplatesSection, openTemplateById } from './templates-admin.js';
import { renderAuditPanel } from './audit-admin.js';
import { clearTraderSession, getSessionExpiresAt, getValidTraderSession } from './auth-session.js';

let refreshInterval = null;
let sessionExpiryTimer = null;

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

function startPolling(leagueCode) {
  if (refreshInterval) clearInterval(refreshInterval);
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
  const adminPanel    = document.getElementById('admin-panel');
  const templatesPanel = document.getElementById('templates-panel');
  const auditPanel = document.getElementById('audit-panel');
  if (section === 'templates') {
    adminPanel.classList.add('hidden');
    templatesPanel.classList.remove('hidden');
    auditPanel.classList.add('hidden');
    renderTemplatesSection();
  } else if (section === 'audit') {
    adminPanel.classList.add('hidden');
    templatesPanel.classList.add('hidden');
    auditPanel.classList.remove('hidden');
    renderAuditPanel();
  } else {
    templatesPanel.classList.add('hidden');
    auditPanel.classList.add('hidden');
    adminPanel.classList.remove('hidden');
    renderAdminPanel();
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
  // Guard: redirect to login if no operator is signed in or the session expired.
  const traderSession = getValidTraderSession();
  if (!traderSession) {
    window.location.replace('login.html');
    return;
  }
  scheduleSessionExpiry(traderSession);

  // Show active operator chip in header
  const traderName = traderSession.name;
  const traderColor = traderSession.color;
  const chip = document.getElementById('trader-chip');
  if (chip) {
    chip.querySelector('.trader-chip-dot').style.background = traderColor;
    chip.querySelector('.trader-chip-name').textContent = traderName;
    chip.addEventListener('click', () => {
      if (confirm(`Sign out as ${traderName}?`)) {
        clearTraderSession();
        window.location.replace('login.html');
      }
    });
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
    startPolling(e.detail.code);
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

  window.addEventListener('sync:status', e => updateSyncStatus(e.detail?.status));

  // Hydrate from Turso in parallel — failures are non-fatal (localStorage remains source of truth)
  const traderId = traderSession.id;
  const syncResults = await Promise.allSettled([
    fetchSharedState().then(hydrateSharedState),
    fetchTraderState(traderId).then(hydrateTraderState),
  ]);
  const failedSyncs = syncResults.filter(result => result.status === 'rejected');
  if (failedSyncs.length) {
    failedSyncs.forEach(result => console.warn('State hydration failed:', result.reason));
    showSyncFailureBanner();
  }

  const leaguesContainer = document.getElementById('leagues-container');
  try {
    const leaguesData = await fetchLeagues();
    state.allLeagues = leaguesData;
    renderLeagues(state.allLeagues);
  } catch (error) {
    console.error('Error fetching leagues', error);
    leaguesContainer.innerHTML = `<div class="empty-state" style="color:#ef4444">Failed to load leagues. CORS issue or network error.</div>`;
  }
});
