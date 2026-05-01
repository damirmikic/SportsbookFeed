// pricing.js — Template pricing engine
// Steps are implemented incrementally; each function is independently importable.

import { getMatchTemplate, getLeagueSetting, getTemplates, TIMELINE_NODES } from './state.js';

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
