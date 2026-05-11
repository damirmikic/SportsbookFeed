import {
  getTemplates, addTemplate, updateTemplate, deleteTemplate,
  MARKET_DEFS, TIMELINE_NODES, getDiscoveredMarkets, setDiscoveredMarkets,
  getDetailedOdds, isDetailedOddsFresh, setDetailedOdds,
} from './state.js';
import { state } from './state.js';
import { fetchEventOdds } from './api.js';
import { getTeamNames } from './utils.js';

// ── Filter state ──────────────────────────────────────────
const tplFilters = { type: '', activeOnly: true };

// ── Helpers ───────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getFiltered() {
  return getTemplates().filter(t => {
    if (tplFilters.type && t.type !== tplFilters.type) return false;
    if (tplFilters.activeOnly && !t.active) return false;
    return true;
  });
}

function enabledCount(tpl) {
  return (tpl.markets || []).filter(m => m.enabled).length;
}

function typeLabel(type) {
  return { prematch: 'Pre-match', live: 'Live', both: 'Both' }[type] || type;
}

// Returns the active market definition list:
// discovered markets from the feed (if any), else MARKET_DEFS fallback.
function getActiveMarketDefs() {
  const disc = getDiscoveredMarkets();
  if (disc?.markets?.length) return disc.markets;
  return MARKET_DEFS.map(d => ({ id: d.id, group: d.group, name: d.name }));
}

// Default config values for a market def (margin, maxBet, enabled).
// Looks up in MARKET_DEFS first, then sensible defaults.
function defaultsForMarket(id) {
  const def = MARKET_DEFS.find(d => d.id === id);
  return {
    enabled: def?.defaultEnabled ?? false,
    margin:  def?.defaultMargin  ?? 5.0,
    maxBet:  def?.defaultMaxBet  ?? 1000,
  };
}

// ── Canonical market pattern catalog ─────────────────────
// Patterns matched against raw API market names.
// The FIRST match wins → use its canonical id/group/name (no team names).
// Order matters: more specific patterns must come before broader ones.
const MARKET_PATTERNS = [
  // Match Odds
  { id: 'dc',              group: 'Match Odds',     name: 'Double Chance',                pattern: /double chance/i },
  { id: 'dnb',             group: 'Match Odds',     name: 'Draw No Bet',                  pattern: /draw no bet/i },
  { id: 'cs',              group: 'Match Odds',     name: 'Correct Score',                pattern: /correct score/i },
  { id: 'hdp_3way',        group: 'Handicap',       name: '3-Way Handicap',               pattern: /3.?way handicap/i },
  // Goals
  { id: 'btts',            group: 'Goals',          name: 'Both Teams To Score',          pattern: /both teams to score/i },
  { id: 'either_tts',      group: 'Goals',          name: 'Either Team To Score',         pattern: /either team to score/i },
  { id: 'exact_goals',     group: 'Goals',          name: 'Exact Goals',                  pattern: /exact goals/i },
  { id: 'goals_range',     group: 'Goals',          name: 'Goals Range',                  pattern: /goals range/i },
  { id: 'goals_oddeven',   group: 'Goals',          name: 'Total Goals Odd/Even',         pattern: /total goals odd.?even/i },
  { id: 'result_btts',     group: 'Goals',          name: 'Result & Both Teams Score',    pattern: /result.*both teams|both teams.*result/i },
  // Team Props — order: specific before generic
  { id: 'first_tts',       group: 'Team Props',     name: 'First Team To Score',          pattern: /first team to score/i },
  { id: 'last_tts',        group: 'Team Props',     name: 'Last Team To Score',           pattern: /last team to score/i },
  { id: 'clean_sheet',     group: 'Team Props',     name: 'Clean Sheet',                  pattern: /clean sheet/i },
  { id: 'win_nil',         group: 'Team Props',     name: 'Win To Nil',                   pattern: /win to nil/i },
  { id: 'score_btth',      group: 'Team Props',     name: 'Score In Both Halves',         pattern: /score in both halves|score.*both halves/i },
  { id: 'win_btth',        group: 'Team Props',     name: 'Win Both Halves',              pattern: /win.*both halves/i },
  { id: 'team_goals_oe',   group: 'Team Props',     name: 'Team Goals Odd/Even',          pattern: /goals odd.?even/i },
  // Halves — specific before generic
  { id: 'h1_1x2',          group: 'Halves',         name: '1st Half 1X2',                 pattern: /1st half.*1x2|first half.*1x2|half.?time result/i },
  { id: 'h1_hdp_sp',       group: 'Halves',         name: '1st Half Handicap',            pattern: /1st half.*handicap|first half.*handicap/i },
  { id: 'h1_ou_sp',        group: 'Halves',         name: '1st Half Total Goals',         pattern: /1st half.*total|first half.*total|1st half.*over/i },
  { id: 'h2_1x2',          group: 'Halves',         name: '2nd Half 1X2',                 pattern: /2nd half.*1x2|second half.*1x2/i },
  { id: 'h2_ou',           group: 'Halves',         name: '2nd Half Total Goals',         pattern: /2nd half.*total|second half.*total/i },
  { id: 'h2_hdp',          group: 'Halves',         name: '2nd Half Handicap',            pattern: /2nd half.*handicap|second half.*handicap/i },
  // Specials
  { id: 'htft',            group: 'Specials',       name: 'HT / Full Time',               pattern: /ht.?ft|half.?time.*full.?time|halftime\/fulltime/i },
  { id: 'result_ou',       group: 'Specials',       name: 'Result & Total Goals',         pattern: /result.*over.?under|result.*total goals/i },
  { id: 'btts_ou',         group: 'Specials',       name: 'BTTS & Over/Under',            pattern: /both teams.*over.?under|btts.*over/i },
  { id: 'btth_ou',         group: 'Specials',       name: 'Score Over In Both Halves',    pattern: /both halves.*over|over.*both halves/i },
  // Corners
  { id: 'corner_hdp',      group: 'Corners',        name: 'Corner Handicap',              pattern: /corner.*handicap|handicap.*corner/i },
  { id: 'corners_ou',      group: 'Corners',        name: 'Total Corners',                pattern: /corner/i },
  // Bookings
  { id: 'bookings_ou',     group: 'Bookings',       name: 'Total Bookings / Cards',       pattern: /booking|yellow card|red card|\bcards?\b/i },
  // Player Markets — group all individual player entries into the market type
  { id: 'anytime_scorer',  group: 'Player Markets', name: 'Anytime Goal Scorer',          pattern: /anytime.*scorer|anytime goal scorer/i },
  { id: 'first_scorer',    group: 'Player Markets', name: 'First Goal Scorer',            pattern: /first goal.?scorer|first goalscorer/i },
  { id: 'last_scorer',     group: 'Player Markets', name: 'Last Goal Scorer',             pattern: /last goal.?scorer/i },
  { id: 'to_score',        group: 'Player Markets', name: 'To Score',                     pattern: /to score/i },
];

