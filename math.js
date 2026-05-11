export function calculateShinNoVig(oddsArray, targetSum = 1.0) {
  const indices = [];
  const validOdds = [];
  oddsArray.forEach((o, i) => {
    const val = parseFloat(o);
    if (!isNaN(val) && val > 1) {
      indices.push(i);
      validOdds.push(val);
    }
  });

  if (validOdds.length < 2) return oddsArray;

  const rawProbs = validOdds.map(o => 1 / o);
  const S1 = rawProbs.reduce((a, b) => a + b, 0);
  const S2 = rawProbs.reduce((a, b) => a + b * b, 0);
  
  let result = new Array(oddsArray.length).fill('-');
  
  if (S1 <= targetSum) {
    validOdds.forEach((vo, idx) => result[indices[idx]] = vo.toFixed(3));
    return result;
  }

  // To support targetSum != 1, we normalize rawProbs such that sum is S1/targetSum?
  // Actually, Shin formula derives from S1=1. 
  // For targetSum=2, we can solve on pi' = pi / targetSum.
  const normS1 = S1 / targetSum;
  const normS2 = S2 / (targetSum * targetSum);

  const z = Math.max(0, Math.min(1, (1 - normS2) / (normS1 - normS2)));

  validOdds.forEach((vo, idx) => {
    const pi = (1 / vo) / targetSum;
    const fairProbNorm = (pi * pi * (1 - z)) + (pi * z);
    const fairProb = fairProbNorm * targetSum;
    result[indices[idx]] = (1 / fairProb).toFixed(3);
  });

  return result;
}

export function poissonPmf(k, lam) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  let logP = -lam + k * Math.log(lam);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

export function dixonColesTau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

export function scoreProb(i, j, lh, la, rho) {
  return poissonPmf(i, lh) * poissonPmf(j, la) * dixonColesTau(i, j, lh, la, rho);
}

export function dcMatchProbs(lh, la, rho) {
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = scoreProb(i, j, lh, la, rho);
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
    }
  }
  return { pH, pD, pA };
}

export function dcOverProb(lh, la, rho, line) {
  let pOver = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      if (i + j > line) pOver += scoreProb(i, j, lh, la, rho);
    }
  }
  return pOver;
}

export function calcAsianOdds(pWin, pLoss, pPush, pHalfWin, pHalfLoss) {
  const pAction = pWin + pLoss + pPush + pHalfWin + pHalfLoss;
  if (pAction === 0) return null;
  const w = pWin / pAction;
  const l = pLoss / pAction;
  const hw = pHalfWin / pAction;
  const hl = pHalfLoss / pAction;

  const denom = w + 0.5 * hw;
  if (denom <= 0) return null; 
  const num = l + 0.5 * hl;
  return 1 + (num / denom);
}

// For Poisson(λ), P(k) is negligible beyond k ≈ λ + 4√λ.
// Clamp to at least 8 so low-lambda matches still have sufficient resolution.
function adaptiveMaxGoals(lh, la) {
  const lMax = Math.max(lh, la);
  return Math.max(8, Math.ceil(lMax + 4 * Math.sqrt(lMax) + 1));
}

export function buildScoreGrid(lh, la, rho, maxGoals = 0) {
  if (maxGoals <= 0) maxGoals = adaptiveMaxGoals(lh, la);
  const grid = [];
  let sum = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = scoreProb(i, j, lh, la, rho);
      grid.push({ home: i, away: j, prob: p });
      sum += p;
    }
  }
  if (sum > 0) grid.forEach(s => s.prob /= sum);
  return grid;
}

export function calibrateHalvesFraction(lh, la, rho, p1, pX, p2) {
  let bestT = 0.45;
  let minErr = Infinity;
  for (let t = 0.35; t <= 0.55; t += 0.01) {
    const { pH, pD, pA } = dcMatchProbs(lh * t, la * t, rho);
    const err = (pH - p1)**2 + (pD - pX)**2 + (pA - p2)**2;
    if (err < minErr) {
      minErr = err;
      bestT = t;
    }
  }
  return bestT;
}

