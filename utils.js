export function getTeamNames(event) {
  let home = event.home || 'Home';
  let away = event.away || 'Away';
  if (event.participants) {
    const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
    const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
    if (h) home = h.name || h.englishName || home;
    if (a) away = a.name || a.englishName || away;
  }
  return { home, away };
}
