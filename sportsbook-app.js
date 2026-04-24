const state = {
  generatedAt: null,
  search: "",
  filterMode: "all",
  leagues: [],
  providerFeed: { events: [], markets: [] },
  marketsByEventId: new Map(),
  eventMetaById: new Map(),
  selectedLeagueKey: null,
  selectedMatchKey: null,
  selectedMarketKey: null,
  selectedPriceGroupKeys: {},
  editingCell: null,
  inlineEditValue: "",
  traderName: localStorage.getItem("sportsbook-trader-name") || "local-trader",
  firstHalfRatio: readFirstHalfRatio(),
  oddsSnapshot: new Map(),
  searchRenderTimer: null,
};

const leagueGroupsEl = document.getElementById("leagueGroups");
const mainContentEl = document.getElementById("mainContent");
const leagueTotalEl = document.getElementById("leagueTotal");
const matchTotalEl = document.getElementById("matchTotal");
const generatedStatusEl = document.getElementById("generatedStatus");
const searchInputEl = document.getElementById("searchInput");
const traderNameInputEl = document.getElementById("traderNameInput");
const firstHalfRatioInputEl = document.getElementById("firstHalfRatioInput");
const secondHalfRatioLabelEl = document.getElementById("secondHalfRatioLabel");
const traderFilterGroupEl = document.getElementById("traderFilterGroup");
const heroTitleEl = document.getElementById("heroTitle");
const heroSourceEl = document.getElementById("heroSource");
const heroMatchCountEl = document.getElementById("heroMatchCount");
const countdownPillEl = document.getElementById("countdownPill");
const countdownValEl = document.getElementById("countdownVal");
const refreshBtnEl = document.getElementById("refreshBtn");

searchInputEl.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  if (state.searchRenderTimer) {
    clearTimeout(state.searchRenderTimer);
  }
  state.searchRenderTimer = setTimeout(() => {
    state.searchRenderTimer = null;
    render();
  }, 120);
});

traderNameInputEl.value = state.traderName;
traderNameInputEl.addEventListener("input", (event) => {
  state.traderName = event.target.value.trim() || "local-trader";
  localStorage.setItem("sportsbook-trader-name", state.traderName);
});

firstHalfRatioInputEl.value = state.firstHalfRatio.toFixed(2);
syncFirstHalfRatioLabel();
firstHalfRatioInputEl.addEventListener("change", async () => {
  const parsed = Number(firstHalfRatioInputEl.value);
  if (!Number.isFinite(parsed)) {
    firstHalfRatioInputEl.value = state.firstHalfRatio.toFixed(2);
    return;
  }

  const nextRatio = clampFirstHalfRatio(parsed);
  firstHalfRatioInputEl.value = nextRatio.toFixed(2);

  try {
    generatedStatusEl.textContent = "Live - updating 1H split...";
    await submitFeedSettingsUpdate({ firstHalfRatio: nextRatio });
    generatedStatusEl.textContent = "Live - 1H split updated";
  } catch (error) {
    firstHalfRatioInputEl.value = state.firstHalfRatio.toFixed(2);
    syncFirstHalfRatioLabel();
    generatedStatusEl.textContent = `Feed settings error: ${error.message}`;
  }
});

for (const button of traderFilterGroupEl.querySelectorAll("[data-filter-mode]")) {
  button.addEventListener("click", () => {
    state.filterMode = button.dataset.filterMode || "all";
    render();
  });
}

leagueGroupsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-league-key]");
  if (!button) {
    return;
  }

  state.selectedLeagueKey = button.dataset.leagueKey;
  state.selectedMatchKey = null;
  state.selectedMarketKey = null;
  render();
});

mainContentEl.addEventListener("click", async (event) => {
  const eventStateButton = event.target.closest("[data-event-state-id][data-event-state-value]");
  if (eventStateButton) {
    await handleEventStateButtonClick(eventStateButton);
    return;
  }

  const marketStateButton = event.target.closest("[data-market-state-id][data-market-state-value]");
  if (marketStateButton) {
    await handleMarketStateButtonClick(marketStateButton);
    return;
  }

  const manualPriceButton = event.target.closest("[data-manual-market-id][data-manual-selection-id]");
  if (manualPriceButton) {
    state.editingCell = {
      marketId: manualPriceButton.dataset.manualMarketId,
      selectionId: manualPriceButton.dataset.manualSelectionId,
    };
    state.inlineEditValue = manualPriceButton.dataset.manualCurrent || manualPriceButton.querySelector("strong")?.textContent || "";
    render();
    return;
  }

  const priceGroupButton = event.target.closest("[data-price-group-key][data-parent-market-group]");
  if (priceGroupButton) {
    const parentGroup = priceGroupButton.dataset.parentMarketGroup;
    const priceGroup = priceGroupButton.dataset.priceGroupKey;
    if (!parentGroup || !priceGroup) {
      return;
    }
    state.selectedPriceGroupKeys[parentGroup] = priceGroup;
    render();
    return;
  }

  const marketButton = event.target.closest("[data-market-key]");
  if (marketButton) {
    state.selectedMarketKey = marketButton.dataset.marketKey;
    render();
    return;
  }

  const matchCard = event.target.closest("[data-match-key]");
  if (matchCard) {
    state.selectedMatchKey = matchCard.dataset.matchKey;
    state.selectedMarketKey = null;
    render();
  }
});

refreshBtnEl.addEventListener("click", () => {
  refreshBtnEl.classList.add("spinning");
  generatedStatusEl.textContent = "Live - fetching...";
  fetch("/refresh", { method: "POST" }).catch(() => {
    refreshBtnEl.classList.remove("spinning");
  });
});

fetchSnapshot();
connectSSE();

function fetchSnapshot() {
  if (location.protocol === "file:") return;
  fetch("/snapshot")
    .then((res) => {
      if (!res.ok || res.status === 204) return null;
      return res.json();
    })
    .then((data) => {
      if (data && !state.generatedAt) {
        ingestData(data);
      }
    })
    .catch(() => {});
}

function connectSSE() {
  if (location.protocol === "file:") {
    showFileOpenError();
    return;
  }

  generatedStatusEl.textContent = "Connecting...";
  countdownPillEl.style.display = "none";

  const eventSource = new EventSource("/events");

  eventSource.onopen = () => {
    generatedStatusEl.textContent = "Live - waiting for data...";
    countdownPillEl.style.display = "none";
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.error) {
        generatedStatusEl.textContent = `Server error: ${data.error}`;
        return;
      }

      ingestData(data);
      refreshBtnEl.classList.remove("spinning");
    } catch {
      generatedStatusEl.textContent = "Failed to parse server data";
    }
  };

  eventSource.onerror = () => {
    generatedStatusEl.textContent = "Connection lost - reconnecting...";
    countdownPillEl.style.display = "";
    countdownValEl.textContent = "...";
    countdownValEl.className = "cd-low";
  };
}

function ingestData(data) {
  const previousGeneratedAt = state.generatedAt;
  state.generatedAt = data.generatedAt || null;
  const feedSettingsRatio = clampFirstHalfRatio(data?.feedSettings?.firstHalfRatio);
  state.firstHalfRatio = feedSettingsRatio;
  firstHalfRatioInputEl.value = state.firstHalfRatio.toFixed(2);
  syncFirstHalfRatioLabel();
  state.providerFeed = normalizeProviderFeed(data.providerFeed);
  recomputeDerivedFeedState();

  if (!state.leagues.some((league) => league.key === state.selectedLeagueKey)) {
    state.selectedLeagueKey = state.leagues[0]?.key || null;
  }

  render();

  const isNew = previousGeneratedAt && previousGeneratedAt !== state.generatedAt;
  const p4578Progress = data?.sources?.p4578?.progress || null;
  const progressSuffix = p4578Progress && !p4578Progress.complete
    ? ` - loading leagues ${p4578Progress.fetchedLeagueCount + p4578Progress.failedLeagueCount}/${p4578Progress.totalLeagueTargetCount}`
    : "";
  generatedStatusEl.textContent = state.generatedAt
    ? `Live - updated ${new Date(state.generatedAt).toLocaleTimeString()}${isNew ? " - new data" : ""}${progressSuffix}`
    : `Live${progressSuffix}`;
}