export function calibrateHalvesFractionFromOU(lh, la, h1OUArray) {
  const valid = h1OUArray.filter(ou => !ou.unavailable && !ou.offline);
  if (!valid.length) return 0.45;

  let mainOU = valid.find(ou => !ou.isAlt);
  if (!mainOU) {
    mainOU = valid.reduce((b, ou) =>
      Math.abs(parseFloat(ou.points) - 1) < Math.abs(parseFloat(b.points) - 1) ? ou : b
    );
  }

  const line = parseFloat(mainOU.points);
  const fairOU = calculateShinNoVig([mainOU.overOdds, mainOU.underOdds]);
  const fairOverOdds = parseFloat(fairOU[0]);
  if (isNaN(line) || isNaN(fairOverOdds) || fairOverOdds <= 1) return 0.45;

  let bestT = 0.45;
  let minErr = Infinity;
  for (let t = 0.30; t <= 0.60; t += 0.005) {
    const h1Grid = buildScoreGrid(lh * t, la * t, 0);
    const modelOdds = dcAsianTotalOdds(h1Grid, line, true);
    if (!modelOdds) continue;
    const err = (modelOdds - fairOverOdds) ** 2;
    if (err < minErr) { minErr = err; bestT = t; }
  }
  return bestT;
}

export function dcAsianHandicapOdds(grid, spread, isAway = false) {
  let pWin = 0, pLoss = 0, pPush = 0, pHalfWin = 0, pHalfLoss = 0;
  grid.forEach(({ home, away, prob }) => {
    const diff = isAway ? (away - home) : (home - away);
    const margin = Math.round((diff + spread) * 4) / 4; 
    if (margin >= 0.5) pWin += prob;
    else if (margin === 0.25) pHalfWin += prob;
    else if (margin === 0) pPush += prob;
    else if (margin === -0.25) pHalfLoss += prob;
    else pLoss += prob;
  });
  return calcAsianOdds(pWin, pLoss, pPush, pHalfWin, pHalfLoss);
}

export function dcAsianTotalOdds(grid, line, isOver) {
  let pWin = 0, pLoss = 0, pPush = 0, pHalfWin = 0, pHalfLoss = 0;
  grid.forEach(({ home, away, prob }) => {
    const total = home + away;
    const margin = Math.round((isOver ? (total - line) : (line - total)) * 4) / 4;
    if (margin >= 0.5) pWin += prob;
    else if (margin === 0.25) pHalfWin += prob;
    else if (margin === 0) pPush += prob;
    else if (margin === -0.25) pHalfLoss += prob;
    else pLoss += prob;
  });
  return calcAsianOdds(pWin, pLoss, pPush, pHalfWin, pHalfLoss);
}

export function dcAsianTeamTotalOdds(grid, line, isOver, isAway = false) {
  let pWin = 0, pLoss = 0, pPush = 0, pHalfWin = 0, pHalfLoss = 0;
  grid.forEach(({ home, away, prob }) => {
    const goals = isAway ? away : home;
    const margin = Math.round((isOver ? (goals - line) : (line - goals)) * 4) / 4;
    if (margin >= 0.5) pWin += prob;
    else if (margin === 0.25) pHalfWin += prob;
    else if (margin === 0) pPush += prob;
    else if (margin === -0.25) pHalfLoss += prob;
    else pLoss += prob;
  });
  return calcAsianOdds(pWin, pLoss, pPush, pHalfWin, pHalfLoss);
}

// ── DC solver: warm start + Adam gradient descent ────────────────────────────

// Estimate initial [λh, λa, ρ] from market prices.
//
// λ_total: binary-search Poisson CDF against the OU line closest to 2.5.
// λh/λa split: home/away strength ratio from 1x2 probs.
// ρ seed: analytical formula from draw-probability discrepancy.
//   pD_dc = pD_poisson - ρ*(P00*λh*λa + P11)  →  ρ = (pD_poisson - pD) / (P00*λh*λa + P11)
function warmStart(pH, pD, pA, ouLines) {
  // Pick the OU line closest to 2.5 for total goals estimation
  const ref = ouLines.length
    ? ouLines.reduce((b, o) => Math.abs(o.line - 2.5) < Math.abs(b.line - 2.5) ? o : b)
    : null;

  let lTotal = 2.5;
  if (ref && ref.pOver > 0 && ref.pOver < 1) {
    const k = Math.floor(ref.line);
    let lo = 0.3, hi = 9.0;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      let pUnder = 0;
      for (let j = 0; j <= k; j++) pUnder += poissonPmf(j, mid);
      if (1 - pUnder > ref.pOver) hi = mid; else lo = mid;
    }
    lTotal = (lo + hi) / 2;
  }

  const strength = (pH + 0.5 * pD) / Math.max(0.01, pA + 0.5 * pD);
  const lh = Math.max(0.2, lTotal * strength / (1 + strength));
  const la = Math.max(0.2, lTotal / (1 + strength));

  // Analytical ρ seed from draw discrepancy (exact, not an approximation)
  const p00 = poissonPmf(0, lh) * poissonPmf(0, la);
  const p11 = poissonPmf(1, lh) * poissonPmf(1, la);
  let pD_poisson = 0;
  const kMax = Math.ceil(lTotal * 3 + 4);
  for (let k = 0; k <= kMax; k++) pD_poisson += poissonPmf(k, lh) * poissonPmf(k, la);
  const denom = p00 * lh * la + p11;
  const rho = denom > 1e-10
    ? Math.max(-0.25, Math.min(0.1, (pD_poisson - pD) / denom))
    : -0.05;

  return [lh, la, rho];
}

