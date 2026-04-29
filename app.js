import { fetchLeagues } from './api.js';
import { state } from './state.js';
import { renderLeagues, closeDrawer } from './ui.js';

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Sportsbook Trading Terminal initialized.');

  const leagueSearchInput = document.getElementById('league-search');
  const closeDrawerBtn = document.getElementById('close-drawer');
  const drawerOverlay = document.getElementById('drawer-overlay');

  // Bind drawer events
  closeDrawerBtn.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);

  // Search
  leagueSearchInput.addEventListener('input', () => {
    renderLeagues(state.allLeagues);
  });

  // Fetch initial data
  const leaguesContainer = document.getElementById('leagues-container');
  try {
    const leaguesData = await fetchLeagues();
    state.allLeagues = leaguesData;
    renderLeagues(state.allLeagues);
  } catch (error) {
    console.error("Error fetching leagues", error);
    leaguesContainer.innerHTML = `<div class="empty-state" style="color: #ef4444">Failed to load leagues. CORS issue or network error.</div>`;
  }
});
