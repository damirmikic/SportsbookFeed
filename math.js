export function calculateShinNoVig(oddsArray) {
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
  
  if (S1 <= 1) {
    validOdds.forEach((vo, idx) => result[indices[idx]] = vo.toFixed(3));
    return result;
  }

  const z = Math.max(0, Math.min(1, (1 - S2) / (S1 - S2)));

  validOdds.forEach((vo, idx) => {
    const pi = 1 / vo;
    const fairProb = (pi * pi * (1 - z)) + (pi * z);
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

export function calculateTeamLambdas(matchPeriod) {
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

  return solveLambdas(pH, pD, pA, pOver, totalLine);
}
