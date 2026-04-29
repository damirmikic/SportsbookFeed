export const state = {
  activeEvents: [],
  allLeagues: [],
  favorites: JSON.parse(localStorage.getItem('favoriteLeagues') || '[]'),
  currentLeagueCode: null,
  previousOdds: {},  // eventId -> { home, draw, away }
};

export function toggleFavorite(code) {
  const index = state.favorites.indexOf(code);
  if (index > -1) state.favorites.splice(index, 1);
  else state.favorites.push(code);
  localStorage.setItem('favoriteLeagues', JSON.stringify(state.favorites));
}

export function snapshotOdds() {
  const snap = {};
  state.activeEvents.forEach(event => {
    let matchPeriod;
    if (event.periods && !Array.isArray(event.periods)) {
      matchPeriod = event.periods['0'];
    } else {
      const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
      matchPeriod = arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
    }
    if (!matchPeriod) return;
    const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
    if (!ml) return;
    snap[event.id] = {
      home: parseFloat(ml.homePrice || ml.home) || null,
      draw: parseFloat(ml.drawPrice || ml.draw) || null,
      away: parseFloat(ml.awayPrice || ml.away) || null,
    };
  });
  return snap;
}
