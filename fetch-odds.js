#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { computeLambdas: computeLambdasFromModule } = require("./lib/lambda");
const { buildProviderFeed } = require("./lib/provider-feed");
const { loadManualOddsStore } = require("./lib/manual-odds");

const DEFAULT_TIPSPORT_HAR = "C:/Users/kvoter2/Downloads/www.tipsport.cz.har";
const DEFAULT_TIPSPORT_DETECTOR = "C:/Users/kvoter2/Downloads/api-detector-export (1).json";
const DEFAULT_P4578_HAR = "C:/Users/kvoter2/Downloads/www.p4578.com.har";
const DEFAULT_P4578_BASE_URL = "https://www.pinnacle888.com";
const DEFAULT_P4578_MAX_LEAGUES = 200;
const DEFAULT_P4578_CHUNK_SIZE = 50;
const DEFAULT_P4578_EVENT_ENRICHMENT_CHUNK_SIZE = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const TIPSPORT_MUTED = true;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await fetchOddsData(args, {
    onProgress(snapshot) {
      if (typeof process.send === "function") {
        process.send({ type: "progress", snapshot });
      }
    },
  });
  const output = JSON.stringify(result, null, 2);
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.writeFileSync(outPath, output, "utf8");
    console.log(`Wrote ${outPath}`);
    return;
  }

  console.log(output);
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--tipsport-har" && next) {
      args.tipsportHar = next;
      i += 1;
    } else if (current === "--tipsport-detector" && next) {
      args.tipsportDetector = next;
      i += 1;
    } else if (current === "--p4578-har" && next) {
      args.p4578Har = next;
      i += 1;
    } else if (current === "--p4578-base-url" && next) {
      args.p4578BaseUrl = next;
      i += 1;
    } else if (current === "--source" && next) {
      args.source = next;
      i += 1;
    } else if (current === "--tipsport-limit" && next) {
      args.tipsportLimit = Number(next);
      i += 1;
    } else if (current === "--tipsport-live") {
      args.tipsportLive = true;
    } else if (current === "--out" && next) {
      args.out = next;
      i += 1;
    } else if (current === "--manual-odds-file" && next) {
      args.manualOddsFile = next;
      i += 1;
    } else if (current === "--p4578-sport-id" && next) {
      args.p4578SportId = Number(next);
      i += 1;
    } else if (current === "--p4578-league-code" && next) {
      args.p4578LeagueCode = next;
      i += 1;
    } else if (current === "--p4578-fetch-events") {
      args.p4578FetchEvents = true;
    } else if (current === "--p4578-max-leagues" && next) {
      args.p4578MaxLeagues = Number(next);
      i += 1;
    } else if (current === "--p4578-chunk-size" && next) {
      args.p4578ChunkSize = Number(next);
      i += 1;
    } else if (current === "--p4578-event-id" && next) {
      args.p4578EventId = Number(next);
      i += 1;
    } else if (current === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(
    [
      "Usage: node fetch-odds.js [options]",
      "",
      "Options:",
      "  --source tipsport|p4578  Fetch only one source",
      "  --tipsport-har <path>      Override Tipsport HAR path",
      "  --tipsport-detector <path> Override Tipsport API detector export path",
      "  --p4578-har <path>         Override p4578 HAR path",
      `  --p4578-base-url <url>     Override p4578 base URL (default: ${DEFAULT_P4578_BASE_URL})`,
      "  --out <path>               Write JSON output as UTF-8 to a file",
      "  --manual-odds-file <path>  Override manual odds JSON path",
      "  --tipsport-limit <n>       Override Tipsport offer limit",
      "  --tipsport-live            Try live Tipsport replay instead of HAR-only mode",
      "  --p4578-sport-id <n>       Override p4578 sport id (default: inferred from HAR or 29)",
      "  --p4578-league-code <code> Fetch a specific p4578 league odds payload",
      "  --p4578-fetch-events       Fetch events for multiple p4578 leagues",
      `  --p4578-max-leagues <n>    Limit how many p4578 leagues are expanded into events (default: ${DEFAULT_P4578_MAX_LEAGUES})`,
      `  --p4578-chunk-size <n>     Emit progressive updates every N leagues (default: ${DEFAULT_P4578_CHUNK_SIZE})`,
      "  --p4578-event-id <id>      Fetch a specific p4578 event odds payload",
    ].join("\n")
  );
}

async function fetchOddsData(args, options = {}) {
  const tipsportHarPath = path.resolve(args.tipsportHar || DEFAULT_TIPSPORT_HAR);
  const tipsportDetectorPath = path.resolve(args.tipsportDetector || DEFAULT_TIPSPORT_DETECTOR);
  const p4578HarPath = args.p4578Har ? path.resolve(args.p4578Har) : path.resolve(DEFAULT_P4578_HAR);
  const manualOddsStore = loadManualOddsStore(args.manualOddsFile);
  const emitProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  const result = {
    generatedAt: new Date().toISOString(),
    sources: {},
  };

  if (!args.source || args.source === "tipsport") {
    if (TIPSPORT_MUTED) {
      result.sources.tipsport = {
        muted: true,
        matches: [],
        warning: "Tipsport odds are temporarily muted.",
      };
    } else {
      try {
        result.sources.tipsport = await fetchTipsportOdds(tipsportHarPath, tipsportDetectorPath, args);
      } catch (e) {
        result.sources.tipsport = { error: e.message, matches: [] };
        console.error(`[tipsport] ${e.message}`);
      }
    }
  }

  if (!args.source || args.source === "p4578") {
    try {
      result.sources.p4578 = await fetchP4578Data(p4578HarPath, args, {
        onProgress(partialSource) {
          result.generatedAt = new Date().toISOString();
          result.sources.p4578 = partialSource;
          if (emitProgress) {
            emitProgress(buildProgressSnapshot(result, manualOddsStore));
          }
        },
      });
    } catch (e) {
      result.sources.p4578 = { error: e.message, matches: [], leagues: [] };
      console.error(`[p4578] ${e.message}`);
    }
  }

  result.generatedAt = new Date().toISOString();
  result.providerFeed = buildProviderFeed(result, { manualOddsStore });
  result.manualOdds = manualOddsStore;
  return result;
}

function buildProgressSnapshot(result, manualOddsStore) {
  return {
    generatedAt: result.generatedAt,
    sources: {
      ...result.sources,
    },
    manualOdds: manualOddsStore,
  };
}

async function fetchTipsportOdds(harPath, detectorPath, args) {
  const har = readHar(harPath);
  const detectorExport = readOptionalJsonArray(detectorPath);
  const offerEntry = findEntry(har, (entry) =>
    entry.request.method === "POST" &&
    entry.request.url.includes("/rest/offer/v2/offer")
  );
  const bootstrapPlan = buildTipsportBootstrapPlan(har, detectorExport);

  if (!offerEntry) {
    throw new Error(`Tipsport offer request was not found in HAR: ${harPath}`);
  }

  const offerUrl = new URL(offerEntry.request.url);
  if (Number.isFinite(args.tipsportLimit)) {
    offerUrl.searchParams.set("limit", String(args.tipsportLimit));
  }

  const body = JSON.parse(offerEntry.request.postData?.text || "{}");
  if (Number.isFinite(args.tipsportLimit)) {
    body.limit = args.tipsportLimit;
  }

  const harPayload = parseHarJsonResponse(offerEntry);
  if (!args.tipsportLive) {
    if (!harPayload) {
      throw new Error(`Tipsport HAR response payload is missing or invalid: ${harPath}`);
    }

    const matches = normalizeTipsport(harPayload);
    return {
      request: {
        url: offerUrl.toString(),
        method: "POST",
        body,
      },
      detectorPath: detectorExport ? detectorPath : null,
      startupSequence: bootstrapPlan.map(describeTipsportStep),
      live: false,
      warning: "Tipsport is running in HAR-only mode. Use --tipsport-live to try a live replay.",
      matchCount: matches.length,
      matches,
    };
  }

  const jar = createCookieJar();
  const requestLog = [];
  let offerResponse = null;

  for (const step of bootstrapPlan) {
    const headers = buildHeaders(step.entry?.request?.headers, step.headers || {});
    const finalUrl = step.kind === "offer" ? offerUrl.toString() : step.url;
    const finalBody = step.kind === "offer"
      ? JSON.stringify(body)
      : step.body != null
        ? JSON.stringify(step.body)
        : undefined;

    const response = await fetchWithCookies(finalUrl, {
      method: step.method,
      headers,
      body: finalBody,
    }, jar);

    requestLog.push({
      kind: step.kind,
      url: finalUrl,
      method: step.method,
      status: response.status,
      ok: response.ok,
    });

    if (step.kind === "offer") {
      offerResponse = response;
    }

    if (step.kind === "offer" && !response.ok) {
      break;
    }
  }

  if (!offerResponse || !offerResponse.ok) {
    const lastStatus = offerResponse ? `${offerResponse.status} ${offerResponse.statusText}` : "request not sent";
    if (offerResponse?.status === 403 && harPayload) {
      const matches = normalizeTipsport(harPayload);
      return {
        request: {
          url: offerUrl.toString(),
          method: "POST",
          body,
        },
        detectorPath: detectorExport ? detectorPath : null,
        startupSequence: bootstrapPlan.map(describeTipsportStep),
        attemptedRequests: requestLog,
        live: false,
        warning:
          "Live Tipsport bootstrap returned 403 Forbidden, so this result was extracted from the HAR capture instead.",
        matchCount: matches.length,
        matches,
      };
    }

    throw new Error(`Tipsport request failed after bootstrap: ${lastStatus}`);
  }

  const payload = await offerResponse.json();
  const matches = normalizeTipsport(payload);

  return {
    request: {
      url: offerUrl.toString(),
      method: "POST",
      body,
    },
    detectorPath: detectorExport ? detectorPath : null,
    startupSequence: bootstrapPlan.map(describeTipsportStep),
    attemptedRequests: requestLog,
    live: true,
    matchCount: matches.length,
    matches,
  };
}

