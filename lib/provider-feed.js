const {
  buildPoissonPMF,
  computeDixonColesMatchProbs,
  computeLambdas,
  computeShinProbabilities,
  dixonColesTotalGoalsMarketShare,
} = require("./lambda");
const { DEFAULT_FIRST_HALF_RATIO, clampFirstHalfRatio } = require("./feed-settings");

function buildProviderFeed(result, options = {}) {
  const generatedAt = result?.generatedAt || new Date().toISOString();
  const sources = result?.sources || {};
  const manualOddsStore = options.manualOddsStore || { selections: {} };
  const marketStateStore = options.marketStateStore || { markets: {} };
  const firstHalfRatio = clampFirstHalfRatio(
    options.feedSettings?.firstHalfRatio ?? result?.feedSettings?.firstHalfRatio ?? DEFAULT_FIRST_HALF_RATIO
  );
  const templates = buildTemplates();
  const events = [];
  const markets = [];
  const timelines = [];
  const incidents = [];

  for (const [sourceName, source] of Object.entries(sources)) {
    const matches = Array.isArray(source?.matches) ? source.matches : [];
    for (const match of matches) {
      const enrichedMatch = enrichMatch(match);
      const event = applyEventStateOverride(buildEvent(enrichedMatch, sourceName, firstHalfRatio), marketStateStore);
      events.push(event);
      const eventMarkets = applyMarketStateOverrides(
        applyManualOverrides(buildMarkets(enrichedMatch, event.eventId, firstHalfRatio), manualOddsStore),
        marketStateStore,
        event
      );
      markets.push(...propagateRelatedMarketOverrides(eventMarkets));
      timelines.push({
        eventId: event.eventId,
        provider: sourceName,
        status: event.status,
        matchClock: null,
        incidents: [],
        bookingEvents: [],
      });
    }
  }

  return {
    provider: "internal-betradar-style",
    generatedAt,
    capabilities: {
      templates: true,
      timelines: true,
      bookingEvents: true,
      derivedMarkets: true,
      manualOdds: true,
    },
    templates,
    events,
    markets,
    timelines,
    incidents,
  };
}

function enrichMatch(match) {
  if (!match || typeof match !== "object") {
    return match;
  }

  if (match.lambdas) {
    return match;
  }

  const computed = computeLambdas(match);
  return computed ? { ...match, lambdas: computed } : match;
}