// Escape a string for use inside a RegExp
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Remove team names from a market name, replacing with generic "Home"/"Away"
function sanitizeName(name, homeTeam, awayTeam) {
  let s = name;
  if (homeTeam) s = s.replace(new RegExp(escRe(homeTeam), 'gi'), 'Home');
  if (awayTeam) s = s.replace(new RegExp(escRe(awayTeam), 'gi'), 'Away');
  return s.replace(/\s{2,}/g, ' ').trim();
}

// ── Market discovery ──────────────────────────────────────
function extractMarketsFromEvent(event, detailed) {
  const markets = [];
  const seen    = new Set();

  function add(id, group, name) {
    if (seen.has(id)) return;
    seen.add(id);
    markets.push({ id, group, name });
  }

  const { home, away } = getTeamNames(event);

  // Normalise periods object
  const periods = (!Array.isArray(event.periods) && event.periods) ? event.periods : {};
  const ft = periods['0'];
  const h1 = periods['1'];

  // ── Full-match markets (FT) ───────────────────────────
  if (ft) {
    if (ft.moneyLine || ft.moneyline)  add('ml',      'Match Odds',  '1x2');
    if (ft.handicap?.length)           add('hdp',     'Handicap',    'Asian Handicap');
    if (ft.overUnder?.length)          add('ou',      'Totals',      'Total Goals (all lines)');
    const ttFT = ft.teamTotals || ft.teamTotal;
    if (ttFT) {
      if (ttFT.home || ttFT.homeLines) add('tt_home', 'Team Totals', 'Home Team Total');
      if (ttFT.away || ttFT.awayLines) add('tt_away', 'Team Totals', 'Away Team Total');
    }
  }

  // ── 1st-half markets ─────────────────────────────────
  if (h1) {
    if (h1.moneyLine || h1.moneyline)  add('h1_ml',      'Halves', '1st Half 1X2');
    if (h1.handicap?.length)           add('h1_hdp',     'Halves', '1st Half Asian Handicap');
    if (h1.overUnder?.length)          add('h1_ou',      'Halves', '1st Half Total Goals');
    const ttH1 = h1.teamTotals || h1.teamTotal;
    if (ttH1) {
      if (ttH1.home || ttH1.homeLines) add('h1_tt_home', 'Halves', '1st Half Home Total');
      if (ttH1.away || ttH1.awayLines) add('h1_tt_away', 'Halves', '1st Half Away Total');
    }
  }

  // ── Derived (always when 1x2 is present) ─────────────
  if (seen.has('ml')) {
    add('dc',   'Match Odds', 'Double Chance');
    add('dnb',  'Match Odds', 'Draw No Bet');
    add('btts', 'Goals',      'Both Teams To Score');
    add('cs',   'Goals',      'Correct Score');
  }

  // ── Specials from event detail endpoint ───────────────
  if (detailed?.specials && Array.isArray(detailed.specials)) {
    detailed.specials.forEach(category => {
      if (!category.events?.length) return;
      category.events.forEach(mkt => {
        // Skip markets already handled above as derived
        if (['Both Teams To Score?', 'Draw No Bet', 'Double Chance', 'Correct Score'].includes(mkt.name)) return;

        // 1. Try to match against the canonical pattern catalog
        const canonical = MARKET_PATTERNS.find(p => p.pattern.test(mkt.name));
        if (canonical) {
          // Use canonical id/group/name — no team-specific text ever stored
          add(canonical.id, canonical.group, canonical.name);
          return;
        }

        // 2. No pattern matched → sanitize: replace team names, derive a stable id
        const cleanName = sanitizeName(mkt.name, home, away);
        const id = 'sp_' + cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        add(id, 'Specials', cleanName);
      });
    });
  }

  return markets;
}

