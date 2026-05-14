import { state, toggleFavorite, toggleGroup } from './state.js';
import { loadOdds } from './ui-board.js';

export function renderLeagues(leaguesToRender) {
  const leaguesContainer   = document.getElementById('leagues-container');
  const favoritesContainer = document.getElementById('favorites-container');
  const leagueSearchInput  = document.getElementById('league-search');

  const searchTerm = (leagueSearchInput.value || '').toLowerCase();
  const filtered   = leaguesToRender.filter(league =>
    (league.name || league.leagueName || '').toLowerCase().includes(searchTerm)
  );

  leaguesContainer.innerHTML   = '';
  favoritesContainer.innerHTML = '';

  if (!filtered.length && !searchTerm) {
    leaguesContainer.innerHTML = `<div class="empty-state">No leagues found.</div>`;
    return;
  }

  const favoriteLeagues = filtered.filter(l => state.favorites.includes(l.code || l.leagueCode || l.id));
  if (favoriteLeagues.length > 0) {
    favoriteLeagues.forEach(league => {
      const name = league.name || league.leagueName || 'Unknown League';
      const code = league.code || league.leagueCode || league.id;
      favoritesContainer.appendChild(createLeagueElement(name, code, true, !!league.isManual));
    });
  }

  const groups = {};
  filtered.forEach(league => {
    const name    = league.name || league.leagueName || 'Unknown League';
    const country = name.includes(' - ') ? name.split(' - ')[0] : 'International';
    if (!groups[country]) groups[country] = [];
    groups[country].push(league);
  });

  const sortedCountries = Object.keys(groups).sort();
  sortedCountries.forEach(country => {
    const isExpanded = state.expandedGroups.includes(country) || (searchTerm !== '');
    leaguesContainer.appendChild(createLeagueGroup(country, groups[country], isExpanded));
  });
}

function createLeagueGroup(country, leagues, isExpanded) {
  const group = document.createElement('div');
  group.className = `league-group ${isExpanded ? 'expanded' : ''}`;

  const header = document.createElement('div');
  header.className = 'league-group-header';
  header.innerHTML = `
    <span class="group-toggle-icon">${isExpanded ? '▼' : '▶'}</span>
    <span class="group-name">${country}</span>
    <span class="group-count">${leagues.length}</span>
  `;
  header.onclick = (e) => {
    e.stopPropagation();
    toggleGroup(country);
    renderLeagues(state.allLeagues);
  };

  const content = document.createElement('div');
  content.className = 'league-group-content';
  leagues.forEach(league => {
    const name = league.name || league.leagueName || 'Unknown League';
    const code = league.code || league.leagueCode || league.id;
    content.appendChild(createLeagueElement(name, code, state.favorites.includes(code), !!league.isManual));
  });

  group.appendChild(header);
  group.appendChild(content);
  return group;
}

export function createLeagueElement(name, code, isFav, isManual = false) {
  const el = document.createElement('div');
  el.className = 'league-item';
  const manualBadge = isManual ? `<span class="manual-league-badge" title="Custom league">✎</span>` : '';
  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:0.5rem;flex:1;">
      <span class="favorite-star ${isFav ? 'active' : ''}" data-code="${code}" style="margin-top: 0.2rem;">★</span>
      <span class="league-name">${name}</span>
      ${manualBadge}
    </div>
    <span style="font-size:0.8em;color:var(--text-secondary);margin-top: 0.3rem;">›</span>
  `;

  el.addEventListener('click', async (e) => {
    if (e.target.classList.contains('favorite-star')) {
      toggleFavorite(code);
      renderLeagues(state.allLeagues);
      return;
    }
    document.querySelectorAll('.league-item').forEach(i => i.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('current-league').textContent = `– ${name}`;
    document.dispatchEvent(new CustomEvent('league:selected', { detail: { code, name } }));
    await loadOdds(code);
  });

  return el;
}
