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

export function buildScoreGrid(lh, la, rho, maxGoals = 10) {
  const grid = [];
  let sum = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = scoreProb(i, j, lh, la, rho);
      grid.push({ home: i, away: j, prob: p });
      sum += p;
    }
  }
  // Normalize to 1.0
  if (sum > 0) {
    grid.forEach(s => s.prob /= sum);
  }
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

export function solveLambdas(pH, pD, pA, pOver, totalLine) {
  let bestLh = 1, bestLa = 1, bestRho = 0, bestErr = Infinity;

  const calcErr = (lh, la, rho) => {
    const p = dcMatchProbs(lh, la, rho);
    let err = (p.pH - pH) ** 2 + (p.pD - pD) ** 2 + (p.pA - pA) ** 2;
    if (pOver !== null && totalLine !== null) {
      err += (dcOverProb(lh, la, rho, totalLine) - pOver) ** 2;
    }
    return err;
  };

  for (let lh = 0.3; lh <= 4.0; lh += 0.15) {
    for (let la = 0.3; la <= 4.0; la += 0.15) {
      for (let rho = -0.15; rho <= 0.05; rho += 0.025) {
        const err = calcErr(lh, la, rho);
        if (err < bestErr) { bestErr = err; bestLh = lh; bestLa = la; bestRho = rho; }
      }
    }
  }

  const rLh = bestLh, rLa = bestLa, rRho = bestRho;
  for (let lh = rLh - 0.2; lh <= rLh + 0.2; lh += 0.01) {
    for (let la = rLa - 0.2; la <= rLa + 0.2; la += 0.01) {
      for (let rho = rRho - 0.03; rho <= rRho + 0.03; rho += 0.005) {
        if (lh <= 0 || la <= 0) continue;
        const err = calcErr(lh, la, rho);
        if (err < bestErr) { bestErr = err; bestLh = lh; bestLa = la; bestRho = rho; }
      }
    }
  }

  const scores = [];
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++)
      scores.push({ home: i, away: j, prob: scoreProb(i, j, bestLh, bestLa, bestRho) });
  scores.sort((a, b) => b.prob - a.prob);

  return { lh: bestLh, la: bestLa, rho: bestRho, scores: scores.slice(0, 6) };
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

  let pOver = null, totalLine = null;
  if (matchPeriod.overUnder && Array.isArray(matchPeriod.overUnder)) {
    let ou25 = matchPeriod.overUnder.find(ou => parseFloat(ou.points) === 2.5);
    if (!ou25) ou25 = matchPeriod.overUnder.reduce((b, ou) =>
      Math.abs(parseFloat(ou.points) - 2.5) < Math.abs(parseFloat(b.points) - 2.5) ? ou : b);
    if (ou25) {
      const fairOU = calculateShinNoVig([ou25.overOdds, ou25.underOdds]);
      const fOver = parseFloat(fairOU[0]);
      if (!isNaN(fOver)) { pOver = 1 / fOver; totalLine = parseFloat(ou25.points); }
    }
  }

  const solved = solveLambdas(pH, pD, pA, pOver, totalLine);

  let t = 0.45;
  if (h1Period && (h1Period.moneyLine || h1Period.moneyline)) {
    const h1ml = h1Period.moneyLine || h1Period.moneyline;
    const h1O = parseFloat(h1ml.homePrice || h1ml.home);
    const d1O = parseFloat(h1ml.drawPrice || h1ml.draw);
    const a1O = parseFloat(h1ml.awayPrice || h1ml.away);
    if (!isNaN(h1O) && !isNaN(d1O) && !isNaN(a1O)) {
      const fair1 = calculateShinNoVig([h1O, d1O, a1O]);
      const f1 = parseFloat(fair1[0]), fX = parseFloat(fair1[1]), f2 = parseFloat(fair1[2]);
      if (!isNaN(f1) && !isNaN(fX) && !isNaN(f2)) {
         let p1 = 1/f1, px = 1/fX, p2 = 1/f2;
         const s1 = p1 + px + p2;
         p1 /= s1; px /= s1; p2 /= s1;
         t = calibrateHalvesFraction(solved.lh, solved.la, solved.rho, p1, px, p2);
      }
    }
  }

  return {
    ft: { lh: solved.lh, la: solved.la, rho: solved.rho, grid: buildScoreGrid(solved.lh, solved.la, solved.rho) },
    h1: { lh: solved.lh * t, la: solved.la * t, rho: 0, grid: buildScoreGrid(solved.lh * t, solved.la * t, 0) },
    h2: { lh: solved.lh * (1-t), la: solved.la * (1-t), rho: 0, grid: buildScoreGrid(solved.lh * (1-t), solved.la * (1-t), 0) },
    splitFraction: t
  };
}
