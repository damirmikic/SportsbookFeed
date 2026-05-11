import { state, getOverride, setOverride, getOverrideMeta, setOverrideWithMeta, updateOverrideAlertState, setTradingMode, getOverriddenLambdas, setOverriddenLambdas, isSuspended, isSelectionSuspended, setSuspension, clearOverride, clearOverrideMetaSelection, hasAnyOverrideForEvent, clearOverriddenLambdas } from './state.js';
import { resolveTemplate, getMarketConfig, resolveActiveKey } from './pricing.js';
import { calculateShinNoVig, solveLambdasAsync, applyMarginAndLadder } from './math.js';
import { calcMargin, marginBadgeHTML } from './ui-helpers.js';
import { updateModeButton, renderDrawerMarkets } from './ui-drawer.js';

// ── Lambda back-solve ─────────────────────────────────────────────────────────

async function solveLambdasFromOverrides(eventId, changedMarketId, changedRows, drawerEvent) {
  let pH = null, pD = null, pA = null;
  const ouLines = [];

  const getMatchPeriod = (ev) => {
    if (!ev) return null;
    if (ev.periods && !Array.isArray(ev.periods)) return ev.periods['0'];
    const arr = Array.isArray(ev.periods) ? ev.periods : Object.values(ev.periods || {});
    return arr.find(p => p.num === 0 || p.periodNumber === 0) || arr[0];
  };
  const mp = getMatchPeriod(drawerEvent);

  if (changedMarketId === 'ml') {
    const prices = changedRows.map(r => {
      const ov = getOverride(`${eventId}|ml|${r.label}`);
      return ov ? parseFloat(ov) : parseFloat(r.value);
    });
    if (prices.length === 3 && prices.every(p => p > 1)) {
      const shins = calculateShinNoVig(prices);
      const raw   = shins.map(s => 1 / parseFloat(s));
      const sum   = raw.reduce((a, b) => a + b, 0);
      [pH, pD, pA] = raw.map(p => p / sum);
    }
  } else {
    const mlMeta    = getOverrideMeta(eventId, 'ml');
    const mlEntries = mlMeta?.selections ? Object.values(mlMeta.selections) : [];
    if (mlEntries.length === 3 && mlEntries.every(s => s.overridePrice > 1)) {
      const prices = mlEntries.map(s => s.overridePrice);
      const shins  = calculateShinNoVig(prices);
      const raw    = shins.map(s => 1 / parseFloat(s));
      const sum    = raw.reduce((a, b) => a + b, 0);
      [pH, pD, pA] = raw.map(p => p / sum);
    } else if (mp) {
      const ml = mp.moneyLine || mp.moneyline;
      if (ml) {
        const hO = parseFloat(ml.homePrice || ml.home);
        const dO = parseFloat(ml.drawPrice || ml.draw);
        const aO = parseFloat(ml.awayPrice || ml.away);
        if (!isNaN(hO) && !isNaN(dO) && !isNaN(aO)) {
          const shins = calculateShinNoVig([hO, dO, aO]);
          const raw   = shins.map(s => 1 / parseFloat(s));
          const sum   = raw.reduce((a, b) => a + b, 0);
          [pH, pD, pA] = raw.map(p => p / sum);
        }
      }
    }
  }

  // Collect OU lines (prefer overrides; fall back to raw market data for each target line).
  const seen = new Set();
  for (const target of [1.5, 2.5, 3.5]) {
    const labelO = `Over ${target}`, labelU = `Under ${target}`;
    const ovO = getOverride(`${eventId}|ou|${labelO}`);
    const ovU = getOverride(`${eventId}|ou|${labelU}`);
    if (ovO && ovU) {
      const shins = calculateShinNoVig([parseFloat(ovO), parseFloat(ovU)]);
      const f = parseFloat(shins[0]);
      if (!isNaN(f) && f > 1 && !seen.has(target)) { seen.add(target); ouLines.push({ line: target, pOver: 1 / f }); }
    } else if (mp?.overUnder) {
      const ou = mp.overUnder.find(o => parseFloat(o.points) === target)
        ?? mp.overUnder.reduce((b, o) =>
          Math.abs(parseFloat(o.points) - target) < Math.abs(parseFloat(b.points) - target) ? o : b
        );
      if (ou) {
        const line = parseFloat(ou.points);
        if (!seen.has(line)) {
          const shins = calculateShinNoVig([ou.overOdds, ou.underOdds]);
          const f = parseFloat(shins[0]);
          if (!isNaN(f) && f > 1) { seen.add(line); ouLines.push({ line, pOver: 1 / f }); }
        }
      }
    }
  }

  if (pH === null || pD === null || pA === null) return;

  const { lh, la, rho, grid } = await solveLambdasAsync(pH, pD, pA, ouLines);
  setOverriddenLambdas(eventId, { lh, la, rho, grid });
}

