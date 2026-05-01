import { fetchLeagues } from './api.js';
import { state } from './state.js';
import { renderLeagues, closeDrawer, loadOdds } from './ui.js';
import { renderAdminPanel } from './admin.js';
import { renderTemplatesSection } from './templates-admin.js';

let refreshInterval = null;

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
  if (section === 'templates') {
    adminPanel.classList.add('hidden');
    templatesPanel.classList.remove('hidden');
    renderTemplatesSection();
  } else {
    templatesPanel.classList.add('hidden');
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
  const leagueSearchInput = document.getElementById('league-search');
  const closeDrawerBtn    = document.getElementById('close-drawer');
  const drawerOverlay     = document.getElementById('drawer-overlay');

  closeDrawerBtn.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  leagueSearchInput.addEventListener('input', () => renderLeagues(state.allLeagues));

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
