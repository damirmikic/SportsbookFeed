import { fetchLeagues } from './api.js';
import { state } from './state.js';
import { renderLeagues, closeDrawer, loadOdds } from './ui.js';

let refreshInterval = null;

function startPolling(leagueCode) {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    try {
      await loadOdds(leagueCode, true); // silent — no loading spinner
      updateRefreshBadge();
    } catch (err) {
      console.warn('Auto-refresh failed:', err);
    }
  }, 30000);
}

function stopPolling() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

function updateRefreshBadge() {
  const el = document.getElementById('last-refresh');
  if (el) el.textContent = `↻ ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const leagueSearchInput = document.getElementById('league-search');
  const closeDrawerBtn    = document.getElementById('close-drawer');
  const drawerOverlay     = document.getElementById('drawer-overlay');

  closeDrawerBtn.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);

  leagueSearchInput.addEventListener('input', () => renderLeagues(state.allLeagues));

  // Start polling when a league is selected
  document.addEventListener('league:selected', (e) => {
    state.currentLeagueCode = e.detail.code;
    startPolling(e.detail.code);
  });

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
