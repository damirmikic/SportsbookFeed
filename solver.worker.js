import { solveLambdas, buildScoreGrid, calculateTeamLambdas } from './math.js';

self.onmessage = ({ data: { id, type, payload } }) => {
  try {
    let result;
    if (type === 'SOLVE_LAMBDAS') {
      const { pH, pD, pA, pOver, ouLine } = payload;
      const solved = solveLambdas(pH, pD, pA, pOver, ouLine);
      result = { lh: solved.lh, la: solved.la, rho: solved.rho, grid: buildScoreGrid(solved.lh, solved.la, solved.rho) };
    } else if (type === 'CALCULATE_TEAM_LAMBDAS') {
      result = calculateTeamLambdas(payload.matchPeriod, payload.h1Period);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
