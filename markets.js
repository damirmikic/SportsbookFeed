import { scoreProb } from './math.js';

function buildScoreGrid(lh, la, rho) {
  const grid = [];
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++)
      grid.push({ home: i, away: j, prob: scoreProb(i, j, lh, la, rho) });
  return grid;
}

function gridMatchProbs(grid) {
  let pH = 0, pD = 0, pA = 0;
  grid.forEach(({ home, away, prob }) => {
    if (home > away) pH += prob;
    else if (home === away) pD += prob;
    else pA += prob;
  });
  return { pH, pD, pA };
}

export function buildBTTS(lambdaData) {
  const { lh, la, rho } = lambdaData;
  const grid = buildScoreGrid(lh, la, rho);
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

export function buildDoubleChance(lambdaData) {
  const { lh, la, rho } = lambdaData;
  const { pH, pD, pA } = gridMatchProbs(buildScoreGrid(lh, la, rho));
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

export function buildDrawNoBet(lambdaData) {
  const { lh, la, rho } = lambdaData;
  const { pH, pA } = gridMatchProbs(buildScoreGrid(lh, la, rho));
  const norm = pH + pA;
  return {
    id: 'dnb', name: 'Draw No Bet', cols: 'two-cols',
    selections: [
      { label: 'Home', price: (norm / pH).toFixed(3), fairPrice: (norm / pH).toFixed(3), prob: pH / norm },
      { label: 'Away', price: (norm / pA).toFixed(3), fairPrice: (norm / pA).toFixed(3), prob: pA / norm },
    ]
  };
}

export function buildCorrectScore(lambdaData, topN = 12) {
  const { lh, la, rho } = lambdaData;
  const grid = buildScoreGrid(lh, la, rho);
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

export function buildAllMarkets(lambdaData) {
  if (!lambdaData) return [];
  return [
    buildBTTS(lambdaData),
    buildDoubleChance(lambdaData),
    buildDrawNoBet(lambdaData),
    buildCorrectScore(lambdaData),
  ];
}
