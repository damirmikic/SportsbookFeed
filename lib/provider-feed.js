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
    {
      templateId: "tmpl:odd_even_goals:2way",
      marketType: "odd_even_goals",
      selectionLayout: ["odd", "even"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:clean_sheet:2way",
      marketType: "clean_sheet",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:first_team_to_score:3way",
      marketType: "first_team_to_score",
      selectionLayout: ["home", "away", "no_goal"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:which_team_to_score:3way",
      marketType: "which_team_to_score",
      selectionLayout: ["home", "away", "no_goal"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:goal_range:2way",
      marketType: "goal_range",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:team_to_score_in_both_halves:2way",
      marketType: "team_to_score_in_both_halves",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:both_halves_total_goals:2way",
      marketType: "both_halves_total_goals",
      selectionLayout: ["yes", "no"],
      supportsLine: true,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:highest_scoring_half:3way",
      marketType: "highest_scoring_half",
      selectionLayout: ["first_half", "second_half", "tie"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:team_highest_scoring_half:3way",
      marketType: "team_highest_scoring_half",
      selectionLayout: ["first_half", "second_half", "tie"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:team_to_win_both_halves:2way",
      marketType: "team_to_win_both_halves",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "specials",
    },
    {
      templateId: "tmpl:team_to_win_either_half:2way",
      marketType: "team_to_win_either_half",
      selectionLayout: ["yes", "no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "specials",
    },
    {
      templateId: "tmpl:team_odd_even_goals:2way",
      marketType: "team_odd_even_goals",
      selectionLayout: ["odd", "even"],
      supportsLine: false,
      supportsSuspension: true,
      group: "goals",
    },
    {
      templateId: "tmpl:halftime_fulltime:9way",
      marketType: "halftime_fulltime",
      selectionLayout: ["home_home", "home_draw", "home_away", "draw_home", "draw_draw", "draw_away", "away_home", "away_draw", "away_away"],
      supportsLine: false,
      supportsSuspension: true,
      group: "main",
    },
    {
      templateId: "tmpl:match_result_and_total:6way",
      marketType: "match_result_and_total",
      selectionLayout: ["home_over", "draw_over", "away_over", "home_under", "draw_under", "away_under"],
      supportsLine: true,
      supportsSuspension: true,
      group: "specials",
    },
    {
      templateId: "tmpl:match_result_and_btts:6way",
      marketType: "match_result_and_btts",
      selectionLayout: ["home_yes", "draw_yes", "away_yes", "home_no", "draw_no", "away_no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "specials",
    },
    {
      templateId: "tmpl:total_and_btts:4way",
      marketType: "total_and_btts",
      selectionLayout: ["over_yes", "over_no", "under_yes", "under_no"],
      supportsLine: true,
      supportsSuspension: true,
      group: "specials",
    },
    {
      templateId: "tmpl:double_chance_and_btts:6way",
      marketType: "double_chance_and_btts",
      selectionLayout: ["home_draw_yes", "home_away_yes", "draw_away_yes", "home_draw_no", "home_away_no", "draw_away_no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:double_chance_and_total:6way",
      marketType: "double_chance_and_total",
      selectionLayout: ["home_draw_over", "home_away_over", "draw_away_over", "home_draw_under", "home_away_under", "draw_away_under"],
      supportsLine: true,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:double_chance_match_and_btts_half:6way",
      marketType: "double_chance_match_and_btts_half",
      selectionLayout: ["home_draw_yes", "home_away_yes", "draw_away_yes", "home_draw_no", "home_away_no", "draw_away_no"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:halftime_fulltime_and_total:18way",
      marketType: "halftime_fulltime_and_total",
      selectionLayout: ["combined"],
      supportsLine: true,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:halftime_fulltime_and_first_half_total:18way",
      marketType: "halftime_fulltime_and_first_half_total",
      selectionLayout: ["combined"],
      supportsLine: true,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:halftime_fulltime_and_exact_goals:36way",
      marketType: "halftime_fulltime_and_exact_goals",
      selectionLayout: ["combined"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:first_half_result_or_match_result:3way",
      marketType: "first_half_result_or_match_result",
      selectionLayout: ["home", "draw", "away"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:multigoals:multiway",
      marketType: "multigoals",
      selectionLayout: ["range"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:team_multigoals:multiway",
      marketType: "team_multigoals",
      selectionLayout: ["range"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
    },
    {
      templateId: "tmpl:multiscores:multiway",
      marketType: "multiscores",
      selectionLayout: ["group"],
      supportsLine: false,
      supportsSuspension: true,
      group: "others",
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
  const providerMarketRegistry = buildProviderMarketRegistry(match);

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

  let lambdaCompareMarkets = [];
  if (match.lambdas && shouldBuildDerivedMarkets(match)) {
    const allDerived = [
      ...buildDerivedMarkets(match, eventId, pricingContext, providerMarketRegistry),
      ...buildFirstHalfMarkets(match, eventId, firstHalfRatio, providerMarketRegistry),
      ...buildSecondHalfMarkets(match, eventId, firstHalfRatio, providerMarketRegistry),
      ...buildSplitDependentMarkets(match, eventId, firstHalfRatio, providerMarketRegistry),
    ];
    lambdaCompareMarkets = allDerived.filter((m) => m._lambdaCompare && isLambdaComparableMarketType(m.type));
    markets.push(...allDerived.filter((m) => !m._lambdaCompare));
  }

  markets = mergeSupplementalMarkets(markets, match, eventId);
  attachLambdaOddsToMarkets(markets, lambdaCompareMarkets);
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
  const scoreMatrix = buildScoreMatrix(model.lambdaHome, model.lambdaAway, model.rho ?? 0);
  const pHomeNoGoal = homePMF[0] ?? 0;
  const pAwayNoGoal = awayPMF[0] ?? 0;
  const bttsYes = 1 - pHomeNoGoal - pAwayNoGoal + (scoreMatrix?.[0]?.[0] ?? pHomeNoGoal * pAwayNoGoal);
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
    const yesProb = teamToWinToNilProbability(scoreMatrix, market.specifier?.team ?? "home");
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
      selections: buildCorrectScoreSelections(scoreMatrix).map((selection) => ({
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

function buildDerivedMarkets(match, eventId, pricingContext, providerMarketRegistry) {
  return buildGoalDerivedMarketsForPeriod(match, eventId, {
    analytics: match.lambdas,
    pricingContext,
    registry: providerMarketRegistry,
    period: "ft",
    totalPoints: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5],
    teamTotalPoints: [0.5, 1.5, 2.5],
    goalRangeStarts: [6, 7],
  });
}

function buildFirstHalfMarkets(match, eventId, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO, providerMarketRegistry) {
  const analytics = buildEventAnalytics(match, firstHalfRatio);
  const firstHalf = analytics?.firstHalf || null;
  if (!firstHalf) {
    return [];
  }

  return buildGoalDerivedMarketsForPeriod(match, eventId, {
    analytics: firstHalf,
    pricingContext: {
      ...firstHalf,
      source: "ratio-derived",
      basePeriod: "1h",
      derivedFrom: ["full_time_model"],
      firstHalfRatio: analytics.firstHalfRatio,
    },
    registry: providerMarketRegistry,
    period: "1h",
    totalPoints: [0.5, 1, 1.5],
    teamTotalPoints: [0.5, 1.5],
    goalRangeStarts: [2, 3],
  });
}

function buildSecondHalfMarkets(match, eventId, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO, providerMarketRegistry) {
  const analytics = buildEventAnalytics(match, firstHalfRatio);
  const secondHalf = analytics?.secondHalf || null;
  if (!secondHalf) {
    return [];
  }

  return buildGoalDerivedMarketsForPeriod(match, eventId, {
    analytics: secondHalf,
    pricingContext: {
      ...secondHalf,
      source: "ratio-derived",
      basePeriod: "2h",
      derivedFrom: ["full_time_model"],
      secondHalfRatio: analytics.secondHalfRatio,
    },
    registry: providerMarketRegistry,
    period: "2h",
    totalPoints: [0.5, 1, 1.5],
    teamTotalPoints: [0.5, 1.5],
    goalRangeStarts: [2, 3],
  });
}

function buildGoalDerivedMarketsForPeriod(match, eventId, options) {
  const period = options?.period || "ft";
  const analytics = options?.analytics || null;
  const pricingContext = options?.pricingContext || analytics || null;
  const registry = options?.registry || new Set();
  const totalPoints = Array.isArray(options?.totalPoints) ? options.totalPoints : [];
  const teamTotalPoints = Array.isArray(options?.teamTotalPoints) ? options.teamTotalPoints : [];
  const goalRangeStarts = Array.isArray(options?.goalRangeStarts) ? options.goalRangeStarts : [];

  const lambdaHome = Number(analytics?.lambdaHome);
  const lambdaAway = Number(analytics?.lambdaAway);
  const rho = Number.isFinite(Number(analytics?.rho)) ? Number(analytics.rho) : 0;
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway) || lambdaHome < 0 || lambdaAway < 0) {
    return [];
  }

  const model = buildPeriodModel(lambdaHome, lambdaAway, rho);
  if (!model) {
    return [];
  }

  const markets = [];
  const addMarket = (market) => {
    if (!market) {
      return;
    }
    if (!canGenerateDerivedMarket(registry, market.type, market.specifier)) {
      markets.push({ ...market, _lambdaCompare: true });
      return;
    }
    markets.push(market);
  };

  addMarket(buildMatchWinnerMarket(eventId, period, pricingContext, model.probs));
  addMarket(buildDoubleChanceMarket(eventId, period, pricingContext, model.probs));
  addMarket(buildDrawNoBetMarket(eventId, period, pricingContext, model.probs));
  addMarket(buildBttsMarket(eventId, period, pricingContext, model));
  addMarket(buildOddEvenMarket(eventId, period, pricingContext, model));
  addMarket(buildFirstTeamToScoreMarket(eventId, period, pricingContext, model));
  addMarket(buildWhichTeamToScoreMarket(eventId, period, pricingContext, model));
  addMarket(buildCorrectScoreMarket(eventId, period, pricingContext, model));
  addMarket(buildExactGoalsMarket(eventId, period, pricingContext, model));
  addMarket(buildMatchResultAndTotalMarket(eventId, period, pricingContext, model));
  addMarket(buildMatchResultAndBttsMarket(eventId, period, pricingContext, model));
  addMarket(buildDoubleChanceAndBttsMarket(eventId, period, pricingContext, model));
  addMarket(buildMultigoalsMarket(eventId, period, pricingContext, model.totalGoalsPMF));
  if (period === "ft") {
    addMarket(buildMultiscoresMarket(eventId, pricingContext, model.scoreMatrix));
  }

  if (period === "ft") {
    addMarket(buildTotalAndBttsMarket(eventId, period, pricingContext, model));
    addMarket(buildDoubleChanceAndTotalMarket(eventId, period, pricingContext, model));
  }

  for (const points of totalPoints) {
    addMarket(buildTotalGoalsMarket(eventId, period, points, pricingContext, model));
  }

  for (const minimumGoals of goalRangeStarts) {
    addMarket(buildGoalRangeMarket(eventId, period, minimumGoals, pricingContext, model));
  }

  for (const [teamKey, teamName, teamPMF, opposingPMF, teamLambda] of [
    ["home", match.home || "Home", model.homePMF, model.awayPMF, lambdaHome],
    ["away", match.away || "Away", model.awayPMF, model.homePMF, lambdaAway],
  ]) {
    addMarket(buildTeamMultigoalsMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF));
    addMarket(buildTeamOddEvenMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF));
    addMarket(buildTeamExactGoalsMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF));
    addMarket(buildTeamWinToNilMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF, opposingPMF, teamLambda, model.scoreMatrix));
    addMarket(buildCleanSheetMarket(eventId, period, teamKey, teamName, pricingContext, opposingPMF));

    for (const points of teamTotalPoints) {
      addMarket(buildTeamTotalGoalsMarket(eventId, period, teamKey, teamName, points, pricingContext, teamPMF, teamLambda));
    }
  }

  return markets;
}

function buildSplitDependentMarkets(match, eventId, firstHalfRatio = DEFAULT_FIRST_HALF_RATIO, providerMarketRegistry) {
  const analytics = buildEventAnalytics(match, firstHalfRatio);
  const firstHalf = analytics?.firstHalf || null;
  const secondHalf = analytics?.secondHalf || null;
  if (!firstHalf || !secondHalf) {
    return [];
  }

  const first = buildPeriodModel(firstHalf.lambdaHome, firstHalf.lambdaAway, firstHalf.rho);
  const second = buildPeriodModel(secondHalf.lambdaHome, secondHalf.lambdaAway, secondHalf.rho);
  if (!first || !second) {
    return [];
  }

  const markets = [];
  const registry = providerMarketRegistry || new Set();
  const addMarket = (market) => {
    if (!market) {
      return;
    }
    if (!canGenerateDerivedMarket(registry, market.type, market.specifier)) {
      markets.push({ ...market, _lambdaCompare: true });
      return;
    }
    markets.push(market);
  };

  addMarket(buildHalftimeFulltimeMarket(eventId, analytics, first, second));
  addMarket(buildHalftimeFulltimeAndTotalMarket(eventId, analytics, first, second, 2.5));
  addMarket(buildHalftimeFulltimeAndFirstHalfTotalMarket(eventId, analytics, first, second, 1.5));
  addMarket(buildHalftimeFulltimeAndExactGoalsMarket(eventId, analytics, first, second, [1, 2, 3, 4]));
  addMarket(buildFirstHalfResultOrMatchResultMarket(eventId, analytics, first, second));
  addMarket(buildDoubleChanceMatchAndHalfBttsMarket(eventId, analytics, first, second, "1h"));
  addMarket(buildDoubleChanceMatchAndHalfBttsMarket(eventId, analytics, first, second, "2h"));

  for (const [teamKey, teamName] of [["home", match.home || "Home"], ["away", match.away || "Away"]]) {
    addMarket(buildTeamToScoreBothHalvesMarket(eventId, teamKey, teamName, analytics, first, second));
    addMarket(buildTeamWinBothHalvesMarket(eventId, teamKey, teamName, analytics, first, second));
    addMarket(buildTeamWinEitherHalfMarket(eventId, teamKey, teamName, analytics, first, second));
    addMarket(buildTeamHighestScoringHalfMarket(eventId, teamKey, teamName, analytics, first, second));
  }

  addMarket(buildBothHalvesTotalGoalsMarket(eventId, analytics, first, second, 1.5, "over"));
  addMarket(buildBothHalvesTotalGoalsMarket(eventId, analytics, first, second, 1.5, "under"));
  addMarket(buildHighestScoringHalfMarket(eventId, analytics, first, second));

  return markets;
}

function buildPeriodModel(lambdaHome, lambdaAway, rho = 0) {
  const homePMF = buildPoissonPMF(lambdaHome);
  const awayPMF = buildPoissonPMF(lambdaAway);
  const probs = computeDixonColesMatchProbs(lambdaHome, lambdaAway, rho);
  if (!probs) {
    return null;
  }

  const scoreMatrix = buildScoreMatrix(lambdaHome, lambdaAway, rho);
  const totalGoalsPMF = probs.totalGoalsPMF || deriveTotalGoalsPMFFromMatrix(scoreMatrix);
  const pHomeNoGoal = homePMF[0] ?? 0;
  const pAwayNoGoal = awayPMF[0] ?? 0;
  // DC-corrected BTTS: P(home≥1 AND away≥1) = 1 - P(home=0) - P(away=0) + P(0-0)_DC
  // The (0,0) cell in scoreMatrix includes the tau correction, unlike the naive product.
  const bttsYes = 1 - pHomeNoGoal - pAwayNoGoal + (scoreMatrix?.[0]?.[0] ?? pHomeNoGoal * pAwayNoGoal);

  return {
    lambdaHome,
    lambdaAway,
    rho,
    homePMF,
    awayPMF,
    probs,
    scoreMatrix,
    totalGoalsPMF,
    pHomeNoGoal,
    pAwayNoGoal,
    bttsYes,
    bttsNo: 1 - bttsYes,
  };
}

function buildMatchWinnerMarket(eventId, period, pricingContext, probs) {
  if (!probs) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "match_winner", null, period),
    eventId,
    type: "match_winner",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:match_winner:3way",
    source: "lambda-derived",
    selections: [
      buildSelection("home", "Home", decimalOddsFromProbability(probs.home), "lambda-derived"),
      buildSelection("draw", "Draw", decimalOddsFromProbability(probs.draw), "lambda-derived"),
      buildSelection("away", "Away", decimalOddsFromProbability(probs.away), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: withProbabilities(pricingContext, probs),
  };
}

function buildDoubleChanceMarket(eventId, period, pricingContext, probs) {
  if (!probs) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "double_chance", null, period),
    eventId,
    type: "double_chance",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:double_chance:3way",
    source: "lambda-derived",
    selections: [
      buildSelection("home_draw", "Home or Draw", decimalOddsFromProbability(probs.home + probs.draw), "lambda-derived"),
      buildSelection("home_away", "Home or Away", decimalOddsFromProbability(probs.home + probs.away), "lambda-derived"),
      buildSelection("draw_away", "Draw or Away", decimalOddsFromProbability(probs.draw + probs.away), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildDrawNoBetMarket(eventId, period, pricingContext, probs) {
  const denom = Number(probs?.home) + Number(probs?.away);
  if (!(denom > 0)) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "draw_no_bet", null, period),
    eventId,
    type: "draw_no_bet",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:draw_no_bet:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("home", "Home", decimalOddsFromProbability(probs.home / denom), "lambda-derived"),
      buildSelection("away", "Away", decimalOddsFromProbability(probs.away / denom), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildBttsMarket(eventId, period, pricingContext, model) {
  return {
    marketId: marketIdFor(eventId, "both_teams_to_score", null, period),
    eventId,
    type: "both_teams_to_score",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:btts:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(model.bttsYes), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(model.bttsNo), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildOddEvenMarket(eventId, period, pricingContext, model) {
  let odd = 0;
  let even = 0;
  for (let goals = 0; goals < model.totalGoalsPMF.length; goals += 1) {
    const probability = model.totalGoalsPMF[goals] ?? 0;
    if (goals % 2 === 0) {
      even += probability;
    } else {
      odd += probability;
    }
  }

  return {
    marketId: marketIdFor(eventId, "odd_even_goals", null, period),
    eventId,
    type: "odd_even_goals",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:odd_even_goals:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("odd", "Odd", decimalOddsFromProbability(odd), "lambda-derived"),
      buildSelection("even", "Even", decimalOddsFromProbability(even), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildFirstTeamToScoreMarket(eventId, period, pricingContext, model) {
  const probabilities = firstScorerProbabilities(model.lambdaHome, model.lambdaAway);
  if (!probabilities) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "first_team_to_score", null, period),
    eventId,
    type: "first_team_to_score",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:first_team_to_score:3way",
    source: "lambda-derived",
    selections: [
      buildSelection("home", "Home", decimalOddsFromProbability(probabilities.home), "lambda-derived"),
      buildSelection("away", "Away", decimalOddsFromProbability(probabilities.away), "lambda-derived"),
      buildSelection("no_goal", "No Goal", decimalOddsFromProbability(probabilities.no_goal), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildWhichTeamToScoreMarket(eventId, period, pricingContext, model) {
  const probabilities = firstScorerProbabilities(model.lambdaHome, model.lambdaAway);
  if (!probabilities) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "which_team_to_score", null, period),
    eventId,
    type: "which_team_to_score",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:which_team_to_score:3way",
    source: "lambda-derived",
    selections: [
      buildSelection("home", "Home", decimalOddsFromProbability(probabilities.home), "lambda-derived"),
      buildSelection("away", "Away", decimalOddsFromProbability(probabilities.away), "lambda-derived"),
      buildSelection("no_goal", "No Goal", decimalOddsFromProbability(probabilities.no_goal), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildTotalGoalsMarket(eventId, period, points, pricingContext, model) {
  const overShare = dixonColesTotalGoalsMarketShare(points, model.lambdaHome, model.lambdaAway, model.rho);
  if (!Number.isFinite(overShare) || overShare <= 0 || overShare >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "total_goals", { points, label: String(points) }, period),
    eventId,
    type: "total_goals",
    specifier: withPeriod({ points, label: String(points) }, period),
    status: "open",
    templateId: "tmpl:total_goals:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("over", `Over ${points}`, decimalOddsFromProbability(overShare), "lambda-derived"),
      buildSelection("under", `Under ${points}`, decimalOddsFromProbability(1 - overShare), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildTeamTotalGoalsMarket(eventId, period, teamKey, teamName, points, pricingContext, teamPMF, teamLambda) {
  const overProb = 1 - cumulativeProbability(teamPMF, Math.floor(points));
  if (!Number.isFinite(overProb) || overProb <= 0 || overProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "team_total_goals", { team: teamKey, points }, period),
    eventId,
    type: "team_total_goals",
    specifier: withPeriod({ team: teamKey, teamName, points, label: String(points) }, period),
    status: "open",
    templateId: "tmpl:team_total_goals:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("over", `Over ${points}`, decimalOddsFromProbability(overProb), "lambda-derived"),
      buildSelection("under", `Under ${points}`, decimalOddsFromProbability(1 - overProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: { ...pricingContext, teamLambda: round(teamLambda, 3) },
  };
}

function buildTeamWinToNilMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF, opposingPMF, teamLambda, scoreMatrix) {
  const yesProb = teamToWinToNilProbability(scoreMatrix, teamKey);
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "team_to_win_to_nil", { team: teamKey }, period),
    eventId,
    type: "team_to_win_to_nil",
    specifier: withPeriod({ team: teamKey, teamName }, period),
    status: "open",
    templateId: "tmpl:team_to_win_to_nil:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: { ...pricingContext, teamLambda: round(teamLambda, 3) },
  };
}

function buildCleanSheetMarket(eventId, period, teamKey, teamName, pricingContext, opposingPMF) {
  const yesProb = opposingPMF[0] ?? 0;
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "clean_sheet", { team: teamKey }, period),
    eventId,
    type: "clean_sheet",
    specifier: withPeriod({ team: teamKey, teamName }, period),
    status: "open",
    templateId: "tmpl:clean_sheet:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildCorrectScoreMarket(eventId, period, pricingContext, model) {
  const correctScores = buildCorrectScoreSelections(model.scoreMatrix);
  if (!correctScores.length) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "correct_score", { variant: "top6" }, period),
    eventId,
    type: "correct_score",
    specifier: withPeriod({ variant: "top6" }, period),
    status: "open",
    templateId: "tmpl:correct_score:3way",
    source: "lambda-derived",
    selections: correctScores,
    pricingContext,
  };
}

function buildExactGoalsMarket(eventId, period, pricingContext, model) {
  const selections = [];
  for (let goals = 0; goals <= 5; goals += 1) {
    selections.push(buildSelection(
      String(goals),
      String(goals),
      decimalOddsFromProbability(model.totalGoalsPMF[goals] ?? 0),
      "lambda-derived",
      buildFairSelection(model.totalGoalsPMF[goals] ?? 0, "model")
    ));
  }

  const sixPlusProb = sumTail(model.totalGoalsPMF, 6);
  selections.push(buildSelection("6plus", "6+", decimalOddsFromProbability(sixPlusProb), "lambda-derived", buildFairSelection(sixPlusProb, "model")));

  return {
    marketId: marketIdFor(eventId, "exact_total_goals", null, period),
    eventId,
    type: "exact_total_goals",
    specifier: withPeriod({}, period),
    status: "open",
    templateId: "tmpl:exact_total_goals:multiway",
    source: "lambda-derived",
    selections: selections.filter(Boolean),
    pricingContext,
  };
}

function buildTeamExactGoalsMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF) {
  const selections = [];
  for (let goals = 0; goals <= 4; goals += 1) {
    selections.push(buildSelection(
      String(goals),
      String(goals),
      decimalOddsFromProbability(teamPMF[goals] ?? 0),
      "lambda-derived",
      buildFairSelection(teamPMF[goals] ?? 0, "model")
    ));
  }

  const fivePlusProb = sumTail(teamPMF, 5);
  selections.push(buildSelection("5plus", "5+", decimalOddsFromProbability(fivePlusProb), "lambda-derived", buildFairSelection(fivePlusProb, "model")));

  return {
    marketId: marketIdFor(eventId, "team_goals_exact", { team: teamKey }, period),
    eventId,
    type: "team_goals_exact",
    specifier: withPeriod({ team: teamKey, teamName }, period),
    status: "open",
    templateId: "tmpl:team_goals_exact:multiway",
    source: "lambda-derived",
    selections: selections.filter(Boolean),
    pricingContext,
  };
}

function buildTeamOddEvenMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF) {
  let odd = 0;
  let even = 0;
  for (let goals = 0; goals < teamPMF.length; goals += 1) {
    const probability = teamPMF[goals] ?? 0;
    if (goals % 2 === 0) {
      even += probability;
    } else {
      odd += probability;
    }
  }

  return {
    marketId: marketIdFor(eventId, "team_odd_even_goals", { team: teamKey }, period),
    eventId,
    type: "team_odd_even_goals",
    specifier: withPeriod({ team: teamKey, teamName }, period),
    status: "open",
    templateId: "tmpl:team_odd_even_goals:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("odd", "Odd", decimalOddsFromProbability(odd), "lambda-derived"),
      buildSelection("even", "Even", decimalOddsFromProbability(even), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildGoalRangeMarket(eventId, period, minimumGoals, pricingContext, model) {
  const yesProb = sumTail(model.totalGoalsPMF, minimumGoals);
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  const variant = `${minimumGoals}+`;
  return {
    marketId: marketIdFor(eventId, "goal_range", { variant }, period),
    eventId,
    type: "goal_range",
    specifier: withPeriod({ variant }, period),
    status: "open",
    templateId: "tmpl:goal_range:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext,
  };
}

function buildTeamToScoreBothHalvesMarket(eventId, teamKey, teamName, analytics, first, second) {
  const firstProb = 1 - ((teamKey === "home" ? first.homePMF : first.awayPMF)[0] ?? 0);
  const secondProb = 1 - ((teamKey === "home" ? second.homePMF : second.awayPMF)[0] ?? 0);
  const yesProb = firstProb * secondProb;
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "team_to_score_in_both_halves", { team: teamKey }, "ft"),
    eventId,
    type: "team_to_score_in_both_halves",
    specifier: { team: teamKey, teamName },
    status: "open",
    templateId: "tmpl:team_to_score_in_both_halves:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: {
      source: "ratio-derived",
      firstHalfRatio: analytics.firstHalfRatio,
      secondHalfRatio: analytics.secondHalfRatio,
    },
  };
}

function buildBothHalvesTotalGoalsMarket(eventId, analytics, first, second, points, outcome) {
  const firstOver = dixonColesTotalGoalsMarketShare(points, first.lambdaHome, first.lambdaAway, first.rho);
  const secondOver = dixonColesTotalGoalsMarketShare(points, second.lambdaHome, second.lambdaAway, second.rho);
  if (!Number.isFinite(firstOver) || !Number.isFinite(secondOver)) {
    return null;
  }

  const yesProb = outcome === "over"
    ? firstOver * secondOver
    : (1 - firstOver) * (1 - secondOver);
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "both_halves_total_goals", { points, outcome }, "ft"),
    eventId,
    type: "both_halves_total_goals",
    specifier: { points, outcome },
    status: "open",
    templateId: "tmpl:both_halves_total_goals:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: {
      source: "ratio-derived",
      firstHalfRatio: analytics.firstHalfRatio,
      secondHalfRatio: analytics.secondHalfRatio,
    },
  };
}

function buildHighestScoringHalfMarket(eventId, analytics, first, second) {
  const probabilities = halfComparisonProbabilities(first.totalGoalsPMF, second.totalGoalsPMF);
  if (!probabilities) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "highest_scoring_half", null, "ft"),
    eventId,
    type: "highest_scoring_half",
    specifier: null,
    status: "open",
    templateId: "tmpl:highest_scoring_half:3way",
    source: "lambda-derived",
    selections: [
      buildSelection("first_half", "1st Half", decimalOddsFromProbability(probabilities.first_half), "lambda-derived"),
      buildSelection("second_half", "2nd Half", decimalOddsFromProbability(probabilities.second_half), "lambda-derived"),
      buildSelection("tie", "Tie", decimalOddsFromProbability(probabilities.tie), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: {
      source: "ratio-derived",
      firstHalfRatio: analytics.firstHalfRatio,
      secondHalfRatio: analytics.secondHalfRatio,
    },
  };
}

function buildHalftimeFulltimeMarket(eventId, analytics, first, second) {
  const probabilityMap = {};
  iterateHalfScoreStates(first.scoreMatrix, second.scoreMatrix, (state, probability) => {
    const id = `${state.halfTimeResult}_${state.fullTimeResult}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  return buildComboMarket(eventId, "halftime_fulltime", null, "ft", [
    ["home_home", "Home/Home"],
    ["home_draw", "Home/Draw"],
    ["home_away", "Home/Away"],
    ["draw_home", "Draw/Home"],
    ["draw_draw", "Draw/Draw"],
    ["draw_away", "Draw/Away"],
    ["away_home", "Away/Home"],
    ["away_draw", "Away/Draw"],
    ["away_away", "Away/Away"],
  ], probabilityMap, {
    ...analytics,
    source: "ratio-derived",
  });
}

function buildMatchResultAndTotalMarket(eventId, period, pricingContext, model, points = 2.5) {
  const probabilityMap = {};
  iterateScoreMatrix(model.scoreMatrix, (homeGoals, awayGoals, probability) => {
    const result = scoreResult(homeGoals, awayGoals);
    const side = homeGoals + awayGoals > points ? "over" : "under";
    const id = `${result}_${side}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  return buildComboMarket(eventId, "match_result_and_total", { points }, period, [
    ["home_over", "Home & Over"],
    ["draw_over", "Draw & Over"],
    ["away_over", "Away & Over"],
    ["home_under", "Home & Under"],
    ["draw_under", "Draw & Under"],
    ["away_under", "Away & Under"],
  ], probabilityMap, pricingContext);
}

function buildMatchResultAndBttsMarket(eventId, period, pricingContext, model) {
  const probabilityMap = {};
  iterateScoreMatrix(model.scoreMatrix, (homeGoals, awayGoals, probability) => {
    const result = scoreResult(homeGoals, awayGoals);
    const btts = homeGoals > 0 && awayGoals > 0 ? "yes" : "no";
    const id = `${result}_${btts}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  return buildComboMarket(eventId, "match_result_and_btts", null, period, [
    ["home_yes", "Home & BTTS Yes"],
    ["draw_yes", "Draw & BTTS Yes"],
    ["away_yes", "Away & BTTS Yes"],
    ["home_no", "Home & BTTS No"],
    ["draw_no", "Draw & BTTS No"],
    ["away_no", "Away & BTTS No"],
  ], probabilityMap, pricingContext);
}

function buildTotalAndBttsMarket(eventId, period, pricingContext, model, points = 2.5) {
  const probabilityMap = {};
  iterateScoreMatrix(model.scoreMatrix, (homeGoals, awayGoals, probability) => {
    const totalSide = homeGoals + awayGoals > points ? "over" : "under";
    const btts = homeGoals > 0 && awayGoals > 0 ? "yes" : "no";
    const id = `${totalSide}_${btts}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  return buildComboMarket(eventId, "total_and_btts", { points }, period, [
    ["over_yes", "Over & BTTS Yes"],
    ["over_no", "Over & BTTS No"],
    ["under_yes", "Under & BTTS Yes"],
    ["under_no", "Under & BTTS No"],
  ], probabilityMap, pricingContext);
}

function buildDoubleChanceAndBttsMarket(eventId, period, pricingContext, model) {
  const probabilityMap = {};
  iterateScoreMatrix(model.scoreMatrix, (homeGoals, awayGoals, probability) => {
    const result = scoreResult(homeGoals, awayGoals);
    const btts = homeGoals > 0 && awayGoals > 0 ? "yes" : "no";
    for (const dc of doubleChanceIdsForResult(result)) {
      const id = `${dc}_${btts}`;
      probabilityMap[id] = (probabilityMap[id] || 0) + probability;
    }
  });

  return buildComboMarket(eventId, "double_chance_and_btts", null, period, [
    ["home_draw_yes", "1X & BTTS Yes"],
    ["home_away_yes", "12 & BTTS Yes"],
    ["draw_away_yes", "X2 & BTTS Yes"],
    ["home_draw_no", "1X & BTTS No"],
    ["home_away_no", "12 & BTTS No"],
    ["draw_away_no", "X2 & BTTS No"],
  ], probabilityMap, pricingContext);
}

function buildDoubleChanceAndTotalMarket(eventId, period, pricingContext, model, points = 2.5) {
  const probabilityMap = {};
  iterateScoreMatrix(model.scoreMatrix, (homeGoals, awayGoals, probability) => {
    const result = scoreResult(homeGoals, awayGoals);
    const totalSide = homeGoals + awayGoals > points ? "over" : "under";
    for (const dc of doubleChanceIdsForResult(result)) {
      const id = `${dc}_${totalSide}`;
      probabilityMap[id] = (probabilityMap[id] || 0) + probability;
    }
  });

  return buildComboMarket(eventId, "double_chance_and_total", { points }, period, [
    ["home_draw_over", "1X & Over"],
    ["home_away_over", "12 & Over"],
    ["draw_away_over", "X2 & Over"],
    ["home_draw_under", "1X & Under"],
    ["home_away_under", "12 & Under"],
    ["draw_away_under", "X2 & Under"],
  ], probabilityMap, pricingContext);
}

function buildDoubleChanceMatchAndHalfBttsMarket(eventId, analytics, first, second, halfPeriod) {
  const probabilityMap = {};
  iterateHalfScoreStates(first.scoreMatrix, second.scoreMatrix, (state, probability) => {
    const halfBtts = halfPeriod === "1h"
      ? (state.homeFirst > 0 && state.awayFirst > 0)
      : (state.homeSecond > 0 && state.awaySecond > 0);
    const suffix = halfBtts ? "yes" : "no";
    for (const dc of doubleChanceIdsForResult(state.fullTimeResult)) {
      const id = `${dc}_${suffix}`;
      probabilityMap[id] = (probabilityMap[id] || 0) + probability;
    }
  });

  return buildComboMarket(eventId, "double_chance_match_and_btts_half", { period: halfPeriod }, "ft", [
    ["home_draw_yes", "1X & Half BTTS Yes"],
    ["home_away_yes", "12 & Half BTTS Yes"],
    ["draw_away_yes", "X2 & Half BTTS Yes"],
    ["home_draw_no", "1X & Half BTTS No"],
    ["home_away_no", "12 & Half BTTS No"],
    ["draw_away_no", "X2 & Half BTTS No"],
  ], probabilityMap, {
    source: "ratio-derived",
    firstHalfRatio: analytics.firstHalfRatio,
    secondHalfRatio: analytics.secondHalfRatio,
  });
}

function buildHalftimeFulltimeAndTotalMarket(eventId, analytics, first, second, points = 2.5) {
  const outcomes = [
    ["home_home", "Home/Home"],
    ["home_draw", "Home/Draw"],
    ["home_away", "Home/Away"],
    ["draw_home", "Draw/Home"],
    ["draw_draw", "Draw/Draw"],
    ["draw_away", "Draw/Away"],
    ["away_home", "Away/Home"],
    ["away_draw", "Away/Draw"],
    ["away_away", "Away/Away"],
  ];
  const probabilityMap = {};

  iterateHalfScoreStates(first.scoreMatrix, second.scoreMatrix, (state, probability) => {
    const totalSide = state.homeFull + state.awayFull > points ? "over" : "under";
    const id = `${state.halfTimeResult}_${state.fullTimeResult}_${totalSide}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  const selectionDefs = [];
  for (const [id, label] of outcomes) {
    selectionDefs.push([`${id}_over`, `${label} & Over`]);
    selectionDefs.push([`${id}_under`, `${label} & Under`]);
  }

  return buildComboMarket(eventId, "halftime_fulltime_and_total", { points }, "ft", selectionDefs, probabilityMap, {
    source: "ratio-derived",
    firstHalfRatio: analytics.firstHalfRatio,
    secondHalfRatio: analytics.secondHalfRatio,
  });
}

function buildHalftimeFulltimeAndFirstHalfTotalMarket(eventId, analytics, first, second, points = 1.5) {
  const outcomes = [
    ["home_home", "Home/Home"],
    ["home_draw", "Home/Draw"],
    ["home_away", "Home/Away"],
    ["draw_home", "Draw/Home"],
    ["draw_draw", "Draw/Draw"],
    ["draw_away", "Draw/Away"],
    ["away_home", "Away/Home"],
    ["away_draw", "Away/Draw"],
    ["away_away", "Away/Away"],
  ];
  const probabilityMap = {};

  iterateHalfScoreStates(first.scoreMatrix, second.scoreMatrix, (state, probability) => {
    const totalSide = state.homeFirst + state.awayFirst > points ? "over" : "under";
    const id = `${state.halfTimeResult}_${state.fullTimeResult}_${totalSide}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  const selectionDefs = [];
  for (const [id, label] of outcomes) {
    selectionDefs.push([`${id}_over`, `${label} & Over`]);
    selectionDefs.push([`${id}_under`, `${label} & Under`]);
  }

  return buildComboMarket(eventId, "halftime_fulltime_and_first_half_total", { points }, "ft", selectionDefs, probabilityMap, {
    source: "ratio-derived",
    firstHalfRatio: analytics.firstHalfRatio,
    secondHalfRatio: analytics.secondHalfRatio,
  });
}

function buildHalftimeFulltimeAndExactGoalsMarket(eventId, analytics, first, second, exactGoals) {
  const outcomes = [
    ["home_home", "Home/Home"],
    ["home_draw", "Home/Draw"],
    ["home_away", "Home/Away"],
    ["draw_home", "Draw/Home"],
    ["draw_draw", "Draw/Draw"],
    ["draw_away", "Draw/Away"],
    ["away_home", "Away/Home"],
    ["away_draw", "Away/Draw"],
    ["away_away", "Away/Away"],
  ];
  const probabilityMap = {};

  iterateHalfScoreStates(first.scoreMatrix, second.scoreMatrix, (state, probability) => {
    const totalGoals = state.homeFull + state.awayFull;
    if (!exactGoals.includes(totalGoals)) {
      return;
    }
    const id = `${state.halfTimeResult}_${state.fullTimeResult}_${totalGoals}`;
    probabilityMap[id] = (probabilityMap[id] || 0) + probability;
  });

  const selectionDefs = [];
  for (const [id, label] of outcomes) {
    for (const totalGoals of exactGoals) {
      selectionDefs.push([`${id}_${totalGoals}`, `${label} & ${totalGoals}`]);
    }
  }

  return buildComboMarket(eventId, "halftime_fulltime_and_exact_goals", { variant: exactGoals.join("_") }, "ft", selectionDefs, probabilityMap, {
    source: "ratio-derived",
    firstHalfRatio: analytics.firstHalfRatio,
    secondHalfRatio: analytics.secondHalfRatio,
  });
}

function buildFirstHalfResultOrMatchResultMarket(eventId, analytics, first, second) {
  const probabilityMap = { home: 0, draw: 0, away: 0 };

  iterateHalfScoreStates(first.scoreMatrix, second.scoreMatrix, (state, probability) => {
    if (state.halfTimeResult === "home" || state.fullTimeResult === "home") {
      probabilityMap.home += probability;
    }
    if (state.halfTimeResult === "draw" || state.fullTimeResult === "draw") {
      probabilityMap.draw += probability;
    }
    if (state.halfTimeResult === "away" || state.fullTimeResult === "away") {
      probabilityMap.away += probability;
    }
  });

  return buildComboMarket(eventId, "first_half_result_or_match_result", null, "ft", [
    ["home", "Home"],
    ["draw", "Draw"],
    ["away", "Away"],
  ], probabilityMap, {
    source: "ratio-derived",
    firstHalfRatio: analytics.firstHalfRatio,
    secondHalfRatio: analytics.secondHalfRatio,
  });
}

function buildMultigoalsMarket(eventId, period, pricingContext, totalGoalsPMF) {
  const ranges = period === "ft"
    ? [[1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [2, 4], [2, 5], [2, 6], [3, 4], [3, 5], [3, 6], [4, 5], [4, 6], [5, 6]]
    : [[1, 2], [1, 3], [2, 3]];

  return buildRangeMarket(eventId, "multigoals", null, period, pricingContext, totalGoalsPMF, ranges);
}

function buildTeamMultigoalsMarket(eventId, period, teamKey, teamName, pricingContext, teamPMF) {
  const ranges = [[1, 2], [1, 3], [2, 3]];
  return buildRangeMarket(eventId, "team_multigoals", { team: teamKey, teamName }, period, pricingContext, teamPMF, ranges);
}

function buildMultiscoresMarket(eventId, pricingContext, scoreMatrix) {
  const groups = [
    ["home_1_0_2_0_3_0", "1:0, 2:0 Or 3:0", [[1, 0], [2, 0], [3, 0]]],
    ["away_0_1_0_2_0_3", "0:1, 0:2 Or 0:3", [[0, 1], [0, 2], [0, 3]]],
    ["home_4_0_5_0_6_0", "4:0, 5:0 Or 6:0", [[4, 0], [5, 0], [6, 0]]],
    ["away_0_4_0_5_0_6", "0:4, 0:5 Or 0:6", [[0, 4], [0, 5], [0, 6]]],
    ["home_2_1_3_1_4_1", "2:1, 3:1 Or 4:1", [[2, 1], [3, 1], [4, 1]]],
    ["away_1_2_1_3_1_4", "1:2, 1:3 Or 1:4", [[1, 2], [1, 3], [1, 4]]],
    ["home_mixed_3_2_4_2_4_3_5_1", "3:2, 4:2, 4:3 Or 5:1", [[3, 2], [4, 2], [4, 3], [5, 1]]],
    ["away_mixed_2_3_2_4_3_4_1_5", "2:3, 2:4, 3:4 Or 1:5", [[2, 3], [2, 4], [3, 4], [1, 5]]],
  ];

  const selections = groups
    .map(([id, name, scores]) => {
      const probability = scores.reduce((sum, [homeGoals, awayGoals]) => sum + (scoreMatrix?.[homeGoals]?.[awayGoals] ?? 0), 0);
      return buildSelection(id, name, decimalOddsFromProbability(probability), "lambda-derived", buildFairSelection(probability, "model"));
    })
    .filter(Boolean);

  if (!selections.length) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "multiscores", null, "ft"),
    eventId,
    type: "multiscores",
    specifier: null,
    status: "open",
    templateId: templateIdForMarketType("multiscores"),
    source: "lambda-derived",
    selections,
    pricingContext,
  };
}

function buildRangeMarket(eventId, type, baseSpecifier, period, pricingContext, pmf, ranges) {
  const selections = ranges
    .map(([start, end]) => {
      const probability = sumRangeProbability(pmf, start, end);
      return buildSelection(
        `${start}_${end}`,
        `${start}-${end}`,
        decimalOddsFromProbability(probability),
        "lambda-derived",
        buildFairSelection(probability, "model")
      );
    })
    .filter(Boolean);

  if (!selections.length) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, type, baseSpecifier || null, period),
    eventId,
    type,
    specifier: withPeriod(baseSpecifier || {}, period),
    status: "open",
    templateId: templateIdForMarketType(type),
    source: "lambda-derived",
    selections,
    pricingContext,
  };
}

function buildComboMarket(eventId, type, specifier, period, selectionDefs, probabilityMap, pricingContext) {
  const selections = selectionDefs
    .map(([id, name]) => {
      const probability = Number(probabilityMap?.[id]);
      return buildSelection(id, name, decimalOddsFromProbability(probability), "lambda-derived");
    })
    .filter(Boolean);

  if (!selections.length) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, type, specifier, period),
    eventId,
    type,
    specifier: withPeriod(specifier || {}, period),
    status: "open",
    templateId: templateIdForMarketType(type),
    source: "lambda-derived",
    selections,
    pricingContext,
  };
}

function templateIdForMarketType(type) {
  const map = {
    halftime_fulltime: "tmpl:halftime_fulltime:9way",
    match_result_and_total: "tmpl:match_result_and_total:6way",
    match_result_and_btts: "tmpl:match_result_and_btts:6way",
    total_and_btts: "tmpl:total_and_btts:4way",
    double_chance_and_btts: "tmpl:double_chance_and_btts:6way",
    double_chance_and_total: "tmpl:double_chance_and_total:6way",
    double_chance_match_and_btts_half: "tmpl:double_chance_match_and_btts_half:6way",
    halftime_fulltime_and_total: "tmpl:halftime_fulltime_and_total:18way",
    halftime_fulltime_and_first_half_total: "tmpl:halftime_fulltime_and_first_half_total:18way",
    halftime_fulltime_and_exact_goals: "tmpl:halftime_fulltime_and_exact_goals:36way",
    first_half_result_or_match_result: "tmpl:first_half_result_or_match_result:3way",
    multigoals: "tmpl:multigoals:multiway",
    team_multigoals: "tmpl:team_multigoals:multiway",
    multiscores: "tmpl:multiscores:multiway",
  };
  return map[type] || `tmpl:${type}`;
}

function iterateScoreMatrix(matrix, fn) {
  for (let homeGoals = 0; homeGoals < matrix.length; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals < matrix[homeGoals].length; awayGoals += 1) {
      const probability = matrix[homeGoals][awayGoals] ?? 0;
      if (probability > 0) {
        fn(homeGoals, awayGoals, probability);
      }
    }
  }
}

function iterateHalfScoreStates(firstMatrix, secondMatrix, fn) {
  iterateScoreMatrix(firstMatrix, (homeFirst, awayFirst, firstProb) => {
    iterateScoreMatrix(secondMatrix, (homeSecond, awaySecond, secondProb) => {
      const probability = firstProb * secondProb;
      if (!(probability > 0)) {
        return;
      }
      fn({
        homeFirst,
        awayFirst,
        homeSecond,
        awaySecond,
        homeFull: homeFirst + homeSecond,
        awayFull: awayFirst + awaySecond,
        halfTimeResult: scoreResult(homeFirst, awayFirst),
        fullTimeResult: scoreResult(homeFirst + homeSecond, awayFirst + awaySecond),
      }, probability);
    });
  });
}

function scoreResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "home";
  if (homeGoals < awayGoals) return "away";
  return "draw";
}

function doubleChanceIdsForResult(result) {
  if (result === "home") return ["home_draw", "home_away"];
  if (result === "away") return ["home_away", "draw_away"];
  return ["home_draw", "draw_away"];
}

function buildTeamHighestScoringHalfMarket(eventId, teamKey, teamName, analytics, first, second) {
  const firstPMF = teamKey === "home" ? first.homePMF : first.awayPMF;
  const secondPMF = teamKey === "home" ? second.homePMF : second.awayPMF;
  const probabilities = halfComparisonProbabilities(firstPMF, secondPMF);
  if (!probabilities) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "team_highest_scoring_half", { team: teamKey }, "ft"),
    eventId,
    type: "team_highest_scoring_half",
    specifier: { team: teamKey, teamName },
    status: "open",
    templateId: "tmpl:team_highest_scoring_half:3way",
    source: "lambda-derived",
    selections: [
      buildSelection("first_half", "1st Half", decimalOddsFromProbability(probabilities.first_half), "lambda-derived"),
      buildSelection("second_half", "2nd Half", decimalOddsFromProbability(probabilities.second_half), "lambda-derived"),
      buildSelection("tie", "Tie", decimalOddsFromProbability(probabilities.tie), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: {
      source: "ratio-derived",
      firstHalfRatio: analytics.firstHalfRatio,
      secondHalfRatio: analytics.secondHalfRatio,
    },
  };
}

function buildTeamWinBothHalvesMarket(eventId, teamKey, teamName, analytics, first, second) {
  const firstWin = teamKey === "home" ? first.probs.home : first.probs.away;
  const secondWin = teamKey === "home" ? second.probs.home : second.probs.away;
  const yesProb = firstWin * secondWin;
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "team_to_win_both_halves", { team: teamKey }, "ft"),
    eventId,
    type: "team_to_win_both_halves",
    specifier: { team: teamKey, teamName },
    status: "open",
    templateId: "tmpl:team_to_win_both_halves:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: {
      source: "ratio-derived",
      firstHalfRatio: analytics.firstHalfRatio,
      secondHalfRatio: analytics.secondHalfRatio,
    },
  };
}

function buildTeamWinEitherHalfMarket(eventId, teamKey, teamName, analytics, first, second) {
  const firstWin = teamKey === "home" ? first.probs.home : first.probs.away;
  const secondWin = teamKey === "home" ? second.probs.home : second.probs.away;
  const yesProb = 1 - ((1 - firstWin) * (1 - secondWin));
  if (!Number.isFinite(yesProb) || yesProb <= 0 || yesProb >= 1) {
    return null;
  }

  return {
    marketId: marketIdFor(eventId, "team_to_win_either_half", { team: teamKey }, "ft"),
    eventId,
    type: "team_to_win_either_half",
    specifier: { team: teamKey, teamName },
    status: "open",
    templateId: "tmpl:team_to_win_either_half:2way",
    source: "lambda-derived",
    selections: [
      buildSelection("yes", "Yes", decimalOddsFromProbability(yesProb), "lambda-derived"),
      buildSelection("no", "No", decimalOddsFromProbability(1 - yesProb), "lambda-derived"),
    ].filter(Boolean),
    pricingContext: {
      source: "ratio-derived",
      firstHalfRatio: analytics.firstHalfRatio,
      secondHalfRatio: analytics.secondHalfRatio,
    },
  };
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

function buildCorrectScoreSelections(scoreMatrix) {
  const selections = [];

  for (let h = 0; h <= 3; h += 1) {
    for (let a = 0; a <= 3; a += 1) {
      const probability = scoreMatrix?.[h]?.[a] ?? 0;
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
    secondHalf: (
      Number.isFinite(lambdaHome) &&
      Number.isFinite(lambdaAway) &&
      Number.isFinite(mu)
    ) ? {
      lambdaHome: round(lambdaHome * (1 - normalizedFirstHalfRatio), 3),
      lambdaAway: round(lambdaAway * (1 - normalizedFirstHalfRatio), 3),
      mu: round(mu * (1 - normalizedFirstHalfRatio), 3),
      rho,
    } : null,
  };
}

function shouldBuildDerivedMarkets(match) {
  return Boolean(match?.lambdas);
}

function buildProviderMarketRegistry(match) {
  const registry = new Set();

  if (hasThreeWayOdds(match?.odds || {})) {
    registry.add(marketRegistryKey("match_winner", null));
  }

  for (const totalsLine of [match?.mainTotals, match?.totals25]) {
    if (!isValidTotalsLine(totalsLine)) {
      continue;
    }
    registry.add(marketRegistryKey("total_goals", { points: totalsLine.points }));
  }

  for (const supplemental of match?.supplementalMarkets || []) {
    if (!supplemental?.type || supplemental.type === "asian_handicap_corners") {
      continue;
    }
    registry.add(marketRegistryKey(supplemental.type, {
      ...(supplemental.specifier || {}),
      period: supplemental.period || "ft",
    }));
  }

  return registry;
}

function canGenerateDerivedMarket(registry, type, specifier) {
  return !registry.has(marketRegistryKey(type, specifier));
}

// Market types where the DC model is well-calibrated enough to show a Lambda Calc comparison.
// Team-specific markets are excluded because the model splits total goals by 1x2 ratios,
// which can badly underestimate individual team scoring rates in one-sided matches.
const LAMBDA_COMPARABLE_TYPES = new Set([
  "match_winner",
  "total_goals",
  "double_chance",
  "draw_no_bet",
  "both_teams_to_score",
  "asian_handicap",
]);

function isLambdaComparableMarketType(type) {
  return LAMBDA_COMPARABLE_TYPES.has(type);
}

function marketRegistryKey(type, specifier = null) {
  return JSON.stringify({
    type: String(type || ""),
    period: specifier?.period || "ft",
    team: specifier?.team || "",
    points: normalizeRegistryValue(specifier?.points),
    variant: normalizeRegistryValue(specifier?.variant),
    outcome: normalizeRegistryValue(specifier?.outcome),
  });
}

function normalizeRegistryValue(value) {
  if (value == null || value === "") {
    return "";
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric, 3) : String(value);
}

function teamToWinToNilProbability(scoreMatrix, teamKey) {
  if (!scoreMatrix) return 0;
  let prob = 0;
  if (teamKey === "home") {
    for (let h = 1; h < scoreMatrix.length; h++) {
      prob += scoreMatrix[h]?.[0] ?? 0;
    }
  } else {
    const awayLen = scoreMatrix[0]?.length ?? 0;
    for (let a = 1; a < awayLen; a++) {
      prob += scoreMatrix[0]?.[a] ?? 0;
    }
  }
  return Math.max(0, Math.min(1, prob));
}

function firstScorerProbabilities(lambdaHome, lambdaAway) {
  const total = Number(lambdaHome) + Number(lambdaAway);
  if (!(total > 0)) {
    return null;
  }

  const noGoal = Math.exp(-total);
  const scored = 1 - noGoal;
  return {
    home: scored * (lambdaHome / total),
    away: scored * (lambdaAway / total),
    no_goal: noGoal,
  };
}

function buildScoreMatrix(lambdaHome, lambdaAway, rho = 0) {
  const homePMF = buildPoissonPMF(lambdaHome);
  const awayPMF = buildPoissonPMF(lambdaAway);
  const maxGoals = Math.max(homePMF.length, awayPMF.length) - 1;
  const matrix = Array.from({ length: maxGoals + 1 }, () => Array.from({ length: maxGoals + 1 }, () => 0));
  let total = 0;

  for (let h = 0; h <= maxGoals; h += 1) {
    for (let a = 0; a <= maxGoals; a += 1) {
      const tau = dixonColesTauLocal(h, a, lambdaHome, lambdaAway, rho);
      const probability = (homePMF[h] ?? 0) * (awayPMF[a] ?? 0) * tau;
      matrix[h][a] = probability;
      total += probability;
    }
  }

  if (!(total > 0)) {
    return matrix;
  }

  return matrix.map((row) => row.map((value) => value / total));
}

function dixonColesTauLocal(homeGoals, awayGoals, lambdaHome, lambdaAway, rho) {
  if (homeGoals === 0 && awayGoals === 0) return 1 - (lambdaHome * lambdaAway * rho);
  if (homeGoals === 0 && awayGoals === 1) return 1 + (lambdaHome * rho);
  if (homeGoals === 1 && awayGoals === 0) return 1 + (lambdaAway * rho);
  if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
  return 1;
}

function deriveTotalGoalsPMFFromMatrix(matrix) {
  const maxGoals = Math.max(0, (matrix?.length || 1) - 1);
  const total = Array.from({ length: (maxGoals * 2) + 1 }, () => 0);

  for (let h = 0; h < matrix.length; h += 1) {
    for (let a = 0; a < matrix[h].length; a += 1) {
      total[h + a] += matrix[h][a] ?? 0;
    }
  }

  return total;
}

function sumTail(pmf, startIndex) {
  let total = 0;
  for (let index = startIndex; index < pmf.length; index += 1) {
    total += pmf[index] ?? 0;
  }
  return total;
}

function sumRangeProbability(pmf, startIndexInclusive, endIndexInclusive) {
  let total = 0;
  for (let index = startIndexInclusive; index <= endIndexInclusive; index += 1) {
    total += pmf[index] ?? 0;
  }
  return total;
}

function halfComparisonProbabilities(firstPMF, secondPMF) {
  if (!Array.isArray(firstPMF) || !Array.isArray(secondPMF)) {
    return null;
  }

  let firstHalf = 0;
  let secondHalf = 0;
  let tie = 0;

  for (let first = 0; first < firstPMF.length; first += 1) {
    for (let second = 0; second < secondPMF.length; second += 1) {
      const probability = (firstPMF[first] ?? 0) * (secondPMF[second] ?? 0);
      if (first > second) {
        firstHalf += probability;
      } else if (first < second) {
        secondHalf += probability;
      } else {
        tie += probability;
      }
    }
  }

  return { first_half: firstHalf, second_half: secondHalf, tie };
}

function marketIdFor(eventId, type, specifier = null, period = "ft") {
  const periodSuffix = period && period !== "ft" ? `:${period}` : "";

  if (type === "team_total_goals") {
    return `mkt:${eventId}:${type}:${specifier.team}:${normalizePointsId(specifier.points)}${periodSuffix}`;
  }

  if (type === "team_to_win_to_nil" || type === "clean_sheet" || type === "team_to_score_in_both_halves" || type === "team_highest_scoring_half" || type === "team_to_win_both_halves" || type === "team_to_win_either_half" || type === "team_goals_exact" || type === "team_odd_even_goals") {
    return `mkt:${eventId}:${type}:${specifier.team}${periodSuffix}`;
  }

  if (type === "team_multigoals") {
    return `mkt:${eventId}:${type}:${specifier.team}${periodSuffix}`;
  }

  if (type === "multigoals") {
    return `mkt:${eventId}:${type}${periodSuffix}`;
  }

  if (type === "multiscores") {
    return `mkt:${eventId}:${type}${periodSuffix}`;
  }

  if (type === "halftime_fulltime_and_first_half_total") {
    return `mkt:${eventId}:${type}:${normalizePointsId(specifier.points)}${periodSuffix}`;
  }

  if (type === "halftime_fulltime_and_exact_goals") {
    return `mkt:${eventId}:${type}:${slugify(specifier?.variant || "exact")}${periodSuffix}`;
  }

  if (type === "first_half_result_or_match_result") {
    return `mkt:${eventId}:${type}${periodSuffix}`;
  }

  if (type === "total_goals" || type === "both_halves_total_goals") {
    const extra = type === "both_halves_total_goals"
      ? `:${normalizePointsId(specifier.points)}:${specifier.outcome}`
      : `:${normalizePointsId(specifier.points)}`;
    return `mkt:${eventId}:${type}${extra}${periodSuffix}`;
  }

  if (type === "goal_range") {
    return `mkt:${eventId}:${type}:${slugify(specifier.variant || "range")}${periodSuffix}`;
  }

  if (type === "double_chance_match_and_btts_half") {
    return `mkt:${eventId}:${type}:${specifier?.period || "ft"}${periodSuffix}`;
  }

  if (type === "correct_score") {
    return `mkt:${eventId}:${type}:top${periodSuffix}`;
  }

  return `mkt:${eventId}:${type}${periodSuffix}`;
}

function withPeriod(specifier = {}, period = "ft") {
  return period && period !== "ft" ? { ...specifier, period } : specifier;
}

function withProbabilities(pricingContext, probs) {
  return {
    ...(pricingContext || {}),
    dixonColesProbs: {
      home: round(probs.home, 4),
      draw: round(probs.draw, 4),
      away: round(probs.away, 4),
    },
  };
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
      nextMarkets[existingIndex] = attachSupplementalCompare(nextMarkets[existingIndex], supplemental, match.source || "p4578");
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

  if (
    market.type === "team_total_goals" ||
    market.type === "team_total_corners" ||
    market.type === "team_to_win_to_nil" ||
    market.type === "clean_sheet" ||
    market.type === "team_to_score_in_both_halves" ||
    market.type === "team_highest_scoring_half" ||
    market.type === "team_to_win_both_halves" ||
    market.type === "team_to_win_either_half" ||
    market.type === "team_odd_even_goals"
  ) {
    return (
      market.specifier?.team === supplemental?.specifier?.team &&
      (
        market.type === "team_to_win_to_nil" ||
        market.type === "clean_sheet" ||
        market.type === "team_to_score_in_both_halves" ||
        market.type === "team_highest_scoring_half" ||
        market.type === "team_to_win_both_halves" ||
        market.type === "team_to_win_either_half" ||
        market.type === "team_odd_even_goals" ||
        Number(market.specifier?.points) === Number(supplemental?.specifier?.points)
      )
    );
  }

  if (market.type === "team_multigoals") {
    return market.specifier?.team === supplemental?.specifier?.team;
  }

  if (market.type === "multigoals") {
    return true;
  }

  if (
    market.type === "total_goals" ||
    market.type === "asian_handicap" ||
    market.type === "total_corners" ||
    market.type === "total_and_btts"
  ) {
    return Number(market.specifier?.points) === Number(supplemental?.specifier?.points);
  }

  if (market.type === "both_halves_total_goals") {
    return (
      Number(market.specifier?.points) === Number(supplemental?.specifier?.points) &&
      String(market.specifier?.outcome || "") === String(supplemental?.specifier?.outcome || "")
    );
  }

  if (market.type === "team_goals_exact") {
    return market.specifier?.team === supplemental?.specifier?.team;
  }

  if (market.type === "goal_range") {
    return String(market.specifier?.variant || "") === String(supplemental?.specifier?.variant || "");
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

function buildSupplementalMarket(eventId, supplemental, sourceName) {
  const period = supplemental?.period || "ft";
  const periodSuffix = period === "1h" ? ":1h" : "";
  const fairSelectionMap = computeSupplementalFairSelectionMap(supplemental);
  const pointsSuffix = supplemental?.type === "team_total_goals" || supplemental?.type === "team_total_corners"
    ? `:${supplemental.specifier.team}:${normalizePointsId(supplemental.specifier.points)}`
    : supplemental?.type === "team_to_win_to_nil" ||
      supplemental?.type === "clean_sheet" ||
      supplemental?.type === "team_to_score_in_both_halves" ||
      supplemental?.type === "team_highest_scoring_half" ||
      supplemental?.type === "team_to_win_both_halves" ||
      supplemental?.type === "team_to_win_either_half" ||
      supplemental?.type === "team_odd_even_goals" ||
      supplemental?.type === "team_goals_exact"
      ? `:${supplemental.specifier.team}`
    : supplemental?.type === "team_multigoals"
      ? `:${supplemental.specifier.team}`
    : supplemental?.type === "multigoals"
      ? ""
    : supplemental?.type === "total_goals" || supplemental?.type === "asian_handicap" || supplemental?.type === "total_corners" || supplemental?.type === "total_and_btts"
      ? `:${normalizePointsId(supplemental.specifier.points)}`
    : supplemental?.type === "both_halves_total_goals"
      ? `:${normalizePointsId(supplemental.specifier.points)}:${supplemental.specifier.outcome}`
    : supplemental?.type === "goal_range"
      ? `:${slugify(supplemental.specifier.variant || "range")}`
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
            : supplemental.type === "odd_even_goals"
              ? "tmpl:odd_even_goals:2way"
            : supplemental.type === "clean_sheet"
              ? "tmpl:clean_sheet:2way"
            : supplemental.type === "first_team_to_score"
              ? "tmpl:first_team_to_score:3way"
            : supplemental.type === "which_team_to_score"
              ? "tmpl:which_team_to_score:3way"
            : supplemental.type === "goal_range"
              ? "tmpl:goal_range:2way"
            : supplemental.type === "team_to_score_in_both_halves"
              ? "tmpl:team_to_score_in_both_halves:2way"
            : supplemental.type === "both_halves_total_goals"
              ? "tmpl:both_halves_total_goals:2way"
            : supplemental.type === "highest_scoring_half"
              ? "tmpl:highest_scoring_half:3way"
            : supplemental.type === "team_highest_scoring_half"
              ? "tmpl:team_highest_scoring_half:3way"
            : supplemental.type === "team_to_win_both_halves"
              ? "tmpl:team_to_win_both_halves:2way"
            : supplemental.type === "team_to_win_either_half"
              ? "tmpl:team_to_win_either_half:2way"
            : supplemental.type === "team_odd_even_goals"
              ? "tmpl:team_odd_even_goals:2way"
            : supplemental.type === "multigoals"
              ? "tmpl:multigoals:multiway"
            : supplemental.type === "team_multigoals"
              ? "tmpl:team_multigoals:multiway"
            : supplemental.type === "team_goals_exact"
              ? "tmpl:team_goals_exact:multiway"
            : supplemental.type === "match_result_and_btts"
              ? "tmpl:match_result_and_btts:6way"
            : supplemental.type === "total_and_btts"
              ? "tmpl:total_and_btts:4way"
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

function attachLambdaOddsToMarkets(primaryMarkets, lambdaMarkets) {
  const primaryById = new Map(primaryMarkets.map((m) => [m.marketId, m]));
  for (const lambdaMarket of lambdaMarkets) {
    const primary = primaryById.get(lambdaMarket.marketId);
    if (!primary) {
      continue;
    }
    for (const primarySel of (primary.selections || [])) {
      const lambdaSel = (lambdaMarket.selections || []).find((s) => s.id === primarySel.id);
      const odds = Number(lambdaSel?.odds);
      if (Number.isFinite(odds) && odds > 1) {
        primarySel.compare = {
          ...(primarySel.compare || {}),
          lambda: { odds: round(odds, 3) },
        };
      }
    }
  }
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