function normalizeProviderFeed(feed) {
  return {
    events: Array.isArray(feed?.events) ? feed.events : [],
    markets: Array.isArray(feed?.markets) ? feed.markets : [],
  };
}

function recomputeDerivedFeedState() {
  state.marketsByEventId = buildMarketsByEventId(state.providerFeed.markets);
  state.eventMetaById = buildEventMetaById(state.providerFeed.events, state.marketsByEventId);
  state.leagues = buildLeagueCollection();
}

function buildMarketsByEventId(markets) {
  const grouped = new Map();

  for (const market of markets || []) {
    const eventId = market?.eventId;
    if (!eventId) {
      continue;
    }

    let bucket = grouped.get(eventId);
    if (!bucket) {
      bucket = [];
      grouped.set(eventId, bucket);
    }
    bucket.push(market);
  }

  return grouped;
}

function buildEventMetaById(events, marketsByEventId) {
  const metaById = new Map();

  for (const event of events || []) {
    const eventId = event?.eventId;
    if (!eventId) {
      continue;
    }

    const markets = marketsByEventId.get(eventId) || [];
    const meta = {
      hasSuspendedMarket: false,
      hasManualMarket: false,
      eventSuspended: event.tradingStatus === "suspended",
    };

    for (const market of markets) {
      if (market.status === "suspended") {
        meta.hasSuspendedMarket = true;
      }

      if (!meta.hasManualMarket && (market.selections || []).some((selection) => selection.manualOverride?.odds != null)) {
        meta.hasManualMarket = true;
      }

      if (meta.hasSuspendedMarket && meta.hasManualMarket) {
        break;
      }
    }

    metaById.set(eventId, meta);
  }

  return metaById;
}

function showFileOpenError() {
  generatedStatusEl.textContent = "Error: opened as file";
  leagueGroupsEl.innerHTML = `<div class="empty-state"><strong>Wrong URL</strong>Run <code>node server.js --port 3000</code> or your preferred port, then open <code>http://localhost:&lt;port&gt;</code></div>`;
  mainContentEl.innerHTML = `<div class="empty-state"><strong>No data</strong>You opened this file directly from disk. Start the server first.</div>`;
}