// ── Reprice helpers ───────────────────────────────────────────────────────────

function applyTargetMargin(eventId, marketId, rows, targetMarginPct) {
  const M = targetMarginPct / 100;
  const effectivePrice = (row) => {
    const k = `${eventId}|${marketId}|${row.label}`;
    return parseFloat(getOverride(k) || row.value);
  };
  const applyToGroup = (group) => {
    const valid    = group.filter(r => { const p = effectivePrice(r); return !isNaN(p) && p > 1; });
    if (valid.length < 2) return;
    const impProbs  = valid.map(r => 1 / effectivePrice(r));
    const total     = impProbs.reduce((a, b) => a + b, 0);
    const fairProbs = impProbs.map(q => q / total);
    valid.forEach((row, i) => {
      const newPrice = 1 / (fairProbs[i] * M);
      if (newPrice > 1) setOverride(`${eventId}|${marketId}|${row.label}`, newPrice);
    });
  };
  if (rows.length > 3) {
    for (let i = 0; i < rows.length; i += 2) applyToGroup(rows.slice(i, i + 2));
  } else {
    applyToGroup(rows);
  }
}

function repriceOthers(changedKey, newPrice, rows, marketId, targetMargin = null) {
  const changedLabel = changedKey.split('|')[2];
  const effectivePrice = (row) => {
    const k = `${state.drawerEventId}|${marketId}|${row.label}`;
    return parseFloat(getOverride(k) || row.value);
  };
  const valid = rows.filter(r => { const p = effectivePrice(r); return !isNaN(p) && p > 1; });
  if (valid.length < 2) return;
  const M        = targetMargin ?? valid.reduce((s, r) => s + 1 / effectivePrice(r), 0);
  const q_new    = 1 / newPrice;
  const budget   = M - q_new;
  const others   = valid.filter(r => r.label !== changedLabel);
  const otherSum = others.reduce((s, r) => s + 1 / effectivePrice(r), 0);
  if (budget <= 0 || otherSum <= 0) return;
  const scale = budget / otherSum;
  others.forEach(r => {
    const qNew = (1 / effectivePrice(r)) * scale;
    if (qNew > 0 && 1 / qNew > 1) setOverride(`${state.drawerEventId}|${marketId}|${r.label}`, 1 / qNew);
  });
}

function resolveTargetMargin(eventId, leagueCode, marketId, repriceRows) {
  const { template } = resolveTemplate(eventId, leagueCode);
  const marketConf   = template ? getMarketConfig(template, marketId) : null;
  if (marketConf?.margin != null) return 1 + marketConf.margin / 100;
  return repriceRows.reduce((s, r) => {
    const p = parseFloat(r.value);
    return (!isNaN(p) && p > 1) ? s + 1 / p : s;
  }, 0);
}

function makeEditable(chip, priceSpan, key, currentVal, rows = [], marketId = '', shinFair = null, apiVal = null) {
  const input = document.createElement('input');
  input.type      = 'number';
  input.step      = '0.01';
  input.min       = '1.01';
  input.value     = currentVal;
  input.className = 'price-edit-input';
  priceSpan.replaceWith(input);
  input.focus();
  input.select();

  const confirm = () => {
    const val = parseFloat(input.value);
    if (val > 1) {
      setOverride(key, val);
      const [evId, mktId, label] = key.split('|');
      if (rows.length > 1 && marketId) {
        repriceOthers(key, val, rows, marketId, resolveTargetMargin(evId, state.currentLeagueCode, marketId, rows));
      }
      const shinFairOdds = parseFloat(shinFair);
      const refOdds      = parseFloat(apiVal) || shinFairOdds;
      const direction    = (!isNaN(refOdds) && refOdds > 1) ? (val < refOdds ? 'DOWN' : 'UP') : 'UP';
      if (!isNaN(shinFairOdds) && shinFairOdds > 1) {
        setOverrideWithMeta(evId, mktId, label, val, direction, shinFairOdds);
        const gap = val - shinFairOdds;
        updateOverrideAlertState(evId, mktId, gap > 0 ? 'VALUE_BET' : 'CLEAN', Math.max(0, gap));
      }
      setTradingMode(state.drawerEventId, 'manual');
      updateModeButton(state.drawerEventId);
      const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
      if (ev) renderDrawerMarkets(ev);
    } else {
      input.replaceWith(priceSpan);
    }
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') input.replaceWith(priceSpan);
  });
  input.addEventListener('blur', confirm);
}