function buildTipsportBootstrapPlan(har, detectorExport) {
  const plan = [];
  const detectorSequence = findTipsportDetectorSequence(detectorExport);
  const preferredKinds = detectorSequence.length > 0
    ? detectorSequence
    : ["init-web", "sports", "page-info", "offer"];

  for (const kind of preferredKinds) {
    const step = buildTipsportStep(har, kind);
    if (step) {
      plan.push(step);
    }
  }

  if (!plan.some((step) => step.kind === "offer")) {
    const offerStep = buildTipsportStep(har, "offer");
    if (offerStep) {
      plan.push(offerStep);
    }
  }

  return dedupeTipsportSteps(plan);
}

function buildTipsportStep(har, kind) {
  if (kind === "referer-page") {
    const offerEntry = findEntry(har, (entry) =>
      entry.request.method === "POST" &&
      entry.request.url.includes("/rest/offer/v2/offer")
    );
    const referer = offerEntry?.request?.headers?.find((header) =>
      String(header.name || "").toLowerCase() === "referer"
    )?.value;
    if (!referer) {
      return null;
    }
    return {
      kind,
      method: "GET",
      url: referer,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      entry: null,
    };
  }

  const entry = findEntry(har, (candidate) => {
    if (kind === "init-web") {
      return candidate.request.method === "POST" && candidate.request.url.includes("/rest/common/v1/init-web");
    }
    if (kind === "sports") {
      return candidate.request.method === "GET" && candidate.request.url.includes("/rest/offer/v6/sports");
    }
    if (kind === "page-info") {
      return candidate.request.method === "GET" && candidate.request.url.includes("/rest/seo/v1/page-info");
    }
    if (kind === "offer") {
      return candidate.request.method === "POST" && candidate.request.url.includes("/rest/offer/v2/offer");
    }
    return false;
  });

  if (!entry) {
    return null;
  }

  return {
    kind,
    method: entry.request.method,
    url: entry.request.url,
    headers: defaultTipsportStepHeaders(kind),
    body: parseRequestJson(entry.request.postData?.text),
    entry,
  };
}

function defaultTipsportStepHeaders(kind) {
  if (kind === "init-web" || kind === "offer") {
    return {
      accept: "application/json",
      "content-type": "application/json;charset=utf-8",
    };
  }

  return {
    accept: "application/json",
  };
}

function findTipsportDetectorSequence(detectorExport) {
  if (!Array.isArray(detectorExport)) {
    return [];
  }

  const relevant = detectorExport
    .filter((item) => String(item?.url || "").includes("tipsport.cz/rest/"))
    .sort((a, b) => Number(a?.time || 0) - Number(b?.time || 0));

  const sequence = [];
  for (const item of relevant) {
    const url = String(item.url || "");
    if (url.includes("/rest/common/v1/init-web")) {
      sequence.push("referer-page", "init-web");
    } else if (url.includes("/rest/offer/v6/sports")) {
      sequence.push("sports");
    } else if (url.includes("/rest/seo/v1/page-info")) {
      sequence.push("page-info");
    } else if (url.includes("/rest/offer/v2/offer")) {
      sequence.push("offer");
    }
  }

  return dedupeArray(sequence);
}

