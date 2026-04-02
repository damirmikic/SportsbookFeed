function computeShinProbabilities(odds1x2) {
  const rawOdds = [odds1x2["1"], odds1x2["X"], odds1x2["2"]];
  if (rawOdds.some((o) => !Number.isFinite(o) || o <= 1)) return null;

  const q = rawOdds.map((o) => 1 / o);
  const D = q.reduce((sum, qi) => sum + qi, 0);
  if (!(D > 1)) {
    const fair = q.map((qi) => qi / D);
    return { home: fair[0], draw: fair[1], away: fair[2], shinZ: 0 };
  }

  function shinProbs(z) {
    return q.map((qi) => {
      const discriminant = z * z + 4 * (1 - z) * ((qi * qi) / D);
      return (Math.sqrt(discriminant) - z) / (2 * (1 - z));
    });
  }

  let lo = 0;
  let hi = 1 - 1e-9;
  for (let i = 0; i < 64; i += 1) {
    const mid = (lo + hi) / 2;
    const probSum = shinProbs(mid).reduce((a, b) => a + b, 0);
    if (probSum > 1) lo = mid;
    else hi = mid;
  }

  const z = (lo + hi) / 2;
  const probs = shinProbs(z);
  const total = probs.reduce((sum, p) => sum + p, 0);
  if (!(total > 0) || probs.some((p) => !Number.isFinite(p) || p < 0)) {
    return null;
  }

  return {
    home: probs[0] / total,
    draw: probs[1] / total,
    away: probs[2] / total,
    shinZ: z,
  };
}

function buildPoissonPMF(lambda, tailTolerance = 1e-12, hardCap = 250) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    return [1];
  }

  const pmf = [Math.exp(-lambda)];
  let cumulative = pmf[0];

  for (let k = 1; k <= hardCap; k += 1) {
    pmf[k] = pmf[k - 1] * (lambda / k);
    cumulative += pmf[k];
    if (1 - cumulative <= tailTolerance) {
      break;
    }
  }

  const total = pmf.reduce((sum, p) => sum + p, 0);
  return total > 0 ? pmf.map((p) => p / total) : [1];
}

function splitAsianTotalLine(points) {
  const base = Math.floor(points);
  const frac = points - base;

  if (Math.abs(frac - 0) < 1e-9 || Math.abs(frac - 0.5) < 1e-9) {
    return [{ points, weight: 1 }];
  }

  if (Math.abs(frac - 0.25) < 1e-9) {
    return [
      { points: base, weight: 0.5 },
      { points: base + 0.5, weight: 0.5 },
    ];
  }

  if (Math.abs(frac - 0.75) < 1e-9) {
    return [
      { points: base + 0.5, weight: 0.5 },
      { points: base + 1, weight: 0.5 },
    ];
  }

  return [{ points, weight: 1 }];
}

function asianTotalResultFractions(totalGoals, linePoints, side) {
  const isIntegerLine = Math.abs(linePoints - Math.round(linePoints)) < 1e-9;

  if (side === "over") {
    if (totalGoals > linePoints) return { win: 1, refund: 0 };
    if (isIntegerLine && totalGoals === Math.round(linePoints)) return { win: 0, refund: 1 };
    return { win: 0, refund: 0 };
  }

  if (totalGoals < linePoints) return { win: 1, refund: 0 };
  if (isIntegerLine && totalGoals === Math.round(linePoints)) return { win: 0, refund: 1 };
  return { win: 0, refund: 0 };
}

function asianTotalPricingMomentsFromTotalPMF(totalGoalsPMF, points, side) {
  if (!Array.isArray(totalGoalsPMF) || !Number.isFinite(points)) {
    return null;
  }

  const components = splitAsianTotalLine(points);
  let expectedWinFraction = 0;
  let expectedRefundFraction = 0;

  for (let goals = 0; goals < totalGoalsPMF.length; goals += 1) {
    const goalProb = totalGoalsPMF[goals] ?? 0;
    let winFraction = 0;
    let refundFraction = 0;

    for (const component of components) {
      const result = asianTotalResultFractions(goals, component.points, side);
      winFraction += component.weight * result.win;
      refundFraction += component.weight * result.refund;
    }

    expectedWinFraction += goalProb * winFraction;
    expectedRefundFraction += goalProb * refundFraction;
  }

  return {
    win: expectedWinFraction,
    refund: expectedRefundFraction,
  };
}