function buildTemplates() {
  return [
    {
      templateId: "tmpl:match_winner:3way",
      marketType: "match_winner",
      selectionLayout: ["home", "draw", "away"],
      supportsLine: false,
      supportsSuspension: true,
      group: "main",
    },
    {
      templateId: "tmpl:total_goals:2way",
      marketType: "total_goals",
      selectionLayout: ["over", "under"],
      supportsLine: true,
      supportsSuspension: true,
      group: "totals",
    },
    {
      templateId: "tmpl:asian_handicap:2way",
      marketType: "asian_handicap",
      selectionLayout: ["home", "away"],
      supportsLine: true,
      supportsSuspension: true,
      group: "main",
    },
    {
      templateId: "tmpl:double_chance:3way",
      marketType: "double_chance",
      selectionLayout: ["home_draw", "home_away", "draw_away"],
      supportsLine: false,
      supportsSuspension: true,
      group: "derived",
    },
    {
      templateId: "tmpl:draw_no_bet:2way",
      marketType: "draw_no_bet",
      selectionLayout: ["home", "away"],
      supportsLine: false,
      supportsSuspension: true,
      group: "derived",
    },
    {
      templateId: "tmpl:btts:2way",
      marketType: "both_teams_to_score",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "derived",
    },
    {
      templateId: "tmpl:team_total_goals:2way",
      marketType: "team_total_goals",
      selectionLayout: ["over", "under"],
      supportsLine: true,
      supportsSuspension: true,
      group: "derived",
    },
    {
      templateId: "tmpl:total_corners:2way",
      marketType: "total_corners",
      selectionLayout: ["over", "under"],
      supportsLine: true,
      supportsSuspension: true,
      group: "corners",
    },
    {
      templateId: "tmpl:team_total_corners:2way",
      marketType: "team_total_corners",
      selectionLayout: ["over", "under"],
      supportsLine: true,
      supportsSuspension: true,
      group: "corners",
    },
    {
      templateId: "tmpl:team_to_win_to_nil:2way",
      marketType: "team_to_win_to_nil",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "specials",
    },
    {
      templateId: "tmpl:correct_score:3way",
      marketType: "correct_score",
      selectionLayout: ["home_score", "away_score", "price"],
      supportsLine: true,
      supportsSuspension: true,
      group: "derived",
    },
    {
      templateId: "tmpl:team_goals_exact:multiway",
      marketType: "team_goals_exact",
      selectionLayout: ["0", "1", "2", "3", "4", "5plus"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:exact_total_goals:multiway",
      marketType: "exact_total_goals",
      selectionLayout: ["0", "1", "2", "3", "4", "5", "6plus"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
  ];
}

function buildEvent(match, sourceName, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO) {
  const competitionName = match.competition || match.leagueCode || "Unknown Competition";
  const home = match.home || "Unknown Home";
  const away = match.away || "Unknown Away";
  const scheduledStart = normalizeStart(match.startsAt);
  const eventId = buildEventId(match, sourceName, scheduledStart);

  return {
    eventId,
    sourceEventId: match.matchId != null ? `${sourceName}:${match.matchId}` : null,
    provider: sourceName,
    sport: {
      id: match.sportId != null ? `sport:${match.sportId}` : `sport:${slugify(sourceName)}`,
      name: match.sport || "Unknown Sport",
    },
    competition: {
      id: `comp:${slugify(competitionName)}`,
      name: competitionName,
      code: match.leagueCode || null,
    },
    participants: [
      { id: `team:${slugify(home)}`, role: "home", name: home },
      { id: `team:${slugify(away)}`, role: "away", name: away },
    ],
    scheduledStart,
    status: scheduledStart && Date.parse(scheduledStart) <= Date.now() ? "live_or_started" : "not_started",
    tradingStatus: "open",
    coverage: {
      timeline: true,
      bookingEvents: true,
      derivedMarkets: shouldBuildDerivedMarkets(match),
      manualOdds: true,
    },
    analytics: buildEventAnalytics(match, firstHalfRatio),
  };
}

function buildMarkets(match, eventId, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO) {
  let markets = [];
  const pricingContext = match.lambdas ? { ...match.lambdas } : null;

  if (hasThreeWayOdds(match.odds || {})) {
    const fairThreeWay = computeFairThreeWaySelectionMap(match.odds);
    markets.push({
      marketId: `mkt:${eventId}:match_winner`,
      eventId,
      type: "match_winner",
      specifier: null,
      status: "open",
      templateId: "tmpl:match_winner:3way",
      source: match.source,
      selections: [
        buildSelection("home", "Home", match.odds["1"], "provider", fairThreeWay?.home),
        buildSelection("draw", "Draw", match.odds["X"], "provider", fairThreeWay?.draw),
        buildSelection("away", "Away", match.odds["2"], "provider", fairThreeWay?.away),
      ].filter(Boolean).map((selection) => ({
        ...selection,
        compare: {
          ...(selection.compare || {}),
          [match.source || "p4578"]: {
            odds: round(Number(selection.sourceOdds), 3),
            sourceMarketId: match.moneyLineSourceMarketId ?? null,
            sourceSelectionId: `${match.moneyLineSourceMarketId ?? "moneyline"}:${selection.id}`,
            period: "ft",
          },
        },
      })),
      pricingContext: {
        ...pricingContext,
        devigMethod: fairThreeWay ? "shin" : null,
        shinZ: fairThreeWay?.home?.devigContext?.shinZ ?? null,
      },
    });
  }

  for (const totalsLine of [match.mainTotals, match.totals25]) {
    if (!isValidTotalsLine(totalsLine)) {
      continue;
    }
    const fairTwoWay = computeFairTwoWaySelectionMap({
      over: totalsLine.over,
      under: totalsLine.under,
    });

    const marketSuffix = normalizePointsId(totalsLine.points);
    markets.push({
      marketId: `mkt:${eventId}:total_goals:${marketSuffix}`,
      eventId,
      type: "total_goals",
      specifier: { points: totalsLine.points, label: totalsLine.label || String(totalsLine.points) },
      status: "open",
      templateId: "tmpl:total_goals:2way",
      source: match.source,
      selections: [
        buildSelection("over", `Over ${totalsLine.label || totalsLine.points}`, totalsLine.over, "provider", fairTwoWay?.over),
        buildSelection("under", `Under ${totalsLine.label || totalsLine.points}`, totalsLine.under, "provider", fairTwoWay?.under),
      ].filter(Boolean),
      pricingContext: {
        ...pricingContext,
        devigMethod: fairTwoWay ? "proportional" : null,
      },
    });
  }

  if (match.lambdas && shouldBuildDerivedMarkets(match)) {
    markets.push(...buildDerivedMarkets(match, eventId, pricingContext));
    markets.push(...buildFirstHalfMarkets(match, eventId, firstHalfRatio));
  }

  markets = mergeSupplementalMarkets(markets, match, eventId);
  return dedupeBy(markets, (market) => market.marketId);
}

function applyManualOverrides(markets, manualOddsStore) {
  return markets.map((market) => ({
    ...market,
    selections: (market.selections || []).map((selection) => applyManualOverrideToSelection(market, selection, manualOddsStore)),
  }));
}

function applyEventStateOverride(event, marketStateStore) {
  const stateOverride = marketStateStore?.events?.[event.eventId] || null;
  return {
    ...event,
    tradingStatus: stateOverride?.status || event.tradingStatus || "open",
    tradingStateOverride: stateOverride,
  };
}

function applyMarketStateOverrides(markets, marketStateStore, event = null) {
  return markets.map((market) => {
    const stateOverride = marketStateStore?.markets?.[market.marketId] || null;
    const eventStatus = event?.tradingStatus || "open";
    const status = eventStatus === "suspended"
      ? "suspended"
      : (stateOverride?.status || market.status || "open");
    return {
      ...market,
      status,
      tradingStateOverride: stateOverride,
      selections: (market.selections || []).map((selection) => ({
        ...selection,
        marketStatus: status,
      })),
    };
  });
}

function propagateRelatedMarketOverrides(markets) {
  const fullTimeMarkets = markets.filter((market) => getMarketPeriod(market) === "ft");
  const modelOverride = deriveEventModelOverride(fullTimeMarkets);
  const linkedProbabilitiesByPeriod = new Map();

  for (const market of markets) {
    if (market.type !== "match_winner") {
      continue;
    }

    const period = getMarketPeriod(market);
    const probabilities = extractSelectionProbabilities(market, ["home", "draw", "away"]);
    if (probabilities) {
      linkedProbabilitiesByPeriod.set(period, probabilities);
    }
  }

  return markets.map((market) => {
    const period = getMarketPeriod(market);

    if (modelOverride && period === "ft") {
      return applyEventModelOverrideToMarket(market, modelOverride);
    }

    const probabilities = linkedProbabilitiesByPeriod.get(period);
    if (!probabilities) {
      return market;
    }

    if (market.type === "double_chance") {
      return overrideDerivedMarketFromProbabilities(market, {
        home_draw: probabilities.home + probabilities.draw,
        home_away: probabilities.home + probabilities.away,
        draw_away: probabilities.draw + probabilities.away,
      }, "linked-1x2");
    }

    if (market.type === "draw_no_bet") {
      const denom = probabilities.home + probabilities.away;
      if (!(denom > 0)) {
        return market;
      }

      return overrideDerivedMarketFromProbabilities(market, {
        home: probabilities.home / denom,
        away: probabilities.away / denom,
      }, "linked-1x2");
    }

    return market;
  });
}

function deriveEventModelOverride(markets) {
  const matchWinner = markets.find((market) => market.type === "match_winner") || null;
  const totalsMarkets = markets.filter((market) => market.type === "total_goals");
  const pricingContext = matchWinner?.pricingContext || totalsMarkets[0]?.pricingContext || null;
  if (!pricingContext) {
    return null;
  }

  const hasManual = markets.some((market) => (market.selections || []).some((selection) => selection.manualOverride));
  if (!hasManual) {
    return null;
  }

  const targetProbs = matchWinner
    ? extractSelectionProbabilities(matchWinner, ["home", "draw", "away"])
    : null;
  const totalsTargetMarket = chooseTotalsTargetMarket(totalsMarkets);
  const targetTotals = totalsTargetMarket ? extractTotalsTarget(totalsTargetMarket) : null;

  const model = calibrateEventModel(pricingContext, targetProbs, targetTotals);
  return model ? { ...model, targetTotals } : null;
}

function chooseTotalsTargetMarket(totalsMarkets) {
  if (!totalsMarkets.length) {
    return null;
  }

  return totalsMarkets.find((market) => (market.selections || []).some((selection) => selection.manualOverride))
    || totalsMarkets.find((market) => Number(market.specifier?.points) !== 2.5)
    || totalsMarkets[0];
}

function extractTotalsTarget(market) {
  const over = (market.selections || []).find((selection) => selection.id === "over");
  const under = (market.selections || []).find((selection) => selection.id === "under");
  const overProb = impliedProbabilityFromOdds(over?.odds);
  const underProb = impliedProbabilityFromOdds(under?.odds);
  if (!Number.isFinite(overProb) || !Number.isFinite(underProb) || overProb <= 0 || underProb <= 0) {
    return null;
  }

  const total = overProb + underProb;
  if (!(total > 0)) {
    return null;
  }

  return {
    points: Number(market.specifier?.points),
    overShare: overProb / total,
  };
}

function calibrateEventModel(pricingContext, targetProbs, targetTotals) {
  const baseLambdaHome = Number(pricingContext.lambdaHome);
  const baseLambdaAway = Number(pricingContext.lambdaAway);
  const baseMu = Number(pricingContext.mu) || (baseLambdaHome + baseLambdaAway);
  const baseRho = Number.isFinite(Number(pricingContext.rho)) ? Number(pricingContext.rho) : 0;
  const baseShare = baseMu > 0 ? baseLambdaHome / baseMu : 0.5;

  if (!(baseMu > 0) || !(baseShare > 0 && baseShare < 1)) {
    return null;
  }

  const desiredProbs = targetProbs || extractBaseThreeWayProbabilities(pricingContext);
  if (!desiredProbs) {
    return null;
  }

  function evaluate(totalMu, homeShare, rho) {
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

    let score =
      squared(dc.home - desiredProbs.home) +
      (2 * squared(dc.draw - desiredProbs.draw)) +
      squared(dc.away - desiredProbs.away);

    let totalsShare = null;
    if (targetTotals) {
      totalsShare = dixonColesTotalGoalsMarketShare(targetTotals.points, lambdaHome, lambdaAway, rho);
      if (totalsShare == null) {
        return { score: Number.POSITIVE_INFINITY, model: null };
      }
      score += 1.5 * squared(totalsShare - targetTotals.overShare);
    }

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

  let best = evaluate(baseMu, baseShare, baseRho);
  const muRange = Math.max(0.6, Math.min(2.5, baseMu * 0.35));
  const rhoMin = Math.max(-0.3, baseRho - 0.12);
  const rhoMax = Math.min(0.3, baseRho + 0.12);

  for (let i = 0; i < 9; i += 1) {
    const totalMu = Math.max(0.2, baseMu - muRange + ((2 * muRange * i) / 8));
    for (let j = 0; j < 21; j += 1) {
      const homeShare = 0.08 + ((0.84 * j) / 20);
      for (let k = 0; k < 11; k += 1) {
        const rho = rhoMin + (((rhoMax - rhoMin) * k) / 10);
        const fit = evaluate(totalMu, homeShare, rho);
        if (fit.score < best.score) {
          best = fit;
        }
      }
    }
  }

  if (!best.model) {
    return null;
  }

  return {
    lambdaHome: round(best.model.lambdaHome, 3),
    lambdaAway: round(best.model.lambdaAway, 3),
    mu: round(best.model.mu, 3),
    rho: round(best.model.rho, 4),
    probs: {
      home: round(best.model.probs.home, 6),
      draw: round(best.model.probs.draw, 6),
      away: round(best.model.probs.away, 6),
    },
  };
}

function extractBaseThreeWayProbabilities(pricingContext) {
  const probs = pricingContext?.dixonColesProbs || pricingContext?.poissonProbs || pricingContext?.shinProbs || null;
  if (!probs) {
    return null;
  }

  const home = Number(probs.home);
  const draw = Number(probs.draw);
  const away = Number(probs.away);
  if (![home, draw, away].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  return { home, draw, away };
}

function applyEventModelOverride(markets, model) {
  return markets.map((market) => applyEventModelOverrideToMarket(market, model));
}

function applyEventModelOverrideToMarket(market, model) {
  const homePMF = buildPoissonPMF(model.lambdaHome);
  const awayPMF = buildPoissonPMF(model.lambdaAway);
  const pHomeNoGoal = homePMF[0] ?? 0;
  const pAwayNoGoal = awayPMF[0] ?? 0;
  const bttsYes = (1 - pHomeNoGoal) * (1 - pAwayNoGoal);
  const bttsNo = 1 - bttsYes;

  if (market.type === "match_winner") {
    return overrideDerivedMarketFromProbabilities(market, model.probs, "model-manual");
  }

  if (market.type === "double_chance") {
    return overrideDerivedMarketFromProbabilities(market, {
      home_draw: model.probs.home + model.probs.draw,
      home_away: model.probs.home + model.probs.away,
      draw_away: model.probs.draw + model.probs.away,
    }, "model-manual");
  }

  if (market.type === "draw_no_bet") {
    const denom = model.probs.home + model.probs.away;
    if (!(denom > 0)) {
      return market;
    }
    return overrideDerivedMarketFromProbabilities(market, {
      home: model.probs.home / denom,
      away: model.probs.away / denom,
    }, "model-manual");
  }

  if (market.type === "both_teams_to_score") {
    return overrideDerivedMarketFromProbabilities(market, {
      yes: bttsYes,
      no: bttsNo,
    }, "model-manual");
  }

  if (market.type === "team_to_win_to_nil") {
    const yesProb = teamToWinToNilProbability(
      market.specifier?.team === "home" ? homePMF : awayPMF,
      market.specifier?.team === "home" ? awayPMF : homePMF
    );
    return overrideDerivedMarketFromProbabilities(market, {
      yes: yesProb,
      no: 1 - yesProb,
    }, "model-manual");
  }

  if (market.type === "total_goals") {
    const points = Number(market.specifier?.points);
    const overShare = dixonColesTotalGoalsMarketShare(points, model.lambdaHome, model.lambdaAway, model.rho);
    if (!Number.isFinite(overShare) || overShare <= 0 || overShare >= 1) {
      return market;
    }

    return overrideDerivedMarketFromProbabilities(market, {
      over: overShare,
      under: 1 - overShare,
    }, "model-manual");
  }

  if (market.type === "team_total_goals") {
    const points = Number(market.specifier?.points);
    const teamLambda = market.specifier?.team === "home" ? model.lambdaHome : model.lambdaAway;
    const pmf = market.specifier?.team === "home" ? homePMF : awayPMF;
    const overProb = 1 - cumulativeProbability(pmf, Math.floor(points));
    return overrideDerivedMarketFromProbabilities(market, {
      over: overProb,
      under: 1 - overProb,
    }, "model-manual", { teamLambda: round(teamLambda, 3) });
  }

  if (market.type === "correct_score") {
    return {
      ...market,
      selections: buildCorrectScoreSelections(homePMF, awayPMF).map((selection) => ({
        ...selection,
        tradingMode: "model-manual",
        devigMethod: "model-linked",
        devigContext: { linkedFrom: "event-model" },
      })),
    };
  }

  return market;
}

function applyManualOverrideToSelection(market, selection, manualOddsStore) {
  const manualOverride = manualOddsStore?.selections?.[selectionKey(market.marketId, selection.id)] || null;
  const fairOdds = Number(selection.fairOdds);
  const sourceOdds = Number(selection.sourceOdds);
  const manualOdds = Number(manualOverride?.odds);
  const displayOdds = Number.isFinite(manualOdds)
    ? manualOdds
    : (Number.isFinite(fairOdds) ? fairOdds : sourceOdds);

  return {
    ...selection,
    odds: displayOdds,
    manualOverride,
    tradingMode: Number.isFinite(manualOdds) ? "manual" : "auto",
    marketStatus: market.status || "open",
  };
}

function overrideDerivedMarketFromProbabilities(market, probabilityMap, mode, pricingContextPatch = null) {
  return {
    ...market,
    pricingContext: pricingContextPatch ? { ...(market.pricingContext || {}), ...pricingContextPatch } : market.pricingContext,
    selections: (market.selections || []).map((selection) => {
      const probability = Number(probabilityMap?.[selection.id]);
      if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
        return selection;
      }

      const odds = decimalOddsFromProbability(probability);
      return {
        ...selection,
        odds,
        fairOdds: odds,
        fairProbability: round(probability, 6),
        devigMethod: "model-linked",
        devigContext: { linkedFrom: "event-model" },
        tradingMode: mode,
      };
    }),
  };
}

function extractSelectionProbabilities(market, ids) {
  const entries = ids.map((id) => {
    const selection = (market.selections || []).find((item) => item.id === id);
    if (!selection) {
      return null;
    }

    const probability = impliedProbabilityFromOdds(selection.odds);
    return Number.isFinite(probability) && probability > 0 ? { id, probability } : null;
  });

  if (entries.some((entry) => !entry)) {
    return null;
  }

  const total = entries.reduce((sum, entry) => sum + entry.probability, 0);
  if (!(total > 0)) {
    return null;
  }

  return Object.fromEntries(entries.map((entry) => [entry.id, entry.probability / total]));
}

function buildDerivedMarkets(match, eventId, pricingContext) {
  const markets = [];
  const probs = extractThreeWayProbabilities(match.lambdas);

  if (probs) {
    markets.push({
      marketId: `mkt:${eventId}:double_chance`,
      eventId,
      type: "double_chance",
      specifier: null,
      status: "open",
      templateId: "tmpl:double_chance:3way",
      source: "lambda-derived",
      selections: [
        buildSelection("home_draw", "Home or Draw", decimalOddsFromProbability(probs.home + probs.draw), "lambda-derived"),
        buildSelection("home_away", "Home or Away", decimalOddsFromProbability(probs.home + probs.away), "lambda-derived"),
        buildSelection("draw_away", "Draw or Away", decimalOddsFromProbability(probs.draw + probs.away), "lambda-derived"),
      ].filter(Boolean),
      pricingContext,
    });

    markets.push({
      marketId: `mkt:${eventId}:draw_no_bet`,
      eventId,
      type: "draw_no_bet",
      specifier: null,
      status: "open",
      templateId: "tmpl:draw_no_bet:2way",
      source: "lambda-derived",
      selections: [
        buildSelection("home", "Home", decimalOddsFromProbability(probs.home / Math.max(1e-9, probs.home + probs.away)), "lambda-derived"),
        buildSelection("away", "Away", decimalOddsFromProbability(probs.away / Math.max(1e-9, probs.home + probs.away)), "lambda-derived"),
      ].filter(Boolean),
      pricingContext,
    });
  }

  const lambdaHome = Number(match.lambdas.lambdaHome);
  const lambdaAway = Number(match.lambdas.lambdaAway);
  if (Number.isFinite(lambdaHome) && Number.isFinite(lambdaAway) && lambdaHome >= 0 && lambdaAway >= 0) {
    const homePMF = buildPoissonPMF(lambdaHome);
    const awayPMF = buildPoissonPMF(lambdaAway);

    const pHomeNoGoal = homePMF[0] ?? 0;
    const pAwayNoGoal = awayPMF[0] ?? 0;
    const bttsYes = (1 - pHomeNoGoal) * (1 - pAwayNoGoal);
    const bttsNo = 1 - bttsYes;

    markets.push({
      marketId: `mkt:${eventId}:both_teams_to_score`,
      eventId,
      type: "both_teams_to_score",
      specifier: null,
      status: "open",
      templateId: "tmpl:btts:2way",
      source: "lambda-derived",
      selections: [
        buildSelection("yes", "Yes", decimalOddsFromProbability(bttsYes), "lambda-derived"),
        buildSelection("no", "No", decimalOddsFromProbability(bttsNo), "lambda-derived"),
      ].filter(Boolean),
      pricingContext,
    });

    for (const [teamKey, lambda] of [["home", lambdaHome], ["away", lambdaAway]]) {
      const pmf = teamKey === "home" ? homePMF : awayPMF;
      const teamName = teamKey === "home" ? (match.home || "Home") : (match.away || "Away");
      for (const points of [0.5, 1.5, 2.5]) {
        const overProb = 1 - cumulativeProbability(pmf, Math.floor(points));
        const underProb = 1 - overProb;
        markets.push({
          marketId: `mkt:${eventId}:team_total_goals:${teamKey}:${normalizePointsId(points)}`,
          eventId,
          type: "team_total_goals",
          specifier: { team: teamKey, teamName, points, label: String(points) },
          status: "open",
          templateId: "tmpl:team_total_goals:2way",
          source: "lambda-derived",
          selections: [
            buildSelection("over", `Over ${points}`, decimalOddsFromProbability(overProb), "lambda-derived"),
            buildSelection("under", `Under ${points}`, decimalOddsFromProbability(underProb), "lambda-derived"),
          ].filter(Boolean),
          pricingContext: { ...pricingContext, teamLambda: round(lambda, 3) },
        });
      }

      const yesProb = teamToWinToNilProbability(pmf, teamKey === "home" ? awayPMF : homePMF);
      markets.push({
        marketId: `mkt:${eventId}:team_to_win_to_nil:${teamKey}`,
        eventId,
        type: "team_to_win_to_nil",
        specifier: { team: teamKey, teamName },
        status: "open",
        templateId: "tmpl:team_to_win_to_nil:2way",
        source: "lambda-derived",
        selections: [
          buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
          buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
        ].filter(Boolean),
        pricingContext: { ...pricingContext, teamLambda: round(lambda, 3) },
      });
    }

    const correctScores = buildCorrectScoreSelections(homePMF, awayPMF);
    markets.push({
      marketId: `mkt:${eventId}:correct_score:top`,
      eventId,
      type: "correct_score",
      specifier: { variant: "top6" },
      status: "open",
      templateId: "tmpl:correct_score:3way",
      source: "lambda-derived",
      selections: correctScores,
      pricingContext,
    });
  }

  return markets;
}

function buildFirstHalfMarkets(match, eventId, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO) {
  const analytics = buildEventAnalytics(match, firstHalfRatio);
  const firstHalf = analytics?.firstHalf || null;
  if (!firstHalf) {
    return [];
  }

  const markets = [];
  const pricingContext = {
    ...firstHalf,
    source: "ratio-derived",
    basePeriod: "1h",
    derivedFrom: ["full_time_model"],
    firstHalfRatio: analytics.firstHalfRatio,
  };
  const matchProbs = computeDixonColesMatchProbs(firstHalf.lambdaHome, firstHalf.lambdaAway, firstHalf.rho);
  const homePMF = buildPoissonPMF(firstHalf.lambdaHome);
  const awayPMF = buildPoissonPMF(firstHalf.lambdaAway);

  if (matchProbs) {
    markets.push({
      marketId: `mkt:${eventId}:match_winner:1h`,
      eventId,
      type: "match_winner",
      specifier: { period: "1h" },
      status: "open",
      templateId: "tmpl:match_winner:3way",
      source: "lambda-derived",
      selections: [
        buildSelection("home", "Home", decimalOddsFromProbability(matchProbs.home), "lambda-derived"),
        buildSelection("draw", "Draw", decimalOddsFromProbability(matchProbs.draw), "lambda-derived"),
        buildSelection("away", "Away", decimalOddsFromProbability(matchProbs.away), "lambda-derived"),
      ].filter(Boolean),
      pricingContext: {
        ...pricingContext,
        dixonColesProbs: {
          home: round(matchProbs.home, 4),
          draw: round(matchProbs.draw, 4),
          away: round(matchProbs.away, 4),
        },
      },
    });

    markets.push({
      marketId: `mkt:${eventId}:double_chance:1h`,
      eventId,
      type: "double_chance",
      specifier: { period: "1h" },
      status: "open",
      templateId: "tmpl:double_chance:3way",
      source: "lambda-derived",
      selections: [
        buildSelection("home_draw", "Home or Draw", decimalOddsFromProbability(matchProbs.home + matchProbs.draw), "lambda-derived"),
        buildSelection("home_away", "Home or Away", decimalOddsFromProbability(matchProbs.home + matchProbs.away), "lambda-derived"),
        buildSelection("draw_away", "Draw or Away", decimalOddsFromProbability(matchProbs.draw + matchProbs.away), "lambda-derived"),
      ].filter(Boolean),
      pricingContext,
    });

    const dnbDenom = matchProbs.home + matchProbs.away;
    if (dnbDenom > 0) {
      markets.push({
        marketId: `mkt:${eventId}:draw_no_bet:1h`,
        eventId,
        type: "draw_no_bet",
        specifier: { period: "1h" },
        status: "open",
        templateId: "tmpl:draw_no_bet:2way",
        source: "lambda-derived",
        selections: [
          buildSelection("home", "Home", decimalOddsFromProbability(matchProbs.home / dnbDenom), "lambda-derived"),
          buildSelection("away", "Away", decimalOddsFromProbability(matchProbs.away / dnbDenom), "lambda-derived"),
        ].filter(Boolean),
        pricingContext,
      });
    }
  }

  const pHomeNoGoal = homePMF[0] ?? 0;
  const pAwayNoGoal = awayPMF[0] ?? 0;
  const bttsYes = (1 - pHomeNoGoal) * (1 - pAwayNoGoal);
  const bttsNo = 1 - bttsYes;

  markets.push({
    marketId: `mkt:${eventId}:both_teams_to_score:1h`,
    eventId,
    type: "both_teams_to_score",
    specifier: { period: "1h" },
    status: "open",
    templateId: "tmpl:btts:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(bttsYes), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(bttsNo), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  });

  for (const [teamKey, lambda, pmf] of [
    ["home", firstHalf.lambdaHome, homePMF],
    ["away", firstHalf.lambdaAway, awayPMF],
  ]) {
    const teamName = teamKey === "home" ? (match.home || "Home") : (match.away || "Away");
    const opposingPMF = teamKey === "home" ? awayPMF : homePMF;
    const yesProb = teamToWinToNilProbability(pmf, opposingPMF);
    markets.push({
      marketId: `mkt:${eventId}:team_to_win_to_nil:${teamKey}:1h`,
      eventId,
      type: "team_to_win_to_nil",
      specifier: { team: teamKey, teamName, period: "1h" },
      status: "open",
      templateId: "tmpl:team_to_win_to_nil:2way",
      source: "lambda-derived",
      selections: [
        buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
        buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
      ].filter(Boolean),
      pricingContext: { ...pricingContext, teamLambda: round(lambda, 3) },
    });
  }

  for (const points of [0.5, 1, 1.5]) {
    const overShare = dixonColesTotalGoalsMarketShare(points, firstHalf.lambdaHome, firstHalf.lambdaAway, firstHalf.rho);
    if (!Number.isFinite(overShare) || overShare <= 0 || overShare >= 1) {
      continue;
    }

    markets.push({
      marketId: `mkt:${eventId}:total_goals:${normalizePointsId(points)}:1h`,
      eventId,
      type: "total_goals",
      specifier: { points, label: String(points), period: "1h" },
      status: "open",
      templateId: "tmpl:total_goals:2way",
      source: "lambda-derived",
      selections: [
        buildSelection("over", `Over ${points}`, decimalOddsFromProbability(overShare), "lambda-derived"),
        buildSelection("under", `Under ${points}`, decimalOddsFromProbability(1 - overShare), "lambda-derived"),
      ].filter(Boolean),
      pricingContext,
    });
  }

  for (const [teamKey, lambda, pmf] of [
    ["home", firstHalf.lambdaHome, homePMF],
    ["away", firstHalf.lambdaAway, awayPMF],
  ]) {
    const teamName = teamKey === "home" ? (match.home || "Home") : (match.away || "Away");
    for (const points of [0.5, 1.5]) {
      const overProb = 1 - cumulativeProbability(pmf, Math.floor(points));
      markets.push({
        marketId: `mkt:${eventId}:team_total_goals:${teamKey}:${normalizePointsId(points)}:1h`,
        eventId,
        type: "team_total_goals",
        specifier: { team: teamKey, teamName, points, label: String(points), period: "1h" },
        status: "open",
        templateId: "tmpl:team_total_goals:2way",
        source: "lambda-derived",
        selections: [
          buildSelection("over", `Over ${points}`, decimalOddsFromProbability(overProb), "lambda-derived"),
          buildSelection("under", `Under ${points}`, decimalOddsFromProbability(1 - overProb), "lambda-derived"),
        ].filter(Boolean),
        pricingContext: { ...pricingContext, teamLambda: round(lambda, 3) },
      });
    }
  }

  return markets;
}

function buildSelection(id, name, odds, origin, fair = null) {
  if (!Number.isFinite(odds)) {
    return null;
  }

  return {
    id,
    name,
    odds: Number.isFinite(Number(fair?.fairOdds)) ? Number(fair.fairOdds) : odds,
    sourceOdds: odds,
    fairOdds: Number.isFinite(Number(fair?.fairOdds)) ? Number(fair.fairOdds) : odds,
    fairProbability: Number.isFinite(Number(fair?.fairProbability)) ? Number(fair.fairProbability) : impliedProbabilityFromOdds(odds),
    devigMethod: fair?.devigMethod || (origin === "lambda-derived" ? "model" : null),
    devigContext: fair?.devigContext || null,
    origin,
    compare: {},
    manualOverride: null,
  };
}

function buildCorrectScoreSelections(homePMF, awayPMF) {
  const selections = [];

  for (let h = 0; h <= 3; h += 1) {
    for (let a = 0; a <= 3; a += 1) {
      const probability = (homePMF[h] ?? 0) * (awayPMF[a] ?? 0);
      selections.push(buildSelection(
        `${h}:${a}`,
        `${h}-${a}`,
        decimalOddsFromProbability(probability),
        "lambda-derived",
        buildFairSelection(probability, "model")
      ));
    }
  }

  return selections
    .filter(Boolean)
    .sort((a, b) => a.odds - b.odds)
    .slice(0, 6);
}

function extractThreeWayProbabilities(lambdas) {
  const probs = lambdas?.dixonColesProbs || lambdas?.poissonProbs || lambdas?.shinProbs || null;
  if (!probs) {
    return null;
  }

  const home = Number(probs.home);
  const draw = Number(probs.draw);
  const away = Number(probs.away);
  if (![home, draw, away].every((value) => Number.isFinite(value) && value > 0)) {
    return null;
  }

  return { home, draw, away };
}

function decimalOddsFromProbability(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }

  return round(1 / probability, 3);
}

function squared(value) {
  return value * value;
}

function cumulativeProbability(pmf, maxIndexInclusive) {
  let total = 0;
  const limit = Math.min(maxIndexInclusive, pmf.length - 1);
  for (let i = 0; i <= limit; i += 1) {
    total += pmf[i] ?? 0;
  }
  return total;
}

function computeFairThreeWaySelectionMap(odds) {
  const shin = computeShinProbabilities(odds);
  if (!shin) {
    return null;
  }

  return {
    home: buildFairSelection(shin.home, "shin", { shinZ: round(shin.shinZ, 6) }),
    draw: buildFairSelection(shin.draw, "shin", { shinZ: round(shin.shinZ, 6) }),
    away: buildFairSelection(shin.away, "shin", { shinZ: round(shin.shinZ, 6) }),
  };
}

function computeFairTwoWaySelectionMap(odds) {
  return computeProportionalFairSelectionMap(odds, 2);
}

function computeProportionalFairSelectionMap(odds, expectedCount = null) {
  const raw = Object.entries(odds)
    .map(([key, price]) => [key, impliedProbabilityFromOdds(price)])
    .filter(([, probability]) => Number.isFinite(probability) && probability > 0);

  if (expectedCount != null && raw.length !== expectedCount) {
    return null;
  }

  if (raw.length < 2) {
    return null;
  }

  const total = raw.reduce((sum, [, probability]) => sum + probability, 0);
  if (!(total > 0)) {
    return null;
  }

  return Object.fromEntries(
    raw.map(([key, probability]) => [
      key,
      buildFairSelection(probability / total, "proportional"),
    ])
  );
}

function computeSupplementalFairSelectionMap(supplemental) {
  const selections = Array.isArray(supplemental?.selections) ? supplemental.selections : [];
  if (!selections.length) {
    return null;
  }

  if (supplemental?.type === "match_winner") {
    return computeFairThreeWaySelectionMap({
      "1": selections.find((selection) => selection.id === "home")?.odds,
      X: selections.find((selection) => selection.id === "draw")?.odds,
      "2": selections.find((selection) => selection.id === "away")?.odds,
    });
  }

  return computeProportionalFairSelectionMap(
    Object.fromEntries(selections.map((selection) => [selection.id, selection.odds]))
  );
}

function buildFairSelection(probability, devigMethod, devigContext = null) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }

  return {
    fairProbability: round(probability, 6),
    fairOdds: decimalOddsFromProbability(probability),
    devigMethod,
    devigContext,
  };
}

function impliedProbabilityFromOdds(odds) {
  const numericOdds = Number(odds);
  if (!Number.isFinite(numericOdds) || numericOdds <= 1) {
    return null;
  }

  return 1 / numericOdds;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function hasThreeWayOdds(odds) {
  return Number.isFinite(odds["1"]) && Number.isFinite(odds["X"]) && Number.isFinite(odds["2"]);
}

function isValidTotalsLine(line) {
  return Boolean(
    line &&
    Number.isFinite(line.points) &&
    Number.isFinite(line.over) &&
    Number.isFinite(line.under)
  );
}

function buildEventAnalytics(match, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO) {
  const analytics = match?.lambdas || null;
  if (!analytics) {
    return null;
  }

  const lambdaHome = Number(analytics.lambdaHome);
  const lambdaAway = Number(analytics.lambdaAway);
  const mu = Number(analytics.mu);
  const rho = Number.isFinite(Number(analytics.rho)) ? Number(analytics.rho) : 0;
  const normalizedFirstHalfRatio = clampFirstHalfRatio(firstHalfRatio);

  return {
    ...analytics,
    firstHalfRatio: normalizedFirstHalfRatio,
    secondHalfRatio: round(1 - normalizedFirstHalfRatio, 2),
    firstHalf: (
      Number.isFinite(lambdaHome) &&
      Number.isFinite(lambdaAway) &&
      Number.isFinite(mu)
    ) ? {
      lambdaHome: round(lambdaHome * normalizedFirstHalfRatio, 3),
      lambdaAway: round(lambdaAway * normalizedFirstHalfRatio, 3),
      mu: round(mu * normalizedFirstHalfRatio, 3),
      rho,
    } : null,
  };
}

function shouldBuildDerivedMarkets(match) {
  return Boolean(match?.lambdas);
}

function teamToWinToNilProbability(teamPMF, opposingPMF) {
  const teamNoGoal = teamPMF?.[0] ?? 0;
  const opposingNoGoal = opposingPMF?.[0] ?? 0;
  return Math.max(0, Math.min(1, (1 - teamNoGoal) * opposingNoGoal));
}

function mergeSupplementalMarkets(markets, match, eventId) {
  const supplementalMarkets = Array.isArray(match?.supplementalMarkets) ? match.supplementalMarkets : [];
  if (!supplementalMarkets.length) {
    return markets;
  }

  let nextMarkets = [...markets];
  for (const supplemental of supplementalMarkets) {
    if (supplemental?.type === "asian_handicap_corners") {
      continue;
    }

    const existingIndex = nextMarkets.findIndex((market) => marketsMatchSupplemental(market, supplemental));
    if (existingIndex >= 0) {
      if (supplemental?.type === "correct_score") {
        nextMarkets[existingIndex] = mergeCorrectScoreMarket(nextMarkets[existingIndex], supplemental, match.source || "p4578");
      } else {
        nextMarkets[existingIndex] = attachSupplementalCompare(nextMarkets[existingIndex], supplemental, match.source || "p4578");
      }
      continue;
    }

    nextMarkets.push(buildSupplementalMarket(eventId, supplemental, match.source || "p4578"));
  }

  return nextMarkets;
}

function marketsMatchSupplemental(market, supplemental) {
  if (!market || market.type !== supplemental?.type) {
    return false;
  }

  if (getMarketPeriod(market) !== (supplemental?.period || "ft")) {
    return false;
  }

  if (market.type === "team_total_goals" || market.type === "team_total_corners" || market.type === "team_to_win_to_nil") {
    return (
      market.specifier?.team === supplemental?.specifier?.team &&
      (
        market.type === "team_to_win_to_nil" ||
        Number(market.specifier?.points) === Number(supplemental?.specifier?.points)
      )
    );
  }

  if (
    market.type === "total_goals" ||
    market.type === "asian_handicap" ||
    market.type === "total_corners"
  ) {
    return Number(market.specifier?.points) === Number(supplemental?.specifier?.points);
  }

  if (market.type === "team_goals_exact") {
    return market.specifier?.team === supplemental?.specifier?.team;
  }

  return true;
}

function attachSupplementalCompare(market, supplemental, compareSource) {
  const sourceSelections = new Map(
    (supplemental?.selections || []).map((selection) => [selection.id, selection])
  );

  return {
    ...market,
    selections: (market.selections || []).map((selection) => {
      const sourceSelection = sourceSelections.get(selection.id);
      if (!sourceSelection) {
        return selection;
      }

      return {
        ...selection,
        compare: {
          ...(selection.compare || {}),
          [compareSource]: {
            odds: round(Number(sourceSelection.odds), 3),
            sourceMarketId: supplemental?.sourceMarketId ?? null,
            sourceSelectionId: sourceSelection?.sourceSelectionId ?? null,
            period: supplemental?.period || "ft",
          },
        },
      };
    }),
  };
}

function mergeCorrectScoreMarket(existingMarket, supplemental, compareSource) {
  const lambdaByID = new Map(
    (existingMarket?.selections || []).map((sel) => [sel.id, sel])
  );

  const period = supplemental?.period || "ft";
  const fairSelectionMap = computeSupplementalFairSelectionMap(supplemental);

  const selections = (supplemental?.selections || []).map((sourceSelection) => {
    const lambda = lambdaByID.get(sourceSelection.id);

    const base = lambda
      ? { ...lambda }
      : buildSelection(
          sourceSelection.id,
          sourceSelection.name,
          Number(sourceSelection.odds),
          "provider",
          fairSelectionMap?.[sourceSelection.id] || null
        );

    if (!base) {
      return null;
    }

    return {
      ...base,
      compare: {
        ...(base.compare || {}),
        [compareSource]: {
          odds: round(Number(sourceSelection.odds), 3),
          sourceMarketId: supplemental?.sourceMarketId ?? null,
          sourceSelectionId: sourceSelection?.sourceSelectionId ?? null,
          period,
        },
      },
    };
  }).filter(Boolean);

  return {
    ...existingMarket,
    selections,
    pricingContext: {
      ...existingMarket.pricingContext,
      compareSource,
      sourceMarketId: supplemental?.sourceMarketId ?? null,
    },
  };
}

function buildSupplementalMarket(eventId, supplemental, sourceName) {
  const period = supplemental?.period || "ft";
  const periodSuffix = period === "1h" ? ":1h" : "";
  const fairSelectionMap = computeSupplementalFairSelectionMap(supplemental);
  const pointsSuffix = supplemental?.type === "team_total_goals" || supplemental?.type === "team_total_corners"
    ? `:${supplemental.specifier.team}:${normalizePointsId(supplemental.specifier.points)}`
    : supplemental?.type === "team_to_win_to_nil"
      ? `:${supplemental.specifier.team}`
    : supplemental?.type === "total_goals" || supplemental?.type === "asian_handicap" || supplemental?.type === "total_corners"
      ? `:${normalizePointsId(supplemental.specifier.points)}`
    : supplemental?.type === "team_goals_exact"
      ? `:${supplemental.specifier.team}`
      : "";

  return {
    marketId: `mkt:${eventId}:${supplemental.type}${pointsSuffix}${periodSuffix}`,
    eventId,
    type: supplemental.type,
    specifier: {
      ...(supplemental.specifier || {}),
      ...(period === "1h" ? { period: "1h" } : {}),
    },
    status: "open",
    templateId: supplemental.type === "match_winner"
      ? "tmpl:match_winner:3way"
      : supplemental.type === "total_goals"
        ? "tmpl:total_goals:2way"
      : supplemental.type === "asian_handicap"
          ? "tmpl:asian_handicap:2way"
        : supplemental.type === "total_corners"
          ? "tmpl:total_corners:2way"
          : supplemental.type === "both_teams_to_score"
      ? "tmpl:btts:2way"
      : supplemental.type === "double_chance"
        ? "tmpl:double_chance:3way"
        : supplemental.type === "draw_no_bet"
          ? "tmpl:draw_no_bet:2way"
          : supplemental.type === "team_total_goals"
            ? "tmpl:team_total_goals:2way"
            : supplemental.type === "team_total_corners"
              ? "tmpl:team_total_corners:2way"
            : supplemental.type === "team_to_win_to_nil"
              ? "tmpl:team_to_win_to_nil:2way"
            : supplemental.type === "team_goals_exact"
              ? "tmpl:team_goals_exact:multiway"
              : supplemental.type === "correct_score"
                ? "tmpl:correct_score:3way"
                : "tmpl:exact_total_goals:multiway",
    source: sourceName,
    selections: (supplemental?.selections || []).map((selection) => {
      const built = buildSelection(
        selection.id,
        selection.name,
        Number(selection.odds),
        "provider",
        fairSelectionMap?.[selection.id] || null
      );
      if (!built) {
        return null;
      }

      return {
        ...built,
        compare: {
          ...(built.compare || {}),
          [sourceName]: {
            odds: round(Number(selection.odds), 3),
            sourceMarketId: supplemental?.sourceMarketId ?? null,
            sourceSelectionId: selection?.sourceSelectionId ?? null,
            period,
          },
        },
      };
    }).filter(Boolean),
    pricingContext: {
      source: sourceName,
      sourceMarketId: supplemental?.sourceMarketId ?? null,
      period,
    },
  };
}

function getMarketPeriod(market) {
  return market?.specifier?.period || "ft";
}

function buildEventId(match, sourceName, scheduledStart) {
  if (match.matchId != null) {
    return `ev:${sourceName}:${match.matchId}`;
  }

  return [
    "ev",
    slugify(sourceName),
    slugify(match.competition || match.leagueCode || "unknown"),
    slugify(match.home || "home"),
    slugify(match.away || "away"),
    slugify(scheduledStart || "unscheduled"),
  ].join(":");
}

function normalizeStart(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePointsId(points) {
  return String(points).replace(/\./g, "_");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }

  return out;
}

module.exports = {
  buildProviderFeed,
};

function selectionKey(marketId, selectionId) {
  return `${marketId}::${selectionId}`;
}
