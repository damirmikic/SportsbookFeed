function gridMatchProbs(grid) {
  let pH = 0, pD = 0, pA = 0;
  grid.forEach(({ home, away, prob }) => {
    if (home > away) pH += prob;
    else if (home === away) pD += prob;
    else pA += prob;
  });
  return { pH, pD, pA };
}

export function buildBTTS(grid) {
  const pYes = grid.filter(s => s.home > 0 && s.away > 0).reduce((a, s) => a + s.prob, 0);
  const pNo = Math.max(1e-6, 1 - pYes);
  return {
    id: 'btts', name: 'Both Teams To Score', cols: 'two-cols',
    selections: [
      { label: 'Yes', price: (1 / pYes).toFixed(3), fairPrice: (1 / pYes).toFixed(3), prob: pYes },
      { label: 'No',  price: (1 / pNo).toFixed(3),  fairPrice: (1 / pNo).toFixed(3),  prob: pNo  },
    ]
  };
}

export function buildDoubleChance(grid) {
  const { pH, pD, pA } = gridMatchProbs(grid);
  const p1X = pH + pD, p12 = pH + pA, pX2 = pD + pA;
  return {
    id: 'dc', name: 'Double Chance', cols: 'three-cols',
    selections: [
      { label: '1X', price: (1 / p1X).toFixed(3), fairPrice: (1 / p1X).toFixed(3), prob: p1X },
      { label: '12', price: (1 / p12).toFixed(3), fairPrice: (1 / p12).toFixed(3), prob: p12 },
      { label: 'X2', price: (1 / pX2).toFixed(3), fairPrice: (1 / pX2).toFixed(3), prob: pX2 },
    ]
  };
}

export function calculateDrawNoBetPrices(grid) {
  const { pH, pA } = gridMatchProbs(grid);
  const norm = pH + pA;
  if (norm <= 0) return { home: null, away: null, reason: 'zero_action' };

  return {
    home: pH > 0 ? norm / pH : null,
    away: pA > 0 ? norm / pA : null,
    reason: null,
  };
}

export function buildDrawNoBet(grid) {
  const prices = calculateDrawNoBetPrices(grid);
  return {
    id: 'dnb', name: 'Draw No Bet', cols: 'two-cols',
    selections: [
      {
        label: 'Home',
        price: prices.home == null ? null : prices.home.toFixed(3),
        fairPrice: prices.home == null ? null : prices.home.toFixed(3),
        prob: prices.home == null ? null : 1 / prices.home,
        reason: prices.reason,
      },
      {
        label: 'Away',
        price: prices.away == null ? null : prices.away.toFixed(3),
        fairPrice: prices.away == null ? null : prices.away.toFixed(3),
        prob: prices.away == null ? null : 1 / prices.away,
        reason: prices.reason,
      },
    ]
  };
}

export function buildCorrectScore(grid, topN = 12) {
  const total = grid.reduce((a, s) => a + s.prob, 0);
  const sorted = grid
    .map(s => ({ ...s, prob: s.prob / total }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, topN);
  return {
    id: 'cs', name: 'Correct Score', cols: 'three-cols',
    selections: sorted.map(s => ({
      label: `${s.home}–${s.away}`,
      price: (1 / s.prob).toFixed(2),
      fairPrice: (1 / s.prob).toFixed(2),
      prob: s.prob,
    }))
  };
}

export function buildAllMarkets(grid) {
  if (!grid) return [];
  return [
    buildBTTS(grid),
    buildDoubleChance(grid),
    buildDrawNoBet(grid),
    buildCorrectScore(grid),
  ];
}