// Adam optimizer with numerical gradients and optional box constraints.
// Typically converges in 50-150 iterations for DC parameters.
function adamOptimize(x0, lossFn, { lr = 0.01, maxIter = 300, tol = 1e-11, bounds } = {}) {
  const n = x0.length;
  const x = [...x0];
  const m = new Array(n).fill(0);
  const v = new Array(n).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8, H = 1e-5;
  let prevLoss = Infinity;

  for (let iter = 1; iter <= maxIter; iter++) {
    const loss = lossFn(x);
    if (Math.abs(prevLoss - loss) < tol) break;
    prevLoss = loss;

    const b1t = b1 ** iter, b2t = b2 ** iter;
    for (let i = 0; i < n; i++) {
      const xp = [...x]; xp[i] = bounds ? Math.min(bounds[i][1], x[i] + H) : x[i] + H;
      const xm = [...x]; xm[i] = bounds ? Math.max(bounds[i][0], x[i] - H) : x[i] - H;
      const gi = (lossFn(xp) - lossFn(xm)) / (xp[i] - xm[i]);
      m[i] = b1 * m[i] + (1 - b1) * gi;
      v[i] = b2 * v[i] + (1 - b2) * gi * gi;
      x[i] -= lr * (m[i] / (1 - b1t)) / (Math.sqrt(v[i] / (1 - b2t)) + eps);
      if (bounds) x[i] = Math.max(bounds[i][0], Math.min(bounds[i][1], x[i]));
    }
  }
  return x;
}

// Joint loss: 1x2 + all OU lines + optional Asian HCP.
// Grid is built once per evaluation and shared across all constraints.
// maxG is fixed at call-site from warm-start lambdas for a stable loss landscape.
function solverLoss(params, pH, pD, pA, ouLines, hcpSpread, hcpPHome, maxG) {
  const [lh, la, rho] = params;
  if (lh <= 0.05 || la <= 0.05) return 1e8;

  const grid = buildScoreGrid(lh, la, rho, maxG);
  let pH_m = 0, pD_m = 0, pA_m = 0;
  for (const { home, away, prob } of grid) {
    if (home > away) pH_m += prob;
    else if (home === away) pD_m += prob;
    else pA_m += prob;
  }

  let loss = (pH_m - pH) ** 2 + (pD_m - pD) ** 2 + (pA_m - pA) ** 2;

  for (const { line, pOver } of ouLines) {
    let pOver_m = 0;
    for (const { home, away, prob } of grid) {
      if (home + away > line) pOver_m += prob;
    }
    loss += (pOver_m - pOver) ** 2;
  }

  if (hcpSpread !== null && hcpPHome !== null) {
    const hcpOdds = dcAsianHandicapOdds(grid, hcpSpread, false);
    if (hcpOdds !== null && hcpOdds > 1) loss += (1 / hcpOdds - hcpPHome) ** 2;
  }
  return loss;
}