// ── Comparison table ──────────────────────────────────────────────────────────

export function renderMarketTable(market) {
  const isOverridable = market.id === 'ml' || market.id === 'ou';
  const marketSuspended = isSuspended(state.drawerEventId, market.id);

  const wrapper = document.createElement('div');
  wrapper.className = 'comparison-table-wrapper';

  const marketAlertMeta = isOverridable ? getOverrideMeta(state.drawerEventId, market.id) : null;
  if (marketAlertMeta?.alertState === 'VALUE_BET') {
    const banner = document.createElement('div');
    banner.className = 'market-value-bet-banner';
    banner.textContent = `⚠ Value bet exposure — override exceeds Shin fair by ${marketAlertMeta.valueBetGap.toFixed(2)}`;
    wrapper.appendChild(banner);
  }

  const DRAWER_TO_TPL_ID = { ml: '1x2', hdp: 'asian_hcp', ou: 'ou25' };
  const tplMarketId = DRAWER_TO_TPL_ID[market.id] ?? market.id;

  const drawerEvent  = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
  const eventStart   = drawerEvent?.starts || drawerEvent?.startTime || drawerEvent?.time;
  const { template: offerTpl } = resolveTemplate(state.drawerEventId, state.currentLeagueCode);
  const offerMktConf = offerTpl ? getMarketConfig(offerTpl, tplMarketId) : null;

  const computeOffer = (row) => {
    const ov = getOverride(`${state.drawerEventId}|${market.id}|${row.label}`);
    if (ov) return parseFloat(ov);

    const ovLambdas = getOverriddenLambdas(state.drawerEventId);
    if (ovLambdas) {
      const modelFair = parseFloat(row.modelFair);
      if (!isNaN(modelFair) && modelFair > 1) {
        if (offerMktConf?.enabled) {
          let marginPct = offerMktConf.margin;
          if (eventStart) {
            const tl = resolveActiveKey(offerMktConf, eventStart);
            if (tl?.key != null) marginPct = tl.key;
          }
          if (marginPct != null) {
            const offered = applyMarginAndLadder(modelFair, marginPct, offerMktConf.ladder ?? 'eu');
            if (offered) return offered;
          }
        }
        const rowIdx    = market.rows.indexOf(row);
        const isPaired  = market.id === 'ou' || market.id === 'hdp';
        const groupStart = isPaired ? Math.floor(rowIdx / 2) * 2 : 0;
        const groupRows  = isPaired ? market.rows.slice(groupStart, groupStart + 2) : market.rows;
        const apiPrices  = groupRows.map(r => parseFloat(r.value)).filter(p => !isNaN(p) && p > 1);
        if (apiPrices.length >= 2) {
          const expectedSum   = market.id === 'dc' ? 2.0 : 1.0;
          const effectiveMargin = apiPrices.reduce((s, p) => s + 1 / p, 0) / expectedSum;
          if (effectiveMargin > 1) return modelFair / effectiveMargin;
        }
        return modelFair;
      }
    }

    if (offerMktConf?.enabled) {
      let marginPct = offerMktConf.margin;
      if (eventStart) {
        const tl = resolveActiveKey(offerMktConf, eventStart);
        if (tl?.key != null) marginPct = tl.key;
      }
      if (marginPct != null) {
        const shin  = parseFloat(row.shinFair);
        const model = parseFloat(row.modelFair);
        // Prefer shin fair; fall back to model fair for derived markets that lack independent devig
        const fair  = (!isNaN(shin)  && shin  > 1) ? shin
                    : (!isNaN(model) && model > 1) ? model
                    : NaN;
        if (!isNaN(fair)) {
          const offered = applyMarginAndLadder(fair, marginPct, offerMktConf.ladder ?? 'eu');
          if (offered) return offered;
          // applyMarginAndLadder returned null (margined ≤ 1) — fall through to api
        }
      }
    }

    const api = parseFloat(row.value);
    return (!isNaN(api) && api > 1) ? api : null;
  };

  const hasAnyOffer = market.rows.some(row => { const o = computeOffer(row); return o !== null && o > 1; });
  const effectivelySuspended = marketSuspended || !hasAnyOffer;
  if (effectivelySuspended) wrapper.classList.add('market-table-suspended');

  const table = document.createElement('table');
  table.className = 'comparison-table';

  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th class="market-name-th">
        <span>${market.name}</span>
        <button class="suspend-market-btn ${effectivelySuspended ? 'suspended' : 'open'}"
          ${!hasAnyOffer ? 'disabled title="No offer configured — assign a template to enable this market"' : `title="${marketSuspended ? 'Market suspended — click to publish' : 'Suspend this market'}"`}>
          ${effectivelySuspended ? '🔒 SUSPENDED' : '🔓 PUBLISHED'}
        </button>
      </th>
      <th class="offer-header" style="text-align: right;">Offer</th>
      <th style="text-align: right;">Shin (Fair)</th>
      <th style="text-align: right;">Model (Fair)</th>
      <th style="text-align: right;">Pinnacle (API)</th>
      <th style="text-align: right;">Bet365</th>
      <th style="text-align: right;">Dafabet</th>
      ${isOverridable ? '<th style="text-align: right; width: 130px;">Override</th>' : ''}
    </tr>
  `;
  if (hasAnyOffer) {
    thead.querySelector('.suspend-market-btn').addEventListener('click', e => {
      e.stopPropagation();
      const nowSusp = isSuspended(state.drawerEventId, market.id);
      setSuspension(state.drawerEventId, market.id, nowSusp ? 'open' : 'suspended');
      const ev = state.activeEvents.find(ev2 => ev2.id.toString() === state.drawerEventId?.toString());
      if (ev) renderDrawerMarkets(ev);
    });
  }
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  market.rows.forEach(row => {
    const selSusp = isSelectionSuspended(state.drawerEventId, market.id, row.label);
    const tr = document.createElement('tr');
    if (selSusp) tr.classList.add('selection-suspended');

    const fmtPrice = v => {
      const n = parseFloat(v);
      return (!isNaN(n) && n > 1) ? n.toFixed(2) : '-';
    };

    const shinVal  = fmtPrice(row.shinFair);
    const modelVal = fmtPrice(row.modelFair);
    const pinVal   = fmtPrice(row.value);

    const overrideKey     = `${state.drawerEventId}|${market.id}|${row.label}`;
    const currentOverride = getOverride(overrideKey);
    const ovValue         = currentOverride ? parseFloat(currentOverride).toFixed(2) : '';

    const getEdgeClass = (model, shin) => {
      const nm = parseFloat(model), ns = parseFloat(shin);
      if (isNaN(nm) || isNaN(ns)) return '';
      const diff = nm - ns;
      if (diff < -0.05) return 'price-higher';
      if (diff > 0.05)  return 'price-lower';
      return '';
    };

    const tdLabel = document.createElement('td');
    tdLabel.className = 'selection-label-cell';

    const suspSelBtn = document.createElement('button');
    suspSelBtn.className = `suspend-sel-btn ${selSusp ? 'suspended' : 'open'}`;
    suspSelBtn.textContent = selSusp ? '🔒' : '🔓';
    suspSelBtn.title = selSusp ? 'Selection suspended — click to publish' : 'Suspend this selection';
    suspSelBtn.addEventListener('click', e => {
      e.stopPropagation();
      const nowSusp = isSelectionSuspended(state.drawerEventId, market.id, row.label);
      setSuspension(state.drawerEventId, `${market.id}|${row.label}`, nowSusp ? 'open' : 'suspended');
      const ev = state.activeEvents.find(ev2 => ev2.id.toString() === state.drawerEventId?.toString());
      if (ev) renderDrawerMarkets(ev);
    });
    tdLabel.appendChild(suspSelBtn);
    tdLabel.appendChild(document.createTextNode(row.label));

    const offerOdds    = computeOffer(row);
    const offerDisplay = offerOdds && offerOdds > 1 ? offerOdds.toFixed(2) : '-';
    const tdOffer = document.createElement('td');
    tdOffer.className   = offerDisplay !== '-' ? 'offer-cell' : 'empty-cell';
    tdOffer.textContent = offerDisplay;

    const tdShin = document.createElement('td');
    tdShin.className   = shinVal !== '-' ? 'price-cell' : 'empty-cell';
    tdShin.textContent = shinVal;

    const tdModel = document.createElement('td');
    tdModel.className   = `${modelVal !== '-' ? 'price-cell' : 'empty-cell'} ${getEdgeClass(modelVal, shinVal)}`;
    tdModel.textContent = modelVal;

    const tdPin = document.createElement('td');
    tdPin.className   = pinVal !== '-' ? 'price-cell' : 'empty-cell';
    tdPin.textContent = pinVal;

    const tdBet365 = document.createElement('td');
    tdBet365.className   = 'empty-cell';
    tdBet365.textContent = '-';

    const tdDafabet = document.createElement('td');
    tdDafabet.className   = 'empty-cell';
    tdDafabet.textContent = '-';

    tr.appendChild(tdLabel);
    tr.appendChild(tdOffer);
    tr.appendChild(tdShin);
    tr.appendChild(tdModel);
    tr.appendChild(tdPin);
    tr.appendChild(tdBet365);
    tr.appendChild(tdDafabet);

    if (isOverridable) {
      const tdOverride = document.createElement('td');
      tdOverride.className = 'override-input-cell';
      const input = document.createElement('input');
      input.type        = 'number';
      input.className   = 'table-override-input';
      input.step        = '0.01';
      input.min         = '1.01';
      input.max         = '999.99';
      input.value       = ovValue;
      const offerForPh  = computeOffer(row);
      input.placeholder = (offerForPh && offerForPh > 1) ? offerForPh.toFixed(2) : '-';

      const confirmOverride = async () => {
        const val = parseFloat(input.value);
        if (!(val > 1)) return;

        setOverride(overrideKey, val);

        const rowIdx      = market.rows.indexOf(row);
        const pairStart   = Math.floor(rowIdx / 2) * 2;
        const repriceRows = market.id === 'ou'
          ? market.rows.slice(pairStart, pairStart + 2)
          : market.rows;
        if (repriceRows.length > 1) {
          repriceOthers(overrideKey, val, repriceRows, market.id, resolveTargetMargin(state.drawerEventId, state.currentLeagueCode, market.id, repriceRows));
        }

        repriceRows.forEach(r => {
          const rOv  = r.label === row.label ? val : parseFloat(getOverride(`${state.drawerEventId}|${market.id}|${r.label}`));
          if (!(rOv > 1)) return;
          const rShin = parseFloat(r.shinFair);
          const rDir  = rOv < parseFloat(r.value) ? 'DOWN' : 'UP';
          setOverrideWithMeta(state.drawerEventId, market.id, r.label, rOv, rDir, rShin);
        });

        let maxGap = 0, hasVB = false;
        repriceRows.forEach(r => {
          const rOv   = r.label === row.label ? val : parseFloat(getOverride(`${state.drawerEventId}|${market.id}|${r.label}`));
          const rShin = parseFloat(r.shinFair);
          if (rOv > 1 && rShin > 1 && rOv - rShin > 0) {
            hasVB = true;
            if (rOv - rShin > maxGap) maxGap = rOv - rShin;
          }
        });
        updateOverrideAlertState(state.drawerEventId, market.id, hasVB ? 'VALUE_BET' : 'CLEAN', maxGap);

        await solveLambdasFromOverrides(state.drawerEventId, market.id, market.rows, drawerEvent);
        setTradingMode(state.drawerEventId, 'manual');
        updateModeButton(state.drawerEventId);
        const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
        if (ev) renderDrawerMarkets(ev);
      };

      const saveBtn = document.createElement('button');
      saveBtn.className   = 'save-override-btn';
      saveBtn.textContent = '✓';
      saveBtn.title       = 'Save override and reprice others';
      saveBtn.addEventListener('click', e => { e.preventDefault(); confirmOverride(); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmOverride(); } });

      const inputWrapper = document.createElement('div');
      inputWrapper.className = 'override-input-wrapper';
      inputWrapper.appendChild(input);
      inputWrapper.appendChild(saveBtn);
      tdOverride.appendChild(inputWrapper);

      if (currentOverride) {
        const shinFairOdds = parseFloat(row.shinFair);
        if (!isNaN(shinFairOdds) && shinFairOdds > 1 && parseFloat(currentOverride) > shinFairOdds) {
          input.classList.add('value-bet-override');
          const gap     = (parseFloat(currentOverride) - shinFairOdds).toFixed(2);
          const gapSpan = document.createElement('span');
          gapSpan.className   = 'value-bet-gap';
          gapSpan.textContent = `⚠ +${gap}`;
          gapSpan.title       = `Override exceeds Shin fair by ${gap}`;
          tdOverride.appendChild(gapSpan);
        }
      }
      tr.appendChild(tdOverride);
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  const tfoot   = document.createElement('tfoot');
  const tfootTr = document.createElement('tr');
  tfootTr.className = 'margin-row';

  const getMarginHTML = (prop) => {
    let sum = 0, count = 0;
    market.rows.forEach(r => {
      let val = null;
      if (prop === 'override') {
        val = parseFloat(getOverride(`${state.drawerEventId}|${market.id}|${r.label}`));
      } else if (prop === 'offer') {
        val = computeOffer(r);
      } else {
        val = parseFloat(r[prop]);
      }
      if (!isNaN(val) && val > 1) { sum += 1 / val; count++; }
    });
    if (count === 0) return '<span class="empty-cell">-</span>';
    let expectedPairs = 1;
    if (market.id === 'hdp' || market.id === 'ou' || market.name.includes('Handicap') || market.name.includes('Total') || market.name.includes('Corners') || market.name.includes('Odd/Even') || market.name.includes('Bookings')) {
      if (count % 2 === 0) expectedPairs = count / 2;
    }
    if (market.name.includes('Double Chance')) expectedPairs = 2;
    if (market.id === 'home_multigoals' || market.id === 'away_multigoals') expectedPairs = count;
    if (market.id.startsWith('htft_total') || market.id === 'h1_or_ft') expectedPairs = 1;
    return marginBadgeHTML(sum / expectedPairs);
  };

  tfootTr.innerHTML = `
    <td><span class="margin-label">Margin (Avg)</span></td>
    <td style="text-align: right;">${getMarginHTML('offer')}</td>
    <td style="text-align: right;">${getMarginHTML('shinFair')}</td>
    <td style="text-align: right;">${getMarginHTML('modelFair')}</td>
    <td style="text-align: right;">${getMarginHTML('value')}</td>
    <td style="text-align: right;"><span class="empty-cell">-</span></td>
    <td style="text-align: right;"><span class="empty-cell">-</span></td>
    ${isOverridable ? `<td style="text-align: right; padding-right: 12px;">${getMarginHTML('override')}</td>` : ''}
  `;
  tfoot.appendChild(tfootTr);
  table.appendChild(tfoot);

  wrapper.appendChild(table);
  return wrapper;
}

// ── Market group (card-style, used for derived/legacy markets) ────────────────

export function createMarketGroup(title, rows, extraClass = '', hasShowAll = false, margin = null, marketId = '') {
  const mktSuspended = marketId ? isSuspended(state.drawerEventId, marketId) : false;
  const evtSuspended = state.drawerEventId ? isSuspended(state.drawerEventId, 'event') : false;
  const suspended    = mktSuspended || evtSuspended;

  const group = document.createElement('div');
  group.className = `market-group${suspended ? ' market-suspended' : ''}`;
  group.innerHTML = `
    <div class="market-header">
      <h3>${title}</h3>
      <div class="market-header-actions">
        ${marginBadgeHTML(margin)}
        ${hasShowAll ? '<button class="show-all-btn">Show All</button>' : ''}
        ${marketId ? `<button class="suspend-market-btn ${suspended ? 'suspended' : 'open'}" title="${suspended ? 'Market suspended — click to publish' : 'Suspend this market'}">${suspended ? '🔒 SUSPENDED' : '🔓 PUBLISHED'}</button>` : ''}
        <span style="font-size:0.8rem">▼</span>
      </div>
    </div>
    <div class="market-grid ${extraClass}"></div>
  `;

  const suspendBtn = group.querySelector('.suspend-market-btn');
  if (suspendBtn && marketId) {
    suspendBtn.addEventListener('click', e => {
      e.stopPropagation();
      const nowSusp = isSuspended(state.drawerEventId, marketId);
      setSuspension(state.drawerEventId, marketId, nowSusp ? 'open' : 'suspended');
      const row = document.querySelector(`tr[data-event-id="${state.drawerEventId}"]`);
      if (row) {
        const isMLmarket = ['ml'].includes(marketId);
        const isOUmarket = ['ou'].includes(marketId);
        row.querySelectorAll('td').forEach((td, i) => {
          if ((isMLmarket && i >= 1 && i <= 3) || (isOUmarket && i >= 4)) {
            td.classList.toggle('susp-cell', !nowSusp);
            const btn = td.querySelector('button');
            if (btn) btn.textContent = nowSusp ? (btn.dataset.orig || btn.textContent) : 'SUSP';
          }
        });
      }
      suspendBtn.innerHTML  = !nowSusp ? '🔒 SUSPENDED' : '🔓 PUBLISHED';
      suspendBtn.className  = `suspend-market-btn ${!nowSusp ? 'suspended' : 'open'}`;
      suspendBtn.title      = !nowSusp ? 'Market suspended — click to publish' : 'Suspend this market';
      const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
      if (ev) renderDrawerMarkets(ev);
    });
  }

  const grid = group.querySelector('.market-grid');

  if (marketId && !evtSuspended) {
    const actionsDiv  = group.querySelector('.market-header-actions');
    const marginInput = document.createElement('input');
    marginInput.type        = 'number';
    marginInput.className   = 'margin-target-input';
    marginInput.min         = '100';
    marginInput.max         = '120';
    marginInput.step        = '0.1';
    const curM = calcMargin(rows);
    marginInput.placeholder = curM ? `${(curM * 100).toFixed(1)}%` : '105.0%';
    marginInput.title       = 'Type target margin % and press Enter';

    const confirmMargin = () => {
      const val = parseFloat(marginInput.value);
      if (!isNaN(val) && val >= 100 && val <= 120) {
        applyTargetMargin(state.drawerEventId, marketId, rows, val);
        setTradingMode(state.drawerEventId, 'manual');
        updateModeButton(state.drawerEventId);
        const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
        if (ev) renderDrawerMarkets(ev);
      } else {
        marginInput.value = '';
      }
    };

    marginInput.addEventListener('click',   e => e.stopPropagation());
    marginInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); confirmMargin(); }
      if (e.key === 'Escape') { marginInput.value = ''; marginInput.blur(); }
    });
    marginInput.addEventListener('blur', () => { if (marginInput.value) confirmMargin(); });

    const suspBtn = actionsDiv.querySelector('.suspend-market-btn');
    if (suspBtn) actionsDiv.insertBefore(marginInput, suspBtn);
    else         actionsDiv.appendChild(marginInput);
  }

  rows.forEach(row => {
    const item = document.createElement('div');
    item.className = 'market-row';

    const overrideKey  = marketId ? `${state.drawerEventId}|${marketId}|${row.label}` : null;
    const overrideVal  = overrideKey ? getOverride(overrideKey) : null;
    const isOverridden = !!overrideVal;
    const displayPrice = overrideVal || row.value;

    const ovFloat   = parseFloat(overrideVal);
    const shinFloat = parseFloat(row.shinFair);
    const isValueBet = isOverridden && !isNaN(ovFloat) && !isNaN(shinFloat) && shinFloat > 1 && ovFloat > shinFloat;

    const probBadge = row.prob != null
      ? `<span class="prob-badge">${(row.prob * 100).toFixed(1)}%</span>` : '';

    const labelEl = document.createElement('span');
    labelEl.className = 'market-label';
    labelEl.innerHTML = `${row.label}${probBadge}`;

    const oddsComp = document.createElement('div');
    oddsComp.className = 'odds-comparison';

    const bookieChip = document.createElement('div');
    bookieChip.className = `price-chip bookie${isOverridden ? ' overridden' : ''}${overrideKey ? ' editable' : ''}${isValueBet ? ' value-bet-chip' : ''}`;
    bookieChip.title     = overrideKey ? (isOverridden ? 'Click price to edit override' : 'Click to override price') : '';

    const chipLabel = document.createElement('span');
    chipLabel.className   = 'chip-label';
    chipLabel.textContent = isOverridden ? 'M' : (row.fair || row.isApiOnly ? 'API' : 'Fair');

    const priceSpan = document.createElement('span');
    priceSpan.className   = 'market-value';
    priceSpan.textContent = displayPrice;

    bookieChip.appendChild(chipLabel);
    bookieChip.appendChild(priceSpan);

    if (overrideKey) {
      if (isOverridden) {
        const clearBtn = document.createElement('span');
        clearBtn.className   = 'clear-override-btn';
        clearBtn.textContent = '×';
        clearBtn.title       = 'Clear override';
        clearBtn.addEventListener('click', e => {
          e.stopPropagation();
          clearOverride(overrideKey);
          const [evId, mktId, lbl] = overrideKey.split('|');
          clearOverrideMetaSelection(evId, mktId, lbl);
          if (!hasAnyOverrideForEvent(evId)) {
            setTradingMode(evId, 'auto');
            clearOverriddenLambdas(evId);
            updateModeButton(evId);
          }
          const ev = state.activeEvents.find(e => e.id.toString() === state.drawerEventId?.toString());
          if (ev) renderDrawerMarkets(ev);
        });
        bookieChip.appendChild(clearBtn);
        priceSpan.style.cursor = 'pointer';
        priceSpan.addEventListener('click', () => makeEditable(bookieChip, priceSpan, overrideKey, displayPrice, rows, marketId, row.shinFair, row.value));
      } else {
        bookieChip.style.cursor = 'pointer';
        bookieChip.addEventListener('click', () => makeEditable(bookieChip, priceSpan, overrideKey, displayPrice, rows, marketId, row.shinFair, row.value));
      }
    }

    oddsComp.appendChild(bookieChip);

    if (row.fair && row.fair !== '-') {
      const fairChip = document.createElement('div');
      fairChip.className = 'price-chip fair';
      fairChip.innerHTML = `<span class="chip-label">Fair</span><span class="fair-value">${row.fair}</span>`;
      oddsComp.appendChild(fairChip);
    }

    item.appendChild(labelEl);
    item.appendChild(oddsComp);
    grid.appendChild(item);
  });

  return group;
}

// ── Dixon-Coles model summary card ───────────────────────────────────────────

export function createLambdaSection(lambdaData, homeTeam, awayTeam) {
  const section = document.createElement('div');
  section.className = 'lambda-section';
  const data      = lambdaData.ft;
  const topScores = [...data.grid].sort((a, b) => b.prob - a.prob).slice(0, 6);
  const scoresHtml = topScores.map(s =>
    `<div class="score-chip"><div class="score">${s.home}–${s.away}</div><div class="prob">${(s.prob * 100).toFixed(1)}%</div></div>`
  ).join('');
  const tPct = (lambdaData.splitFraction * 100).toFixed(1);
  section.innerHTML = `
    <h3 class="lambda-title">Dixon-Coles Model</h3>
    <div class="lambda-cards">
      <div class="lambda-card">
        <div class="team-name">${homeTeam}</div>
        <div class="lambda-value">${data.lh.toFixed(2)}</div>
        <div class="lambda-label">λ Expected Goals</div>
      </div>
      <div class="lambda-card">
        <div class="team-name">${awayTeam}</div>
        <div class="lambda-value">${data.la.toFixed(2)}</div>
        <div class="lambda-label">λ Expected Goals</div>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
      <div class="likely-scores-label" style="margin-bottom:0">Most Likely Scores</div>
      <div style="font-size:0.7rem;color:#64748b;text-align:right">
        <div>ρ = ${data.rho.toFixed(3)}</div>
        <div>H1 Split: ${tPct}%</div>
      </div>
    </div>
    <div class="likely-scores">${scoresHtml}</div>
  `;
  return section;
}
