// pricing.js — Template pricing engine
// Steps are implemented incrementally; each function is independently importable.

import { getMatchTemplate, getLeagueSetting, getTemplates, TIMELINE_NODES, getAllOverrideMeta, updateOverrideAlertState } from './state.js';
import { calculateShinNoVig } from './math.js';

// ── Node thresholds: minutes before kick-off at which each node activates ──
// INST is treated as Infinity — it is always the opening fallback.
const NODE_MINUTES = {
  'INST':  Infinity,
  '240D':  240 * 24 * 60,
  '120D':  120 * 24 * 60,
  '60D':   60  * 24 * 60,
  '30D':   30  * 24 * 60,
  '15D':   15  * 24 * 60,
  '10D':   10  * 24 * 60,
  '9D':    9   * 24 * 60,
  '8D':    8   * 24 * 60,
  '7D':    7   * 24 * 60,
  '6D':    6   * 24 * 60,
  '5D':    5   * 24 * 60,
  '4D':    4   * 24 * 60,
  '3D':    3   * 24 * 60,
  '2.5D':  2.5 * 24 * 60,
  '2D':    2   * 24 * 60,
  '36h':   36  * 60,
  '24h':   24  * 60,
  '18h':   18  * 60,
  '12h':   12  * 60,
  '6h':    6   * 60,
  '3h':    3   * 60,
  '2h':    2   * 60,
  '1h':    1   * 60,
  '30m':   30,
  '15m':   15,
};

/**
 * Resolves the active template for an event.
 *
 * Resolution order (first match wins):
 *   1. Match-level override  — matchTemplates[eventId]
 *   2. League default        — leagueSettings[leagueCode].template
 *   3. Nothing assigned      — { template: null, source: 'none' }
 *
 * Both active and inactive templates are returned; the caller decides
 * whether to warn the user about an inactive assignment.
 *
 * @param {string|number} eventId
 * @param {string|number} leagueCode
 * @returns {{ template: object|null, source: 'match'|'league'|'none' }}
 */
export function resolveTemplate(eventId, leagueCode) {
  const all  = getTemplates();
  const find = (id) => (id ? (all.find(t => t.id === id) ?? null) : null);

  // 1. Match-level override
  const matchTpl = find(getMatchTemplate(eventId));
  if (matchTpl) return { template: matchTpl, source: 'match' };

  // 2. League default
  const leagueTpl = find(getLeagueSetting(leagueCode)?.template);
  if (leagueTpl) return { template: leagueTpl, source: 'league' };

  // 3. Nothing assigned
  return { template: null, source: 'none' };
}

/**
 * Returns the config entry for a specific market within a template.
 * Returns null if the template is null or the market is not found.
 *
 * @param {object|null} template
 * @param {string} marketId
 * @returns {object|null}  e.g. { id, enabled, margin, maxBet, ladder, rangeLimit, timeline }
 */
export function getMarketConfig(template, marketId) {
  if (!template?.markets) return null;
  return template.markets.find(m => m.id === marketId) ?? null;
}

/**
 * Resolves the active timeline key for a market given the event start time.
 *
 * Walks nodes from nearest-to-kick-off (15m) outward (INST), returning the
 * first node where:
 *   a) minutesToKickoff <= nodeThreshold  (we have entered this tier)
 *   b) a key is set in the market's timeline
 *
 * This means: as kick-off approaches the active node advances rightward,
 * and each key transition is triggered automatically.
 *
 * For post-kick-off events (minutesToKickoff < 0) the last pre-match key
 * remains active — no live pricing logic here.
 *
 * @param {object} marketConfig  — one market entry from a template
 * @param {string|number} eventStartTime  — ISO string or ms timestamp
 * @returns {{ key: number, node: string, minutesToKickoff: number } | null}
 *   null when no timeline keys are set (caller should fall back to base margin)
 */
export function resolveActiveKey(marketConfig, eventStartTime) {
  const timeline = marketConfig?.timeline;
  if (!timeline || Object.keys(timeline).length === 0) return null;

  const minutesToKickoff = (new Date(eventStartTime).getTime() - Date.now()) / 60_000;

  // Walk from nearest (15m) toward farthest (INST).
  // First node where current time falls inside its tier AND has a key wins.
  const nodesNearFirst = [...TIMELINE_NODES].reverse();

  for (const node of nodesNearFirst) {
    const threshold = NODE_MINUTES[node.id];
    if (minutesToKickoff <= threshold && timeline[node.id] != null) {
      return { key: timeline[node.id], node: node.id, minutesToKickoff };
    }
  }

  return null; // No keys configured for the current time window
}