// ouLines: array of { line, pOver } — pass as many OU lines as available (1.5, 2.5, 3.5).
export function solveLambdas(pH, pD, pA, ouLines = [], hcpSpread = null, hcpPHome = null) {
  const [lh0, la0, rho0] = warmStart(pH, pD, pA, ouLines);
  const maxG = adaptiveMaxGoals(lh0, la0); // fixed for this solve — keeps loss landscape stable
  const [lh, la, rho] = adamOptimize(
    [lh0, la0, rho0],
    p => solverLoss(p, pH, pD, pA, ouLines, hcpSpread, hcpPHome, maxG),
    { lr: 0.01, maxIter: 300, tol: 1e-11, bounds: [[0.1, 6], [0.1, 6], [-0.25, 0.1]] }
  );

  const scores = [];
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++)
      scores.push({ home: i, away: j, prob: scoreProb(i, j, lh, la, rho) });
  scores.sort((a, b) => b.prob - a.prob);

  return { lh, la, rho, scores: scores.slice(0, 6) };
}

// ── Odds laddering ────────────────────────────────────────────────────────────

// EU decimal ladder: floor to the step size for the price range.
// Flooring keeps offered odds at or below the margined fair, preserving bookmaker margin.
function snapEu(odds) {
  if (odds < 2)   return Math.floor(odds * 100) / 100;
  if (odds < 3)   return Math.floor(odds *  50) / 50;
  if (odds < 4)   return Math.floor(odds *  20) / 20;
  if (odds < 6)   return Math.floor(odds *  10) / 10;
  if (odds < 10)  return Math.floor(odds *   5) / 5;
  if (odds < 20)  return Math.floor(odds *   2) / 2;
  if (odds < 30)  return Math.floor(odds);
  if (odds < 50)  return Math.floor(odds  / 2)  * 2;
  if (odds < 100) return Math.floor(odds  / 5)  * 5;
  return           Math.floor(odds  / 10) * 10;
}

// US (American) ladder: snap to nearest 5-unit increment, rounding against the bettor.
function snapUs(euOdds) {
  if (euOdds >= 2.0) {
    const us = (euOdds - 1) * 100;
    return 1 + (Math.floor(us / 5) * 5) / 100;
  }
  // Negative US odds: ceil the absolute value → more negative → lower EU odds
  const usAbs    = 100 / (euOdds - 1);                // positive magnitude, e.g. 208.33
  const snapped  = Math.ceil(usAbs / 5) * 5;           // e.g. 210
  return 1 + 100 / snapped;
}

/**
 * Applies a margin percentage to a fair-odds value, then snaps the result
 * to the standard increment ladder for the given format.
 *
 * @param {number|string} fairOdds  - No-vig (fair) decimal odds
 * @param {number|string} marginPct - Target margin, e.g. 5 means 5%
 * @param {'eu'|'us'|'hk'|'malay'|'indo'} [ladder='eu']
 * @returns {number|null}  Snapped offered odds, or null if inputs are invalid
 */
export function applyMarginAndLadder(fairOdds, marginPct, ladder = 'eu') {
  const fair = parseFloat(fairOdds);
  if (isNaN(fair) || fair <= 1) return null;
  const margined = fair / (1 + (parseFloat(marginPct) || 0) / 100);
  if (margined <= 1) return null;
  if (ladder === 'us') return snapUs(margined);
  // eu, hk, malay, indo all snap on the EU decimal scale
  return snapEu(margined);
}

// ── Off-thread solver ─────────────────────────────────────────────────────────

let _solverWorker = null;
const _pending = new Map();
let _nextId = 0;
const SOLVER_TIMEOUT_MS = 3000;

function getSolverWorker() {
  if (!_solverWorker) {
    _solverWorker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    _solverWorker.onmessage = ({ data: { id, result, error } }) => {
      const p = _pending.get(id);
      _pending.delete(id);
      if (p?.timeoutId) clearTimeout(p.timeoutId);
      if (p) error ? p.reject(new Error(error)) : p.resolve(result);
    };
    _solverWorker.onerror = (e) => {
      _pending.forEach(p => {
        if (p.timeoutId) clearTimeout(p.timeoutId);
        p.reject(e);
      });
      _pending.clear();
      _solverWorker = null;
    };
  }
  return _solverWorker;
}

function postToSolver(type, payload) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const timeoutId = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`${type} timed out after ${SOLVER_TIMEOUT_MS}ms`));
    }, SOLVER_TIMEOUT_MS);
    _pending.set(id, { resolve, reject, timeoutId });
    try {
      getSolverWorker().postMessage({ id, type, payload });
    } catch (error) {
      clearTimeout(timeoutId);
      _pending.delete(id);
      reject(error);
    }
  });
}