function dedupeTipsportSteps(steps) {
  const seen = new Set();
  const out = [];

  for (const step of steps) {
    const key = `${step.kind}:${step.method}:${step.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(step);
  }

  return out;
}

function dedupeArray(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }

  return out;
}

function describeTipsportStep(step) {
  return {
    kind: step.kind,
    method: step.method,
    url: step.url,
  };
}

function parseRequestJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readOptionalJsonArray(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createCookieJar() {
  const store = new Map();

  return {
    addSetCookie(headers) {
      const values = getSetCookieHeaders(headers);
      for (const raw of values) {
        const firstPart = String(raw || "").split(";")[0];
        const eqIndex = firstPart.indexOf("=");
        if (eqIndex <= 0) {
          continue;
        }

        const name = firstPart.slice(0, eqIndex).trim();
        const value = firstPart.slice(eqIndex + 1).trim();
        if (name) {
          store.set(name, value);
        }
      }
    },
    toHeader() {
      return [...store.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}

function getSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = headers.get?.("set-cookie");
  if (!combined) {
    return [];
  }

  return combined.split(/,(?=[^;]+?=)/);
}

async function fetchWithCookies(url, options, jar) {
  const headers = { ...(options.headers || {}) };
  const cookieHeader = jar.toHeader();
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });
  jar.addSetCookie(response.headers);
  return response;
}

async function fetchP4578Data(harPath, args, options = {}) {
  const bootstrap = getP4578BootstrapContext(harPath, args);
  const discoveryHeaders = bootstrap.headers;
  const sportId =
    Number.isFinite(args.p4578SportId)
      ? args.p4578SportId
      : Number(bootstrap.leaguesUrl.searchParams.get("sportId")) || 29;

  bootstrap.leaguesUrl.searchParams.set("sportId", String(sportId));
  bootstrap.leaguesUrl.searchParams.set("_", String(Date.now()));
  bootstrap.periodsUrl.searchParams.set("_", String(Date.now()));

  const leaguesResponse = await fetchWithRetry(bootstrap.leaguesUrl, { headers: discoveryHeaders });
  if (!leaguesResponse.ok) {
    throw new Error(`p4578 leagues request failed: ${leaguesResponse.status} ${leaguesResponse.statusText}`);
  }

  let periods = [];
  let periodsWarning = null;
  try {
    const periodsResponse = await fetchWithRetry(bootstrap.periodsUrl, { headers: discoveryHeaders });
    if (!periodsResponse.ok) {
      throw new Error(`${periodsResponse.status} ${periodsResponse.statusText}`);
    }
    periods = await periodsResponse.json();
  } catch (error) {
    periodsWarning = `p4578 odds/periods request failed: ${error.message}`;
  }

  const leagues = await leaguesResponse.json();

  const leagueList = Array.isArray(leagues) ? leagues : [];
  const selectedLeagueCode =
    args.p4578LeagueCode || leagueList.find((league) => league?.leagueCode)?.leagueCode || null;
  const shouldFetchLeagueEvents = Boolean(args.p4578FetchEvents || args.p4578LeagueCode);
  const leagueTargets = shouldFetchLeagueEvents
    ? pickP4578LeagueTargets(leagueList, args)
    : [];

  const result = {
    request: {
      bootstrap: bootstrap.kind,
      leaguesUrl: bootstrap.leaguesUrl.toString(),
      periodsUrl: bootstrap.periodsUrl.toString(),
    },
    sportId,
    leagueCount: leagueList.length,
    leagues: leagueList,
    periods,
  };
  if (periodsWarning) {
    result.warning = periodsWarning;
  }

  if (leagueTargets.length > 0) {
    const fetchedLeagueResults = [];
    const failedLeagueResults = [];
    const chunkSize = Number.isFinite(args.p4578ChunkSize) && args.p4578ChunkSize > 0
      ? args.p4578ChunkSize
      : DEFAULT_P4578_CHUNK_SIZE;

    for (let index = 0; index < leagueTargets.length; index += 1) {
      const league = leagueTargets[index];
      const leagueOddsUrl = buildP4578LeagueOddsUrl({
        baseUrl: bootstrap.baseUrl,
        sportId,
        leagueCode: league.leagueCode,
      });
      try {
        const leagueOddsResponse = await fetchWithRetry(leagueOddsUrl, {
          headers: discoveryHeaders,
        });
        if (!leagueOddsResponse.ok) {
          throw new Error(`${leagueOddsResponse.status} ${leagueOddsResponse.statusText}`);
        }

        const leagueOdds = await leagueOddsResponse.json();
        if (fetchedLeagueResults.length === 0) {
          // Log top-level keys of the first league response for debugging
          const keys = leagueOdds && typeof leagueOdds === "object" ? Object.keys(leagueOdds) : ["(not an object)"];
          console.error(`[p4578] first league response top-level keys: ${keys.join(", ")}`);
        }
        const leagueContext = {
          source: "p4578",
          sportId,
          leagueCode: league.leagueCode,
          leagueName: league.name || league.englishName || league.leagueCode,
        };
        const rawLeagueEvents = findEventsArray(leagueOdds);
        const leagueEnrichment = await enrichP4578EventsWithEventOdds(rawLeagueEvents, leagueContext, {
          baseUrl: bootstrap.baseUrl,
          headers: discoveryHeaders,
          har: bootstrap.har || null,
        });
        const leagueMatches = leagueEnrichment.matches;

        fetchedLeagueResults.push({
          leagueCode: league.leagueCode,
          leagueName: league.name || league.englishName || league.leagueCode,
          requestUrl: leagueOddsUrl,
          eventRequestUrls: leagueEnrichment.requestUrls,
          eventFetchFailures: leagueEnrichment.failures,
          matchCount: leagueMatches.length,
          matches: leagueMatches,
          raw: leagueOdds,
        });
      } catch (error) {
        failedLeagueResults.push({
          leagueCode: league.leagueCode,
          leagueName: league.name || league.englishName || league.leagueCode,
          error: error.message || String(error),
        });
      }

      updateP4578LeagueAggregation(result, fetchedLeagueResults, failedLeagueResults, selectedLeagueCode, {
        complete: false,
        totalLeagueTargetCount: leagueTargets.length,
        chunkSize,
      });
      if ((index + 1) % chunkSize === 0 || index === leagueTargets.length - 1) {
        options.onProgress?.(cloneJsonCompatible(result));
      }

      await sleep(350);
    }

    updateP4578LeagueAggregation(result, fetchedLeagueResults, failedLeagueResults, selectedLeagueCode, {
      complete: true,
      totalLeagueTargetCount: leagueTargets.length,
      chunkSize,
    });
  }

  if (Number.isFinite(args.p4578EventId)) {
    const eventOddsUrl = buildP4578EventOddsUrl({
      baseUrl: bootstrap.baseUrl,
      eventId: args.p4578EventId,
    });
    const eventOddsResponse = await fetchWithRetry(eventOddsUrl, { headers: discoveryHeaders });
    if (!eventOddsResponse.ok) {
      throw new Error(
        `p4578 event odds request failed: ${eventOddsResponse.status} ${eventOddsResponse.statusText}`
      );
    }

    result.request.eventOddsUrl = eventOddsUrl;
    result.eventId = args.p4578EventId;
    result.eventOdds = await eventOddsResponse.json();
    const eventMatch = normalizeP4578EventOddsPayload(result.eventOdds, {
      source: "p4578",
      sportId,
      leagueCode: selectedLeagueCode,
    });
    const eventMatches = eventMatch ? [eventMatch] : normalizeLeagueOdds(result.eventOdds, {
      source: "p4578",
      sportId,
      leagueCode: selectedLeagueCode,
    });
    result.event = eventMatches[0] ?? null;
  }

  return result;
}

function normalizeLeagueOdds(payload, context) {
  const events = findEventsArray(payload);
  return dedupeByEventId(events.map((ev) => normalizeEvent(ev, context)));
}

function normalizeP4578EventOddsPayload(payload, context, baseEvent = null) {
  const eventRecord = buildP4578EventRecord(payload, baseEvent);
  if (!eventRecord) {
    return null;
  }

  const info = payload && typeof payload === "object" ? payload.info : null;
  return normalizeEvent(eventRecord, {
    ...context,
    leagueCode: context?.leagueCode ?? info?.leagueCode ?? null,
    leagueName: context?.leagueName ?? info?.leagueName ?? null,
    sportId: context?.sportId ?? info?.sportId ?? null,
  });
}

function buildP4578EventRecord(payload, baseEvent = null) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const normal = payload.normal;
  const sourceEvent = isEventLike(baseEvent)
    ? baseEvent
    : (isEventLike(normal) ? normal : null);
  if (!sourceEvent) {
    return null;
  }

  const mergedPeriods = mergeP4578Periods(baseEvent?.periods, normal?.periods);

  return {
    ...sourceEvent,
    ...(isEventLike(normal) ? normal : {}),
    periods: mergedPeriods,
    specials: Array.isArray(payload.specials) ? payload.specials : (Array.isArray(normal?.specials) ? normal.specials : []),
    corners: payload.corners && typeof payload.corners === "object" ? payload.corners : null,
  };
}

function mergeP4578Periods(basePeriods, overridePeriods) {
  const base = basePeriods && typeof basePeriods === "object" ? basePeriods : {};
  const override = overridePeriods && typeof overridePeriods === "object" ? overridePeriods : {};
  const merged = {};

  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const basePeriod = base[key];
    const overridePeriod = override[key];
    if (basePeriod && typeof basePeriod === "object" && overridePeriod && typeof overridePeriod === "object") {
      merged[key] = {
        ...basePeriod,
        ...overridePeriod,
      };
      continue;
    }

    merged[key] = overridePeriod ?? basePeriod;
  }

  return merged;
}

async function enrichP4578EventsWithEventOdds(events, context, options = {}) {
  const rawEvents = Array.isArray(events) ? events : [];
  if (!rawEvents.length) {
    return { matches: [], requestUrls: [], failures: [] };
  }

  const matches = [];
  const requestUrls = [];
  const failures = [];

  for (let index = 0; index < rawEvents.length; index += DEFAULT_P4578_EVENT_ENRICHMENT_CHUNK_SIZE) {
    const batch = rawEvents.slice(index, index + DEFAULT_P4578_EVENT_ENRICHMENT_CHUNK_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (event) => enrichP4578EventWithOdds(event, context, options))
    );

    for (const result of batchResults) {
      if (result.requestUrl) {
        requestUrls.push(result.requestUrl);
      }
      if (result.failure) {
        failures.push(result.failure);
      }
      if (result.match) {
        matches.push(result.match);
      }
    }
  }

  return {
    matches: dedupeByEventId(matches),
    requestUrls,
    failures,
  };
}

async function enrichP4578EventWithOdds(event, context, options = {}) {
  const fallbackMatch = normalizeEvent(event, context);
  const eventId = Number(event?.id ?? event?.eventId);
  const shouldFetchEventOdds = Number.isFinite(eventId) && Number(event?.moreBet) > 0;
  if (!shouldFetchEventOdds) {
    return {
      match: fallbackMatch,
      requestUrl: null,
      failure: null,
    };
  }

  const requestUrl = buildP4578EventOddsUrl({
    baseUrl: options.baseUrl,
    eventId,
  });

  try {
    const response = await fetchWithRetry(requestUrl, { headers: options.headers });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const match = normalizeP4578EventOddsPayload(payload, context, event) || fallbackMatch;
    return {
      match,
      requestUrl,
      failure: null,
    };
  } catch (error) {
    const harPayload = findP4578EventOddsInHar(options.har, eventId);
    if (harPayload) {
      const match = normalizeP4578EventOddsPayload(harPayload, context, event) || fallbackMatch;
      return {
        match,
        requestUrl,
        failure: {
          eventId,
          error: `live fetch failed; used HAR fallback (${error.message || String(error)})`,
        },
      };
    }

    return {
      match: fallbackMatch,
      requestUrl,
      failure: {
        eventId,
        error: error.message || String(error),
      },
    };
  }
}

// Find the events array wherever it lives in the payload.
// Handles: { events: [...] }, [...events], { leagues: [{ events: [...] }] }, etc.
function findEventsArray(payload) {
  if (!payload) return [];

  // Payload is already an events array
  if (Array.isArray(payload)) return payload.filter(isEventLike);

  if (typeof payload !== "object") return [];

  // Top-level .events key
  if (Array.isArray(payload.events)) return payload.events;

  // One level deep: each value is either an events array, an object with .events,
  // or an array of wrapper objects that each contain .events (e.g. payload.leagues[n].events)
  for (const val of Object.values(payload)) {
    if (Array.isArray(val)) {
      if (val.length > 0 && isEventLike(val[0])) return val;
      // Array of wrapper objects — look inside each for .events
      const allEvents = val.flatMap((item) =>
        item && typeof item === "object" && Array.isArray(item.events) ? item.events : []
      );
      if (allEvents.length > 0) return allEvents;
    } else if (val && typeof val === "object") {
      if (Array.isArray(val.events)) return val.events;
    }
  }

  return [];
}

function isEventLike(item) {
  return item != null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    (item.id != null || item.eventId != null) &&
    Array.isArray(item.participants);
}

function normalizeEvent(ev, context) {
  // Participants: type "HOME" / "AWAY"
  const participants = Array.isArray(ev.participants) ? ev.participants : [];
  const homeP = participants.find((p) => String(p.type || "").toUpperCase() === "HOME");
  const awayP = participants.find((p) => String(p.type || "").toUpperCase() === "AWAY");
  const homeName = homeP?.name ?? homeP?.englishName ?? null;
  const awayName = awayP?.name ?? awayP?.englishName ?? null;

  // 1X2 odds from period 0 moneyLine
  const period0 = ev.periods?.["0"] ?? {};
  const ml = period0.moneyLine ?? {};
  const odds = {};
  if (ml.homePrice != null && !ml.offline && !ml.unavailable) odds["1"] = Number(ml.homePrice);
  if (ml.drawPrice != null && !ml.offline && !ml.unavailable) odds["X"] = Number(ml.drawPrice);
  if (ml.awayPrice != null && !ml.offline && !ml.unavailable) odds["2"] = Number(ml.awayPrice);

  const totals25 = findOverUnderLine(period0, 2.5);
  const mainTotals = findMostBalancedOverUnderLine(period0);

  // Time: Pinnacle sends Unix ms timestamp in ev.time
  let startsAt = null;
  if (ev.time != null) {
    startsAt = new Date(ev.time).toISOString();
  } else if (ev.starts != null) {
    startsAt = ev.starts;
  }

  const match = {
    source: context.source,
    matchId: ev.id ?? ev.parentId ?? null,
    sportId: context.sportId,
    leagueCode: context.leagueCode ?? null,
    competition: context.leagueName ?? null,
    home: homeName,
    away: awayName,
    startsAt,
    odds,
    moneyLineSourceMarketId: ml.lineId ?? null,
    totals25,
    mainTotals,
    supplementalMarkets: extractP4578SupplementalMarkets(ev, homeName, awayName),
  };

  match.lambdas = computeLambdasFromModule(match);
  return match;
}

function extractP4578SupplementalMarkets(ev, homeName, awayName) {
  const markets = [];
  const periods = ev?.periods && typeof ev.periods === "object" ? ev.periods : {};

  pushMoneyLineMarket(markets, periods["1"], "1h");
  pushOverUnderMarkets(markets, periods["0"], "ft");
  pushOverUnderMarkets(markets, periods["1"], "1h");
  pushHandicapMarkets(markets, periods["0"], "ft", homeName, awayName);
  pushHandicapMarkets(markets, periods["1"], "1h", homeName, awayName);
  pushTeamTotalsMarkets(markets, periods["0"], "ft", homeName, awayName);
  pushTeamTotalsMarkets(markets, periods["1"], "1h", homeName, awayName);
  pushCornerMarkets(markets, ev?.corners, homeName, awayName);

  const specialEvents = Array.isArray(ev?.specials)
    ? ev.specials.flatMap((group) => Array.isArray(group?.events) ? group.events : [])
    : [];

  for (const special of specialEvents) {
    const name = normalizeMarketName(special?.name);
    if (!name) {
      continue;
    }

    const period = name.includes("1st half") ? "1h" : "ft";
    const contestants = Array.isArray(special?.contestants) ? special.contestants : [];

    if (name === "both teams to score?" || name === "both teams to score? 1st half") {
      const selections = [
        mapNamedSpecialSelection(contestants, "yes", "yes", "Yes"),
        mapNamedSpecialSelection(contestants, "no", "no", "No"),
      ].filter(Boolean);
      if (selections.length === 2) {
        markets.push(createSupplementalMarketRecord("both_teams_to_score", period, null, selections, special));
      }
      continue;
    }

    if (name === "double chance" || name === "double chance 1st half") {
      const homeOrDraw = contestants.find((item) => normalizeContestantName(item?.n) === `${normalizeContestantName(homeName)} or draw`);
      const drawOrAway = contestants.find((item) => normalizeContestantName(item?.n) === `draw or ${normalizeContestantName(awayName)}`);
      const homeOrAway = contestants.find((item) => normalizeContestantName(item?.n) === `${normalizeContestantName(homeName)} or ${normalizeContestantName(awayName)}`);
      const selections = [
        mapSpecialSelection(homeOrDraw, "home_draw", homeOrDraw?.n),
        mapSpecialSelection(homeOrAway, "home_away", homeOrAway?.n),
        mapSpecialSelection(drawOrAway, "draw_away", drawOrAway?.n),
      ].filter(Boolean);
      if (selections.length === 3) {
        markets.push(createSupplementalMarketRecord("double_chance", period, null, selections, special));
      }
      continue;
    }

    if (name === "draw no bet" || name === "draw no bet 1st half") {
      const homeSelection = contestants.find((item) => normalizeContestantName(item?.n) === normalizeContestantName(homeName));
      const awaySelection = contestants.find((item) => normalizeContestantName(item?.n) === normalizeContestantName(awayName));
      const selections = [
        mapSpecialSelection(homeSelection, "home", homeSelection?.n || homeName),
        mapSpecialSelection(awaySelection, "away", awaySelection?.n || awayName),
      ].filter(Boolean);
      if (selections.length === 2) {
        markets.push(createSupplementalMarketRecord("draw_no_bet", period, null, selections, special));
      }
      continue;
    }

    if (name === normalizeMarketName(`${homeName} to win to nil?`) || name === normalizeMarketName(`${homeName} to win to nil? 1st half`)) {
      const selections = [
        mapNamedSpecialSelection(contestants, "yes", "yes", "Yes"),
        mapNamedSpecialSelection(contestants, "no", "no", "No"),
      ].filter(Boolean);
      if (selections.length === 2) {
        markets.push(createSupplementalMarketRecord("team_to_win_to_nil", period, {
          team: "home",
          teamName: homeName,
        }, selections, special));
      }
      continue;
    }

    if (name === normalizeMarketName(`${awayName} to win to nil?`) || name === normalizeMarketName(`${awayName} to win to nil? 1st half`)) {
      const selections = [
        mapNamedSpecialSelection(contestants, "yes", "yes", "Yes"),
        mapNamedSpecialSelection(contestants, "no", "no", "No"),
      ].filter(Boolean);
      if (selections.length === 2) {
        markets.push(createSupplementalMarketRecord("team_to_win_to_nil", period, {
          team: "away",
          teamName: awayName,
        }, selections, special));
      }
      continue;
    }

    if (name === normalizeMarketName(`${homeName} goals`) || name === normalizeMarketName(`${homeName} goals 1st half`)) {
      const selections = contestants
        .map((item) => mapExactGoalsSelection(item))
        .filter(Boolean);
      if (selections.length) {
        markets.push(createSupplementalMarketRecord("team_goals_exact", period, {
          team: "home",
          teamName: homeName,
        }, selections, special));
      }
      continue;
    }

    if (name === normalizeMarketName(`${awayName} goals`) || name === normalizeMarketName(`${awayName} goals 1st half`)) {
      const selections = contestants
        .map((item) => mapExactGoalsSelection(item))
        .filter(Boolean);
      if (selections.length) {
        markets.push(createSupplementalMarketRecord("team_goals_exact", period, {
          team: "away",
          teamName: awayName,
        }, selections, special));
      }
      continue;
    }

    if (name === "exact total goals" || name === "exact total goals 1st half") {
      const selections = contestants
        .map((item) => mapExactGoalsSelection(item))
        .filter(Boolean);
      if (selections.length) {
        markets.push(createSupplementalMarketRecord("exact_total_goals", period, null, selections, special));
      }
      continue;
    }

    if (name === "first team to score" || name === "first team to score 1st half") {
      const homeContestant = contestants.find((item) => normalizeContestantName(item?.n) === normalizeContestantName(homeName));
      const awayContestant = contestants.find((item) => normalizeContestantName(item?.n) === normalizeContestantName(awayName));
      const neitherContestant = contestants.find((item) => normalizeContestantName(item?.n) === "neither");
      const selections = [
        mapSpecialSelection(homeContestant, "home", homeName),
        mapSpecialSelection(awayContestant, "away", awayName),
        mapSpecialSelection(neitherContestant, "no_goal", "No Goal"),
      ].filter(Boolean);
      if (selections.length === 3) {
        markets.push(createSupplementalMarketRecord("first_team_to_score", period, null, selections, special));
      }
      continue;
    }

    if (name === "both teams to score/winner" || name === "both teams to score/winner 1st half") {
      const find = (btts, team) =>
        contestants.find((item) => normalizeContestantName(item?.n) === `${btts} & ${normalizeContestantName(team)}`);
      const selections = [
        mapSpecialSelection(find("yes", homeName), "home_yes", `Yes & ${homeName}`),
        mapSpecialSelection(find("yes", "draw"), "draw_yes", "Yes & Draw"),
        mapSpecialSelection(find("yes", awayName), "away_yes", `Yes & ${awayName}`),
        mapSpecialSelection(find("no", homeName), "home_no", `No & ${homeName}`),
        mapSpecialSelection(find("no", "draw"), "draw_no", "No & Draw"),
        mapSpecialSelection(find("no", awayName), "away_no", `No & ${awayName}`),
      ].filter(Boolean);
      if (selections.length === 6) {
        markets.push(createSupplementalMarketRecord("match_result_and_btts", period, null, selections, special));
      }
    }
  }

  return markets;
}

function pushCornerMarkets(markets, cornersEvent, homeName, awayName) {
  if (!cornersEvent || typeof cornersEvent !== "object") {
    return;
  }

  const periods = cornersEvent?.periods && typeof cornersEvent.periods === "object" ? cornersEvent.periods : {};
  pushCornerOverUnderMarkets(markets, periods["0"], "ft");
  pushCornerOverUnderMarkets(markets, periods["1"], "1h");
  pushCornerTeamTotalsMarkets(markets, periods["0"], "ft", homeName, awayName);
  pushCornerTeamTotalsMarkets(markets, periods["1"], "1h", homeName, awayName);
}

function pushMoneyLineMarket(markets, period, marketPeriod) {
  const moneyLine = mapMoneyLineMarket(period?.moneyLine, marketPeriod);
  if (moneyLine) {
    markets.push(moneyLine);
  }
}

function mapMoneyLineMarket(moneyLine, period) {
  if (!isUsableMoneyLine(moneyLine)) {
    return null;
  }

  return {
    type: "match_winner",
    period,
    specifier: null,
    sourceMarketId: moneyLine?.lineId ?? null,
    selections: [
      {
        id: "home",
        name: "Home",
        odds: Number(moneyLine.homePrice),
        sourceSelectionId: `${moneyLine?.lineId ?? "moneyline"}:home`,
      },
      {
        id: "draw",
        name: "Draw",
        odds: Number(moneyLine.drawPrice),
        sourceSelectionId: `${moneyLine?.lineId ?? "moneyline"}:draw`,
      },
      {
        id: "away",
        name: "Away",
        odds: Number(moneyLine.awayPrice),
        sourceSelectionId: `${moneyLine?.lineId ?? "moneyline"}:away`,
      },
    ],
  };
}

function isUsableMoneyLine(moneyLine) {
  return Boolean(
    moneyLine &&
    !moneyLine.offline &&
    !moneyLine.unavailable &&
    Number.isFinite(Number(moneyLine.homePrice)) &&
    Number.isFinite(Number(moneyLine.drawPrice)) &&
    Number.isFinite(Number(moneyLine.awayPrice))
  );
}

function pushOverUnderMarkets(markets, period, marketPeriod) {
  if (!period || typeof period !== "object") {
    return;
  }

  const lines = Array.isArray(period?.overUnder) ? period.overUnder : [];
  for (const line of lines) {
    const mapped = mapOverUnderMarketLine(line, marketPeriod);
    if (mapped) {
      markets.push(mapped);
    }
  }
}

function mapOverUnderMarketLine(line, period) {
  if (!isUsableOverUnderLine(line)) {
    return null;
  }

  const points = normalizeLinePoints(line?.points);
  if (points == null) {
    return null;
  }

  return {
    type: "total_goals",
    period,
    specifier: {
      points,
      label: formatPointsLabel(points),
    },
    sourceMarketId: line?.lineId ?? null,
    selections: [
      {
        id: "over",
        name: `Over ${formatPointsLabel(points)}`,
        odds: Number(line.overOdds),
        sourceSelectionId: `${line?.lineId ?? "total-goals"}:over`,
      },
      {
        id: "under",
        name: `Under ${formatPointsLabel(points)}`,
        odds: Number(line.underOdds),
        sourceSelectionId: `${line?.lineId ?? "total-goals"}:under`,
      },
    ],
  };
}

function pushCornerOverUnderMarkets(markets, period, marketPeriod) {
  if (!period || typeof period !== "object") {
    return;
  }

  const lines = Array.isArray(period?.overUnder) ? period.overUnder : [];
  for (const line of lines) {
    const mapped = mapCornerOverUnderMarketLine(line, marketPeriod);
    if (mapped) {
      markets.push(mapped);
    }
  }
}

function mapCornerOverUnderMarketLine(line, period) {
  if (!isUsableOverUnderLine(line)) {
    return null;
  }

  const points = normalizeLinePoints(line?.points);
  if (points == null) {
    return null;
  }

  return {
    type: "total_corners",
    period,
    specifier: {
      points,
      label: formatPointsLabel(points),
    },
    sourceMarketId: line?.lineId ?? null,
    selections: [
      {
        id: "over",
        name: `Over ${formatPointsLabel(points)}`,
        odds: Number(line.overOdds),
        sourceSelectionId: `${line?.lineId ?? "total-corners"}:over`,
      },
      {
        id: "under",
        name: `Under ${formatPointsLabel(points)}`,
        odds: Number(line.underOdds),
        sourceSelectionId: `${line?.lineId ?? "total-corners"}:under`,
      },
    ],
  };
}

function pushHandicapMarkets(markets, period, marketPeriod, homeName, awayName) {
  if (!period || typeof period !== "object") {
    return;
  }

  const lines = Array.isArray(period?.handicap) ? period.handicap : [];
  for (const line of lines) {
    const mapped = mapHandicapLine(line, marketPeriod, homeName, awayName);
    if (mapped) {
      markets.push(mapped);
    }
  }
}

function mapHandicapLine(line, period, homeName, awayName) {
  if (!isUsableHandicapLine(line)) {
    return null;
  }

  const homeSpread = normalizeLinePoints(line?.homeSpread);
  const awaySpread = normalizeLinePoints(line?.awaySpread);
  if (homeSpread == null || awaySpread == null) {
    return null;
  }

  if (homeSpread === 0 && awaySpread === 0) {
    return {
      type: "draw_no_bet",
      period,
      specifier: null,
      sourceMarketId: line?.lineId ?? null,
      selections: [
        {
          id: "home",
          name: homeName || "Home",
          odds: Number(line.homeOdds),
          sourceSelectionId: `${line?.lineId ?? "handicap"}:home`,
        },
        {
          id: "away",
          name: awayName || "Away",
          odds: Number(line.awayOdds),
          sourceSelectionId: `${line?.lineId ?? "handicap"}:away`,
        },
      ],
    };
  }

  if (!(homeSpread === -1.5 && awaySpread === 1.5)) {
    return null;
  }

  return {
    type: "asian_handicap",
    period,
    specifier: {
      points: homeSpread,
      label: formatSignedPointsLabel(homeSpread),
      homeSpread,
      awaySpread,
      homeLabel: formatSignedPointsLabel(homeSpread),
      awayLabel: formatSignedPointsLabel(awaySpread),
    },
    sourceMarketId: line?.lineId ?? null,
    selections: [
      {
        id: "home",
        name: `${homeName || "Home"} ${formatSignedPointsLabel(homeSpread)}`,
        odds: Number(line.homeOdds),
        sourceSelectionId: `${line?.lineId ?? "handicap"}:home`,
      },
      {
        id: "away",
        name: `${awayName || "Away"} ${formatSignedPointsLabel(awaySpread)}`,
        odds: Number(line.awayOdds),
        sourceSelectionId: `${line?.lineId ?? "handicap"}:away`,
      },
    ],
  };
}

function isUsableHandicapLine(line) {
  return Boolean(
    line &&
    !line.offline &&
    !line.unavailable &&
    Number.isFinite(Number(line.homeOdds)) &&
    Number.isFinite(Number(line.awayOdds)) &&
    normalizeLinePoints(line.homeSpread) !== null &&
    normalizeLinePoints(line.awaySpread) !== null
  );
}

function pushTeamTotalsMarkets(markets, period, marketPeriod, homeName, awayName) {
  if (!period || typeof period !== "object") {
    return;
  }

  const homeLines = Array.isArray(period?.teamTotals?.homeLines) ? period.teamTotals.homeLines : [];
  const awayLines = Array.isArray(period?.teamTotals?.awayLines) ? period.teamTotals.awayLines : [];

  for (const line of homeLines) {
    const mapped = mapTeamTotalLine(line, "home", homeName, marketPeriod);
    if (mapped) {
      markets.push(mapped);
    }
  }

  for (const line of awayLines) {
    const mapped = mapTeamTotalLine(line, "away", awayName, marketPeriod);
    if (mapped) {
      markets.push(mapped);
    }
  }
}

function mapTeamTotalLine(line, team, teamName, period) {
  if (!isUsableOverUnderLine(line)) {
    return null;
  }

  const points = normalizeLinePoints(line?.points);
  if (points == null) {
    return null;
  }

  return {
    type: "team_total_goals",
    period,
    specifier: {
      team,
      teamName,
      points,
      label: formatPointsLabel(points),
    },
    sourceMarketId: line?.lineId ?? null,
    selections: [
      {
        id: "over",
        name: `Over ${formatPointsLabel(points)}`,
        odds: Number(line.overOdds),
        sourceSelectionId: `${line?.lineId ?? "team-total"}:over`,
      },
      {
        id: "under",
        name: `Under ${formatPointsLabel(points)}`,
        odds: Number(line.underOdds),
        sourceSelectionId: `${line?.lineId ?? "team-total"}:under`,
      },
    ],
  };
}

function pushCornerTeamTotalsMarkets(markets, period, marketPeriod, homeName, awayName) {
  if (!period || typeof period !== "object") {
    return;
  }

  const homeLines = Array.isArray(period?.teamTotals?.homeLines) ? period.teamTotals.homeLines : [];
  const awayLines = Array.isArray(period?.teamTotals?.awayLines) ? period.teamTotals.awayLines : [];

  for (const line of homeLines) {
    const mapped = mapCornerTeamTotalLine(line, "home", homeName, marketPeriod);
    if (mapped) {
      markets.push(mapped);
    }
  }

  for (const line of awayLines) {
    const mapped = mapCornerTeamTotalLine(line, "away", awayName, marketPeriod);
    if (mapped) {
      markets.push(mapped);
    }
  }
}

function mapCornerTeamTotalLine(line, team, teamName, period) {
  if (!isUsableOverUnderLine(line)) {
    return null;
  }

  const points = normalizeLinePoints(line?.points);
  if (points == null) {
    return null;
  }

  return {
    type: "team_total_corners",
    period,
    specifier: {
      team,
      teamName,
      points,
      label: formatPointsLabel(points),
    },
    sourceMarketId: line?.lineId ?? null,
    selections: [
      {
        id: "over",
        name: `Over ${formatPointsLabel(points)}`,
        odds: Number(line.overOdds),
        sourceSelectionId: `${line?.lineId ?? "team-total-corners"}:over`,
      },
      {
        id: "under",
        name: `Under ${formatPointsLabel(points)}`,
        odds: Number(line.underOdds),
        sourceSelectionId: `${line?.lineId ?? "team-total-corners"}:under`,
      },
    ],
  };
}

function createSupplementalMarketRecord(type, period, specifier, selections, sourceEvent) {
  return {
    type,
    period,
    specifier,
    sourceMarketId: sourceEvent?.id ?? null,
    selections,
  };
}

function mapSpecialSelection(contestant, id, fallbackName) {
  const odds = Number(contestant?.p);
  if (!Number.isFinite(odds) || odds <= 1) {
    return null;
  }

  return {
    id,
    name: contestant?.n || fallbackName || id,
    odds,
    sourceSelectionId: contestant?.i ?? contestant?.l ?? null,
  };
}

function mapNamedSpecialSelection(contestants, lookupName, id, fallbackName) {
  const contestant = Array.isArray(contestants)
    ? contestants.find((item) => normalizeContestantName(item?.n) === normalizeContestantName(lookupName))
    : null;
  return mapSpecialSelection(contestant, id, fallbackName);
}

function mapExactGoalsSelection(contestant) {
  const label = String(contestant?.n || "").trim();
  if (!label) {
    return null;
  }

  const normalizedId = label.replace(/\s+/g, "").replace(/\+/g, "plus");
  return mapSpecialSelection(contestant, normalizedId, label);
}

function normalizeMarketName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeContestantName(value) {
  return String(value || "").trim().toLowerCase();
}

function findOverUnderLine(period, targetPoints) {
  const lines = Array.isArray(period?.overUnder) ? period.overUnder : [];
  const target = normalizeLinePoints(targetPoints);
  const line = lines.find((entry) => normalizeLinePoints(entry?.points) === target && isUsableOverUnderLine(entry));
  return line ? mapOverUnderLine(line, "exact") : null;
}

function findMostBalancedOverUnderLine(period) {
  const lines = Array.isArray(period?.overUnder) ? period.overUnder : [];
  const usableLines = lines.filter(isUsableOverUnderLine);
  if (usableLines.length === 0) {
    return null;
  }

  const preferredIndex = Number(period?.indexMainLineOU);
  if (Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < lines.length) {
    const preferredLine = lines[preferredIndex];
    if (isUsableOverUnderLine(preferredLine)) {
      return mapOverUnderLine(preferredLine, "indexMainLineOU");
    }
  }

  const balancedLine = usableLines
    .map((line) => ({
      line,
      delta: Math.abs(Number(line.overOdds) - Number(line.underOdds)),
      margin: Math.abs((1 / Number(line.overOdds)) + (1 / Number(line.underOdds)) - 1),
    }))
    .sort((a, b) => a.delta - b.delta || a.margin - b.margin)[0]?.line;

  return balancedLine ? mapOverUnderLine(balancedLine, "closestOdds") : null;
}

function isUsableOverUnderLine(line) {
  return Boolean(
    line &&
    !line.offline &&
    !line.unavailable &&
    Number.isFinite(Number(line.overOdds)) &&
    Number.isFinite(Number(line.underOdds)) &&
    normalizeLinePoints(line.points) !== null
  );
}

function normalizeLinePoints(value) {
  const points = Number(value);
  return Number.isFinite(points) ? points : null;
}

function mapOverUnderLine(line, selection) {
  const points = normalizeLinePoints(line?.points);
  if (points == null) {
    return null;
  }

  return {
    lineId: line.lineId ?? null,
    points,
    label: formatPointsLabel(points),
    over: Number(line.overOdds),
    under: Number(line.underOdds),
    selection,
  };
}

function formatPointsLabel(points) {
  return Number.isInteger(points) ? String(points) : String(points);
}

function formatSignedPointsLabel(points) {
  if (!Number.isFinite(points)) {
    return "";
  }

  if (points > 0) {
    return `+${formatPointsLabel(points)}`;
  }

  return formatPointsLabel(points);
}

// ---------------------------------------------------------------------------
// Poisson lambda estimation from 1x2 (Shin-deviggged) + total goals market
// ---------------------------------------------------------------------------

/**
 * Shin (1993) method: find fair probabilities for a 1x2 market.
 *
 * Formula: p_i = (sqrt(z^2 + 4*(1-z)*(q_i^2/D)) - z) / (2*(1-z))
 * where q_i = 1/o_i, D = sum(q_i), and z is the insider fraction.
 * z is found via binary search such that sum(p_i) = 1.
 *
 * At z=0: sum(p_i) = sqrt(D) > 1 (since D > 1 for a vigged market).
 * As z → 1: sum(p_i) → 0. So exactly one root exists in (0, 1).
 */
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
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const probSum = shinProbs(mid).reduce((a, b) => a + b, 0);
    // sum > 1 means z is too low → push lo up to increase z
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

/**
 * Poisson PMF computed in log-space to avoid factorial overflow.
 */
function poissonPMF(k, lambda) {
  if (k < 0 || !Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
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

/**
 * Independent Poisson 1x2 probabilities for given home/away goal rates.
 */
function computePoissonMatchProbs(lambdaHome, lambdaAway) {
  if (
    !Number.isFinite(lambdaHome) ||
    !Number.isFinite(lambdaAway) ||
    lambdaHome < 0 ||
    lambdaAway < 0
  ) {
    return null;
  }

  const homePMF = buildPoissonPMF(lambdaHome);
  const awayPMF = buildPoissonPMF(lambdaAway);
  const maxGoals = Math.max(homePMF.length, awayPMF.length) - 1;

  let home = 0;
  let draw = 0;
  const awayCDF = [];
  let runningAway = 0;

  for (let a = 0; a <= maxGoals; a += 1) {
    runningAway += awayPMF[a] ?? 0;
    awayCDF[a] = runningAway;
  }

  for (let h = 0; h <= maxGoals; h += 1) {
    const pHome = homePMF[h] ?? 0;
    const pAwaySame = awayPMF[h] ?? 0;
    draw += pHome * pAwaySame;
    if (h > 0) {
      home += pHome * (awayCDF[h - 1] ?? 0);
    }
  }

  const away = Math.max(0, 1 - home - draw);
  const total = home + draw + away;
  return total > 0
    ? { home: home / total, draw: draw / total, away: away / total }
    : null;
}

function poissonCDF(k, lambda) {
  if (k < 0) return 0;
  const pmf = buildPoissonPMF(lambda);
  const limit = Math.min(k, pmf.length - 1);
  let cdf = 0;
  for (let i = 0; i <= limit; i += 1) {
    cdf += pmf[i];
  }
  return cdf;
}

function totalGoalsOverProbability(points, lambda) {
  if (!Number.isFinite(points) || !Number.isFinite(lambda) || lambda < 0) {
    return null;
  }

  const frac = points - Math.floor(points);
  const base = Math.floor(points);

  if (Math.abs(frac - 0) < 1e-9) {
    return 1 - poissonCDF(base, lambda);
  }

  if (Math.abs(frac - 0.5) < 1e-9) {
    return 1 - poissonCDF(base, lambda);
  }

  if (Math.abs(frac - 0.25) < 1e-9) {
    return 0.5 * ((1 - poissonCDF(base, lambda)) + (1 - poissonCDF(base - 1, lambda)));
  }

  if (Math.abs(frac - 0.75) < 1e-9) {
    return 0.5 * ((1 - poissonCDF(base, lambda)) + (1 - poissonCDF(base + 1, lambda)));
  }

  return 1 - poissonCDF(Math.floor(points), lambda);
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

function asianTotalPricingMoments(points, side, lambda) {
  if (!Number.isFinite(points) || !Number.isFinite(lambda) || lambda < 0) {
    return null;
  }

  const totalPMF = buildPoissonPMF(lambda);
  const components = splitAsianTotalLine(points);
  let expectedWinFraction = 0;
  let expectedRefundFraction = 0;

  for (let goals = 0; goals < totalPMF.length; goals += 1) {
    const goalProb = totalPMF[goals] ?? 0;
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

function asianTotalImpliedProbability(points, side, lambda) {
  const moments = asianTotalPricingMoments(points, side, lambda);
  if (!moments) {
    return null;
  }

  const losingFraction = 1 - moments.refund;
  if (!(losingFraction > 0) || moments.win < 0) {
    return null;
  }

  return moments.win / losingFraction;
}

function totalGoalsMarketShare(points, lambda) {
  const qOver = asianTotalImpliedProbability(points, "over", lambda);
  const qUnder = asianTotalImpliedProbability(points, "under", lambda);
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

/**
 * Devig over/under with proportional normalization, then invert the Poisson CDF
 * to find lambda (total expected goals) such that P(X >= floor(points)+1) = p_over.
 */
function estimateTotalLambda(totalsLine) {
  if (!totalsLine) return null;
  const { points, over, under } = totalsLine;
  if (!Number.isFinite(points) || !Number.isFinite(over) || !Number.isFinite(under)) return null;

  const qOver = 1 / over;
  const qUnder = 1 / under;
  const pOver = qOver / (qOver + qUnder); // fair P(over) — 2-way proportional devig

  // P(X >= threshold) = 1 − CDF(threshold − 1)
  const threshold = Math.floor(points) + 1;

  let lo = 0.01;
  let hi = 20;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    let cdf = 0;
    for (let k = 0; k < threshold; k++) cdf += poissonPMF(k, mid);
    // P(over | mid) > pOver means lambda is too high → lower hi
    if (1 - cdf > pOver) hi = mid;
    else lo = mid;
  }

  return (lo + hi) / 2;
}

/**
 * Derive Poisson goal-scoring rates (lambdaHome, lambdaAway) from a match record.
 *
 * Steps:
 *   1. Shin-devig 1x2 odds to get fair win/draw/loss probabilities.
 *   2. Invert the total goals over/under line to get mu = lambdaHome + lambdaAway.
 *   3. Binary-search lambdaHome in (0, mu) so that the independent-Poisson
 *      P(home win) − P(away win) matches the Shin difference.
 *
 * Returns null when any required market is missing or degenerate.
 */
function computeLambdas(match) {
  const { odds, mainTotals, totals25 } = match;
  if (!odds || !odds["1"] || !odds["X"] || !odds["2"]) return null;

  const shin = computeShinProbabilities(odds);
  if (!shin) return null;

  const totalsLine = mainTotals || totals25;
  const mu = estimateTotalLambda(totalsLine);
  if (!mu || mu <= 0) return null;

  // Binary search on lambdaHome: match P_home − P_away from Shin
  const shinDiff = shin.home - shin.away;
  let lo = 0.01;
  let hi = mu - 0.01;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const poisson = computePoissonMatchProbs(mid, mu - mid);
    if (poisson.home - poisson.away < shinDiff) lo = mid;
    else hi = mid;
  }

  const lambdaHome = (lo + hi) / 2;
  const lambdaAway = mu - lambdaHome;

  return {
    lambdaHome: Math.round(lambdaHome * 1000) / 1000,
    lambdaAway: Math.round(lambdaAway * 1000) / 1000,
    mu: Math.round(mu * 1000) / 1000,
    shinProbs: {
      home: Math.round(shin.home * 10000) / 10000,
      draw: Math.round(shin.draw * 10000) / 10000,
      away: Math.round(shin.away * 10000) / 10000,
    },
    shinZ: Math.round(shin.shinZ * 10000) / 10000,
  };
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

function normalizeTipsport(payload) {
  const out = [];

  for (const superSport of payload.offerSuperSports || []) {
    for (const tab of superSport.tabs || []) {
      for (const competition of tab.offerCompetitionAnnuals || []) {
        for (const match of competition.matches || []) {
          const row = Array.isArray(match.oppRows) ? match.oppRows[0] : null;
          const prices = {};

          for (const odd of row?.oppsTab || []) {
            if (!odd || typeof odd !== "object") {
              continue;
            }

            prices[odd.type || odd.label] = odd.odd;
          }

          out.push({
            source: "tipsport",
            matchId: match.id,
            eventUrl: match.url ? `https://www.tipsport.cz${match.url}` : null,
            sport: match.superSport || superSport.name || null,
            competition: match.competition || competition.name || null,
            home: match.participantHome || null,
            away: match.participantVisiting || null,
            startsAt: match.dateClosed || match.dateStartTv || null,
            market: tab.name || null,
            odds: prices,
          });
        }
      }
    }
  }

  return out;
}

