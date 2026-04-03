const fs = require("fs");
const path = require("path");

const DEFAULT_FIRST_HALF_RATIO = 0.45;
const DEFAULT_FEED_SETTINGS_PATH = path.resolve(__dirname, "..", "feed-settings.json");

function getFeedSettingsPath(customPath = null) {
  return customPath ? path.resolve(customPath) : DEFAULT_FEED_SETTINGS_PATH;
}

function createDefaultFeedSettings() {
  return {
    firstHalfRatio: DEFAULT_FIRST_HALF_RATIO,
    updatedAt: null,
  };
}

function normalizeFeedSettings(settings) {
  const firstHalfRatio = clampFirstHalfRatio(settings?.firstHalfRatio);
  return {
    firstHalfRatio,
    updatedAt: settings?.updatedAt || null,
  };
}

function loadFeedSettings(customPath = null) {
  const filePath = getFeedSettingsPath(customPath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeFeedSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") {
      return createDefaultFeedSettings();
    }
    throw error;
  }
}

function saveFeedSettings(settings, customPath = null) {
  const filePath = getFeedSettingsPath(customPath);
  const normalized = {
    ...normalizeFeedSettings(settings),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function clampFirstHalfRatio(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_FIRST_HALF_RATIO;
  }

  return round(Math.min(0.95, Math.max(0.05, numeric)), 2);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = {
  DEFAULT_FIRST_HALF_RATIO,
  clampFirstHalfRatio,
  createDefaultFeedSettings,
  getFeedSettingsPath,
  loadFeedSettings,
  normalizeFeedSettings,
  saveFeedSettings,
};
