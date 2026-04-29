export const state = {
  activeEvents: [],
  allLeagues: [],
  favorites: JSON.parse(localStorage.getItem('favoriteLeagues') || '[]')
};

export function toggleFavorite(code) {
  const index = state.favorites.indexOf(code);
  if (index > -1) {
    state.favorites.splice(index, 1);
  } else {
    state.favorites.push(code);
  }
  localStorage.setItem('favoriteLeagues', JSON.stringify(state.favorites));
}
