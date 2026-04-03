const fs = require("fs");
const path = require("path");

const DEFAULT_MARKET_STATE_PATH = path.resolve(__dirname, "..", "market-state.json");

function getMarketStatePath(customPath = null) {
  return customPath ? path.resolve(customPath) : DEFAULT_MARKET_STATE_PATH;
}

function loadMarketStateStore(customPath = null) {
  const filePath = getMarketStatePath(customPath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeMarketStateStore(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return createEmptyMarketStateStore();
    }
    throw error;
  }
}

function saveMarketStateStore(store, customPath = null) {
  const filePath = getMarketStatePath(customPath);
  const normalized = normalizeMarketStateStore(store);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function upsertEventState(store, input) {
  const normalized = normalizeMarketStateStore(store);
  const eventId = String(input?.eventId || "").trim();
  const status = normalizeStatus(input?.status);

  if (!eventId) {
    throw new Error("eventId is required");
  }
  if (!status) {
    throw new Error("status must be open or suspended");
  }

  normalized.events[eventId] = {
    eventId,
    status,
    trader: sanitizeOptionalString(input?.trader),
    reason: sanitizeOptionalString(input?.reason),
    updatedAt: input?.updatedAt || new Date().toISOString(),
  };

  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function upsertMarketState(store, input) {
  const normalized = normalizeMarketStateStore(store);
  const marketId = String(input?.marketId || "").trim();
  const status = normalizeStatus(input?.status);

  if (!marketId) {
    throw new Error("marketId is required");
  }
  if (!status) {
    throw new Error("status must be open or suspended");
  }

  normalized.markets[marketId] = {
    marketId,
    status,
    trader: sanitizeOptionalString(input?.trader),
    reason: sanitizeOptionalString(input?.reason),
    updatedAt: input?.updatedAt || new Date().toISOString(),
  };

  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function clearMarketState(store, marketId) {
  const normalized = normalizeMarketStateStore(store);
  delete normalized.markets[String(marketId || "").trim()];
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function clearEventState(store, eventId) {
  const normalized = normalizeMarketStateStore(store);
  delete normalized.events[String(eventId || "").trim()];
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function normalizeMarketStateStore(store) {
  const events = {};
  const markets = {};
  const rawEvents = store?.events || {};
  const rawMarkets = store?.markets || {};

  for (const value of Object.values(rawEvents)) {
    const eventId = String(value?.eventId || "").trim();
    const status = normalizeStatus(value?.status);
    if (!eventId || !status) {
      continue;
    }

    events[eventId] = {
      eventId,
      status,
      trader: sanitizeOptionalString(value?.trader),
      reason: sanitizeOptionalString(value?.reason),
      updatedAt: value?.updatedAt || null,
    };
  }

  for (const value of Object.values(rawMarkets)) {
    const marketId = String(value?.marketId || "").trim();
    const status = normalizeStatus(value?.status);
    if (!marketId || !status) {
      continue;
    }

    markets[marketId] = {
      marketId,
      status,
      trader: sanitizeOptionalString(value?.trader),
      reason: sanitizeOptionalString(value?.reason),
      updatedAt: value?.updatedAt || null,
    };
  }

  return {
    updatedAt: store?.updatedAt || null,
    events,
    markets,
  };
}

function createEmptyMarketStateStore() {
  return {
    updatedAt: null,
    events: {},
    markets: {},
  };
}

function normalizeStatus(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "open" || text === "suspended") {
    return text;
  }
  return null;
}

function sanitizeOptionalString(value) {
  const text = String(value || "").trim();
  return text || null;
}

module.exports = {
  clearEventState,
  clearMarketState,
  createEmptyMarketStateStore,
  getMarketStatePath,
  loadMarketStateStore,
  normalizeMarketStateStore,
  saveMarketStateStore,
  upsertEventState,
  upsertMarketState,
};
