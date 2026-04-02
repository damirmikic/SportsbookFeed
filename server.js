#!/usr/bin/env node

/**
 * Sportsbook local dev server.
 *
 * - Runs fetch-odds.js on startup and every 30 s (or --interval <s>)
 * - Pushes results directly to browsers via Server-Sent Events (no JSON file)
 * - GET /events   — SSE stream; browser receives odds the moment they are ready
 * - POST /refresh — trigger an immediate fetch (manual refresh button)
 * - GET /         — serves sportsbook.html
 *
 * Usage:
 *   node server.js [--port 3000] [--interval 30] [any fetch-odds.js flags]
 *
 * Examples:
 *   node server.js
 *   node server.js --source pinnacle --pinnacle-fetch-events --interval 30
 *   node server.js --port 8080 --source p4578 --p4578-fetch-events
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const {
  clearManualMarket,
  clearManualSelection,
  getManualOddsPath,
  loadManualOddsStore,
  saveManualOddsStore,
  upsertManualSelection,
  upsertManualSelections,
} = require("./lib/manual-odds");

const DIR = __dirname;
const MANUAL_ODDS_PATH = getManualOddsPath();

// ── Parse our own flags, pass the rest straight to fetch-odds.js ──
const rawArgs = process.argv.slice(2);
let PORT        = 3000;
let INTERVAL_MS = 30_000;
const fetchArgs = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a    = rawArgs[i];
  const next = rawArgs[i + 1];
  if (a === "--port" && next) {
    PORT = Number(next); i++;
  } else if (a === "--interval" && next) {
    INTERVAL_MS = Math.max(5, Number(next)) * 1000; i++;
  } else {
    fetchArgs.push(a);
  }
}

// ── SSE clients ────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// Heartbeat — keeps connections alive through proxies / browser timeouts
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(": ping\n\n"); } catch { sseClients.delete(res); }
  }
}, 20_000);

// ── In-memory cache (last successful fetch) ────────────────────────
let cache      = null;
let refreshing = false;

function refreshOdds() {
  if (refreshing) return;
  refreshing = true;
  console.log(`[${ts()}] Fetching odds…`);

  const chunks = [];
  const child  = require("child_process").spawn(
    process.execPath,
    [path.join(DIR, "fetch-odds.js"), ...fetchArgs],
    { cwd: DIR, stdio: ["ignore", "pipe", "inherit"] }
  );

  child.stdout.on("data", (d) => chunks.push(d));

  child.on("exit", (code) => {
    refreshing = false;
    if (code !== 0) {
      console.error(`[${ts()}] fetch-odds.js exited with code ${code}`);
      broadcast({ error: `fetch-odds.js failed (exit ${code})`, generatedAt: new Date().toISOString() });
      return;
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed.generatedAt) parsed.generatedAt = new Date().toISOString();
      cache = parsed;
      // Log a summary of what each source returned
      for (const [src, val] of Object.entries(parsed.sources || {})) {
        if (val?.error) {
          console.error(`  [${src}] ERROR: ${val.error}`);
        } else {
          const mc = Array.isArray(val?.matches) ? val.matches.length : 0;
          console.log(`  [${src}] ${mc} matches`);
        }
      }
      console.log(`[${ts()}] Broadcasting to ${sseClients.size} client(s).`);
      broadcast(cache);
    } catch (e) {
      console.error(`[${ts()}] Failed to parse fetch-odds output: ${e.message}`);
    }
  });
}

// ── HTTP server ────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".ico":  "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── SSE stream ─────────────────────────────────────────────────
  if (pathname === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",   // disable nginx buffering if behind proxy
    });
    res.write(`retry: 3000\n\n`);  // browser reconnects after 3s if dropped

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));

    // Send current data immediately if we already have it
    if (cache) res.write(`data: ${JSON.stringify(cache)}\n\n`);
    return;
  }

  // ── Debug: inspect raw cache structure ────────────────────────
  if (pathname === "/debug" && req.method === "GET") {
    if (!cache) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "no data yet" }));
      return;
    }
    const summary = {
      generatedAt: cache.generatedAt,
      sources: Object.fromEntries(
        Object.entries(cache.sources || {}).map(([src, val]) => [src, {
          error: val?.error ?? null,
          matchCount: Array.isArray(val?.matches) ? val.matches.length : 0,
          leagueCount: Array.isArray(val?.leagues) ? val.leagues.length : 0,
          sampleMatch: Array.isArray(val?.matches) ? val.matches[0] ?? null : null,
          // Show top-level keys of the raw source so we can see actual API structure
          rawTopLevelKeys: val ? Object.keys(val) : [],
          sampleLeagueResult: Array.isArray(val?.leagueResults) ? val.leagueResults[0] ?? null : null,
        }])
      ),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summary, null, 2));
    return;
  }

  if (pathname === "/manual-odds" && req.method === "GET") {
    const store = loadManualOddsStore(MANUAL_ODDS_PATH);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(store, null, 2));
    return;
  }

  if (pathname === "/manual-odds" && req.method === "POST") {
    collectJsonBody(req)
      .then((payload) => {
        const marketId = String(payload?.marketId || "").trim();
        const selectionId = String(payload?.selectionId || "").trim();
        const mode = String(payload?.mode || "").trim();

        if (!marketId) {
          throw new Error("marketId is required");
        }

        const currentStore = loadManualOddsStore(MANUAL_ODDS_PATH);
        const nextStore = resolveNextManualOddsStore(currentStore, payload, mode, marketId, selectionId);

        const saved = saveManualOddsStore(nextStore, MANUAL_ODDS_PATH);
        fetchOddsSnapshot()
          .then((parsed) => {
            cache = parsed;
            logFetchSummary(parsed);
            broadcast(cache);
            res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              status: mode === "clear_market" || (payload?.odds == null || String(payload.odds).trim() === "") ? "cleared" : "saved",
              manualOdds: saved,
              feed: parsed,
            }));
          })
          .catch((fetchError) => {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: fetchError.message }));
          });
      })
      .catch((error) => {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error.message }));
      });
    return;
  }

  // ── Manual refresh trigger ─────────────────────────────────────
  if (pathname === "/refresh" && req.method === "POST") {
    refreshOdds();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "fetching" }));
    return;
  }

  // ── Static files ───────────────────────────────────────────────
  const filename = pathname === "/" ? "sportsbook.html" : pathname.slice(1);
  const filePath = path.resolve(DIR, filename);

  if (!filePath.startsWith(DIR + path.sep) && filePath !== DIR) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext     = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log("");
  console.log(`  Sportsbook server → http://localhost:${PORT}`);
  console.log(`  Odds pushed via SSE every ${INTERVAL_MS / 1000}s`);
  if (fetchArgs.length) console.log(`  fetch-odds args: ${fetchArgs.join(" ")}`);
  console.log("");
});

// ── Start ──────────────────────────────────────────────────────────
refreshOdds();
setInterval(refreshOdds, INTERVAL_MS);

function ts() {
  return new Date().toLocaleTimeString();
}

function collectJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function resolveNextManualOddsStore(currentStore, payload, mode, marketId, selectionId) {
  if (mode === "reprice_market") {
    if (!selectionId) {
      throw new Error("selectionId is required");
    }
    const repricedEntries = buildRepricedMarketOverrides(payload, marketId, selectionId);
    let nextStore = clearManualMarket(currentStore, marketId);
    nextStore = upsertManualSelections(nextStore, repricedEntries);
    return nextStore;
  }

  if (mode === "clear_market") {
    return clearManualMarket(currentStore, marketId);
  }

  if (!selectionId) {
    throw new Error("selectionId is required");
  }

  const shouldClear = payload?.odds == null || String(payload.odds).trim() === "";
  return shouldClear
    ? clearManualSelection(currentStore, marketId, selectionId)
    : upsertManualSelection(currentStore, {
        marketId,
        selectionId,
        odds: payload.odds,
        trader: payload.trader,
        reason: payload.reason,
        mode: payload.mode,
      });
}

function buildRepricedMarketOverrides(payload, marketId, selectionId) {
  const market = cache?.providerFeed?.markets?.find((item) => item.marketId === marketId) || null;
  if (!market) {
    throw new Error("Market not found in current feed");
  }

  const editedOdds = Number(payload?.odds);
  if (!Number.isFinite(editedOdds) || editedOdds <= 1) {
    throw new Error("Manual odds must be a decimal price greater than 1");
  }

  const selections = Array.isArray(market.selections) ? market.selections : [];
  const editedSelection = selections.find((item) => item.id === selectionId);
  if (!editedSelection) {
    throw new Error("Selection not found in current feed");
  }

  const baseProbabilities = normalizeProbabilities(
    selections.map((item) => ({
      id: item.id,
      probability: impliedProbability(item.odds),
    }))
  );

  const editedProbability = 1 / editedOdds;
  if (!(editedProbability > 0 && editedProbability < 1)) {
    throw new Error("Edited odds produce an invalid probability");
  }

  const others = baseProbabilities.filter((item) => item.id !== selectionId);
  const otherBaseTotal = others.reduce((sum, item) => sum + item.probability, 0);
  const remainingProbability = 1 - editedProbability;
  if (!(remainingProbability > 0)) {
    throw new Error("Edited odds leave no probability for the rest of the market");
  }

  const repriced = [];
  for (const selection of selections) {
    let probability;
    if (selection.id === selectionId) {
      probability = editedProbability;
    } else if (otherBaseTotal > 0) {
      const base = others.find((item) => item.id === selection.id)?.probability || 0;
      probability = remainingProbability * (base / otherBaseTotal);
    } else {
      probability = remainingProbability / Math.max(1, selections.length - 1);
    }

    const odds = 1 / probability;
    if (!Number.isFinite(odds) || odds <= 1) {
      throw new Error("Failed to rebalance market odds");
    }

    repriced.push({
      marketId,
      selectionId: selection.id,
      odds: round(odds, 3),
      trader: payload.trader,
      reason: payload.reason,
      mode: "market_reprice",
      updatedAt: new Date().toISOString(),
    });
  }

  return repriced;
}

function normalizeProbabilities(items) {
  const valid = items.filter((item) => Number.isFinite(item.probability) && item.probability > 0);
  const total = valid.reduce((sum, item) => sum + item.probability, 0);
  if (!(total > 0)) {
    return [];
  }

  return valid.map((item) => ({
    id: item.id,
    probability: item.probability / total,
  }));
}

function impliedProbability(odds) {
  const numericOdds = Number(odds);
  return Number.isFinite(numericOdds) && numericOdds > 1 ? 1 / numericOdds : null;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function refreshOdds() {
  if (refreshing) return;
  refreshing = true;
  console.log(`[${ts()}] Fetching odds...`);

  fetchOddsSnapshot()
    .then((parsed) => {
      refreshing = false;
      cache = parsed;
      logFetchSummary(parsed);
      console.log(`[${ts()}] Broadcasting to ${sseClients.size} client(s).`);
      broadcast(cache);
    })
    .catch((error) => {
      refreshing = false;
      console.error(`[${ts()}] ${error.message}`);
      broadcast({ error: error.message, generatedAt: new Date().toISOString() });
    });
}

function fetchOddsSnapshot() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = require("child_process").spawn(
      process.execPath,
      [path.join(DIR, "fetch-odds.js"), ...fetchArgs],
      { cwd: DIR, stdio: ["ignore", "pipe", "inherit"] }
    );

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`fetch-odds.js failed (exit ${code})`));
        return;
      }

      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed.generatedAt) {
          parsed.generatedAt = new Date().toISOString();
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse fetch-odds output: ${error.message}`));
      }
    });
  });
}

function logFetchSummary(parsed) {
  for (const [src, val] of Object.entries(parsed.sources || {})) {
    if (val?.error) {
      console.error(`  [${src}] ERROR: ${val.error}`);
    } else {
      const mc = Array.isArray(val?.matches) ? val.matches.length : 0;
      console.log(`  [${src}] ${mc} matches`);
    }
  }
}
