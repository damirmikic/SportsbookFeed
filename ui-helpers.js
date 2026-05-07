import { getOverride } from './state.js';

export function calcMargin(rows) {
  let sum = 0, count = 0;
  rows.forEach(r => {
    const v = parseFloat(r.value);
    if (!isNaN(v) && v > 1) { sum += 1 / v; count++; }
  });
  return count >= 2 ? sum : null;
}

export function marginBadgeHTML(margin) {
  if (margin === null) return '';
  const pct = (margin * 100).toFixed(1);
  const cls = margin < 1.03 ? 'margin-green' : margin < 1.07 ? 'margin-yellow' : 'margin-red';
  return `<span class="margin-badge ${cls}">${pct}%</span>`;
}

export function getEffectiveMatchPeriod(matchPeriod, eventId, homeTeam, awayTeam) {
  const get = (mktId, label, original) => {
    const ov = getOverride(`${eventId}|${mktId}|${label}`);
    return ov ? parseFloat(ov) : (parseFloat(original) || original);
  };
  const r = JSON.parse(JSON.stringify(matchPeriod));
  const ml = r.moneyLine || r.moneyline;
  if (ml) {
    const h = get('ml', homeTeam, ml.homePrice || ml.home);
    const d = get('ml', 'Draw',   ml.drawPrice || ml.draw);
    const a = get('ml', awayTeam, ml.awayPrice || ml.away);
    if (r.moneyLine) r.moneyLine = { ...r.moneyLine, homePrice: h, home: h, drawPrice: d, draw: d, awayPrice: a, away: a };
    if (r.moneyline) r.moneyline = { ...r.moneyline, homePrice: h, home: h, drawPrice: d, draw: d, awayPrice: a, away: a };
  }
  if (r.overUnder && Array.isArray(r.overUnder)) {
    r.overUnder = r.overUnder.map(ou => ({
      ...ou,
      overOdds:  get('ou', `Over ${ou.points}`,  ou.overOdds),
      underOdds: get('ou', `Under ${ou.points}`, ou.underOdds),
    }));
  }
  return r;
}