// ── Override expiry & alert evaluation ────────────────────

function getTeamNames(event) {
  let home = event.home || 'Home';
  let away = event.away || 'Away';
  if (event.participants) {
    const h = event.participants.find(p => p.type === 'HOME' || p.participantType === 'Home');
    const a = event.participants.find(p => p.type === 'AWAY' || p.participantType === 'Away');
    if (h) home = h.name || h.englishName || home;
    if (a) away = a.name || a.englishName || away;
  }
  return { home, away };
}

function getMatchPeriod(event) {
  if (event.periods && !Array.isArray(event.periods)) return event.periods['0'];
  const arr = Array.isArray(event.periods) ? event.periods : Object.values(event.periods || {});
  return arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
}

function computeCurrentShinFairs(event, marketId) {
  const matchPeriod = getMatchPeriod(event);
  if (!matchPeriod) return null;

  if (marketId === 'ml') {
    const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
    if (!ml) return null;
    const { home, away } = getTeamNames(event);
    const shins = calculateShinNoVig([ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away]);
    return { [home]: shins[0], 'Draw': shins[1], [away]: shins[2] };
  }

  if (marketId === 'ou') {
    if (!Array.isArray(matchPeriod.overUnder)) return null;
    const result = {};
    matchPeriod.overUnder.forEach(ou => {
      const shins = calculateShinNoVig([ou.overOdds, ou.underOdds]);
      result[`Over ${ou.points}`] = shins[0];
      result[`Under ${ou.points}`] = shins[1];
    });
    return result;
  }

  // Derived markets (btts, cs, hdp, etc.) — no fresh shin available from event data alone
  return null;
}

/**
 * Evaluates all active manual overrides each poll cycle.
 * - Checks expiry: Shin fair crossing the override implied-prob threshold → auto-revert
 * - Checks VALUE_BET: offer price exceeds Shin fair → alert state
 * Returns array of expired selections: [{ eventId, marketId, label }]
 */
export function evaluateOverrides(activeEvents) {
  const meta = getAllOverrideMeta();
  const expiries = [];

  for (const metaKey of Object.keys(meta)) {
    const sepIdx = metaKey.indexOf('|');
    const eventId  = metaKey.slice(0, sepIdx);
    const marketId = metaKey.slice(sepIdx + 1);
    const marketMeta = meta[metaKey];
    if (!marketMeta?.selections) continue;

    const event = activeEvents.find(e => e.id.toString() === eventId);
    if (!event) continue;

    const currentShins = computeCurrentShinFairs(event, marketId);
    let maxGap = 0;
    let hasValueBet = false;

    for (const [label, selMeta] of Object.entries(marketMeta.selections)) {
      // Use fresh shin where available; fall back to snapshot for derived markets
      const shinFairOdds = currentShins
        ? parseFloat(currentShins[label])
        : parseFloat(selMeta.shinFairAtTime);

      if (!shinFairOdds || isNaN(shinFairOdds) || shinFairOdds <= 1) continue;

      // Expiry: only when we have a fresh shin to compare against
      if (currentShins) {
        const shinFairProb = 1 / shinFairOdds;
        const expired = selMeta.direction === 'DOWN'
          ? shinFairProb >= selMeta.overrideImpliedProb
          : shinFairProb <= selMeta.overrideImpliedProb;
        if (expired) {
          expiries.push({ eventId, marketId, label });
          continue;
        }
      }

      // VALUE_BET: offer price above shin fair
      const gap = selMeta.overridePrice - shinFairOdds;
      if (gap > 0) {
        hasValueBet = true;
        if (gap > maxGap) maxGap = gap;
      }
    }

    const newState = hasValueBet ? 'VALUE_BET' : 'CLEAN';
    if (newState !== marketMeta.alertState || Math.abs(maxGap - marketMeta.valueBetGap) > 0.005) {
      updateOverrideAlertState(eventId, marketId, newState, maxGap);
    }
  }

  return expiries;
}