// ── Filter bar + chips ────────────────────────────────────
function filterBarHTML() {
  return `
    <div class="tpl-filter-bar">
      <div class="tpl-filters-left">
        <select class="admin-sel" id="tf-sport"><option value="soccer">SPORT</option></select>
        <select class="admin-sel" id="tf-type">
          <option value="">TYPE</option>
          <option value="prematch" ${tplFilters.type === 'prematch' ? 'selected' : ''}>Pre-match</option>
          <option value="live"     ${tplFilters.type === 'live'     ? 'selected' : ''}>Live</option>
          <option value="both"     ${tplFilters.type === 'both'     ? 'selected' : ''}>Both</option>
        </select>
        <label class="admin-cb-label tpl-active-cb">
          <input type="checkbox" id="tf-active" ${tplFilters.activeOnly ? 'checked' : ''}> Active templates
        </label>
      </div>
      <div class="tpl-filters-right">
        <button class="tpl-ladders-btn" id="tpl-my-ladders">MY LADDERS</button>
        <button class="tpl-create-btn"  id="tpl-create-new">CREATE NEW</button>
      </div>
    </div>`;
}

function chipsBarHTML() {
  const chips = [];
  if (tplFilters.activeOnly) chips.push({ key: 'activeOnly', label: 'Active Templates' });
  if (tplFilters.type)       chips.push({ key: 'type', label: typeLabel(tplFilters.type) });
  return `
    <div class="admin-chips-bar">
      <button class="admin-clear-btn" id="tf-clear">REMOVE ALL FILTERS</button>
      ${chips.map(c => `<span class="admin-chip admin-chip-rm" data-key="${c.key}">× ${c.label}</span>`).join('')}
    </div>`;
}

// ── Template listing table ────────────────────────────────
function templateRowHTML(tpl) {
  const enabled = enabledCount(tpl);
  const total   = (tpl.markets || []).length;
  const created = tpl.createdAt ? new Date(tpl.createdAt).toLocaleDateString() : '—';
  return `
    <tr class="tpl-row" data-id="${tpl.id}">
      <td class="tpl-td-name">
        <div class="tpl-name-display">
          <span class="tpl-name-text">${tpl.name}</span>
          <button class="tpl-rename-btn" data-id="${tpl.id}" title="Rename">✏</button>
        </div>
        <div class="tpl-rename-wrap hidden">
          <input class="tpl-rename-input" type="text" value="${tpl.name}" data-id="${tpl.id}" maxlength="60">
          <button class="tpl-rename-ok" data-id="${tpl.id}" title="Save">✓</button>
          <button class="tpl-rename-x"  data-id="${tpl.id}" title="Cancel">✕</button>
        </div>
      </td>
      <td><span class="tpl-tag">Soccer</span></td>
      <td><span class="tpl-tag tpl-tag-type">${typeLabel(tpl.type)}</span></td>
      <td class="tpl-td-markets">
        <span class="tpl-markets-count">${enabled}</span>
        <span class="tpl-markets-total">/ ${total}</span>
        <span class="tpl-markets-label">markets</span>
      </td>
      <td>
        <label class="tpl-status-toggle">
          <input type="checkbox" class="tpl-status-cb" data-id="${tpl.id}" ${tpl.active ? 'checked' : ''}>
          <span class="tpl-status-track"></span>
          <span class="tpl-status-label">${tpl.active ? 'Active' : 'Inactive'}</span>
        </label>
      </td>
      <td class="tpl-td-date">${created}</td>
      <td class="tpl-td-actions">
        <button class="tpl-edit-btn"   data-id="${tpl.id}">Edit</button>
        <button class="tpl-delete-btn" data-id="${tpl.id}">Delete</button>
      </td>
    </tr>`;
}