export function solveLambdasAsync(pH, pD, pA, ouLines = [], hcpSpread = null, hcpPHome = null) {
  return postToSolver('SOLVE_LAMBDAS', { pH, pD, pA, ouLines, hcpSpread, hcpPHome });
}

export function calculateTeamLambdasAsync(matchPeriod, h1Period) {
  return postToSolver('CALCULATE_TEAM_LAMBDAS', { matchPeriod, h1Period });
}

export function calculateTeamLambdas(matchPeriod, h1Period) {
  if (!matchPeriod) return null;

  const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
  if (!ml) return null;
  const hO = parseFloat(ml.homePrice || ml.home);
  const dO = parseFloat(ml.drawPrice || ml.draw);
  const aO = parseFloat(ml.awayPrice || ml.away);
  if (isNaN(hO) || isNaN(dO) || isNaN(aO)) return null;

  const fair1X2 = calculateShinNoVig([hO, dO, aO]);
  const fH = parseFloat(fair1X2[0]), fD = parseFloat(fair1X2[1]), fA = parseFloat(fair1X2[2]);
  if (isNaN(fH) || isNaN(fD) || isNaN(fA)) return null;

  let pH = 1/fH, pD = 1/fD, pA = 1/fA;
  const s = pH + pD + pA;
  pH /= s; pD /= s; pA /= s;

  // Collect OU 1.5, 2.5, 3.5 — deduped by actual line value to avoid double-counting.
  const ouLines = [];
  if (Array.isArray(matchPeriod.overUnder) && matchPeriod.overUnder.length > 0) {
    const seen = new Set();
    for (const target of [1.5, 2.5, 3.5]) {
      const ou = matchPeriod.overUnder.find(o => parseFloat(o.points) === target)
        ?? matchPeriod.overUnder.reduce((b, o) =>
          Math.abs(parseFloat(o.points) - target) < Math.abs(parseFloat(b.points) - target) ? o : b
        );
      if (!ou) continue;
      const line = parseFloat(ou.points);
      if (seen.has(line)) continue;
      seen.add(line);
      const fair = calculateShinNoVig([ou.overOdds, ou.underOdds]);
      const fOver = parseFloat(fair[0]);
      if (!isNaN(fOver) && fOver > 1) ouLines.push({ line, pOver: 1 / fOver });
    }
  }

  // Asian HCP: main line (non-alt, closest spread to 0) as third solver constraint.
  let hcpSpread = null, hcpPHome = null;
  const spreads = matchPeriod.spreads;
  if (Array.isArray(spreads) && spreads.length > 0) {
    const main = spreads
      .filter(s => !s.altLineId)
      .sort((a, b) =>
        Math.abs(parseFloat(a.hdp ?? a.handicap ?? 0)) -
        Math.abs(parseFloat(b.hdp ?? b.handicap ?? 0))
      )[0] ?? spreads[0];
    const hdp = parseFloat(main.hdp ?? main.handicap ?? NaN);
    const ho  = parseFloat(main.homeOdds);
    const ao  = parseFloat(main.awayOdds);
    if (!isNaN(hdp) && ho > 1 && ao > 1) {
      const fair = calculateShinNoVig([ho, ao]);
      hcpSpread = hdp;
      hcpPHome  = 1 / parseFloat(fair[0]);
    }
  }

  const solved = solveLambdas(pH, pD, pA, ouLines, hcpSpread, hcpPHome);

  let t = 0.45;
  if (h1Period && Array.isArray(h1Period.overUnder) && h1Period.overUnder.length > 0) {
    t = calibrateHalvesFractionFromOU(solved.lh, solved.la, h1Period.overUnder);
  }

  // Use adaptive grid sizes: full match grid scales with solved lambdas;
  // half-time grids scale with their (smaller) lambda fractions.
  return {
    ft: { lh: solved.lh, la: solved.la, rho: solved.rho,
          grid: buildScoreGrid(solved.lh, solved.la, solved.rho) },
    h1: { lh: solved.lh * t, la: solved.la * t, rho: 0,
          grid: buildScoreGrid(solved.lh * t, solved.la * t, 0) },
    h2: { lh: solved.lh * (1-t), la: solved.la * (1-t), rho: 0,
          grid: buildScoreGrid(solved.lh * (1-t), solved.la * (1-t), 0) },
    splitFraction: t,
  };
}
