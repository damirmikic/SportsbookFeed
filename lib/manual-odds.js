const fs = require("fs");
const path = require("path");

const DEFAULT_MANUAL_ODDS_PATH = path.resolve(__dirname, "..", "manual-odds.json");

function getManualOddsPath(customPath = null) {
  return customPath ? path.resolve(customPath) : DEFAULT_MANUAL_ODDS_PATH;
}

function loadManualOddsStore(customPath = null) {
  const filePath = getManualOddsPath(customPath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeManualOddsStore(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return createEmptyManualOddsStore();
    }
    throw error;
  }
}

function saveManualOddsStore(store, customPath = null) {
  const filePath = getManualOddsPath(customPath);
  const normalized = normalizeManualOddsStore(store);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function upsertManualSelection(store, input) {
  const normalized = normalizeManualOddsStore(store);
  const marketId = String(input?.marketId || "").trim();
  const selectionId = String(input?.selectionId || "").trim();
  const odds = Number(input?.odds);

  if (!marketId || !selectionId) {
    throw new Error("marketId and selectionId are required");
  }
  if (!Number.isFinite(odds) || odds <= 1) {
    throw new Error("Manual odds must be a decimal price greater than 1");
  }

  normalized.selections[selectionKey(marketId, selectionId)] = {
    marketId,
    selectionId,
    odds,
    trader: sanitizeOptionalString(input?.trader),
    reason: sanitizeOptionalString(input?.reason),
    mode: sanitizeOptionalString(input?.mode) || "manual",
    updatedAt: input?.updatedAt || new Date().toISOString(),
  };

  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function upsertManualSelections(store, inputs) {
  let normalized = normalizeManualOddsStore(store);
  for (const input of inputs || []) {
    normalized = upsertManualSelection(normalized, input);
  }
  return normalized;
}

function clearManualSelection(store, marketId, selectionId) {
  const normalized = normalizeManualOddsStore(store);
  delete normalized.selections[selectionKey(marketId, selectionId)];
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function clearManualMarket(store, marketId) {
  const normalized = normalizeManualOddsStore(store);
  for (const key of Object.keys(normalized.selections)) {
    if (key.startsWith(`${marketId}::`)) {
      delete normalized.selections[key];
    }
  }
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

function getManualSelection(store, marketId, selectionId) {
  const normalized = normalizeManualOddsStore(store);
  return normalized.selections[selectionKey(marketId, selectionId)] || null;
}

function normalizeManualOddsStore(store) {
  const selections = {};
  const rawSelections = store?.selections || {};

  for (const value of Object.values(rawSelections)) {
    const marketId = String(value?.marketId || "").trim();
    const selectionId = String(value?.selectionId || "").trim();
    const odds = Number(value?.odds);
    if (!marketId || !selectionId || !Number.isFinite(odds) || odds <= 1) {
      continue;
    }

    const normalizedEntry = {
      marketId,
      selectionId,
      odds,
      trader: sanitizeOptionalString(value?.trader),
      reason: sanitizeOptionalString(value?.reason),
      mode: sanitizeOptionalString(value?.mode) || "manual",
      updatedAt: value?.updatedAt || null,
    };

    selections[selectionKey(marketId, selectionId)] = normalizedEntry;
  }

  return {
    updatedAt: store?.updatedAt || null,
    selections,
  };
}

function createEmptyManualOddsStore() {
  return {
    updatedAt: null,
    selections: {},
  };
}

function selectionKey(marketId, selectionId) {
  return `${marketId}::${selectionId}`;
}

function sanitizeOptionalString(value) {
  const text = String(value || "").trim();
  return text || null;
}

module.exports = {
  clearManualSelection,
  clearManualMarket,
  createEmptyManualOddsStore,
  getManualOddsPath,
  getManualSelection,
  loadManualOddsStore,
  normalizeManualOddsStore,
  saveManualOddsStore,
  selectionKey,
  upsertManualSelection,
  upsertManualSelections,
};