function tableHTML(templates) {
  return `
    <div class="admin-table-wrap">
      <table class="admin-tbl tpl-tbl">
        <thead>
          <tr>
            <th>Name</th><th>Sport</th><th>Type</th>
            <th>Markets</th><th>Status</th><th>Created</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${templates.length
            ? templates.map(templateRowHTML).join('')
            : '<tr><td colspan="7" class="admin-empty">No templates match the current filters.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

// ── Market card timeline UI ───────────────────────────────

function timelineHTML(config) {
  const tl = config.timeline || {};
  return `
    <div class="mkt-tl-wrap">
      <span class="mkt-tl-edge">PREMATCH</span>
      <div class="mkt-tl-track">
        ${TIMELINE_NODES.map(node => {
          const key = tl[node.id];
          const has = key != null;
          return `<div class="mkt-tl-node${has ? ' mkt-tl-active' : ''}" data-mid="${config.id}" data-node="${node.id}"${has ? ` data-key="${key}"` : ''}>
              <div class="mkt-tl-circle">${has ? key : ''}</div>
              <div class="mkt-tl-lbl">${node.label}</div>
            </div>`;
        }).join('')}
      </div>
      <span class="mkt-tl-edge mkt-tl-ko">KICK OFF</span>
    </div>`;
}

function marketCardHTML(def, config, group) {
  const tl       = config.timeline || {};
  const setNodes = TIMELINE_NODES.filter(n => tl[n.id] != null);
  const firstKey = setNodes.length ? tl[setNodes[0].id] : '—';
  const lastKey  = setNodes.length ? tl[setNodes[setNodes.length - 1].id] : '—';
  const ladderLbl = config.ladder === 'template' ? 'Template Ladder' : 'EU Ladder';
  const rangeLbl  = config.rangeLimit != null ? config.rangeLimit : 'None';
  const outTxt    = def.outcomes ? `Outcomes: ${def.outcomes}` : '';

  return `
    <div class="mkt-card${config.enabled ? '' : ' mkt-card-off'}" data-mid="${config.id}" data-group="${group}">
      <div class="mkt-card-hdr">
        <button class="mkt-card-chev" data-mid="${config.id}" title="Collapse">▾</button>
        <span class="mkt-card-name">${def.name}</span>
        ${outTxt ? `<span class="mkt-card-meta">${outTxt}</span>` : ''}
        <div class="mkt-cfg-bar">
          <span class="mkt-cfg-item">Ladder: <strong>${ladderLbl}</strong></span>
          <span class="mkt-cfg-sep"></span>
          <span class="mkt-cfg-item">Range Limitation: <strong>${rangeLbl}</strong></span>
          <span class="mkt-cfg-sep"></span>
          <span class="mkt-cfg-item mkt-first-key">1st Key: <strong>${firstKey}</strong></span>
          <span class="mkt-cfg-item mkt-last-key">Last Key: <strong>${lastKey}</strong></span>
          <button class="mkt-open-cfg-btn" data-mid="${config.id}">OPEN MARKET CONFIG</button>
          <label class="mkt-active-wrap" title="Market Active">
            <input type="checkbox" class="mkt-enabled-cb" data-id="${config.id}" ${config.enabled ? 'checked' : ''}>
            <span class="mkt-active-track"></span>
            <span class="mkt-active-lbl">Market Active</span>
          </label>
        </div>
      </div>

      <div class="mkt-card-body">
        <div class="mkt-inline-cfg hidden" data-mid="${config.id}">
          <div class="mkt-inline-row">
            <label class="mkt-inline-field">Margin %
              <input type="number" class="mkt-margin-input mkt-cfg-num" data-id="${config.id}"
                value="${config.margin}" min="0" max="50" step="0.1">
              <span class="mkt-margin-suggest" data-suggest="${defaultsForMarket(config.id).margin}">
                ★ Suggested: ${defaultsForMarket(config.id).margin}%
              </span>
            </label>
            <label class="mkt-inline-field">Max Stake £
              <input type="number" class="mkt-maxbet-input mkt-cfg-num" data-id="${config.id}"
                value="${config.maxBet}" min="0" step="100">
            </label>
            <label class="mkt-inline-field">Ladder
              <select class="mkt-ladder-sel mkt-cfg-num" data-id="${config.id}">
                <option value="eu" ${config.ladder !== 'template' ? 'selected' : ''}>EU Ladder</option>
                <option value="template" ${config.ladder === 'template' ? 'selected' : ''}>Template Ladder</option>
              </select>
            </label>
            <label class="mkt-inline-field">Range Limit
              <input type="number" class="mkt-range-input mkt-cfg-num" data-id="${config.id}"
                value="${config.rangeLimit ?? ''}" placeholder="None" min="1" max="5" step="0.001">
            </label>
          </div>
        </div>

        ${timelineHTML(config)}

        <div class="mkt-card-foot">
          <button class="mkt-copy-btn" data-mid="${config.id}">COPY CONFIG ⎘</button>
        </div>
      </div>
    </div>`;
}

function marketConfigHTML(existingMarkets, marketDefs) {
  const mMap = {};
  (existingMarkets || []).forEach(m => { mMap[m.id] = m; });

  const groupOrder = [];
  const groupItems = {};
  marketDefs.forEach(def => {
    if (!groupItems[def.group]) { groupOrder.push(def.group); groupItems[def.group] = []; }
    const existing = mMap[def.id];
    const dfl      = defaultsForMarket(def.id);
    groupItems[def.group].push({
      def,
      config: {
        id:         def.id,
        enabled:    existing?.enabled    ?? dfl.enabled,
        margin:     existing?.margin     ?? dfl.margin,
        maxBet:     existing?.maxBet     ?? dfl.maxBet,
        ladder:     existing?.ladder     ?? 'eu',
        rangeLimit: existing?.rangeLimit ?? null,
        timeline:   existing?.timeline   ?? {},
      },
    });
  });

  return groupOrder.map(group => {
    const items = groupItems[group];
    const allOn = items.every(i => i.config.enabled);
    return `
      <div class="mkt-grp-wrap">
        <div class="mkt-grp-hdr">
          <button class="mkt-grp-chev" data-group="${group}">▾</button>
          <span class="mkt-grp-badge">${items.length}</span>
          <span class="mkt-grp-title">${group}</span>
          <button class="mkt-grp-toggle-all" data-group="${group}" data-on="${allOn ? '1' : '0'}">
            ${allOn ? 'DEACTIVATE ALL' : 'ACTIVATE ALL'}
          </button>
        </div>
        <div class="mkt-grp-body" data-group="${group}">
          ${items.map(({ def, config }) => marketCardHTML(def, config, group)).join('')}
        </div>
      </div>`;
  }).join('');
}

// Collect current market config from the card DOM (used before re-rendering)
function collectMarketsFromForm(backdrop) {
  const markets = [];
  backdrop.querySelectorAll('.mkt-card').forEach(card => {
    const id = card.dataset.mid;
    const cb = card.querySelector(`.mkt-enabled-cb[data-id="${id}"]`);
    if (!id) return;
    const timeline = {};
    card.querySelectorAll('.mkt-tl-node.mkt-tl-active').forEach(n => {
      if (n.dataset.key != null && n.dataset.key !== '') timeline[n.dataset.node] = parseInt(n.dataset.key, 10);
    });
    markets.push({
      id,
      enabled:    cb ? cb.checked : false,
      margin:     parseFloat(card.querySelector('.mkt-margin-input')?.value) || 5.0,
      maxBet:     parseInt(card.querySelector('.mkt-maxbet-input')?.value, 10) || 1000,
      ladder:     card.querySelector('.mkt-ladder-sel')?.value || 'eu',
      rangeLimit: parseFloat(card.querySelector('.mkt-range-input')?.value) || null,
      timeline,
    });
  });
  return markets;
}

// ── Form modal ────────────────────────────────────────────
function formModalHTML(tpl) {
  const isEdit    = !!tpl;
  const disc      = getDiscoveredMarkets();
  const mktDefs   = getActiveMarketDefs();
  const sourceMsg = disc
    ? `<span class="mkt-source-badge">📡 ${disc.source.matchName} — ${mktDefs.length} markets</span>`
    : `<span class="mkt-source-badge mkt-source-default">Default market set · ${mktDefs.length} markets</span>`;
  const hasEvents = state.activeEvents?.length > 0;

  return `
    <div class="tpl-modal-backdrop" id="tpl-modal-backdrop">
      <div class="tpl-modal" role="dialog" aria-modal="true">
        <div class="tpl-modal-header">
          <h3>${isEdit ? 'Edit Template' : 'Create Template'}</h3>
          <button class="tpl-modal-close" id="tpl-modal-close">&times;</button>
        </div>
        <div class="tpl-modal-body">

          <section class="tpl-form-section">
            <h4 class="tpl-form-section-title">Basic Info</h4>
            <div class="tpl-form-grid">
              <div class="tpl-field">
                <label class="tpl-label">Template Name <span class="tpl-required">*</span></label>
                <input type="text" class="tpl-text-input" id="tf-name"
                  placeholder="e.g. Premier League Standard"
                  value="${tpl?.name || ''}" maxlength="60">
              </div>
              <div class="tpl-field">
                <label class="tpl-label">Sport</label>
                <select class="tpl-select" id="tf-sport-sel">
                  <option value="soccer">Soccer</option>
                </select>
              </div>
              <div class="tpl-field">
                <label class="tpl-label">Type</label>
                <select class="tpl-select" id="tf-type-sel">
                  <option value="prematch" ${(!tpl || tpl.type === 'prematch') ? 'selected' : ''}>Pre-match</option>
                  <option value="live"     ${tpl?.type === 'live'  ? 'selected' : ''}>Live</option>
                  <option value="both"     ${tpl?.type === 'both'  ? 'selected' : ''}>Both</option>
                </select>
              </div>
              <div class="tpl-field tpl-field-status">
                <label class="tpl-label">Status</label>
                <label class="tpl-status-toggle tpl-form-toggle">
                  <input type="checkbox" id="tf-active-toggle" ${(!tpl || tpl.active) ? 'checked' : ''}>
                  <span class="tpl-status-track"></span>
                  <span class="tpl-status-label" id="tf-active-label">${(!tpl || tpl.active) ? 'Active' : 'Inactive'}</span>
                </label>
              </div>
            </div>
          </section>

          <section class="tpl-form-section">
            <div class="mkt-config-header">
              <div>
                <h4 class="tpl-form-section-title">Markets Configuration</h4>
                <p class="tpl-form-hint">
                  ${sourceMsg}
                  Click any timeline node to set a key. Use <strong>OPEN MARKET CONFIG</strong> per market for margin % and stake limits.
                </p>
              </div>
              <button class="mkt-discover-btn ${!hasEvents ? 'mkt-discover-disabled' : ''}"
                id="tpl-discover-btn"
                title="${hasEvents ? 'Load markets from a live match in the feed' : 'Load a league in the Trading view first'}">
                ${hasEvents ? 'Load from Feed' : 'No events loaded'}
              </button>
            </div>
            <div id="mkt-cards-wrap" class="mkt-cards-wrap">
              ${marketConfigHTML(tpl?.markets, mktDefs)}
            </div>
          </section>

        </div>
        <div class="tpl-modal-footer">
          <button class="tpl-cancel-btn" id="tpl-cancel">Cancel</button>
          <button class="tpl-save-btn"   id="tpl-save">${isEdit ? 'Save Changes' : 'Save Template'}</button>
        </div>
      </div>
    </div>`;
}

// ── Main render ───────────────────────────────────────────
export function renderTemplatesSection() {
  const panel = document.getElementById('templates-panel');
  if (!panel) return;
  panel.innerHTML = filterBarHTML() + chipsBarHTML() + tableHTML(getFiltered());
  wireSectionEvents(panel);
}

// ── Open / close modal ────────────────────────────────────
export function openTemplateById(id) {
  const tpl = getTemplates().find(t => t.id === id);
  if (tpl) openForm(tpl);
}

function openForm(tpl = null) {
  document.getElementById('tpl-modal-backdrop')?.remove();
  document.body.insertAdjacentHTML('beforeend', formModalHTML(tpl));
  const backdrop = document.getElementById('tpl-modal-backdrop');
  requestAnimationFrame(() => backdrop.classList.add('visible'));
  wireFormEvents(backdrop, tpl);
}

function closeForm() {
  const backdrop = document.getElementById('tpl-modal-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('visible');
  backdrop.addEventListener('transitionend', () => backdrop.remove(), { once: true });
}

// ── Inline rename helpers ─────────────────────────────────
function enterRenameMode(td) {
  td.querySelector('.tpl-name-display').classList.add('hidden');
  td.querySelector('.tpl-rename-wrap').classList.remove('hidden');
  const input = td.querySelector('.tpl-rename-input');
  input.focus(); input.select();
}

function saveRename(td) {
  const input   = td.querySelector('.tpl-rename-input');
  const newName = input.value.trim();
  if (newName) {
    updateTemplate(input.dataset.id, { name: newName });
    td.querySelector('.tpl-name-text').textContent = newName;
    input.value = newName;
  }
  exitRenameMode(td);
}

function exitRenameMode(td) {
  td.querySelector('.tpl-name-display').classList.remove('hidden');
  td.querySelector('.tpl-rename-wrap').classList.add('hidden');
}

// ── Timeline key popover ──────────────────────────────────
let _activePopover = null;
let _copiedConfig  = null;

function openKeyPopover(nodeEl) {
  closeKeyPopover();
  const circle = nodeEl.querySelector('.mkt-tl-circle');
  const rect   = circle.getBoundingClientRect();
  const key    = nodeEl.dataset.key || '';

  const pop = document.createElement('div');
  pop.id = 'mkt-key-pop';
  pop.className = 'mkt-key-popover';
  pop.style.cssText = `position:fixed;left:${rect.left + rect.width / 2}px;top:${rect.top - 10}px;transform:translate(-50%,-100%);z-index:9999;`;
  pop.innerHTML = `
    <div class="mkt-kp-lbl">${nodeEl.dataset.node}</div>
    <input type="number" class="mkt-kp-input" value="${key}" min="100" max="999" placeholder="Key (e.g. 106)">
    <div class="mkt-kp-actions">
      <button class="mkt-kp-set">Set</button>
      <button class="mkt-kp-clear">Clear</button>
    </div>`;
  document.body.appendChild(pop);
  _activePopover = pop;

  const input = pop.querySelector('.mkt-kp-input');
  input.focus(); input.select();

  function applyKey() {
    const val = parseInt(input.value, 10);
    if (!isNaN(val) && val > 0) {
      nodeEl.classList.add('mkt-tl-active');
      nodeEl.dataset.key = val;
      circle.textContent = val;
    }
    refreshKeyLabels(nodeEl.closest('.mkt-card'));
    closeKeyPopover();
  }

  function clearKey() {
    nodeEl.classList.remove('mkt-tl-active');
    delete nodeEl.dataset.key;
    circle.textContent = '';
    refreshKeyLabels(nodeEl.closest('.mkt-card'));
    closeKeyPopover();
  }

  pop.querySelector('.mkt-kp-set').addEventListener('click', applyKey);
  pop.querySelector('.mkt-kp-clear').addEventListener('click', clearKey);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') applyKey(); if (e.key === 'Escape') closeKeyPopover(); });
  pop.addEventListener('click', e => e.stopPropagation());
  setTimeout(() => document.addEventListener('click', closeKeyPopover, { once: true }), 0);
}

function closeKeyPopover() {
  if (_activePopover) { _activePopover.remove(); _activePopover = null; }
}

function refreshKeyLabels(card) {
  if (!card) return;
  const active = [...card.querySelectorAll('.mkt-tl-node.mkt-tl-active')]
    .map(n => parseInt(n.dataset.key, 10)).filter(k => !isNaN(k));
  const fk = card.querySelector('.mkt-first-key');
  const lk = card.querySelector('.mkt-last-key');
  if (fk) fk.innerHTML = `1st Key: <strong>${active.length ? active[0] : '—'}</strong>`;
  if (lk) lk.innerHTML = `Last Key: <strong>${active.length ? active[active.length - 1] : '—'}</strong>`;
}

function copyMarketTimeline(card, container) {
  const timeline = {};
  card.querySelectorAll('.mkt-tl-node.mkt-tl-active').forEach(n => {
    if (n.dataset.key) timeline[n.dataset.node] = parseInt(n.dataset.key, 10);
  });
  _copiedConfig = {
    ladder:     card.querySelector('.mkt-ladder-sel')?.value || 'eu',
    rangeLimit: parseFloat(card.querySelector('.mkt-range-input')?.value) || null,
    timeline,
  };
  showTplToast('Timeline config copied — click PASTE on another market to apply.');
  container.querySelectorAll('.mkt-card').forEach(c => {
    if (c === card) return;
    if (!c.querySelector('.mkt-paste-btn')) {
      const foot = c.querySelector('.mkt-card-foot');
      if (!foot) return;
      const btn = document.createElement('button');
      btn.className = 'mkt-paste-btn';
      btn.textContent = 'PASTE ⎘';
      btn.addEventListener('click', () => pasteMarketTimeline(c));
      foot.prepend(btn);
    }
  });
}

function pasteMarketTimeline(card) {
  if (!_copiedConfig) return;
  const ladderSel = card.querySelector('.mkt-ladder-sel');
  if (ladderSel) ladderSel.value = _copiedConfig.ladder;
  const rangeIn = card.querySelector('.mkt-range-input');
  if (rangeIn) rangeIn.value = _copiedConfig.rangeLimit ?? '';
  card.querySelectorAll('.mkt-tl-node').forEach(n => {
    const key = _copiedConfig.timeline[n.dataset.node];
    const circ = n.querySelector('.mkt-tl-circle');
    if (key != null) {
      n.classList.add('mkt-tl-active'); n.dataset.key = key; circ.textContent = key;
    } else {
      n.classList.remove('mkt-tl-active'); delete n.dataset.key; circ.textContent = '';
    }
  });
  refreshKeyLabels(card);
  showTplToast('Timeline config pasted.');
}

// ── Wire market card events ───────────────────────────────
function wireMarketEvents(backdrop) {
  // Group chevron collapse
  backdrop.querySelectorAll('.mkt-grp-chev').forEach(btn =>
    btn.addEventListener('click', () => {
      const body = backdrop.querySelector(`.mkt-grp-body[data-group="${btn.dataset.group}"]`);
      if (!body) return;
      const hidden = body.classList.toggle('hidden');
      btn.textContent = hidden ? '▸' : '▾';
    })
  );

  // Activate All / Deactivate All
  backdrop.querySelectorAll('.mkt-grp-toggle-all').forEach(btn =>
    btn.addEventListener('click', () => {
      const enable = btn.dataset.on === '0';
      backdrop.querySelectorAll(`.mkt-card[data-group="${btn.dataset.group}"]`).forEach(card => {
        const cb = card.querySelector('.mkt-enabled-cb');
        if (cb) cb.checked = enable;
        card.classList.toggle('mkt-card-off', !enable);
      });
      btn.dataset.on  = enable ? '1' : '0';
      btn.textContent = enable ? 'DEACTIVATE ALL' : 'ACTIVATE ALL';
    })
  );

  // Per-market active toggle
  backdrop.querySelectorAll('.mkt-enabled-cb').forEach(cb =>
    cb.addEventListener('change', () => {
      const card  = cb.closest('.mkt-card');
      if (card) card.classList.toggle('mkt-card-off', !cb.checked);
      if (cb.checked) {
        card?.querySelector('.mkt-inline-cfg')?.classList.remove('hidden');
      }
      const group = card?.dataset.group;
      if (!group) return;
      const grpBtn = backdrop.querySelector(`.mkt-grp-toggle-all[data-group="${group}"]`);
      if (!grpBtn) return;
      const allOn = [...backdrop.querySelectorAll(`.mkt-card[data-group="${group}"]`)]
        .every(c => c.querySelector('.mkt-enabled-cb')?.checked);
      grpBtn.dataset.on  = allOn ? '1' : '0';
      grpBtn.textContent = allOn ? 'DEACTIVATE ALL' : 'ACTIVATE ALL';
    })
  );

  // Card chevron collapse
  backdrop.querySelectorAll('.mkt-card-chev').forEach(btn =>
    btn.addEventListener('click', () => {
      const body = btn.closest('.mkt-card')?.querySelector('.mkt-card-body');
      if (!body) return;
      const hidden = body.classList.toggle('hidden');
      btn.textContent = hidden ? '▸' : '▾';
    })
  );

  // OPEN MARKET CONFIG toggle
  backdrop.querySelectorAll('.mkt-open-cfg-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      btn.closest('.mkt-card')?.querySelector('.mkt-inline-cfg')?.classList.toggle('hidden');
    })
  );

  // Timeline node click → key popover
  backdrop.querySelectorAll('.mkt-tl-node').forEach(n =>
    n.addEventListener('click', e => { e.stopPropagation(); openKeyPopover(n); })
  );

  // Suggested margin chip → apply value
  backdrop.querySelectorAll('.mkt-margin-suggest').forEach(chip =>
    chip.addEventListener('click', () => {
      const input = chip.closest('.mkt-inline-field')?.querySelector('.mkt-margin-input');
      if (input) { input.value = chip.dataset.suggest; input.dispatchEvent(new Event('change')); }
    })
  );

  // COPY CONFIG
  const wrap = backdrop.querySelector('#mkt-cards-wrap');
  backdrop.querySelectorAll('.mkt-copy-btn').forEach(btn =>
    btn.addEventListener('click', () => copyMarketTimeline(btn.closest('.mkt-card'), wrap))
  );
}

// ── Discovery: load markets from a live match ─────────────
async function loadMarketsFromFeed(backdrop) {
  const btn = backdrop.querySelector('#tpl-discover-btn');
  if (!btn || btn.classList.contains('mkt-discover-disabled')) return;

  if (!state.activeEvents?.length) {
    showTplToast('Load a league in the Trading view first, then return to discover markets.');
    return;
  }

  const event = state.activeEvents[0];
  btn.disabled    = true;
  btn.textContent = 'Discovering…';

  try {
    // Fetch detailed odds if not cached or older than the drawer cache TTL.
    let detailed = getDetailedOdds(event.id);
    if (!isDetailedOddsFresh(event.id)) {
      detailed = await fetchEventOdds(event.id);
      setDetailedOdds(event.id, detailed);
    }

    const { home, away } = getTeamNames(event);
    const markets = extractMarketsFromEvent(event, detailed);

    setDiscoveredMarkets({
      source: { eventId: event.id, matchName: `${home} vs ${away}`, discoveredAt: new Date().toISOString() },
      markets,
    });

    // Preserve user's existing form input, then re-render cards with new defs
    const currentConfig = collectMarketsFromForm(backdrop);
    const wrap = backdrop.querySelector('#mkt-cards-wrap');
    if (wrap) {
      wrap.innerHTML = marketConfigHTML(currentConfig, markets);
      wireMarketEvents(backdrop);
    }

    // Update source hint
    const badge = backdrop.querySelector('.mkt-source-badge');
    if (badge) {
      badge.className   = 'mkt-source-badge';
      badge.textContent = `📡 ${home} vs ${away} — ${markets.length} markets`;
    }

    showTplToast(`Loaded ${markets.length} markets from ${home} vs ${away}.`);
  } catch (err) {
    console.error('Market discovery failed:', err);
    showTplToast('Could not load markets from feed. See console for details.');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Load from Feed';
  }
}

// ── Section event wiring ──────────────────────────────────
function wireSectionEvents(panel) {
  panel.querySelector('#tf-type').addEventListener('change',   e => { tplFilters.type      = e.target.value;   renderTemplatesSection(); });
  panel.querySelector('#tf-active').addEventListener('change', e => { tplFilters.activeOnly = e.target.checked; renderTemplatesSection(); });
  panel.querySelector('#tf-clear').addEventListener('click', () => {
    Object.assign(tplFilters, { type: '', activeOnly: false });
    renderTemplatesSection();
  });
  panel.querySelectorAll('.admin-chip-rm').forEach(chip =>
    chip.addEventListener('click', () => {
      if (chip.dataset.key === 'activeOnly') tplFilters.activeOnly = false;
      else tplFilters[chip.dataset.key] = '';
      renderTemplatesSection();
    })
  );

  panel.querySelector('#tpl-create-new').addEventListener('click', () => openForm(null));
  panel.querySelector('#tpl-my-ladders').addEventListener('click', () => showTplToast('Price Ladders configuration coming soon.'));

  // Inline rename
  panel.querySelectorAll('.tpl-rename-btn').forEach(btn => btn.addEventListener('click', () => enterRenameMode(btn.closest('td'))));
  panel.querySelectorAll('.tpl-rename-ok').forEach(btn  => btn.addEventListener('click', () => saveRename(btn.closest('td'))));
  panel.querySelectorAll('.tpl-rename-x').forEach(btn   => btn.addEventListener('click', () => exitRenameMode(btn.closest('td'))));
  panel.querySelectorAll('.tpl-rename-input').forEach(input =>
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  saveRename(input.closest('td'));
      if (e.key === 'Escape') exitRenameMode(input.closest('td'));
    })
  );

  // Status toggle
  panel.querySelectorAll('.tpl-status-cb').forEach(cb =>
    cb.addEventListener('change', e => {
      updateTemplate(e.target.dataset.id, { active: e.target.checked });
      const label = e.target.closest('label').querySelector('.tpl-status-label');
      if (label) label.textContent = e.target.checked ? 'Active' : 'Inactive';
    })
  );

  panel.querySelectorAll('.tpl-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const tpl = getTemplates().find(t => t.id === btn.dataset.id);
      if (tpl) openForm(tpl);
    })
  );

  panel.querySelectorAll('.tpl-delete-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const tpl = getTemplates().find(t => t.id === btn.dataset.id);
      if (!tpl) return;
      if (!confirm(`Delete template "${tpl.name}"? This cannot be undone.`)) return;
      deleteTemplate(btn.dataset.id);
      renderTemplatesSection();
    })
  );
}

// ── Form event wiring ─────────────────────────────────────
function wireFormEvents(backdrop, editingTpl) {
  backdrop.querySelector('#tpl-modal-close').addEventListener('click', closeForm);
  backdrop.querySelector('#tpl-cancel').addEventListener('click', closeForm);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeForm(); });

  const activeCb    = backdrop.querySelector('#tf-active-toggle');
  const activeLabel = backdrop.querySelector('#tf-active-label');
  activeCb.addEventListener('change', () => { activeLabel.textContent = activeCb.checked ? 'Active' : 'Inactive'; });

  // Market table events
  wireMarketEvents(backdrop);

  // Load from Feed
  backdrop.querySelector('#tpl-discover-btn')?.addEventListener('click', () => loadMarketsFromFeed(backdrop));

  // Save
  backdrop.querySelector('#tpl-save').addEventListener('click', () => {
    const nameInput = backdrop.querySelector('#tf-name');
    const name      = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      nameInput.classList.add('tpl-input-error');
      showTplToast('Template name is required.');
      return;
    }
    nameInput.classList.remove('tpl-input-error');

    const markets = collectMarketsFromForm(backdrop);

    const data = {
      name,
      sport:   backdrop.querySelector('#tf-sport-sel').value,
      type:    backdrop.querySelector('#tf-type-sel').value,
      active:  backdrop.querySelector('#tf-active-toggle').checked,
      markets,
    };

    if (editingTpl) {
      updateTemplate(editingTpl.id, data);
      showTplToast(`Template "${name}" updated.`);
    } else {
      addTemplate({ ...data, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      showTplToast(`Template "${name}" created.`);
    }

    closeForm();
    renderTemplatesSection();
  });
}

// ── Toast ─────────────────────────────────────────────────
function showTplToast(msg) {
  let toast = document.getElementById('admin-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'admin-toast';
    toast.className = 'admin-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), 3500);
}