function totalGoalsMarketShare(points, lambda) {
  if (!Number.isFinite(points) || !Number.isFinite(lambda) || lambda < 0) {
    return null;
  }

  const totalGoalsPMF = buildPoissonPMF(lambda);
  const qOverMoments = asianTotalPricingMomentsFromTotalPMF(totalGoalsPMF, points, "over");
  const qUnderMoments = asianTotalPricingMomentsFromTotalPMF(totalGoalsPMF, points, "under");
  if (!qOverMoments || !qUnderMoments) {
    return null;
  }

  const qOverDenom = 1 - qOverMoments.refund;
  const qUnderDenom = 1 - qUnderMoments.refund;
  if (!(qOverDenom > 0) || !(qUnderDenom > 0)) {
    return null;
  }

  const qOver = qOverMoments.win / qOverDenom;
  const qUnder = qUnderMoments.win / qUnderDenom;
  if (
    !Number.isFinite(qOver) ||
    !Number.isFinite(qUnder) ||
    qOver < 0 ||
    qUnder < 0 ||
    qOver + qUnder <= 0
  ) {
    return null;
  }

  return qOver / (qOver + qUnder);
}

function dixonColesTau(homeGoals, awayGoals, lambdaHome, lambdaAway, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - (lambdaHome * lambdaAway * rho);
  if (homeGoals === 0 && awayGoals === 1) return 1 + (lambdaHome * rho);
  if (homeGoals === 1 && awayGoals === 0) return 1 + (lambdaAway * rho);
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function computeDixonColesMatchProbs(lambdaHome, lambdaAway, rho) {
  if (
    !Number.isFinite(lambdaHome) ||
    !Number.isFinite(lambdaAway) ||
    !Number.isFinite(rho) ||
    lambdaHome < 0 ||
    lambdaAway < 0
  ) {
    return null;
  }

  const homePMF = buildPoissonPMF(lambdaHome);
  const awayPMF = buildPoissonPMF(lambdaAway);
  const maxGoals = Math.max(homePMF.length, awayPMF.length) - 1;
  const totalGoalsPMF = Array.from({ length: (maxGoals * 2) + 1 }, () => 0);

  let total = 0;
  let home = 0;
  let draw = 0;
  let away = 0;

  for (let h = 0; h <= maxGoals; h += 1) {
    for (let a = 0; a <= maxGoals; a += 1) {
      const tau = dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      if (!(tau >= 0)) {
        return null;
      }

      const p = (homePMF[h] ?? 0) * (awayPMF[a] ?? 0) * tau;
      total += p;
      totalGoalsPMF[h + a] += p;

      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }

  if (!(total > 0)) {
    return null;
  }

  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
    totalGoalsPMF: totalGoalsPMF.map((p) => p / total),
  };
}

function dixonColesTotalGoalsMarketShare(points, lambdaHome, lambdaAway, rho) {
  const match = computeDixonColesMatchProbs(lambdaHome, lambdaAway, rho);
  if (!match) {
    return null;
  }

  const qOverMoments = asianTotalPricingMomentsFromTotalPMF(match.totalGoalsPMF, points, "over");
  const qUnderMoments = asianTotalPricingMomentsFromTotalPMF(match.totalGoalsPMF, points, "under");
  if (!qOverMoments || !qUnderMoments) {
    return null;
  }

  const qOverDenom = 1 - qOverMoments.refund;
  const qUnderDenom = 1 - qUnderMoments.refund;
  if (!(qOverDenom > 0) || !(qUnderDenom > 0)) {
    return null;
  }

  const qOver = qOverMoments.win / qOverDenom;
  const qUnder = qUnderMoments.win / qUnderDenom;
  if (
    !Number.isFinite(qOver) ||
    !Number.isFinite(qUnder) ||
    qOver < 0 ||
    qUnder < 0 ||
    qOver + qUnder <= 0
  ) {
    return null;
  }

  return qOver / (qOver + qUnder);
}

function estimateTotalLambda(totalsLine) {
  if (!totalsLine) return null;
  const { points, over, under } = totalsLine;
  if (
    !Number.isFinite(points) ||
    !Number.isFinite(over) ||
    !Number.isFinite(under) ||
    over <= 1 ||
    under <= 1
  ) {
    return null;
  }

  const qOver = 1 / over;
  const qUnder = 1 / under;
  const pOver = qOver / (qOver + qUnder);
  if (!(pOver > 0 && pOver < 1)) {
    return null;
  }

  let lo = 0;
  let hi = Math.max(6, points + 6);
  let hiProb = totalGoalsMarketShare(points, hi);
  while (hiProb != null && hiProb < pOver && hi < 100) {
    hi *= 2;
    hiProb = totalGoalsMarketShare(points, hi);
  }

  if (hiProb == null) {
    return null;
  }

  for (let i = 0; i < 64; i += 1) {
    const mid = (lo + hi) / 2;
    const overProb = totalGoalsMarketShare(points, mid);
    if (overProb == null) {
      return null;
    }

    if (overProb > pOver) hi = mid;
    else lo = mid;
  }

  return (lo + hi) / 2;
}

function computeLambdas(match) {
  const { odds, mainTotals, totals25 } = match;
  if (!odds || !odds["1"] || !odds["X"] || !odds["2"]) return null;

  const shin = computeShinProbabilities(odds);
  if (!shin) return null;

  const totalsLine = mainTotals || totals25;
  const mu = estimateTotalLambda(totalsLine);
  if (!mu || mu <= 0) return null;

  const qOver = 1 / totalsLine.over;
  const qUnder = 1 / totalsLine.under;
  const targetTotalsShare = qOver / (qOver + qUnder);
  if (!(targetTotalsShare > 0 && targetTotalsShare < 1)) {
    return null;
  }

  function evaluateModel(totalMu, homeShare, rho) {
    if (
      !Number.isFinite(totalMu) ||
      !Number.isFinite(homeShare) ||
      !Number.isFinite(rho) ||
      totalMu <= 0 ||
      homeShare <= 0 ||
      homeShare >= 1
    ) {
      return { score: Number.POSITIVE_INFINITY, model: null };
    }

    const lambdaHome = totalMu * homeShare;
    const lambdaAway = totalMu - lambdaHome;
    const dc = computeDixonColesMatchProbs(lambdaHome, lambdaAway, rho);
    if (!dc) {
      return { score: Number.POSITIVE_INFINITY, model: null };
    }

    const totalsShare = dixonColesTotalGoalsMarketShare(totalsLine.points, lambdaHome, lambdaAway, rho);
    if (totalsShare == null) {
      return { score: Number.POSITIVE_INFINITY, model: null };
    }

    const homeDiff = dc.home - shin.home;
    const drawDiff = dc.draw - shin.draw;
    const awayDiff = dc.away - shin.away;
    const totalsDiff = totalsShare - targetTotalsShare;
    const score =
      (homeDiff * homeDiff) +
      (2 * drawDiff * drawDiff) +
      (awayDiff * awayDiff) +
      (1.5 * totalsDiff * totalsDiff);

    return {
      score,
      model: {
        lambdaHome,
        lambdaAway,
        mu: totalMu,
        rho,
        probs: dc,
        totalsShare,
      },
    };
  }

  let best = evaluateModel(
    mu,
    Math.min(0.9, Math.max(0.1, shin.home / Math.max(shin.home + shin.away, 1e-9))),
    0
  );

  const muCandidates = 11;
  const shareCandidates = 41;
  const rhoCandidates = 25;
  const muRange = Math.max(0.75, Math.min(2, mu * 0.35));
  const rhoMin = -0.3;
  const rhoMax = 0.3;

  for (let i = 0; i < muCandidates; i += 1) {
    const totalMu = Math.max(0.2, mu - muRange + ((2 * muRange * i) / (muCandidates - 1)));
    for (let j = 0; j < shareCandidates; j += 1) {
      const homeShare = 0.08 + ((0.84 * j) / (shareCandidates - 1));
      for (let k = 0; k < rhoCandidates; k += 1) {
        const rho = rhoMin + (((rhoMax - rhoMin) * k) / (rhoCandidates - 1));
        const fit = evaluateModel(totalMu, homeShare, rho);
        if (fit.score < best.score) {
          best = fit;
        }
      }
    }
  }

  if (!best.model) {
    return null;
  }

  let currentMu = best.model.mu;
  let currentShare = best.model.lambdaHome / best.model.mu;
  let currentRho = best.model.rho;

  let muStep = Math.max(0.35, currentMu * 0.18);
  let shareStep = 0.12;
  let rhoStep = 0.08;

  for (let iter = 0; iter < 7; iter += 1) {
    const candidates = [
      [currentMu, currentShare, currentRho],
      [currentMu - muStep, currentShare, currentRho],
      [currentMu + muStep, currentShare, currentRho],
      [currentMu, currentShare - shareStep, currentRho],
      [currentMu, currentShare + shareStep, currentRho],
      [currentMu, currentShare, currentRho - rhoStep],
      [currentMu, currentShare, currentRho + rhoStep],
    ];

    let improved = false;
    for (const [candidateMu, candidateShare, candidateRho] of candidates) {
      const fit = evaluateModel(
        Math.max(0.2, candidateMu),
        Math.min(0.98, Math.max(0.02, candidateShare)),
        Math.min(0.3, Math.max(-0.3, candidateRho))
      );
      if (fit.score < best.score) {
        best = fit;
        currentMu = fit.model.mu;
        currentShare = fit.model.lambdaHome / fit.model.mu;
        currentRho = fit.model.rho;
        improved = true;
      }
    }

    muStep *= improved ? 0.85 : 0.5;
    shareStep *= improved ? 0.85 : 0.5;
    rhoStep *= improved ? 0.85 : 0.5;
  }

  const model = best.model;
  if (!model) return null;

  return {
    lambdaHome: Math.round(model.lambdaHome * 1000) / 1000,
    lambdaAway: Math.round(model.lambdaAway * 1000) / 1000,
    mu: Math.round(model.mu * 1000) / 1000,
    shinProbs: {
      home: Math.round(shin.home * 10000) / 10000,
      draw: Math.round(shin.draw * 10000) / 10000,
      away: Math.round(shin.away * 10000) / 10000,
    },
    dixonColesProbs: {
      home: Math.round(model.probs.home * 10000) / 10000,
      draw: Math.round(model.probs.draw * 10000) / 10000,
      away: Math.round(model.probs.away * 10000) / 10000,
    },
    poissonProbs: {
      home: Math.round(model.probs.home * 10000) / 10000,
      draw: Math.round(model.probs.draw * 10000) / 10000,
      away: Math.round(model.probs.away * 10000) / 10000,
    },
    totalsShare: Math.round(model.totalsShare * 10000) / 10000,
    rho: Math.round(model.rho * 10000) / 10000,
    fitError: Math.round(best.score * 1e8) / 1e8,
    shinZ: Math.round(shin.shinZ * 10000) / 10000,
  };
}

module.exports = {
  buildPoissonPMF,
  computeLambdas,
  computeShinProbabilities,
  estimateTotalLambda,
  computeDixonColesMatchProbs,
  dixonColesTotalGoalsMarketShare,
  totalGoalsMarketShare,
};
