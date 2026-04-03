const state = {
  generatedAt: null,
  search: "",
  filterMode: "all",
  leagues: [],
  providerFeed: { events: [], markets: [] },
  selectedLeagueKey: null,
  selectedMatchKey: null,
  selectedMarketKey: null,
  editingCell: null,
  inlineEditValue: "",
  traderName: localStorage.getItem("sportsbook-trader-name") || "local-trader",
  oddsSnapshot: new Map(),
};

const leagueGroupsEl = document.getElementById("leagueGroups");
const mainContentEl = document.getElementById("mainContent");
const leagueTotalEl = document.getElementById("leagueTotal");
const matchTotalEl = document.getElementById("matchTotal");
const generatedStatusEl = document.getElementById("generatedStatus");
const searchInputEl = document.getElementById("searchInput");
const traderNameInputEl = document.getElementById("traderNameInput");
const traderFilterGroupEl = document.getElementById("traderFilterGroup");
const heroTitleEl = document.getElementById("heroTitle");
const heroSourceEl = document.getElementById("heroSource");
const heroMatchCountEl = document.getElementById("heroMatchCount");
const countdownPillEl = document.getElementById("countdownPill");
const countdownValEl = document.getElementById("countdownVal");
const refreshBtnEl = document.getElementById("refreshBtn");

searchInputEl.addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  render();
});

traderNameInputEl.value = state.traderName;
traderNameInputEl.addEventListener("input", (event) => {
  state.traderName = event.target.value.trim() || "local-trader";
  localStorage.setItem("sportsbook-trader-name", state.traderName);
});

for (const button of traderFilterGroupEl.querySelectorAll("[data-filter-mode]")) {
  button.addEventListener("click", () => {
    state.filterMode = button.dataset.filterMode || "all";
    render();
  });
}

refreshBtnEl.addEventListener("click", () => {
  refreshBtnEl.classList.add("spinning");
  generatedStatusEl.textContent = "Live - fetching...";
  fetch("/refresh", { method: "POST" }).catch(() => {
    refreshBtnEl.classList.remove("spinning");
  });
});

connectSSE();

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
  state.providerFeed = normalizeProviderFeed(data.providerFeed);
  state.leagues = buildLeagueCollection();

  if (!state.leagues.some((league) => league.key === state.selectedLeagueKey)) {
    state.selectedLeagueKey = state.leagues[0]?.key || null;
  }

  render();

  const isNew = previousGeneratedAt && previousGeneratedAt !== state.generatedAt;
  generatedStatusEl.textContent = state.generatedAt
    ? `Live - updated ${new Date(state.generatedAt).toLocaleTimeString()}${isNew ? " - new data" : ""}`
    : "Live";
}

function normalizeProviderFeed(feed) {
  return {
    events: Array.isArray(feed?.events) ? feed.events : [],
    markets: Array.isArray(feed?.markets) ? feed.markets : [],
  };
}