function buildLeagueCollection() {
  const leagueMap = new Map();

  for (const event of state.providerFeed.events) {
    const provider = event.provider || "provider";
    const competition = event.competition || {};
    const sport = event.sport || {};
    const key = `${provider}:${competition.id || competition.code || competition.name || "unknown"}`;

    if (!leagueMap.has(key)) {
      leagueMap.set(key, {
        key,
        source: provider,
        name: competition.name || "Unknown League",
        subtitle: sport.name || "",
        count: 0,
        matches: [],
      });
    }

    const league = leagueMap.get(key);
    league.matches.push(event);
    league.count += 1;
  }

  for (const league of leagueMap.values()) {
    league.matches.sort((a, b) => {
      const aTime = Date.parse(a.scheduledStart || "") || Number.POSITIVE_INFINITY;
      const bTime = Date.parse(b.scheduledStart || "") || Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
  }

  return [...leagueMap.values()].sort((a, b) => {
    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }
    return a.name.localeCompare(b.name);
  });
}

function render() {
  const filteredLeagues = state.leagues
    .map((league) => {
      const matches = league.matches.filter((match) => matchPassesCurrentFilters(match));
      return {
        ...league,
        matches,
        count: matches.length,
      };
    })
    .filter((league) => {
      if (!league.matches.length) {
        return false;
      }
      if (!state.search) {
        return true;
      }
      return `${league.name} ${league.subtitle || ""}`.toLowerCase().includes(state.search);
    });

  if (!filteredLeagues.some((league) => league.key === state.selectedLeagueKey)) {
    state.selectedLeagueKey = filteredLeagues[0]?.key || null;
  }

  const selectedLeague = filteredLeagues.find((league) => league.key === state.selectedLeagueKey) || null;

  if (!selectedLeague?.matches.some((match) => getMatchKey(match) === state.selectedMatchKey)) {
    state.selectedMatchKey = selectedLeague?.matches[0] ? getMatchKey(selectedLeague.matches[0]) : null;
  }

  const selectedMatch = selectedLeague?.matches.find((match) => getMatchKey(match) === state.selectedMatchKey) || null;
  const marketGroups = selectedMatch ? buildMarketGroups(selectedMatch) : [];

  if (!marketGroups.some((group) => group.key === state.selectedMarketKey)) {
    state.selectedMarketKey = marketGroups[0]?.key || null;
  }

  leagueTotalEl.textContent = String(filteredLeagues.length);
  matchTotalEl.textContent = String(filteredLeagues.reduce((sum, league) => sum + league.matches.length, 0));

  syncTraderFilterButtons();

  renderLeagueGroups(filteredLeagues);
  renderHero(selectedLeague);
  renderMatches(selectedLeague);
}

function syncTraderFilterButtons() {
  for (const button of traderFilterGroupEl.querySelectorAll("[data-filter-mode]")) {
    button.classList.toggle("is-active", button.dataset.filterMode === state.filterMode);
  }
}

function matchPassesCurrentFilters(event) {
  if (!event) {
    return false;
  }

  const meta = state.eventMetaById.get(event.eventId) || {
    hasSuspendedMarket: false,
    hasManualMarket: false,
    eventSuspended: event.tradingStatus === "suspended",
  };

  if (state.filterMode === "suspended") {
    return meta.eventSuspended || meta.hasSuspendedMarket;
  }
  if (state.filterMode === "manual") {
    return meta.hasManualMarket;
  }
  if (state.filterMode === "overrides") {
    return meta.eventSuspended || meta.hasSuspendedMarket || meta.hasManualMarket;
  }
  return true;
}

function renderLeagueGroups(leagues) {
  if (!leagues.length) {
    leagueGroupsEl.innerHTML = `<div class="empty-state"><strong>No leagues found</strong></div>`;
    return;
  }

  const grouped = leagues.reduce((accumulator, league) => {
    const source = league.source || "unknown";
    if (!accumulator[source]) {
      accumulator[source] = [];
    }
    accumulator[source].push(league);
    return accumulator;
  }, {});

  leagueGroupsEl.innerHTML = Object.entries(grouped).map(([source, items]) => `
    <section class="league-group">
      <div class="league-group-title">
        <span>${escapeHtml(source)}</span>
        <span class="league-count">${items.length}</span>
      </div>
      <div class="league-list">
        ${items.map((league) => {
          const active = league.key === state.selectedLeagueKey ? " is-active" : "";
          return `
            <button class="league-button${active}" data-league-key="${escapeHtml(league.key)}" type="button">
              <span class="league-name">${escapeHtml(league.name)}</span>
              <span class="league-meta">
                <span>${escapeHtml(league.subtitle || "")}</span>
                <span>${league.count}</span>
              </span>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `).join("");

}

function renderHero(league) {
  if (!league) {
    heroTitleEl.textContent = "No league selected";
    heroSourceEl.textContent = "-";
    heroMatchCountEl.textContent = "0";
    return;
  }

  heroTitleEl.textContent = league.name;
  heroSourceEl.textContent = league.source;
  heroMatchCountEl.textContent = String(league.matches.length);
}

function renderMatches(league) {
  if (!league) {
    mainContentEl.innerHTML = `<div class="empty-state"><strong>No league selected</strong>Choose a competition from the sidebar.</div>`;
    return;
  }

  if (!league.matches.length) {
    mainContentEl.innerHTML = `<div class="empty-state"><strong>${escapeHtml(league.name)}</strong>No fixtures available yet for this competition.</div>`;
    return;
  }

  const selectedMatch = league.matches.find((match) => getMatchKey(match) === state.selectedMatchKey) || league.matches[0];
  const groups = buildMarketGroups(selectedMatch);
  const selectedGroup = groups.find((group) => group.key === state.selectedMarketKey) || groups[0];
  const priceGroups = selectedGroup ? buildPriceGroups(selectedMatch, selectedGroup.key) : [];
  const selectedPriceGroup = selectedGroup ? getSelectedPriceGroup(selectedGroup.key, priceGroups) : null;

  mainContentEl.innerHTML = `
    <div class="trading-shell">
      <div class="event-board">
        ${renderMatchBoard(selectedMatch)}
      </div>
      <div class="event-rail">${league.matches.map((match) => renderEventCard(match, selectedMatch)).join("")}</div>
      <div class="market-workspace">
        <aside class="market-group-nav">
          <div class="workspace-title">Market Groups</div>
          <div class="market-group-list">
            ${groups.map((group) => `
              <button class="market-group-btn${group.key === selectedGroup?.key ? " is-active" : ""}" data-market-key="${escapeHtml(group.key)}" type="button">
                <span>${escapeHtml(group.label)}</span>
                <strong>${group.count}</strong>
              </button>
            `).join("")}
          </div>
        </aside>
        <section class="market-table-wrap">
          ${renderMarketDetailTable(selectedMatch, selectedGroup, selectedPriceGroup, priceGroups)}
        </section>
        <aside class="market-notes">
          ${renderInsightsPanel(selectedMatch, selectedGroup, selectedPriceGroup, league)}
        </aside>
      </div>
    </div>
  `;

  bindManualPriceEditors();
}

function getMatchKey(event) {
  return event?.eventId || "na";
}

function buildMarketGroups(event) {
  const markets = getFeedMarketsForEvent(event);
  const definitions = [
    { key: "main_markets", label: "Main Markets" },
    { key: "corners", label: "Corners" },
    { key: "specials", label: "Specials" },
    { key: "goals", label: "Goals" },
    { key: "others", label: "Others" },
    { key: "first_half", label: "1st Half" },
    { key: "second_half", label: "2nd Half" },
  ];

  return definitions.map((group) => ({
    ...group,
    count: markets.filter((market) => primaryMarketGroupKey(market) === group.key).length,
  }));
}

function buildPriceGroups(event, marketGroupKey) {
  const definitions = priceGroupDefinitionsForMarketGroup(marketGroupKey);
  return definitions.map((group) => ({
    ...group,
    count: getFeedMarketsForEvent(event).filter((market) => marketMatchesPriceGroup(market, group)).length,
  }));
}

function getSelectedPriceGroup(marketGroupKey, priceGroups) {
  if (!priceGroups.length) {
    delete state.selectedPriceGroupKeys[marketGroupKey];
    return null;
  }

  const storedKey = state.selectedPriceGroupKeys[marketGroupKey];
  const existing = storedKey ? priceGroups.find((group) => group.key === storedKey) : null;
  if (existing) {
    return existing;
  }

  const fallback = priceGroups.find((group) => group.count > 0) || priceGroups[0];
  state.selectedPriceGroupKeys[marketGroupKey] = fallback.key;
  return fallback;
}

function priceGroupDefinitionsForMarketGroup(marketGroupKey) {
  if (marketGroupKey === "main_markets") {
    return [
      createPriceGroup("main_1x2", "1X2", ["match_winner"]),
      createPriceGroup("main_total", "Total", ["total_goals"]),
      createPriceGroup("main_handicap", "Handicap", ["asian_handicap"]),
      createPriceGroup("main_double_chance", "Double Chance", ["double_chance"]),
      createPriceGroup("main_draw_no_bet", "Draw No Bet", ["draw_no_bet"]),
      createPriceGroup("main_halftime_fulltime", "Halftime/Fulltime", ["halftime_fulltime", "half_time_full_time", "halftime_full_time", "ht_ft", "half_time_fulltime"]),
      createPriceGroup("main_btts", "Both Teams To Score", ["both_teams_to_score"]),
      createPriceGroup("main_correct_score", "Correct Score", ["correct_score"]),
    ];
  }

  const definitions = [];
  const typeLabels = {
    corners: [
      createPriceGroup("corners_total", "Total Corners", ["total_corners"]),
      createPriceGroup("corners_first_half", "1st Half Corners", ["total_corners"], { period: "1h" }),
      createPriceGroup("corners_home_total", "Home Total Corners", ["team_total_corners"], { team: "home" }),
      createPriceGroup("corners_away_total", "Away Total Corners", ["team_total_corners"], { team: "away" }),
    ],
    specials: [
      createPriceGroup("specials_home_both_halves", "Home To Win Both Halves", ["team_to_win_both_halves"], { team: "home" }),
      createPriceGroup("specials_away_both_halves", "Away To Win Both Halves", ["team_to_win_both_halves"], { team: "away" }),
      createPriceGroup("specials_home_either_half", "Home To Win Either Half", ["team_to_win_either_half"], { team: "home" }),
      createPriceGroup("specials_away_either_half", "Away To Win Either Half", ["team_to_win_either_half"], { team: "away" }),
      createPriceGroup("specials_home_win_to_nil", "Home Win To Nil", ["team_to_win_to_nil"], { team: "home" }),
      createPriceGroup("specials_away_win_to_nil", "Away Win To Nil", ["team_to_win_to_nil"], { team: "away" }),
      createPriceGroup("specials_1x2_total", "1X2 & Total", ["match_result_and_total"]),
      createPriceGroup("specials_1x2_btts", "1X2 & Both Teams To Score", ["match_result_and_btts"]),
      createPriceGroup("specials_total_btts", "Total & Both Teams To Score", ["total_and_btts"]),
    ],
    goals: [
      createPriceGroup("goals_first_goal", "1st Goal", ["first_goal", "first_team_to_score"]),
      createPriceGroup("goals_odd_even", "Odd/Even", ["odd_even_goals", "total_goals_odd_even"]),
      createPriceGroup("goals_home_total", "Home Total", ["team_total_goals"], { team: "home" }),
      createPriceGroup("goals_away_total", "Away Total", ["team_total_goals"], { team: "away" }),
      createPriceGroup("goals_which_team_to_score", "Which Team To Score", ["which_team_to_score", "team_to_score"]),
      createPriceGroup("goals_home_exact", "Home Exact Goals", ["team_goals_exact"], { team: "home" }),
      createPriceGroup("goals_away_exact", "Away Exact Goals", ["team_goals_exact"], { team: "away" }),
      createPriceGroup("goals_range_6_plus", "Goal Range (6+)", ["goal_range_6_plus", "goal_range"], { variant: ["6+", "6_plus", "6plus"] }),
      createPriceGroup("goals_range_7_plus", "Goal Range (7+)", ["goal_range_7_plus", "goal_range"], { variant: ["7+", "7_plus", "7plus"] }),
      createPriceGroup("goals_highest_scoring_half", "Highest Scoring Half", ["highest_scoring_half"]),
      createPriceGroup("goals_home_clean_sheet", "Home Clean Sheet", ["clean_sheet"], { team: "home" }),
      createPriceGroup("goals_away_clean_sheet", "Away Clean Sheet", ["clean_sheet"], { team: "away" }),
      createPriceGroup("goals_home_both_halves", "Home To Score In Both Halves", ["team_to_score_in_both_halves"], { team: "home" }),
      createPriceGroup("goals_away_both_halves", "Away To Score In Both Halves", ["team_to_score_in_both_halves"], { team: "away" }),
      createPriceGroup("goals_both_halves_over_15", "Both Halves Over 1.5", ["both_halves_total_goals"], { outcome: ["over"], points: ["1.5", 1.5] }),
      createPriceGroup("goals_both_halves_under_15", "Both Halves Under 1.5", ["both_halves_total_goals"], { outcome: ["under"], points: ["1.5", 1.5] }),
      createPriceGroup("goals_home_highest_half", "Home Highest Scoring Half", ["team_highest_scoring_half"], { team: "home" }),
      createPriceGroup("goals_away_highest_half", "Away Highest Scoring Half", ["team_highest_scoring_half"], { team: "away" }),
      createPriceGroup("goals_home_odd_even", "Home Odd/Even", ["team_odd_even_goals"], { team: "home" }),
      createPriceGroup("goals_away_odd_even", "Away Odd/Even", ["team_odd_even_goals"], { team: "away" }),
    ],
    others: [
      createPriceGroup("others_dc_btts", "Double Chance & Both Teams To Score", ["double_chance_and_btts"]),
      createPriceGroup("others_1h_dc_btts", "1st Half - Double Chance & Both Teams To Score", ["double_chance_and_btts"], { period: "1h" }),
      createPriceGroup("others_2h_dc_btts", "2nd Half - Double Chance & Both Teams To Score", ["double_chance_and_btts"], { period: "2h" }),
      createPriceGroup("others_multiscores", "Multiscores", ["multiscores"]),
      createPriceGroup("others_multigoals", "Multigoals", ["multigoals"]),
      createPriceGroup("others_1h_multigoals", "1st Half - Multigoals", ["multigoals"], { period: "1h" }),
      createPriceGroup("others_2h_multigoals", "2nd Half - Multigoals", ["multigoals"], { period: "2h" }),
      createPriceGroup("others_home_multigoals", "Home Multigoals", ["team_multigoals"], { team: "home" }),
      createPriceGroup("others_away_multigoals", "Away Multigoals", ["team_multigoals"], { team: "away" }),
      createPriceGroup("others_match_dc_1h_btts", "Double Chance (match) & 1st Half Both Teams Score", ["double_chance_match_and_btts_half"], { period: "1h" }),
      createPriceGroup("others_match_dc_2h_btts", "Double Chance (match) & 2nd Half Both Teams Score", ["double_chance_match_and_btts_half"], { period: "2h" }),
      createPriceGroup("others_exact_goals", "Exact Goals", ["exact_goals"]),
      createPriceGroup("others_halves_btts", "1st/2nd Half Both Teams To Score", ["half_btts_combo"]),
      createPriceGroup("others_2h_1x2_total", "2nd Half - 1X2 & Total", ["match_result_and_total"], { period: "2h" }),
      createPriceGroup("others_2h_1x2_btts", "2nd Half - 1X2 & Both Teams To Score", ["match_result_and_btts"], { period: "2h" }),
      createPriceGroup("others_dc_total", "Double Chance & Total", ["double_chance_and_total"]),
      createPriceGroup("others_htft_total", "Halftime/Fulltime & Total", ["halftime_fulltime_and_total"]),
      createPriceGroup("others_htft_1h_total", "Halftime/Fulltime & 1st Half Total", ["halftime_fulltime_and_first_half_total"]),
      createPriceGroup("others_htft_exact_goals", "Halftime/Fulltime & Exact Goals", ["halftime_fulltime_and_exact_goals"]),
      createPriceGroup("others_1h_or_match_result", "1st Half Result Or Match Result", ["first_half_result_or_match_result"]),
    ],
    first_half: [
      createPriceGroup("first_half_1x2", "1st Half - 1X2", ["match_winner"]),
      createPriceGroup("first_half_total", "1st Half - Total", ["total_goals"]),
      createPriceGroup("first_half_handicap", "1st Half - Handicap", ["asian_handicap"]),
      createPriceGroup("first_half_exact_goals_2_plus", "1st Half - Exact Goals (2+)", ["exact_total_goals", "goal_range"], { variant: ["2+", "2_plus", "2plus"] }),
      createPriceGroup("first_half_exact_goals_3_plus", "1st Half - Exact Goals (3+)", ["exact_total_goals", "goal_range"], { variant: ["3+", "3_plus", "3plus"] }),
      createPriceGroup("first_half_double_chance", "1st Half - Double Chance", ["double_chance"]),
      createPriceGroup("first_half_draw_no_bet", "1st Half - Draw No Bet", ["draw_no_bet"]),
      createPriceGroup("first_half_correct_score", "1st Half - Correct Score", ["correct_score"]),
      createPriceGroup("first_half_btts", "1st Half - Both Teams To Score", ["both_teams_to_score"]),
      createPriceGroup("first_half_home_total", "1st Half - Home Total", ["team_total_goals"], { team: "home" }),
      createPriceGroup("first_half_away_total", "1st Half - Away Total", ["team_total_goals"], { team: "away" }),
      createPriceGroup("first_half_first_goal", "1st Half - 1st Goal", ["first_goal", "first_team_to_score"]),
      createPriceGroup("first_half_home_clean_sheet", "1st Half - Home Clean Sheet", ["clean_sheet"], { team: "home" }),
      createPriceGroup("first_half_away_clean_sheet", "1st Half - Away Clean Sheet", ["clean_sheet"], { team: "away" }),
      createPriceGroup("first_half_odd_even", "1st Half - Odd/Even", ["odd_even_goals", "total_goals_odd_even"]),
    ],
    second_half: [
      createPriceGroup("second_half_1x2", "2nd Half - 1X2", ["match_winner"]),
      createPriceGroup("second_half_total", "2nd Half - Total", ["total_goals"]),
      createPriceGroup("second_half_handicap", "2nd Half - Handicap", ["asian_handicap"]),
      createPriceGroup("second_half_exact_goals_2_plus", "2nd Half - Exact Goals (2+)", ["exact_total_goals", "goal_range"], { variant: ["2+", "2_plus", "2plus"] }),
      createPriceGroup("second_half_exact_goals_3_plus", "2nd Half - Exact Goals (3+)", ["exact_total_goals", "goal_range"], { variant: ["3+", "3_plus", "3plus"] }),
      createPriceGroup("second_half_double_chance", "2nd Half - Double Chance", ["double_chance"]),
      createPriceGroup("second_half_draw_no_bet", "2nd Half - Draw No Bet", ["draw_no_bet"]),
      createPriceGroup("second_half_correct_score", "2nd Half - Correct Score", ["correct_score"]),
      createPriceGroup("second_half_btts", "2nd Half - Both Teams To Score", ["both_teams_to_score"]),
      createPriceGroup("second_half_home_total", "2nd Half - Home Total", ["team_total_goals"], { team: "home" }),
      createPriceGroup("second_half_away_total", "2nd Half - Away Total", ["team_total_goals"], { team: "away" }),
      createPriceGroup("second_half_first_goal", "2nd Half - 1st Goal", ["first_goal", "first_team_to_score"]),
      createPriceGroup("second_half_home_clean_sheet", "2nd Half - Home Clean Sheet", ["clean_sheet"], { team: "home" }),
      createPriceGroup("second_half_away_clean_sheet", "2nd Half - Away Clean Sheet", ["clean_sheet"], { team: "away" }),
      createPriceGroup("second_half_odd_even", "2nd Half - Odd/Even", ["odd_even_goals", "total_goals_odd_even"]),
    ],
  };

  return typeLabels[marketGroupKey] || definitions;
}

function createPriceGroup(key, label, marketTypes, options = {}) {
  return {
    key,
    label,
    marketTypes,
    matchAllWithinPrimaryGroup: options.matchAllWithinPrimaryGroup === true,
    team: options.team || null,
    variant: Array.isArray(options.variant) ? options.variant.map(String) : null,
    outcome: Array.isArray(options.outcome) ? options.outcome.map((value) => String(value).toLowerCase()) : null,
    points: Array.isArray(options.points) ? options.points.map(String) : null,
    period: options.period || null,
  };
}

function marketMatchesPriceGroup(market, group) {
  if (!market || !group) {
    return false;
  }

  if (group.matchAllWithinPrimaryGroup) {
    return true;
  }

  if (!Array.isArray(group.marketTypes) || !group.marketTypes.includes(market.type)) {
    return false;
  }

  if (group.team && market?.specifier?.team !== group.team) {
    return false;
  }

  if (group.period && (market?.specifier?.period || "ft") !== group.period) {
    return false;
  }

  if (group.variant) {
    const variantValues = [
      market?.specifier?.variant,
      market?.specifier?.range,
      market?.specifier?.label,
    ].filter(Boolean).map(String);

    if (!variantValues.some((value) => group.variant.includes(value))) {
      return false;
    }
  }

  if (group.outcome) {
    const outcomeValue = String(
      market?.specifier?.outcome ??
      market?.specifier?.side ??
      market?.specifier?.selection ??
      ""
    ).toLowerCase();

    if (!group.outcome.includes(outcomeValue)) {
      return false;
    }
  }

  if (group.points) {
    const pointsValue = String(market?.specifier?.points ?? "");
    if (!group.points.includes(pointsValue)) {
      return false;
    }
  }

  return true;
}

function getFeedMarketsForEvent(event) {
  if (!event) {
    return [];
  }
  return state.marketsByEventId.get(event.eventId) || [];
}

function findFeedMarket(event, type, predicate = null) {
  const matches = getFeedMarketsForEvent(event).filter((market) => market.type === type);
  return predicate ? (matches.find(predicate) || null) : (matches[0] || null);
}

function findSelection(market, ids) {
  if (!market || !Array.isArray(market.selections)) {
    return null;
  }

  const accepted = ids.map((id) => String(id).toLowerCase());
  return market.selections.find((selection) => accepted.includes(String(selection.id || "").toLowerCase())) || null;
}

function renderEventCard(event, selectedEvent) {
  const date = event.scheduledStart ? new Date(event.scheduledStart) : null;
  const active = getMatchKey(event) === getMatchKey(selectedEvent) ? " is-active" : "";

  return `
    <button class="event-card${active}" data-match-key="${escapeHtml(getMatchKey(event))}" type="button">
      <div class="event-card-time">${date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "No date"} · ${date ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "--:--"}</div>
      <div class="event-card-name">${escapeHtml(getParticipant(event, "home").name || "?")} vs ${escapeHtml(getParticipant(event, "away").name || "?")}</div>
      <div class="event-card-meta">
        ${event.analytics ? `<span>H λ ${formatLambda(event.analytics.lambdaHome)}</span>` : ""}
        ${event.analytics ? `<span>A λ ${formatLambda(event.analytics.lambdaAway)}</span>` : ""}
      </div>
    </button>
  `;
}

function renderMatchBoard(event) {
  const date = event.scheduledStart ? new Date(event.scheduledStart) : null;
  const matchWinnerMarket = findFeedMarket(event, "match_winner");
  const mainTotalsMarket = findPrimaryTotalsMarket(event);
  const matchSuspended = event?.tradingStatus === "suspended";

  return `
    <div class="board-headline">
      <div class="board-meta-line">
        <span>${escapeHtml(event.competition?.name || "Competition")}</span>
        <span>•</span>
        <span>${escapeHtml(event.provider || "source")}</span>
        <span>•</span>
        <span>${escapeHtml(date ? date.toLocaleString() : "Unscheduled")}</span>
      </div>
      <div class="board-trading-bar">
        <span class="match-status-pill${matchSuspended ? " is-suspended" : " is-open"}">${escapeHtml(matchSuspended ? "Match Suspended" : "Match Open")}</span>
        <button class="match-state-btn${matchSuspended ? "" : " is-active"}" type="button" data-event-state-id="${escapeHtml(event.eventId)}" data-event-state-value="open">Open Match</button>
        <button class="match-state-btn is-danger${matchSuspended ? " is-active" : ""}" type="button" data-event-state-id="${escapeHtml(event.eventId)}" data-event-state-value="suspended">Suspend Match</button>
      </div>
      <div class="board-head-grid">
        <div class="board-fixture">
          <div class="fixture-team">
            <span class="fixture-label">Home</span>
            <strong>${escapeHtml(getParticipant(event, "home").name || "?")}</strong>
          </div>
          <div class="fixture-kickoff">
            <span>${date ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "--:--"}</span>
            <small>${date ? date.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit" }) : "No date"}</small>
          </div>
          <div class="fixture-team away">
            <span class="fixture-label">Away</span>
            <strong>${escapeHtml(getParticipant(event, "away").name || "?")}</strong>
          </div>
        </div>
        <div class="board-summary">
          ${renderBoardOddsBlock("1X2", [
            summaryOdds("1", findSelection(matchWinnerMarket, ["home"])),
            summaryOdds("X", findSelection(matchWinnerMarket, ["draw"])),
            summaryOdds("2", findSelection(matchWinnerMarket, ["away"])),
          ])}
          ${renderBoardOddsBlock(mainTotalsMarket?.specifier?.label ? `Main ${mainTotalsMarket.specifier.label}` : "Main Total", [
            summaryOdds("Over", findSelection(mainTotalsMarket, ["over"])),
            summaryOdds("Under", findSelection(mainTotalsMarket, ["under"])),
          ])}
          ${renderBoardOddsBlock("Model", [
            summaryOdds("H λ", event.analytics?.lambdaHome, true),
            summaryOdds("A λ", event.analytics?.lambdaAway, true),
          ])}
        </div>
      </div>
    </div>
  `;
}

function renderBoardOddsBlock(title, items) {
  return `
    <div class="board-odds-block">
      <div class="board-odds-title">${escapeHtml(title)}</div>
      <div class="board-odds-row">${items.join("")}</div>
    </div>
  `;
}

function summaryOdds(label, value, raw = false) {
  const display = raw ? formatLambda(value) : (value?.odds != null ? Number(value.odds).toFixed(3) : "—");
  const feed = !raw && value?.fairOdds != null ? Number(value.fairOdds).toFixed(3) : null;
  const source = !raw && value?.sourceOdds != null ? Number(value.sourceOdds).toFixed(3) : null;

  return `
    <div class="summary-odd">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(display || "—")}</strong>
      ${!raw ? `<small>${feed ? `feed ${escapeHtml(feed)}` : "feed —"}</small>` : ""}
      ${!raw ? `<small>${source ? `p4578 ${escapeHtml(source)}` : "p4578 —"}</small>` : ""}
    </div>
  `;
}

function renderMarketDetailTable(event, group, selectedPriceGroup, priceGroups) {
  if (!group) {
    return `<div class="empty-state"><strong>No market selected</strong>Choose a market group on the left.</div>`;
  }

  const sections = buildMarketSections(event, group.key, selectedPriceGroup);

  return `
    <div class="workspace-header">
      <div>
        <div class="workspace-kicker">Market Board</div>
        <div class="workspace-name">${escapeHtml(group.label)}</div>
      </div>
      <div class="workspace-badge">${sections.reduce((sum, section) => sum + section.rows.length, 0)} rows</div>
    </div>
    ${priceGroups?.length ? `
      <div class="price-group-nav">
        ${priceGroups.map((priceGroup) => `
          <button
            class="price-group-btn${priceGroup.key === selectedPriceGroup?.key ? " is-active" : ""}${priceGroup.count === 0 ? " is-empty" : ""}"
            type="button"
            data-parent-market-group="${escapeHtml(group.key)}"
            data-price-group-key="${escapeHtml(priceGroup.key)}"
          >
            <span>${escapeHtml(priceGroup.label)}</span>
            <strong>${priceGroup.count}</strong>
          </button>
        `).join("")}
      </div>
    ` : ""}
    ${selectedPriceGroup ? `
      <div class="workspace-subtitle">
        <span>Prices</span>
        <strong>${escapeHtml(selectedPriceGroup.label)}</strong>
      </div>
    ` : ""}
    ${sections.length
      ? sections.map((section) => renderMarketSection(section, selectedPriceGroup?.label || group.label)).join("")
      : `<div class="empty-state"><strong>No prices available</strong>The selected price group has no active prices.</div>`}
  `;
}

function buildMarketSections(event, key, selectedPriceGroup = null) {
  return getFeedMarketsForEvent(event)
    .filter((market) => (
      primaryMarketGroupKey(market) === key &&
      (!selectedPriceGroup || marketMatchesPriceGroup(market, selectedPriceGroup))
    ))
    .map((market) => ({
      market,
      marketId: market.marketId,
      status: market.status || "open",
      source: market.source || "provider",
      title: buildMarketSectionTitle(market, event),
      sortOrder: marketSectionOrder(market),
      hasLambdaCompare: (market.selections || []).some((s) => s.compare?.lambda != null),
      margins: {
        active: formatMarginLabel(computeMarketMargin(market, "active")),
        feed: formatMarginLabel(computeMarketMargin(market, "feed")),
        raw: formatMarginLabel(computeMarketMargin(market, "raw")),
        lambda: formatMarginLabel(computeMarketMargin(market, "lambda")),
      },
      rows: (market.selections || []).map((selection) => ({
        marketId: market.marketId,
        selectionId: selection.id,
        label: selection.name || selection.id || "Selection",
        marketSource: market.source || "provider",
        value: selection,
      })),
    }))
    .sort(compareMarketSections)
    .filter((section) => section.rows.length);
}

function compareMarketSections(a, b) {
  const orderDelta = Number(a.sortOrder || 99) - Number(b.sortOrder || 99);
  if (orderDelta !== 0) {
    return orderDelta;
  }

  const marketA = a.market || {};
  const marketB = b.market || {};
  const type = marketA.type;
  if (type && type === marketB.type) {
    if (type === "team_total_goals" || type === "team_total_corners" || type === "team_to_win_to_nil") {
      const teamDelta = teamSortRank(marketA.specifier?.team) - teamSortRank(marketB.specifier?.team);
      if (teamDelta !== 0) {
        return teamDelta;
      }
      if (type !== "team_to_win_to_nil") {
        const pointsDelta = numericSortValue(marketA.specifier?.points) - numericSortValue(marketB.specifier?.points);
        if (pointsDelta !== 0) {
          return pointsDelta;
        }
      }
    }

    if (type === "total_goals" || type === "asian_handicap" || type === "total_corners") {
      const pointsDelta = numericSortValue(marketA.specifier?.points) - numericSortValue(marketB.specifier?.points);
      if (pointsDelta !== 0) {
        return pointsDelta;
      }
    }
  }

  return String(a.title || "").localeCompare(String(b.title || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function numericSortValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function teamSortRank(team) {
  if (team === "home") {
    return 0;
  }
  if (team === "away") {
    return 1;
  }
  return 2;
}

function renderMarketSection(section, fallbackLabel) {
  const isSuspended = section.status === "suspended";
  const isDerived = isModelDerivedSource(section.source);
  return `
    <section class="market-line-section${isSuspended ? " is-suspended" : ""}${isDerived ? " is-derived" : ""}">
      <div class="market-line-header">
        <div>
          <div class="market-line-title">${escapeHtml(section.title || fallbackLabel)}</div>
          <div class="market-line-meta">
            ${section.rows.length} selections
            ${isDerived ? `<span class="market-line-source">Lambda Derived</span>` : ""}
          </div>
        </div>
        <div class="market-line-actions">
          <span class="market-status-pill${isSuspended ? " is-suspended" : " is-open"}">${escapeHtml(isSuspended ? "Suspended" : "Open")}</span>
          <button class="market-state-btn${section.status === "open" ? " is-active" : ""}" type="button" data-market-state-id="${escapeHtml(section.marketId)}" data-market-state-value="open">Open</button>
          <button class="market-state-btn is-danger${section.status === "suspended" ? " is-active" : ""}" type="button" data-market-state-id="${escapeHtml(section.marketId)}" data-market-state-value="suspended">Suspend</button>
        </div>
      </div>
      <table class="detail-table matrix-table">
        <thead>
          <tr>
            <th>${escapeHtml(section.title || fallbackLabel)}</th>
            <th><div class="column-head"><strong>Active</strong><small>${escapeHtml(section.margins.active)}</small></div></th>
            <th><div class="column-head"><strong>Feed</strong><small>${escapeHtml(section.margins.feed)}</small></div></th>
            <th><div class="column-head"><strong>p4578</strong><small>${escapeHtml(section.margins.raw)}</small></div></th>
            ${section.hasLambdaCompare ? `<th><div class="column-head"><strong>Lambda Calc</strong><small>${escapeHtml(section.margins.lambda)}</small></div></th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${section.rows.map((row, index) => `
            <tr>
              <td class="detail-label"><div>${escapeHtml(row.label)}</div></td>
              <td>${renderProviderPriceCell(row, "active", index)}</td>
              <td>${renderProviderPriceCell(row, "feed", index)}</td>
              <td>${renderProviderPriceCell(row, "raw", index)}</td>
              ${section.hasLambdaCompare ? `<td>${renderProviderPriceCell(row, "lambda", index)}</td>` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function buildMarketSectionTitle(market, event) {
  event = event || {};
  const periodPrefix = market.specifier?.period === "1h" ? "1H " : "";
  if (market.type === "team_total_goals" || market.type === "team_total_corners") {
    const teamName = market.specifier?.team === "home" ? getParticipant(event, "home").name : getParticipant(event, "away").name;
    return `${periodPrefix}${teamName} ${market.specifier?.label || market.specifier?.points || ""}`.trim();
  }

  if (market.type === "team_to_win_to_nil") {
    const teamName = market.specifier?.team === "home" ? getParticipant(event, "home").name : getParticipant(event, "away").name;
    return `${periodPrefix}${teamName} To Win To Nil`.trim();
  }

  if (market.type === "team_goals_exact") {
    const teamName = market.specifier?.team === "home" ? getParticipant(event, "home").name : getParticipant(event, "away").name;
    return `${periodPrefix}${teamName} Goals`.trim();
  }

  if (market.type === "asian_handicap") {
    const homeName = getParticipant(event, "home").name;
    const homeLabel = market.specifier?.homeLabel || market.specifier?.label || market.specifier?.points || "";
    const awayLabel = market.specifier?.awayLabel || "";
    return `${periodPrefix}${homeName} ${homeLabel}${awayLabel ? ` / Away ${awayLabel}` : ""}`.trim();
  }

  if (market.specifier?.label) {
    return `${periodPrefix}${marketGroupLabel(market.type)} ${market.specifier.label}`.trim();
  }

  if (market.specifier?.variant) {
    return `${periodPrefix}${marketGroupLabel(market.type)} ${market.specifier.variant}`.trim();
  }

  return `${periodPrefix}${marketGroupLabel(market.type)}`.trim();
}

function computeMarketMargin(market, columnKey) {
  const prices = (market?.selections || [])
    .map((selection) => {
      if (columnKey === "active") return Number(selection?.odds);
      if (columnKey === "feed") return Number(selection?.fairOdds);
      if (columnKey === "lambda") return Number(selection?.compare?.lambda?.odds);
      return getRawComparisonOdds(selection);
    })
    .filter((price) => Number.isFinite(price) && price > 1);

  if (prices.length < 2) {
    return null;
  }

  const book = prices.reduce((sum, price) => sum + (1 / price), 0);
  return (book - 1) * 100;
}

function formatMarginLabel(margin) {
  return Number.isFinite(margin) ? `margin ${margin.toFixed(2)}%` : "margin —";
}

function renderProviderPriceCell(row, columnKey, index) {
  const value = row?.value || null;
  const marketSuspended = value?.marketStatus === "suspended";
  const activeOdds = Number(value?.odds);
  const feedOdds = Number(value?.fairOdds);
  const rawOdds = getRawComparisonOdds(value);
  const tone = index % 2 === 0 ? " alt" : "";
  const isDerived = isModelDerivedSource(row?.marketSource) || isModelDerivedSource(value?.origin);
  const derivedClass = isDerived ? " is-derived" : "";

  if (columnKey === "active") {
    if (marketSuspended) {
      return `<div class="matrix-price is-active is-suspended${tone}${derivedClass}"><strong>SUSP</strong><small>market</small></div>`;
    }

    const snapshotKey = `${row.marketId}:${row.selectionId}:active`;
    const prev = state.oddsSnapshot.get(snapshotKey);

    if (Number.isFinite(activeOdds)) {
      state.oddsSnapshot.set(snapshotKey, activeOdds);
    }

    const changed = prev == null || !Number.isFinite(activeOdds)
      ? ""
      : activeOdds > prev
        ? " changed-up"
        : activeOdds < prev
          ? " changed-down"
          : "";

    return renderMatrixPrice({
      price: activeOdds,
      label: value?.manualOverride?.odds != null ? "Manual" : (isDerived ? "Model" : "Active"),
      className: `matrix-price is-active${tone}${changed}${derivedClass}`,
      marketId: row.marketId,
      selectionId: row.selectionId,
      manualCurrent: value?.manualOverride?.odds,
      clickable: true,
    });
  }

  if (columnKey === "feed") {
    return renderMatrixPrice({
      price: feedOdds,
      label: isDerived ? "Model Fair" : "No margin",
      className: `matrix-price is-feed${tone}${derivedClass}`,
    });
  }

  if (columnKey === "lambda") {
    const lambdaOdds = Number(value?.compare?.lambda?.odds);
    return renderMatrixPrice({
      price: Number.isFinite(lambdaOdds) && lambdaOdds > 1 ? lambdaOdds : null,
      label: "Lambda Calc",
      className: `matrix-price is-lambda${tone}`,
      missingDisplay: "—",
    });
  }

  return renderMatrixPrice({
    price: rawOdds,
    label: value?.compare?.p4578?.period === "1h" ? "P4578 1H" : "P4578",
    className: `matrix-price is-raw${tone}`,
    missingDisplay: "/",
  });
}

function getRawComparisonOdds(selection) {
  const compareOdds = Number(selection?.compare?.p4578?.odds);
  if (Number.isFinite(compareOdds) && compareOdds > 1) {
    return compareOdds;
  }
  return null;
}

function renderMatrixPrice({ price, label, className, marketId = "", selectionId = "", manualCurrent = null, clickable = false, missingDisplay = "—" }) {
  if (!Number.isFinite(price)) {
    return `<div class="${className} is-missing"><strong>${escapeHtml(missingDisplay)}</strong></div>`;
  }

  const isEditing = clickable && state.editingCell?.marketId === marketId && state.editingCell?.selectionId === selectionId;
  if (!clickable) {
    return `<div class="${className}"><strong>${price.toFixed(3)}</strong><small>${escapeHtml(label)}</small></div>`;
  }

  if (isEditing) {
    return `
      <div class="${className} is-editing">
        <input
          class="matrix-price-input"
          type="number"
          min="1.01"
          step="0.001"
          value="${escapeHtml(state.inlineEditValue || Number(price).toFixed(3))}"
          data-inline-edit-input
          data-market-id="${escapeHtml(marketId)}"
          data-selection-id="${escapeHtml(selectionId)}"
        />
        <small>${escapeHtml(label)}</small>
      </div>
    `;
  }

  return `
    <button class="${className}" type="button" data-manual-market-id="${escapeHtml(marketId)}" data-manual-selection-id="${escapeHtml(selectionId)}" data-manual-current="${manualCurrent != null ? escapeHtml(Number(manualCurrent).toFixed(3)) : ""}">
      <strong>${price.toFixed(3)}</strong>
      <small>${escapeHtml(label)}</small>
    </button>
  `;
}

function isModelDerivedSource(source) {
  return source === "lambda-derived" || source === "ratio-derived";
}

function renderInsightsPanel(event, group, selectedPriceGroup, league) {
  const markets = getFeedMarketsForEvent(event);
  const method = markets.find((market) => market.type === "match_winner")?.pricingContext?.devigMethod || "n/a";
  const analytics = event.analytics || {};

  return `
    <div class="insight-card">
      <div class="insight-title">Feed Summary</div>
      <div class="insight-row"><span>League</span><strong>${escapeHtml(league.name)}</strong></div>
      <div class="insight-row"><span>Source</span><strong>${escapeHtml(event.provider || "source")}</strong></div>
      <div class="insight-row"><span>Selected</span><strong>${escapeHtml(group?.label || "none")}</strong></div>
      <div class="insight-row"><span>Prices</span><strong>${escapeHtml(selectedPriceGroup?.label || "all")}</strong></div>
      <div class="insight-row"><span>Feed event</span><strong>${escapeHtml(event?.sourceEventId || "missing")}</strong></div>
      <div class="insight-row"><span>Feed markets</span><strong>${markets.length}</strong></div>
    </div>
    <div class="insight-card">
      <div class="insight-title">Pricing Stack</div>
      <div class="insight-row"><span>De-vig</span><strong>${escapeHtml(method)}</strong></div>
      <div class="insight-row"><span>Top line</span><strong>active odds</strong></div>
      <div class="insight-row"><span>Second line</span><strong>feed no-margin</strong></div>
      <div class="insight-row"><span>Third line</span><strong>p4578 raw</strong></div>
    </div>
    <div class="insight-card">
      <div class="insight-title">Model</div>
      <div class="insight-row"><span>Home λ</span><strong>${escapeHtml(formatLambda(analytics.lambdaHome) || "—")}</strong></div>
      <div class="insight-row"><span>Away λ</span><strong>${escapeHtml(formatLambda(analytics.lambdaAway) || "—")}</strong></div>
      <div class="insight-row"><span>Mu</span><strong>${escapeHtml(formatLambda(analytics.mu) || "—")}</strong></div>
      <div class="insight-row"><span>Rho</span><strong>${escapeHtml(analytics.rho != null ? Number(analytics.rho).toFixed(3) : "—")}</strong></div>
      <div class="insight-row"><span>1H Split</span><strong>${escapeHtml(formatRatio(analytics.firstHalfRatio) || "—")}</strong></div>
      <div class="insight-row"><span>1H Home λ</span><strong>${escapeHtml(formatLambda(analytics.firstHalf?.lambdaHome) || "—")}</strong></div>
      <div class="insight-row"><span>1H Away λ</span><strong>${escapeHtml(formatLambda(analytics.firstHalf?.lambdaAway) || "—")}</strong></div>
      <div class="insight-row"><span>1H Mu</span><strong>${escapeHtml(formatLambda(analytics.firstHalf?.mu) || "—")}</strong></div>
      <div class="insight-row"><span>2H Split</span><strong>${escapeHtml(formatRatio(analytics.secondHalfRatio) || "—")}</strong></div>
    </div>
    <div class="insight-card">
      <div class="insight-title">Timeline Hooks</div>
      <p class="insight-copy">This layout is prepared for future templates, timeline events, booking incidents, and manual odds overlays.</p>
    </div>
  `;
}

function bindManualPriceEditors() {
  for (const input of mainContentEl.querySelectorAll("[data-inline-edit-input]")) {
    input.focus();
    input.select();
    input.addEventListener("input", () => {
      state.inlineEditValue = input.value;
    });
    input.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        await saveInlineEdit(input);
      } else if (event.key === "Escape") {
        event.preventDefault();
        state.editingCell = null;
        state.inlineEditValue = "";
        render();
      }
    });
  }
}

async function handleEventStateButtonClick(button) {
  const eventId = button.dataset.eventStateId;
  const status = button.dataset.eventStateValue;
  if (!eventId || !status) {
    return;
  }

  const previousFeed = cloneProviderFeed();
  applyOptimisticEventState(eventId, status);
  generatedStatusEl.textContent = status === "suspended" ? "Live - suspending match..." : "Live - opening match...";

  try {
    await submitEventStateUpdate({
      eventId,
      status,
      trader: state.traderName,
      reason: status === "suspended" ? "manual suspend match" : "manual reopen match",
    });
    generatedStatusEl.textContent = status === "suspended" ? "Live - match suspended" : "Live - match reopened";
  } catch (error) {
    restoreProviderFeed(previousFeed);
    generatedStatusEl.textContent = `Match state error: ${error.message}`;
  }
}

async function handleMarketStateButtonClick(button) {
  const marketId = button.dataset.marketStateId;
  const status = button.dataset.marketStateValue;
  if (!marketId || !status) {
    return;
  }

  const previousFeed = cloneProviderFeed();
  applyOptimisticMarketState(marketId, status);
  generatedStatusEl.textContent = status === "suspended" ? "Live - suspending market..." : "Live - opening market...";

  try {
    await submitMarketStateUpdate({
      marketId,
      status,
      trader: state.traderName,
      reason: status === "suspended" ? "manual suspend" : "manual reopen",
    });
    generatedStatusEl.textContent = status === "suspended" ? "Live - market suspended" : "Live - market reopened";
  } catch (error) {
    restoreProviderFeed(previousFeed);
    generatedStatusEl.textContent = `Market state error: ${error.message}`;
  }
}

async function submitManualPriceOverride(payload) {
  const response = await fetch("/manual-odds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Failed to save manual odds (${response.status})`);
  }

  if (data?.feed) {
    ingestData(data.feed);
  }

  return data;
}

async function submitMarketStateUpdate(payload) {
  const response = await fetch("/market-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = response.status === 404
      ? "Endpoint /market-state not found. Restart node server.js."
      : null;
    throw new Error(data?.error || hint || `Failed to save market state (${response.status})`);
  }

  if (data?.feed) {
    ingestData(data.feed);
  }

  return data;
}

async function submitEventStateUpdate(payload) {
  const response = await fetch("/event-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint = response.status === 404
      ? "Endpoint /event-state not found. Restart node server.js."
      : null;
    throw new Error(data?.error || hint || `Failed to save event state (${response.status})`);
  }

  if (data?.feed) {
    ingestData(data.feed);
  }

  return data;
}

async function submitFeedSettingsUpdate(payload) {
  const response = await fetch("/feed-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Failed to save feed settings (${response.status})`);
  }

  if (data?.feed) {
    ingestData(data.feed);
  }

  return data;
}

function cloneProviderFeed() {
  return JSON.parse(JSON.stringify(state.providerFeed));
}

function restoreProviderFeed(feed) {
  state.providerFeed = feed && typeof feed === "object" ? feed : { events: [], markets: [] };
  recomputeDerivedFeedState();
  render();
}

function applyOptimisticEventState(eventId, status) {
  const normalized = status === "suspended" ? "suspended" : "open";

  state.providerFeed.events = state.providerFeed.events.map((event) => (
    event.eventId === eventId
      ? {
          ...event,
          tradingStatus: normalized,
          tradingStateOverride: normalized === "suspended" ? { eventId, status: normalized } : null,
        }
      : event
  ));

  state.providerFeed.markets = state.providerFeed.markets.map((market) => {
    if (market.eventId !== eventId) {
      return market;
    }

    const nextStatus = normalized === "suspended"
      ? "suspended"
      : (market.tradingStateOverride?.status || "open");

    return {
      ...market,
      status: nextStatus,
      selections: (market.selections || []).map((selection) => ({
        ...selection,
        marketStatus: nextStatus,
      })),
    };
  });

  recomputeDerivedFeedState();
  render();
}

function applyOptimisticMarketState(marketId, status) {
  const normalized = status === "suspended" ? "suspended" : "open";

  state.providerFeed.markets = state.providerFeed.markets.map((market) => {
    if (market.marketId !== marketId) {
      return market;
    }

    const event = state.providerFeed.events.find((item) => item.eventId === market.eventId) || null;
    const nextStatus = event?.tradingStatus === "suspended"
      ? "suspended"
      : normalized;

    return {
      ...market,
      status: nextStatus,
      tradingStateOverride: normalized === "suspended" ? { marketId, status: normalized } : null,
      selections: (market.selections || []).map((selection) => ({
        ...selection,
        marketStatus: nextStatus,
      })),
    };
  });

  recomputeDerivedFeedState();
  render();
}

async function saveInlineEdit(input) {
  const marketId = input.dataset.marketId;
  const selectionId = input.dataset.selectionId;
  const oddsText = input.value.trim();

  if (!marketId || !selectionId) {
    state.editingCell = null;
    state.inlineEditValue = "";
    render();
    return;
  }

  try {
    await submitManualPriceOverride({
      marketId,
      selectionId,
      odds: oddsText === "" ? null : Number(oddsText),
      trader: state.traderName,
      reason: oddsText === "" ? "manual clear market" : "inline market rebalance",
      mode: oddsText === "" ? "clear_market" : "reprice_market",
    });
    generatedStatusEl.textContent = oddsText === "" ? "Live - market override cleared" : "Live - market repriced";
  } catch (error) {
    generatedStatusEl.textContent = `Manual odds error: ${error.message}`;
  } finally {
    state.editingCell = null;
    state.inlineEditValue = "";
    render();
  }
}

function getParticipant(event, role) {
  return event?.participants?.find((participant) => participant.role === role) || { name: role === "home" ? "Home" : "Away" };
}

function findPrimaryTotalsMarket(event) {
  const totalsMarkets = getFeedMarketsForEvent(event).filter((market) => market.type === "total_goals");
  if (!totalsMarkets.length) {
    return null;
  }
  return totalsMarkets.find((market) => Number(market.specifier?.points) !== 2.5) || totalsMarkets[0];
}

function marketGroupLabel(type) {
  const labels = {
    match_winner: "1X2",
    asian_handicap: "Asian Handicap",
    total_goals: "Totals",
    total_corners: "Corners Totals",
    both_teams_to_score: "Both Teams To Score",
    team_total_goals: "Team Totals",
    team_total_corners: "Team Corners",
    team_to_win_to_nil: "Team To Win To Nil",
    team_goals_exact: "Team Goals",
    double_chance: "Double Chance",
    draw_no_bet: "Draw No Bet",
    correct_score: "Correct Score",
    exact_total_goals: "Exact Total Goals",
    odd_even_goals: "Odd/Even",
    team_odd_even_goals: "Team Odd/Even",
    first_team_to_score: "1st Goal",
    which_team_to_score: "Which Team To Score",
    clean_sheet: "Clean Sheet",
    goal_range: "Goal Range",
    team_to_score_in_both_halves: "Score In Both Halves",
    both_halves_total_goals: "Both Halves Total",
    highest_scoring_half: "Highest Scoring Half",
    team_highest_scoring_half: "Team Highest Scoring Half",
    team_to_win_both_halves: "Win Both Halves",
    team_to_win_either_half: "Win Either Half",
    halftime_fulltime: "Halftime/Fulltime",
    match_result_and_total: "1X2 & Total",
    match_result_and_btts: "1X2 & BTTS",
    total_and_btts: "Total & BTTS",
    double_chance_and_btts: "Double Chance & BTTS",
    double_chance_and_total: "Double Chance & Total",
    double_chance_match_and_btts_half: "Double Chance & Half BTTS",
    halftime_fulltime_and_total: "HT/FT & Total",
    halftime_fulltime_and_first_half_total: "HT/FT & 1H Total",
  };

  return labels[type] || type;
}

function primaryMarketGroupKey(market) {
  const period = market?.specifier?.period || "ft";

  if (market?.type === "team_total_goals") {
    return "goals";
  }

  if (["total_corners", "team_total_corners"].includes(market?.type)) {
    return "corners";
  }

  if ([
    "team_to_win_to_nil",
    "team_to_win_both_halves",
    "team_to_win_either_half",
    "total_and_btts",
  ].includes(market?.type)) {
    return "specials";
  }

  if (["match_result_and_total", "match_result_and_btts"].includes(market?.type)) {
    return period === "ft" ? "specials" : "others";
  }

  if ([
    "exact_total_goals",
    "team_goals_exact",
    "odd_even_goals",
    "team_odd_even_goals",
    "first_team_to_score",
    "which_team_to_score",
    "clean_sheet",
    "goal_range",
    "team_to_score_in_both_halves",
    "both_halves_total_goals",
    "highest_scoring_half",
    "team_highest_scoring_half",
  ].includes(market?.type)) {
    return "goals";
  }

  if ([
    "double_chance_and_btts",
    "double_chance_and_total",
    "double_chance_match_and_btts_half",
    "halftime_fulltime_and_total",
    "halftime_fulltime_and_first_half_total",
  ].includes(market?.type)) {
    return "others";
  }

  if (market?.type === "halftime_fulltime") {
    return "main_markets";
  }

  if (period === "1h") {
    return "first_half";
  }
  if (period === "2h") {
    return "second_half";
  }

  return "main_markets";
}

function marketSectionOrder(market) {
  const order = {
    match_winner: 1,
    asian_handicap: 2,
    total_goals: 3,
    total_corners: 4,
    double_chance: 4,
    draw_no_bet: 5,
    both_teams_to_score: 6,
    team_total_goals: 7,
    team_total_corners: 8,
    team_to_win_to_nil: 9,
    team_goals_exact: 8,
    exact_total_goals: 10,
    correct_score: 11,
  };

  return order[market?.type] || 99;
}

function formatLambda(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
}

function readFirstHalfRatio() {
  const stored = Number(localStorage.getItem("sportsbook-first-half-ratio"));
  return clampFirstHalfRatio(Number.isFinite(stored) ? stored : 0.45);
}

function clampFirstHalfRatio(value) {
  if (!Number.isFinite(value)) {
    return 0.45;
  }

  return Math.min(0.95, Math.max(0.05, round(value, 2)));
}

function syncFirstHalfRatioLabel() {
  localStorage.setItem("sportsbook-first-half-ratio", String(state.firstHalfRatio));
  secondHalfRatioLabelEl.textContent = `2H ${formatRatio(1 - state.firstHalfRatio) || "0.55"}`;
}

function formatRatio(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