function dedupeByEventId(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = item?.matchId ?? JSON.stringify([item?.home, item?.away, item?.startsAt]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function fetchWithRetry(url, options = {}, retryCount = 3) {
  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === retryCount) {
        break;
      }
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (response.status !== 429) {
      return response;
    }

    lastError = new Error(`429 Too Many Requests`);
    if (attempt === retryCount) {
      break;
    }

    const retryAfter = response.headers.get("retry-after");
    const delayMs = retryAfter
      ? Number(retryAfter) * 1000
      : 1000 * (attempt + 1) * 2;
    await sleep(delayMs);
  }

  throw lastError || new Error("Request failed");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateP4578LeagueAggregation(
  result,
  fetchedLeagueResults,
  failedLeagueResults,
  selectedLeagueCode,
  progress = {}
) {
  result.request.leagueOddsUrls = fetchedLeagueResults.map((entry) => entry.requestUrl);
  result.leagueCode = selectedLeagueCode;
  result.fetchedLeagueCount = fetchedLeagueResults.length;
  result.failedLeagueCount = failedLeagueResults.length;
  result.failedLeagues = failedLeagueResults;
  result.leagueResults = fetchedLeagueResults.map((entry) => ({
    leagueCode: entry.leagueCode,
    leagueName: entry.leagueName,
    matchCount: entry.matchCount,
    matches: entry.matches,
  }));
  result.matchesByLeague = Object.fromEntries(
    fetchedLeagueResults.map((entry) => [entry.leagueCode, entry.matches])
  );
  result.matches = dedupeByEventId(
    fetchedLeagueResults.flatMap((entry) => entry.matches)
  );
  result.progress = {
    complete: Boolean(progress.complete),
    chunkSize: progress.chunkSize ?? DEFAULT_P4578_CHUNK_SIZE,
    fetchedLeagueCount: fetchedLeagueResults.length,
    failedLeagueCount: failedLeagueResults.length,
    totalLeagueTargetCount: progress.totalLeagueTargetCount ?? fetchedLeagueResults.length + failedLeagueResults.length,
  };

  const selectedLeagueResult = fetchedLeagueResults.find((entry) => entry.leagueCode === selectedLeagueCode) || null;
  if (selectedLeagueResult) {
    result.request.leagueOddsUrl = selectedLeagueResult.requestUrl;
    result.leagueOdds = selectedLeagueResult.raw;
  }
}

function cloneJsonCompatible(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readHar(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getP4578BootstrapContext(harPath, args) {
  if (harPath && fs.existsSync(harPath)) {
    const har = readHar(harPath);
    const leaguesEntry = findEntry(har, (entry) =>
      entry.request.method === "GET" &&
      entry.request.url.includes("/sports-service/sv/euro/leagues?")
    );
    const periodsEntry = findEntry(har, (entry) =>
      entry.request.method === "GET" &&
      entry.request.url.includes("/sports-service/sv/odds/periods")
    );

    if (leaguesEntry && periodsEntry) {
      return {
        kind: "har",
        har,
        baseUrl: leaguesEntry.request.url,
        leaguesUrl: new URL(leaguesEntry.request.url),
        periodsUrl: new URL(periodsEntry.request.url),
        headers: buildHeaders(leaguesEntry.request.headers, {
          accept: "application/json, text/plain, */*",
        }),
      };
    }
  }

  const baseUrl = normalizeP4578BaseUrl(args.p4578BaseUrl || DEFAULT_P4578_BASE_URL);
  return {
    kind: "direct",
    har: null,
    baseUrl,
    leaguesUrl: buildP4578LeaguesUrl(baseUrl, args),
    periodsUrl: buildP4578PeriodsUrl(baseUrl),
    headers: buildDefaultP4578Headers(baseUrl),
  };
}

function parseHarJsonResponse(entry) {
  try {
    const text = entry?.response?.content?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function findEntry(har, predicate) {
  return har.log.entries.find(predicate) || null;
}

function findP4578EventOddsInHar(har, eventId) {
  if (!har || !Number.isFinite(Number(eventId))) {
    return null;
  }

  const entry = findEntry(har, (candidate) =>
    candidate?.request?.method === "GET" &&
    String(candidate?.request?.url || "").includes("/sports-service/sv/euro/odds/event") &&
    String(candidate?.request?.url || "").includes(`eventId=${Number(eventId)}`)
  );

  return entry ? parseHarJsonResponse(entry) : null;
}

function pickP4578LeagueTargets(leagueList, args) {
  if (!Array.isArray(leagueList) || leagueList.length === 0) {
    return [];
  }

  if (args.p4578LeagueCode) {
    return leagueList.filter((league) => league?.leagueCode === args.p4578LeagueCode).slice(0, 1);
  }

  const maxLeagues = Number.isFinite(args.p4578MaxLeagues) && args.p4578MaxLeagues > 0
    ? args.p4578MaxLeagues
    : DEFAULT_P4578_MAX_LEAGUES;

  return [...leagueList]
    .sort((a, b) => (Number(b?.totalEvents) || 0) - (Number(a?.totalEvents) || 0))
    .slice(0, maxLeagues);
}

function buildP4578LeagueOddsUrl({ baseUrl, sportId, leagueCode }) {
  const url = new URL("/sports-service/sv/euro/odds/league", baseUrl);
  const now = Date.now();
  url.searchParams.set("sportId", String(sportId));
  url.searchParams.set("oddsType", "1");
  url.searchParams.set("version", "0");
  url.searchParams.set("timeStamp", String(now));
  url.searchParams.set("periodNum", "-1");
  url.searchParams.set("eSportCode", "");
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("leagueCode", leagueCode);
  url.searchParams.set("isHlE", "true");
  url.searchParams.set("isLive", "false");
  url.searchParams.set("eventType", "0");
  url.searchParams.set("_", String(now + 1));
  url.searchParams.set("withCredentials", "true");
  return url.toString();
}

function buildP4578LeaguesUrl(baseUrl, args) {
  const url = new URL("/sports-service/sv/euro/leagues", baseUrl);
  url.searchParams.set("sportId", String(Number.isFinite(args.p4578SportId) ? args.p4578SportId : 29));
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("_", String(Date.now()));
  url.searchParams.set("withCredentials", "true");
  return url;
}

function buildP4578PeriodsUrl(baseUrl) {
  const url = new URL("/sports-service/sv/odds/periods", baseUrl);
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("_", String(Date.now()));
  url.searchParams.set("withCredentials", "true");
  return url;
}

function buildP4578EventOddsUrl({ baseUrl, eventId }) {
  const url = new URL("/sports-service/sv/euro/odds/event", baseUrl);
  url.searchParams.set("eventId", String(eventId));
  url.searchParams.set("oddsType", "1");
  url.searchParams.set("version", "0");
  url.searchParams.set("specialVersion", "0");
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("_", String(Date.now()));
  url.searchParams.set("withCredentials", "true");
  return url.toString();
}

function normalizeP4578BaseUrl(input) {
  const url = new URL(input);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildDefaultP4578Headers(baseUrl) {
  const origin = new URL(baseUrl).origin;
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin,
    referer: `${origin}/`,
  };
}

function buildHeaders(headerList, overrides = {}) {
  const blocked = new Set([
    "host",
    "content-length",
    "cookie",
    "connection",
    "priority",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
  ]);
  const headers = {};

  for (const header of headerList || []) {
    const key = String(header.name || "").toLowerCase();
    if (
      !key ||
      key.startsWith(":") ||
      blocked.has(key) ||
      key.startsWith("proxy-") ||
      key.startsWith("cf-")
    ) {
      continue;
    }

    headers[key] = header.value;
  }

  return { ...headers, ...overrides };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  fetchOddsData,
  fetchP4578Data,
  parseArgs,
};