function showFileOpenError() {
  generatedStatusEl.textContent = "Error: opened as file";
  leagueGroupsEl.innerHTML = `<div class="empty-state"><strong>Wrong URL</strong>Run <code>node server.js</code> then open <code>http://localhost:3000</code></div>`;
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
    .map((league) => ({
      ...league,
      matches: league.matches.filter((match) => matchPassesCurrentFilters(match)),
      count: league.matches.filter((match) => matchPassesCurrentFilters(match)).length,
    }))
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

  const markets = getFeedMarketsForEvent(event);
  const hasSuspendedMarket = markets.some((market) => market.status === "suspended");
  const hasManualMarket = markets.some((market) => (market.selections || []).some((selection) => selection.manualOverride?.odds != null));
  const eventSuspended = event.tradingStatus === "suspended";

  if (state.filterMode === "suspended") {
    return eventSuspended || hasSuspendedMarket;
  }
  if (state.filterMode === "manual") {
    return hasManualMarket;
  }
  if (state.filterMode === "overrides") {
    return eventSuspended || hasSuspendedMarket || hasManualMarket;
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

  for (const button of leagueGroupsEl.querySelectorAll("[data-league-key]")) {
    button.addEventListener("click", () => {
      state.selectedLeagueKey = button.dataset.leagueKey;
      state.selectedMatchKey = null;
      state.selectedMarketKey = null;
      render();
    });
  }
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
          ${renderMarketDetailTable(selectedMatch, selectedGroup)}
        </section>
        <aside class="market-notes">
          ${renderInsightsPanel(selectedMatch, selectedGroup, league)}
        </aside>
      </div>
    </div>
  `;

  for (const card of mainContentEl.querySelectorAll("[data-match-key]")) {
    card.addEventListener("click", () => {
      state.selectedMatchKey = card.dataset.matchKey;
      state.selectedMarketKey = null;
      render();
    });
  }

  for (const button of mainContentEl.querySelectorAll("[data-market-key]")) {
    button.addEventListener("click", () => {
      state.selectedMarketKey = button.dataset.marketKey;
      render();
    });
  }

  bindManualPriceEditors();
}

function getMatchKey(event) {
  return event?.eventId || "na";
}

function buildMarketGroups(event) {
  const groups = new Map();

  for (const market of getFeedMarketsForEvent(event)) {
    if (!groups.has(market.type)) {
      groups.set(market.type, {
        key: market.type,
        label: marketGroupLabel(market.type),
        count: 0,
      });
    }
    groups.get(market.type).count += 1;
  }

  return [...groups.values()].sort((a, b) => marketGroupOrder(a.key) - marketGroupOrder(b.key) || a.label.localeCompare(b.label));
}

function getFeedMarketsForEvent(event) {
  if (!event) {
    return [];
  }
  return state.providerFeed.markets.filter((market) => market.eventId === event.eventId);
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

function renderMarketDetailTable(event, group) {
  if (!group) {
    return `<div class="empty-state"><strong>No market selected</strong>Choose a market group on the left.</div>`;
  }

  const sections = buildMarketSections(event, group.key);
  if (!sections.length) {
    return `<div class="empty-state"><strong>No prices available</strong>The selected market has no active prices.</div>`;
  }

  return `
    <div class="workspace-header">
      <div>
        <div class="workspace-kicker">Market Board</div>
        <div class="workspace-name">${escapeHtml(group.label)}</div>
      </div>
      <div class="workspace-badge">${sections.reduce((sum, section) => sum + section.rows.length, 0)} rows</div>
    </div>
    ${sections.map((section) => renderMarketSection(section, group.label)).join("")}
  `;
}

function buildMarketSections(event, key) {
  return getFeedMarketsForEvent(event)
    .filter((market) => market.type === key)
    .map((market) => ({
      marketId: market.marketId,
      status: market.status || "open",
      title: buildMarketSectionTitle(market, event),
      margins: {
        active: formatMarginLabel(computeMarketMargin(market, "active")),
        feed: formatMarginLabel(computeMarketMargin(market, "feed")),
        raw: formatMarginLabel(computeMarketMargin(market, "raw")),
      },
      rows: (market.selections || []).map((selection) => ({
        marketId: market.marketId,
        selectionId: selection.id,
        label: selection.name || selection.id || "Selection",
        value: selection,
      })),
    }))
    .filter((section) => section.rows.length);
}

function renderMarketSection(section, fallbackLabel) {
  const isSuspended = section.status === "suspended";
  return `
    <section class="market-line-section${isSuspended ? " is-suspended" : ""}">
      <div class="market-line-header">
        <div>
          <div class="market-line-title">${escapeHtml(section.title || fallbackLabel)}</div>
          <div class="market-line-meta">${section.rows.length} selections</div>
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
          </tr>
        </thead>
        <tbody>
          ${section.rows.map((row, index) => `
            <tr>
              <td class="detail-label"><div>${escapeHtml(row.label)}</div></td>
              <td>${renderProviderPriceCell(row, "active", index)}</td>
              <td>${renderProviderPriceCell(row, "feed", index)}</td>
              <td>${renderProviderPriceCell(row, "raw", index)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function buildMarketSectionTitle(market, event) {
  event = event || {};
  if (market.type === "team_total_goals") {
    const teamName = market.specifier?.team === "home" ? getParticipant(event, "home").name : getParticipant(event, "away").name;
    return `${teamName} ${market.specifier?.label || market.specifier?.points || ""}`.trim();
  }

  if (market.specifier?.label) {
    return `${marketGroupLabel(market.type)} ${market.specifier.label}`.trim();
  }

  if (market.specifier?.variant) {
    return `${marketGroupLabel(market.type)} ${market.specifier.variant}`.trim();
  }

  return marketGroupLabel(market.type);
}

function computeMarketMargin(market, columnKey) {
  const prices = (market?.selections || [])
    .map((selection) => {
      if (columnKey === "active") return Number(selection?.odds);
      if (columnKey === "feed") return Number(selection?.fairOdds);
      return Number(selection?.sourceOdds);
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
  const rawOdds = Number(value?.sourceOdds);
  const tone = index % 2 === 0 ? " alt" : "";

  if (columnKey === "active") {
    if (marketSuspended) {
      return `<div class="matrix-price is-active is-suspended${tone}"><strong>SUSP</strong><small>market</small></div>`;
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
      label: value?.manualOverride?.odds != null ? "Manual" : "Active",
      className: `matrix-price is-active${tone}${changed}`,
      marketId: row.marketId,
      selectionId: row.selectionId,
      manualCurrent: value?.manualOverride?.odds,
      feedOdds,
      clickable: true,
    });
  }

  if (columnKey === "feed") {
    return renderMatrixPrice({
      price: feedOdds,
      label: "No margin",
      className: `matrix-price is-feed${tone}`,
    });
  }

  return renderMatrixPrice({
    price: rawOdds,
    label: "Raw",
    className: `matrix-price is-raw${tone}`,
  });
}

function renderMatrixPrice({ price, label, className, marketId = "", selectionId = "", manualCurrent = null, feedOdds = null, clickable = false }) {
  if (!Number.isFinite(price)) {
    return `<div class="${className} is-missing"><strong>—</strong></div>`;
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

function renderInsightsPanel(event, group, league) {
  const markets = getFeedMarketsForEvent(event);
  const method = markets.find((market) => market.type === "match_winner")?.pricingContext?.devigMethod || "n/a";
  const analytics = event.analytics || {};

  return `
    <div class="insight-card">
      <div class="insight-title">Feed Summary</div>
      <div class="insight-row"><span>League</span><strong>${escapeHtml(league.name)}</strong></div>
      <div class="insight-row"><span>Source</span><strong>${escapeHtml(event.provider || "source")}</strong></div>
      <div class="insight-row"><span>Selected</span><strong>${escapeHtml(group?.label || "none")}</strong></div>
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
    </div>
    <div class="insight-card">
      <div class="insight-title">Timeline Hooks</div>
      <p class="insight-copy">This layout is prepared for future templates, timeline events, booking incidents, and manual odds overlays.</p>
    </div>
  `;
}

function bindManualPriceEditors() {
  for (const button of mainContentEl.querySelectorAll("[data-event-state-id][data-event-state-value]")) {
    button.addEventListener("click", async () => {
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
    });
  }

  for (const button of mainContentEl.querySelectorAll("[data-market-state-id][data-market-state-value]")) {
    button.addEventListener("click", async () => {
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
    });
  }

  for (const button of mainContentEl.querySelectorAll("[data-manual-market-id][data-manual-selection-id]")) {
    button.addEventListener("click", () => {
      state.editingCell = {
        marketId: button.dataset.manualMarketId,
        selectionId: button.dataset.manualSelectionId,
      };
      state.inlineEditValue = button.dataset.manualCurrent || button.querySelector("strong")?.textContent || "";
      render();
    });
  }

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

function cloneProviderFeed() {
  return JSON.parse(JSON.stringify(state.providerFeed));
}

function restoreProviderFeed(feed) {
  state.providerFeed = feed && typeof feed === "object" ? feed : { events: [], markets: [] };
  state.leagues = buildLeagueCollection();
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

  state.leagues = buildLeagueCollection();
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

  state.leagues = buildLeagueCollection();
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
    total_goals: "Totals",
    both_teams_to_score: "Both Teams To Score",
    team_total_goals: "Team Totals",
    double_chance: "Double Chance",
    draw_no_bet: "Draw No Bet",
    correct_score: "Correct Score",
  };

  return labels[type] || type;
}

function marketGroupOrder(type) {
  const order = {
    match_winner: 1,
    total_goals: 2,
    double_chance: 3,
    draw_no_bet: 4,
    both_teams_to_score: 5,
    team_total_goals: 6,
    correct_score: 7,
  };

  return order[type] || 99;
}

function formatLambda(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
