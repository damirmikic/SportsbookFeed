import { calculateShinNoVig, dcAsianHandicapOdds, dcAsianTotalOdds, dcAsianTeamTotalOdds } from './math.js';
import { buildAllMarkets } from './markets.js';

export function groupMarketsByCategory(event, matchPeriod, h1Period, lambdaData, detailedAll, homeTeam, awayTeam) {
  const groups = {
    'MATCH ODDS': [],
    'HANDICAP': [],
    'GOALS': [],
    'TEAM GOALS': [],
    '1ST HALF': [],
    '2ND HALF': [],
    'CORNERS': [],
    'BOOKINGS': [],
    'TEAM PROPS': [],
    'SPECIALS': [],
    'PLAYER PROPS': []
  };

  // --- Main Markets ---
  let shin1X2 = null;
  if (matchPeriod.moneyLine || matchPeriod.moneyline) {
    const ml = matchPeriod.moneyLine || matchPeriod.moneyline;
    const odds = [ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away];
    shin1X2 = calculateShinNoVig(odds);
    const shin = shin1X2;
    let modelRows = [null, null, null];
    if (lambdaData) {
      let pH = 0, pD = 0, pA = 0;
      lambdaData.ft.grid.forEach(({ home, away, prob }) => {
        if (home > away) pH += prob; else if (home === away) pD += prob; else pA += prob;
      });
      modelRows = [(1/pH).toFixed(3), (1/pD).toFixed(3), (1/pA).toFixed(3)];
    }
    groups['MATCH ODDS'].push({
      id: 'ml',
      name: '1x2',
      rows: [
        { label: homeTeam, value: odds[0] || '-', shinFair: shin[0], modelFair: modelRows[0] },
        { label: 'Draw',   value: odds[1] || '-', shinFair: shin[1], modelFair: modelRows[1] },
        { label: awayTeam, value: odds[2] || '-', shinFair: shin[2], modelFair: modelRows[2] }
      ]
    });
  }

  if (matchPeriod.handicap && Array.isArray(matchPeriod.handicap)) {
    const fmt = s => { const n = parseFloat(s); return (n === 0 || isNaN(n)) ? '0' : (n > 0 ? `+${n}` : `${n}`); };
    let hdps = [...matchPeriod.handicap].sort((a, b) => parseFloat(a.homeSpread) - parseFloat(b.homeSpread));
    let minDiff = Infinity, balancedIdx = 0;
    hdps.forEach((h, i) => {
      const diff = Math.abs(parseFloat(h.homeOdds) - parseFloat(h.awayOdds));
      if (diff < minDiff) { minDiff = diff; balancedIdx = i; }
    });
    let startIdx = Math.max(0, balancedIdx - 2);
    let endIdx = Math.min(hdps.length - 1, startIdx + 4);
    if (endIdx - startIdx < 4) startIdx = Math.max(0, endIdx - 4);
    const selectedHdps = hdps.slice(startIdx, endIdx + 1);

    const rows = [];
    selectedHdps.forEach(h => {
      const shin = calculateShinNoVig([h.homeOdds, h.awayOdds]);
      let mHome = null, mAway = null;
      if (lambdaData) {
        const homeOdds = dcAsianHandicapOdds(lambdaData.ft.grid, parseFloat(h.homeSpread), false);
        const awayOdds = dcAsianHandicapOdds(lambdaData.ft.grid, parseFloat(h.awaySpread), true);
        if (homeOdds) mHome = homeOdds.toFixed(3);
        if (awayOdds) mAway = awayOdds.toFixed(3);
      }
      rows.push({ label: `Home ${fmt(h.homeSpread)}`, value: h.homeOdds, shinFair: shin[0], modelFair: mHome });
      rows.push({ label: `Away ${fmt(h.awaySpread)}`, value: h.awayOdds, shinFair: shin[1], modelFair: mAway });
    });
    groups['HANDICAP'].push({ id: 'hdp', name: 'Handicap (Best 5)', rows });
  }

  if (matchPeriod.overUnder && Array.isArray(matchPeriod.overUnder)) {
    const rows = [];
    const ous = [...matchPeriod.overUnder].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
    ous.forEach(ou => {
      const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
      let mOver = null, mUnder = null;
      if (lambdaData) {
        const line = parseFloat(ou.points);
        const overOdds  = dcAsianTotalOdds(lambdaData.ft.grid, line, true);
        const underOdds = dcAsianTotalOdds(lambdaData.ft.grid, line, false);
        if (overOdds)  mOver  = overOdds.toFixed(3);
        if (underOdds) mUnder = underOdds.toFixed(3);
      }
      rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
      rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
    });
    groups['GOALS'].push({ id: 'ou', name: 'Total (All Lines)', rows });
  }

  const detailedFTPeriod = detailedAll?.normal?.periods?.['0'];
  const ftTeamTotals = matchPeriod.teamTotals || matchPeriod.teamTotal ||
                       detailedFTPeriod?.teamTotals || detailedFTPeriod?.teamTotal;
  if (ftTeamTotals) {
    const processTeamTotal = (tt, labelPrefix, teamName, isAway) => {
      let ousArray = null;
      if (Array.isArray(tt)) ousArray = tt;
      else if (tt?.overUnder) ousArray = tt.overUnder;
      else if (tt?.points !== undefined) ousArray = [tt];
      if (!ousArray || !Array.isArray(ousArray)) return;
      const rows = [];
      const ous = [...ousArray].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
      ous.forEach(ou => {
        const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        let mOver = null, mUnder = null;
        if (lambdaData) {
          const line = parseFloat(ou.points);
          const overOdds  = dcAsianTeamTotalOdds(lambdaData.ft.grid, line, true, isAway);
          const underOdds = dcAsianTeamTotalOdds(lambdaData.ft.grid, line, false, isAway);
          if (overOdds)  mOver  = overOdds.toFixed(3);
          if (underOdds) mUnder = underOdds.toFixed(3);
        }
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
      });
      if (rows.length > 0) groups['TEAM GOALS'].push({ id: `tt_${labelPrefix}`, name: `${teamName} Totals`, rows });
    };
    processTeamTotal(ftTeamTotals.homeLines || ftTeamTotals.home, 'home', homeTeam, false);
    processTeamTotal(ftTeamTotals.awayLines || ftTeamTotals.away, 'away', awayTeam, true);
  }

  if (h1Period && (h1Period.moneyLine || h1Period.moneyline)) {
    const ml = h1Period.moneyLine || h1Period.moneyline;
    const odds = [ml.homePrice || ml.home, ml.drawPrice || ml.draw, ml.awayPrice || ml.away];
    const shin = calculateShinNoVig(odds);
    let modelRows = [null, null, null];
    if (lambdaData && lambdaData.h1) {
      let pH = 0, pD = 0, pA = 0;
      lambdaData.h1.grid.forEach(({ home, away, prob }) => {
        if (home > away) pH += prob; else if (home === away) pD += prob; else pA += prob;
      });
      modelRows = [(1/pH).toFixed(3), (1/pD).toFixed(3), (1/pA).toFixed(3)];
    }
    groups['1ST HALF'].push({
      id: 'h1_ml',
      name: '1st Half 1x2',
      rows: [
        { label: homeTeam, value: odds[0] || '-', shinFair: shin[0], modelFair: modelRows[0] },
        { label: 'Draw',   value: odds[1] || '-', shinFair: shin[1], modelFair: modelRows[1] },
        { label: awayTeam, value: odds[2] || '-', shinFair: shin[2], modelFair: modelRows[2] }
      ]
    });
  } else if (lambdaData && lambdaData.h1) {
    let pH = 0, pD = 0, pA = 0;
    lambdaData.h1.grid.forEach(({ home, away, prob }) => {
      if (home > away) pH += prob; else if (home === away) pD += prob; else pA += prob;
    });
    groups['1ST HALF'].push({
      id: 'h1_ml',
      name: '1st Half 1x2',
      rows: [
        { label: homeTeam, value: null, shinFair: null, modelFair: (1/pH).toFixed(3) },
        { label: 'Draw',   value: null, shinFair: null, modelFair: (1/pD).toFixed(3) },
        { label: awayTeam, value: null, shinFair: null, modelFair: (1/pA).toFixed(3) }
      ]
    });
  }

  if (h1Period && h1Period.overUnder && Array.isArray(h1Period.overUnder)) {
    const rows = [];
    const ous = [...h1Period.overUnder].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
    ous.forEach(ou => {
      const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
      let mOver = null, mUnder = null;
      if (lambdaData && lambdaData.h1) {
        const line = parseFloat(ou.points);
        const overOdds  = dcAsianTotalOdds(lambdaData.h1.grid, line, true);
        const underOdds = dcAsianTotalOdds(lambdaData.h1.grid, line, false);
        if (overOdds)  mOver  = overOdds.toFixed(3);
        if (underOdds) mUnder = underOdds.toFixed(3);
      }
      rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
      rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
    });
    groups['1ST HALF'].push({ id: 'h1_ou', name: '1st Half Total', rows });
  }

  const detailedH1Period = detailedAll?.normal?.periods?.['1'];
  const h1TeamTotals = (h1Period ? (h1Period.teamTotals || h1Period.teamTotal) : null) ||
                       detailedH1Period?.teamTotals || detailedH1Period?.teamTotal;
  if (h1TeamTotals) {
    const processTeamTotalH1 = (tt, labelPrefix, teamName, isAway) => {
      let ousArray = null;
      if (Array.isArray(tt)) ousArray = tt;
      else if (tt?.overUnder) ousArray = tt.overUnder;
      else if (tt?.points !== undefined) ousArray = [tt];
      if (!ousArray || !Array.isArray(ousArray)) return;
      const rows = [];
      const ous = [...ousArray].sort((a, b) => parseFloat(a.points) - parseFloat(b.points));
      ous.forEach(ou => {
        const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        let mOver = null, mUnder = null;
        if (lambdaData && lambdaData.h1) {
          const line = parseFloat(ou.points);
          const overOdds  = dcAsianTeamTotalOdds(lambdaData.h1.grid, line, true, isAway);
          const underOdds = dcAsianTeamTotalOdds(lambdaData.h1.grid, line, false, isAway);
          if (overOdds)  mOver  = overOdds.toFixed(3);
          if (underOdds) mUnder = underOdds.toFixed(3);
        }
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: mOver  });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: mUnder });
      });
      if (rows.length > 0) groups['1ST HALF'].push({ id: `h1_tt_${labelPrefix}`, name: `1st Half ${teamName} Totals`, rows });
    };
    processTeamTotalH1(h1TeamTotals.homeLines || h1TeamTotals.home, 'home', homeTeam, false);
    processTeamTotalH1(h1TeamTotals.awayLines || h1TeamTotals.away, 'away', awayTeam, true);
  }

  // --- Derived Markets ---
  if (lambdaData) {
    const derived = buildAllMarkets(lambdaData.ft.grid);
    const teamProps = detailedAll.specials?.find(s => s.code === 'team-props')?.events || [];
    const getPinnaclePrice = (marketId, label) => {
      let eventName = '';
      if (marketId === 'btts') eventName = 'Both Teams To Score?';
      else if (marketId === 'dnb') eventName = 'Draw No Bet';
      else if (marketId === 'dc') eventName = 'Double Chance';
      else if (marketId === 'cs') eventName = 'Correct Score';
      const mkt = teamProps.find(e => e.name === eventName);
      if (!mkt) return null;
      let pinLabel = label;
      if (marketId === 'dnb') {
        pinLabel = label === 'Home' ? homeTeam : awayTeam;
      } else if (marketId === 'dc') {
        if (label === '1X') pinLabel = `${homeTeam} Or Draw`;
        else if (label === 'X2') pinLabel = `Draw Or ${awayTeam}`;
        else if (label === '12') pinLabel = `${homeTeam} Or ${awayTeam}`;
      } else if (marketId === 'cs') {
        const parts = label.split('–');
        if (parts.length === 2) pinLabel = `${homeTeam} ${parts[0]}, ${awayTeam} ${parts[1]}`;
      }
      const contestant = mkt.contestants?.find(c => c.n === pinLabel);
      return contestant ? contestant.p : null;
    };

    derived.forEach(market => {
      const rows = market.selections.map(s => {
        const pinPrice = getPinnaclePrice(market.id, s.label);
        return {
          label: s.label,
          value: pinPrice || null,
          shinFair: null,
          modelFair: s.price,
          prob: s.prob,
          isApiOnly: false
        };
      });
      const withPin = rows.filter(r => r.value);
      if (withPin.length >= 2) {
        if (market.id === 'dc' && shin1X2) {
          const p1 = 1 / parseFloat(shin1X2[0]);
          const pX = 1 / parseFloat(shin1X2[1]);
          const p2 = 1 / parseFloat(shin1X2[2]);
          withPin.forEach(r => {
            if (r.label === '1X') r.shinFair = (1 / (p1 + pX)).toFixed(2);
            else if (r.label === '12') r.shinFair = (1 / (p1 + p2)).toFixed(2);
            else if (r.label === 'X2') r.shinFair = (1 / (pX + p2)).toFixed(2);
          });
        } else {
          const shinResults = calculateShinNoVig(withPin.map(r => r.value));
          withPin.forEach((r, i) => { r.shinFair = shinResults[i]; });
        }
      }
      const cat = market.id === 'cs' || market.id === 'btts' ? 'GOALS' : 'MATCH ODDS';
      groups[cat].push({ id: market.id, name: market.name, rows });
    });

    // --- Home & Away Multigoals ---
    const MULTIGOAL_RANGES = [
      { label: '1-2', check: k => k === 1 || k === 2 },
      { label: '1-3', check: k => k >= 1 && k <= 3 },
      { label: '2-3', check: k => k === 2 || k === 3 },
      { label: '4+',  check: k => k >= 4 },
    ];

    const buildMultigoalRows = (isAway) =>
      MULTIGOAL_RANGES.map(({ label, check }) => {
        let prob = 0;
        lambdaData.ft.grid.forEach(({ home, away, prob: p }) => {
          if (check(isAway ? away : home)) prob += p;
        });
        return { label, value: null, shinFair: null, modelFair: prob > 0 ? (1 / prob).toFixed(3) : null, prob };
      });

    groups['TEAM GOALS'].push({ id: 'home_multigoals', name: `${homeTeam} Multigoals`, rows: buildMultigoalRows(false) });
    groups['TEAM GOALS'].push({ id: 'away_multigoals', name: `${awayTeam} Multigoals`, rows: buildMultigoalRows(true) });

    // --- Double Chance & Total ---
    const DC_OUTCOMES = [
      { label: 'Home/Draw', check: (h, a) => h >= a },
      { label: 'Home/Away', check: (h, a) => h !== a },
      { label: 'Draw/Away', check: (h, a) => h <= a },
    ];

    [1.5, 2.5, 3.5].forEach(line => {
      const overThresh  = Math.ceil(line);
      const underThresh = Math.floor(line);
      const rows = [];
      ['Under', 'Over'].forEach(ouDir => {
        DC_OUTCOMES.forEach(({ label: dcLabel, check: dcCheck }) => {
          let prob = 0;
          lambdaData.ft.grid.forEach(({ home, away, prob: p }) => {
            const total = home + away;
            if (dcCheck(home, away) && (ouDir === 'Over' ? total >= overThresh : total <= underThresh)) prob += p;
          });
          rows.push({ label: `${dcLabel} & ${ouDir} ${line}`, value: null, shinFair: null, modelFair: prob > 0 ? (1 / prob).toFixed(3) : null, prob });
        });
      });
      groups['SPECIALS'].push({ id: `dc_total_${line.toString().replace('.', '')}`, name: `Double Chance & Total ${line}`, rows });
    });

    // --- Home/Away or BTTS / Over 2.5 ---
    const OR_MARKETS = [
      {
        id: 'home_or_btts',
        name: `${homeTeam} or BTTS`,
        cond: (h, a) => h > a || (h > 0 && a > 0),
      },
      {
        id: 'away_or_btts',
        name: `${awayTeam} or BTTS`,
        cond: (h, a) => a > h || (h > 0 && a > 0),
      },
      {
        id: 'home_or_over25',
        name: `${homeTeam} or Over 2.5`,
        cond: (h, a) => h > a || h + a >= 3,
      },
      {
        id: 'away_or_over25',
        name: `${awayTeam} or Over 2.5`,
        cond: (h, a) => a > h || h + a >= 3,
      },
    ];
    OR_MARKETS.forEach(({ id, name, cond }) => {
      let pYes = 0;
      lambdaData.ft.grid.forEach(({ home, away, prob: p }) => { if (cond(home, away)) pYes += p; });
      const pNo = 1 - pYes;
      groups['SPECIALS'].push({
        id,
        name,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: pYes > 0 ? (1 / pYes).toFixed(3) : null, prob: pYes },
          { label: 'No',  value: null, shinFair: null, modelFair: pNo  > 0 ? (1 / pNo).toFixed(3)  : null, prob: pNo  },
        ]
      });
    });

    if (lambdaData.h1 && lambdaData.h2) {
      const h1 = lambdaData.h1.grid;
      const h2 = lambdaData.h2.grid;
      let pH1home = 0, pH2home = 0, pH1away = 0, pH2away = 0;
      h1.forEach(({ home, away, prob }) => { if (home > 0) pH1home += prob; if (away > 0) pH1away += prob; });
      h2.forEach(({ home, away, prob }) => { if (home > 0) pH2home += prob; if (away > 0) pH2away += prob; });
      const pHomeBoth = pH1home * pH2home;
      const pAwayBoth = pH1away * pH2away;
      groups['TEAM PROPS'].push({
        id: 'home_score_both_halves',
        name: `${homeTeam} To Score In Both Halves`,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pHomeBoth).toFixed(3), prob: pHomeBoth },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pHomeBoth)).toFixed(3), prob: 1 - pHomeBoth }
        ]
      });
      groups['TEAM PROPS'].push({
        id: 'away_score_both_halves',
        name: `${awayTeam} To Score In Both Halves`,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pAwayBoth).toFixed(3), prob: pAwayBoth },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pAwayBoth)).toFixed(3), prob: 1 - pAwayBoth }
        ]
      });

      const pH1btts = h1.reduce((s, { home, away, prob }) => home > 0 && away > 0 ? s + prob : s, 0);
      groups['1ST HALF'].push({
        id: 'h1_btts',
        name: '1st Half Both Teams To Score',
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pH1btts).toFixed(3), prob: pH1btts },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pH1btts)).toFixed(3), prob: 1 - pH1btts }
        ]
      });

      const h1ResultBttsOutcomes = [
        { label: 'Home & Yes', resCheck: (h, a) => h > a, btts: true  },
        { label: 'Home & No',  resCheck: (h, a) => h > a, btts: false },
        { label: 'Draw & Yes', resCheck: (h, a) => h === a, btts: true  },
        { label: 'Draw & No',  resCheck: (h, a) => h === a, btts: false },
        { label: 'Away & Yes', resCheck: (h, a) => a > h, btts: true  },
        { label: 'Away & No',  resCheck: (h, a) => a > h, btts: false },
      ];
      const h1ResultBttsRows = h1ResultBttsOutcomes.map(({ label, resCheck, btts }) => {
        let prob = 0;
        h1.forEach(({ home, away, prob: p }) => {
          if (resCheck(home, away) && (home > 0 && away > 0) === btts) prob += p;
        });
        return { label, value: null, shinFair: null, modelFair: prob > 0 ? (1 / prob).toFixed(3) : null, prob };
      });
      groups['1ST HALF'].push({ id: 'h1_result_btts', name: '1st Half Result & BTTS', rows: h1ResultBttsRows });

      [1.5, 2.5].forEach(h1OuLine => {
        const h1OuThreshold = Math.ceil(h1OuLine);
        const h1ResultOuOutcomes = [
          { label: `Home & Over ${h1OuLine}`,  resCheck: (h, a) => h > a,   over: true  },
          { label: `Home & Under ${h1OuLine}`, resCheck: (h, a) => h > a,   over: false },
          { label: `Draw & Over ${h1OuLine}`,  resCheck: (h, a) => h === a,  over: true  },
          { label: `Draw & Under ${h1OuLine}`, resCheck: (h, a) => h === a,  over: false },
          { label: `Away & Over ${h1OuLine}`,  resCheck: (h, a) => a > h,   over: true  },
          { label: `Away & Under ${h1OuLine}`, resCheck: (h, a) => a > h,   over: false },
        ];
        const h1ResultOuRows = h1ResultOuOutcomes.map(({ label, resCheck, over }) => {
          let prob = 0;
          h1.forEach(({ home, away, prob: p }) => {
            if (resCheck(home, away) && (over ? home + away >= h1OuThreshold : home + away < h1OuThreshold)) prob += p;
          });
          return { label, value: null, shinFair: null, modelFair: prob > 0 ? (1 / prob).toFixed(3) : null, prob };
        });
        const idStr = `h1_result_ou_${h1OuLine.toString().replace('.', '')}`;
        groups['1ST HALF'].push({ id: idStr, name: `1st Half 1x2 & Total ${h1OuLine}`, rows: h1ResultOuRows });
      });

      // --- 1st Half Double Chance & Total ---
      [0.5, 1.5, 2.5].forEach(line => {
        const overThresh  = Math.ceil(line);
        const underThresh = Math.floor(line);
        const rows = [];
        ['Under', 'Over'].forEach(ouDir => {
          DC_OUTCOMES.forEach(({ label: dcLabel, check: dcCheck }) => {
            let prob = 0;
            h1.forEach(({ home, away, prob: p }) => {
              const total = home + away;
              if (dcCheck(home, away) && (ouDir === 'Over' ? total >= overThresh : total <= underThresh)) prob += p;
            });
            rows.push({ label: `${dcLabel} & ${ouDir} ${line}`, value: null, shinFair: null, modelFair: prob > 0 ? (1 / prob).toFixed(3) : null, prob });
          });
        });
        groups['1ST HALF'].push({ id: `h1_dc_total_${line.toString().replace('.', '')}`, name: `1st Half DC & Total ${line}`, rows });
      });

      // --- HT/FT & Total ---
      const HTFT_OUTCOMES = [
        { label: 'Home/Home', htCheck: (h, a) => h > a,   ftCheck: (fh, fa) => fh > fa   },
        { label: 'Home/Draw', htCheck: (h, a) => h > a,   ftCheck: (fh, fa) => fh === fa  },
        { label: 'Home/Away', htCheck: (h, a) => h > a,   ftCheck: (fh, fa) => fa > fh   },
        { label: 'Draw/Home', htCheck: (h, a) => h === a, ftCheck: (fh, fa) => fh > fa   },
        { label: 'Draw/Draw', htCheck: (h, a) => h === a, ftCheck: (fh, fa) => fh === fa  },
        { label: 'Draw/Away', htCheck: (h, a) => h === a, ftCheck: (fh, fa) => fa > fh   },
        { label: 'Away/Home', htCheck: (h, a) => a > h,   ftCheck: (fh, fa) => fh > fa   },
        { label: 'Away/Draw', htCheck: (h, a) => a > h,   ftCheck: (fh, fa) => fh === fa  },
        { label: 'Away/Away', htCheck: (h, a) => a > h,   ftCheck: (fh, fa) => fa > fh   },
      ];

      [1.5, 2.5, 3.5].forEach(line => {
        const overThresh  = Math.ceil(line);
        const underThresh = Math.floor(line);
        const rows = [];
        ['Under', 'Over'].forEach(ouDir => {
          HTFT_OUTCOMES.forEach(({ label: htftLabel, htCheck, ftCheck }) => {
            let prob = 0;
            h1.forEach(s1 => {
              if (!htCheck(s1.home, s1.away)) return;
              h2.forEach(s2 => {
                const ftHome = s1.home + s2.home;
                const ftAway = s1.away + s2.away;
                const total  = ftHome + ftAway;
                if (ftCheck(ftHome, ftAway) && (ouDir === 'Over' ? total >= overThresh : total <= underThresh)) prob += s1.prob * s2.prob;
              });
            });
            rows.push({ label: `${htftLabel} & ${ouDir} ${line}`, value: null, shinFair: null, modelFair: prob > 0 ? (1 / prob).toFixed(3) : null, prob });
          });
        });
        groups['SPECIALS'].push({ id: `htft_total_${line.toString().replace('.', '')}`, name: `HT/FT & Total ${line}`, rows });
      });

      // --- 1st Half Result Or Match Result ---
      let pHTH = 0, pHTD = 0, pHTA = 0;
      let pFTH = 0, pFTD = 0, pFTA = 0;
      let pSameH = 0, pSameD = 0, pSameA = 0;
      h1.forEach(s1 => {
        const htR = s1.home > s1.away ? 1 : s1.home === s1.away ? 0 : -1;
        if (htR === 1)  pHTH += s1.prob;
        else if (htR === 0) pHTD += s1.prob;
        else pHTA += s1.prob;
        h2.forEach(s2 => {
          const fh = s1.home + s2.home, fa = s1.away + s2.away;
          const ftR = fh > fa ? 1 : fh === fa ? 0 : -1;
          if (htR === 1  && ftR === 1)  pSameH += s1.prob * s2.prob;
          if (htR === 0  && ftR === 0)  pSameD += s1.prob * s2.prob;
          if (htR === -1 && ftR === -1) pSameA += s1.prob * s2.prob;
        });
      });
      lambdaData.ft.grid.forEach(({ home, away, prob: p }) => {
        if (home > away) pFTH += p;
        else if (home === away) pFTD += p;
        else pFTA += p;
      });
      const pHomeOr = pHTH + pFTH - pSameH;
      const pDrawOr = pHTD + pFTD - pSameD;
      const pAwayOr = pHTA + pFTA - pSameA;
      groups['SPECIALS'].push({
        id: 'h1_or_ft',
        name: '1st Half Result Or Match Result',
        rows: [
          { label: homeTeam, value: null, shinFair: null, modelFair: pHomeOr > 0 ? (1 / pHomeOr).toFixed(3) : null, prob: pHomeOr },
          { label: 'Draw',   value: null, shinFair: null, modelFair: pDrawOr > 0 ? (1 / pDrawOr).toFixed(3) : null, prob: pDrawOr },
          { label: awayTeam, value: null, shinFair: null, modelFair: pAwayOr > 0 ? (1 / pAwayOr).toFixed(3) : null, prob: pAwayOr },
        ]
      });

      const pH1over = h1.reduce((s, { home, away, prob }) => home + away >= 2 ? s + prob : s, 0);
      const pH2over = h2.reduce((s, { home, away, prob }) => home + away >= 2 ? s + prob : s, 0);
      const pBothOver = pH1over * pH2over;
      groups['GOALS'].push({
        id: 'both_halves_over15',
        name: 'Both Halves Over 1.5',
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pBothOver).toFixed(3), prob: pBothOver },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pBothOver)).toFixed(3), prob: 1 - pBothOver }
        ]
      });

      const pH1under = h1.reduce((s, { home, away, prob }) => home + away <= 1 ? s + prob : s, 0);
      const pH2under = h2.reduce((s, { home, away, prob }) => home + away <= 1 ? s + prob : s, 0);
      const pBothUnder = pH1under * pH2under;
      groups['GOALS'].push({
        id: 'both_halves_under15',
        name: 'Both Halves Under 1.5',
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pBothUnder).toFixed(3), prob: pBothUnder },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pBothUnder)).toFixed(3), prob: 1 - pBothUnder }
        ]
      });

      // --- 1st/2nd Half BTTS ---
      const pH2btts = h2.reduce((s, { home, away, prob: p }) => home > 0 && away > 0 ? s + p : s, 0);
      const pH1no = 1 - pH1btts, pH2no = 1 - pH2btts;
      const pNoNo   = pH1no   * pH2no;
      const pYesNo  = pH1btts * pH2no;
      const pYesYes = pH1btts * pH2btts;
      const pNoYes  = pH1no   * pH2btts;
      groups['GOALS'].push({
        id: 'h1h2_btts',
        name: '1st/2nd Half Both Teams To Score',
        rows: [
          { label: 'No/No',   value: null, shinFair: null, modelFair: pNoNo   > 0 ? (1 / pNoNo).toFixed(3)   : null, prob: pNoNo   },
          { label: 'Yes/No',  value: null, shinFair: null, modelFair: pYesNo  > 0 ? (1 / pYesNo).toFixed(3)  : null, prob: pYesNo  },
          { label: 'Yes/Yes', value: null, shinFair: null, modelFair: pYesYes > 0 ? (1 / pYesYes).toFixed(3) : null, prob: pYesYes },
          { label: 'No/Yes',  value: null, shinFair: null, modelFair: pNoYes  > 0 ? (1 / pNoYes).toFixed(3)  : null, prob: pNoYes  },
        ]
      });

      // --- Win Both Halves ---
      const pH1homeWin = h1.reduce((s, { home, away, prob: p }) => home > away ? s + p : s, 0);
      const pH2homeWin = h2.reduce((s, { home, away, prob: p }) => home > away ? s + p : s, 0);
      const pH1awayWin = h1.reduce((s, { home, away, prob: p }) => away > home ? s + p : s, 0);
      const pH2awayWin = h2.reduce((s, { home, away, prob: p }) => away > home ? s + p : s, 0);
      const pHomeWinBoth = pH1homeWin * pH2homeWin;
      const pAwayWinBoth = pH1awayWin * pH2awayWin;
      groups['TEAM PROPS'].push({
        id: 'home_win_both_halves',
        name: `${homeTeam} To Win Both Halves`,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pHomeWinBoth).toFixed(3), prob: pHomeWinBoth },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pHomeWinBoth)).toFixed(3), prob: 1 - pHomeWinBoth }
        ]
      });
      groups['TEAM PROPS'].push({
        id: 'away_win_both_halves',
        name: `${awayTeam} To Win Both Halves`,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pAwayWinBoth).toFixed(3), prob: pAwayWinBoth },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pAwayWinBoth)).toFixed(3), prob: 1 - pAwayWinBoth }
        ]
      });

      const pHomeWinEither = pH1homeWin + pH2homeWin - pHomeWinBoth;
      const pAwayWinEither = pH1awayWin + pH2awayWin - pAwayWinBoth;
      groups['TEAM PROPS'].push({
        id: 'home_win_either_half',
        name: `${homeTeam} To Win Either Half`,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pHomeWinEither).toFixed(3), prob: pHomeWinEither },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pHomeWinEither)).toFixed(3), prob: 1 - pHomeWinEither }
        ]
      });
      groups['TEAM PROPS'].push({
        id: 'away_win_either_half',
        name: `${awayTeam} To Win Either Half`,
        rows: [
          { label: 'Yes', value: null, shinFair: null, modelFair: (1 / pAwayWinEither).toFixed(3), prob: pAwayWinEither },
          { label: 'No',  value: null, shinFair: null, modelFair: (1 / (1 - pAwayWinEither)).toFixed(3), prob: 1 - pAwayWinEither }
        ]
      });

      // --- 2nd Half derived markets (Pinnacle doesn't offer these) ---
      let pH2win = 0, pH2draw = 0, pH2loss = 0;
      h2.forEach(({ home, away, prob: p }) => {
        if (home > away) pH2win += p;
        else if (home === away) pH2draw += p;
        else pH2loss += p;
      });
      groups['2ND HALF'].push({
        id: 'h2_ml',
        name: '2nd Half 1x2',
        rows: [
          { label: homeTeam, value: null, shinFair: null, modelFair: (1 / pH2win).toFixed(3) },
          { label: 'Draw',   value: null, shinFair: null, modelFair: (1 / pH2draw).toFixed(3) },
          { label: awayTeam, value: null, shinFair: null, modelFair: (1 / pH2loss).toFixed(3) }
        ]
      });

      const h2OuLines = h1Period && Array.isArray(h1Period.overUnder) && h1Period.overUnder.length
        ? [...new Set(h1Period.overUnder.map(o => parseFloat(o.points)).filter(l => !isNaN(l)))].sort((a, b) => a - b)
        : [0.5, 1, 1.5];

      const h2OuRows = [];
      h2OuLines.forEach(line => {
        const mOver  = dcAsianTotalOdds(h2, line, true);
        const mUnder = dcAsianTotalOdds(h2, line, false);
        if (mOver)  h2OuRows.push({ label: `Over ${line}`,  value: null, shinFair: null, modelFair: mOver.toFixed(3) });
        if (mUnder) h2OuRows.push({ label: `Under ${line}`, value: null, shinFair: null, modelFair: mUnder.toFixed(3) });
      });
      if (h2OuRows.length) groups['2ND HALF'].push({ id: 'h2_ou', name: '2nd Half Total', rows: h2OuRows });

      const addH2TeamTotal = (isAway, teamName, labelPrefix) => {
        const rows = [];
        h2OuLines.forEach(line => {
          const mOver  = dcAsianTeamTotalOdds(h2, line, true, isAway);
          const mUnder = dcAsianTeamTotalOdds(h2, line, false, isAway);
          if (mOver)  rows.push({ label: `Over ${line}`,  value: null, shinFair: null, modelFair: mOver.toFixed(3) });
          if (mUnder) rows.push({ label: `Under ${line}`, value: null, shinFair: null, modelFair: mUnder.toFixed(3) });
        });
        if (rows.length) groups['2ND HALF'].push({ id: `h2_tt_${labelPrefix}`, name: `2nd Half ${teamName} Totals`, rows });
      };
      addH2TeamTotal(false, homeTeam, 'home');
      addH2TeamTotal(true, awayTeam, 'away');
    }
  }

  // --- Corners (dedicated detailedAll.corners periods) ---
  if (detailedAll.corners?.periods) {
    const cp  = detailedAll.corners.periods;
    const c0  = cp['0'] || Object.values(cp).find(p => p.num === 0 || p.periodNumber === 0) || Object.values(cp)[0];
    const c1  = cp['1'] || Object.values(cp).find(p => p.num === 1 || p.periodNumber === 1);
    const fmt = s => { const n = parseFloat(s); return (n === 0 || isNaN(n)) ? '0' : (n > 0 ? `+${n}` : `${n}`); };

    const addCornerOU = (period, id, name) => {
      if (!period?.overUnder?.length) return;
      const rows = [];
      [...period.overUnder].sort((a, b) => parseFloat(a.points) - parseFloat(b.points)).forEach(ou => {
        const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: null });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: null });
      });
      groups['CORNERS'].push({ id, name, rows });
    };

    const addCornerHdp = (period, id, name) => {
      if (!period?.handicap?.length) return;
      const rows = [];
      [...period.handicap].sort((a, b) => parseFloat(a.homeSpread) - parseFloat(b.homeSpread)).forEach(h => {
        const shin = calculateShinNoVig([h.homeOdds, h.awayOdds]);
        rows.push({ label: `Home ${fmt(h.homeSpread)}`, value: h.homeOdds, shinFair: shin[0], modelFair: null });
        rows.push({ label: `Away ${fmt(h.awaySpread)}`, value: h.awayOdds, shinFair: shin[1], modelFair: null });
      });
      groups['CORNERS'].push({ id, name, rows });
    };

    const addCornerTeamTotal = (lines, id, name) => {
      if (!lines?.length) return;
      const rows = [];
      [...lines].sort((a, b) => parseFloat(a.points) - parseFloat(b.points)).forEach(ou => {
        const shin = calculateShinNoVig([ou.overOdds, ou.underOdds]);
        rows.push({ label: `Over ${ou.points}`,  value: ou.overOdds,  shinFair: shin[0], modelFair: null });
        rows.push({ label: `Under ${ou.points}`, value: ou.underOdds, shinFair: shin[1], modelFair: null });
      });
      groups['CORNERS'].push({ id, name, rows });
    };

    addCornerOU(c0,  'corner_ou',       'Corner Total (All Lines)');
    addCornerHdp(c0, 'corner_hdp',      'Corner Handicap');
    addCornerTeamTotal(c0?.teamTotals?.homeLines, 'corner_tt_home', `${homeTeam} Corners`);
    addCornerTeamTotal(c0?.teamTotals?.awayLines, 'corner_tt_away', `${awayTeam} Corners`);
    addCornerOU(c1,  'h1_corner_ou',    '1st Half Corner Total');
    addCornerHdp(c1, 'h1_corner_hdp',   '1st Half Corner Handicap');
  }

  // --- Additional Pinnacle Markets ---
  if (detailedAll.specials && Array.isArray(detailedAll.specials)) {
    detailedAll.specials.forEach(category => {
      if (!category.events || category.events.length === 0) return;

      category.events.forEach(mkt => {
        if (['Both Teams To Score?', 'Draw No Bet', 'Double Chance', 'Correct Score'].includes(mkt.name)) return;
        if (mkt.name.toLowerCase().includes('corner')) return;
        if (mkt.name.toLowerCase().includes('to score in both halves')) return;
        if (mkt.name.toLowerCase().includes('both halves over')) return;
        if (mkt.name.toLowerCase().includes('both halves under')) return;
        if (mkt.name.toLowerCase().includes('to win both halves')) return;
        if (mkt.name.toLowerCase().includes('to win either half')) return;
        if (!mkt.contestants || mkt.contestants.length === 0) return;

        const allPrices = mkt.contestants.map(c => parseFloat(c.p)).filter(p => !isNaN(p) && p > 1);
        const targetSum = mkt.name.toLowerCase().includes('double chance') ? 2.0 : 1.0;
        const shinAll   = allPrices.length >= 2 ? calculateShinNoVig(allPrices, targetSum) : allPrices.map(() => null);
        const rows = mkt.contestants.map((c, i) => ({
          label: c.n,
          value: c.p,
          shinFair: shinAll[i] ?? null,
          modelFair: getModelPriceForSpecial(mkt.name, c.n, lambdaData, homeTeam, awayTeam),
          isApiOnly: true
        }));

        const n = mkt.name.toLowerCase();
        let catName;

        if (n.includes('2nd half') || n.includes('second half')) {
          catName = '2ND HALF';
        } else if (n.includes('1st half') || n.includes('first half')) {
          catName = '1ST HALF';
        } else if (n.includes('booking') || n.includes('yellow card') || n.includes('red card') || n.includes('card')) {
          catName = 'BOOKINGS';
        } else if ((/^(home|away|[a-z ]+) goals/i.test(mkt.name) && !n.includes('total goals')) || n.includes('team total')) {
          catName = 'TEAM GOALS';
        } else if (n.includes('handicap') || n.includes('asian handicap') || n.includes('3-way handicap')) {
          catName = 'HANDICAP';
        } else if (
          category.code === 'player-props' ||
          n.includes('goalscorer') || n.includes('anytime scorer') ||
          n.includes('first scorer') || n.includes('last scorer') ||
          n.includes('player to score')
        ) {
          catName = 'PLAYER PROPS';
        } else if (
          n.includes('total goals') || n.includes('exact goals') || n.includes('goals range') ||
          n.includes('goals odd/even') || n.includes('odd/even') ||
          n.includes('either team to score') || n.includes('both teams to score') ||
          n.includes('anytime') || n.includes('over/under')
        ) {
          catName = 'GOALS';
        } else if (
          n.includes('first team to score') || n.includes('last team to score') ||
          n.includes('clean sheet') || n.includes('win to nil') ||
          n.includes('to win to nil') || n.includes('both halves') ||
          (n.includes('to score') && !n.includes('player') && !n.includes('anytime'))
        ) {
          catName = 'TEAM PROPS';
        } else if (
          n.includes('half time') || n.includes('ht/ft') || n.includes('halftime/fulltime') ||
          n.includes('half-time/full-time') || n.includes('winning margin') ||
          n.includes('winner') || n.includes('3-way') || n.includes('draw no bet')
        ) {
          catName = 'SPECIALS';
        } else {
          if (category.code === 'halves') catName = n.includes('2nd half') || n.includes('second half') ? '2ND HALF' : '1ST HALF';
          else catName = 'SPECIALS';
        }

        let marketDisplayName = mkt.name;
        if (catName === 'TEAM GOALS' && /^.+\s+goals$/i.test(mkt.name)) {
          marketDisplayName = mkt.name.replace(/\s+goals$/i, ' Exact Goals');
        }
        groups[catName].push({ id: `special_${mkt.id}`, name: marketDisplayName, rows });
      });
    });
  }

  Object.keys(groups).forEach(k => { if (groups[k].length === 0) delete groups[k]; });
  return groups;
}

function getModelPriceForSpecial(marketName, selectionLabel, lambdaData, homeTeam, awayTeam) {
  if (!lambdaData || !lambdaData.ft || !lambdaData.ft.grid) return null;
  const n     = marketName.toLowerCase();
  const label = selectionLabel.toLowerCase();

  let grid = lambdaData.ft.grid;
  if (n.includes('1st half')) grid = lambdaData.h1.grid;
  else if (n.includes('2nd half')) grid = lambdaData.h2.grid;

  if (n.includes('to win both halves')) {
    if (!lambdaData.h1 || !lambdaData.h2) return null;
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    const isYes = label.includes('yes');
    const pH1 = lambdaData.h1.grid.reduce((s, { home, away, prob: p }) =>
      (isHomeMarket && !isAwayMarket ? home > away : away > home) ? s + p : s, 0);
    const pH2 = lambdaData.h2.grid.reduce((s, { home, away, prob: p }) =>
      (isHomeMarket && !isAwayMarket ? home > away : away > home) ? s + p : s, 0);
    const pBoth = pH1 * pH2;
    const pTarget = isYes ? pBoth : 1 - pBoth;
    return pTarget > 0 ? (1 / pTarget).toFixed(3) : null;
  }

  if (n.includes('to score in both halves')) {
    if (!lambdaData.h1 || !lambdaData.h2) return null;
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    const isYes = label.includes('yes');
    let pH1 = 0, pH2 = 0;
    lambdaData.h1.grid.forEach(({ home, away, prob: p }) => {
      if (isHomeMarket && !isAwayMarket && home > 0) pH1 += p;
      else if (isAwayMarket && !isHomeMarket && away > 0) pH1 += p;
    });
    lambdaData.h2.grid.forEach(({ home, away, prob: p }) => {
      if (isHomeMarket && !isAwayMarket && home > 0) pH2 += p;
      else if (isAwayMarket && !isHomeMarket && away > 0) pH2 += p;
    });
    const pBoth = pH1 * pH2;
    const pTarget = isYes ? pBoth : 1 - pBoth;
    return pTarget > 0 ? (1 / pTarget).toFixed(3) : null;
  }

  if (n.includes('both halves over')) {
    if (!lambdaData.h1 || !lambdaData.h2) return null;
    const lineMatch = n.match(/both halves over\s+([0-9.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : 1.5;
    const threshold = Math.ceil(line);
    const isYes = label.includes('yes');
    const pH1o = lambdaData.h1.grid.reduce((s, { home, away, prob: p }) => home + away >= threshold ? s + p : s, 0);
    const pH2o = lambdaData.h2.grid.reduce((s, { home, away, prob: p }) => home + away >= threshold ? s + p : s, 0);
    const pBoth = pH1o * pH2o;
    const pTarget = isYes ? pBoth : 1 - pBoth;
    return pTarget > 0 ? (1 / pTarget).toFixed(3) : null;
  }

  if (n.includes('both halves under')) {
    if (!lambdaData.h1 || !lambdaData.h2) return null;
    const lineMatch = n.match(/both halves under\s+([0-9.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[1]) : 1.5;
    const threshold = Math.floor(line);
    const isYes = label.includes('yes');
    const pH1u = lambdaData.h1.grid.reduce((s, { home, away, prob: p }) => home + away <= threshold ? s + p : s, 0);
    const pH2u = lambdaData.h2.grid.reduce((s, { home, away, prob: p }) => home + away <= threshold ? s + p : s, 0);
    const pBoth = pH1u * pH2u;
    const pTarget = isYes ? pBoth : 1 - pBoth;
    return pTarget > 0 ? (1 / pTarget).toFixed(3) : null;
  }

  if ((n.includes('both teams to score') || n.includes('btts')) && n.includes('total goals')) {
    const isYes  = label.includes('yes');
    const isOver = label.includes('over');
    const lineMatch = label.match(/(over|under)\s+([0-9.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[2]) : 2.5;
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const bttsMatch = (home > 0 && away > 0) === isYes;
      const overMatch = (home + away > line) === isOver;
      if (bttsMatch && overMatch) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('to score?') && !n.includes('both teams') && !n.includes('btts')) {
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    const isYes = label.includes('yes');
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      let hasScored = false;
      if (isHomeMarket && !isAwayMarket) hasScored = (home > 0);
      else if (isAwayMarket && !isHomeMarket) hasScored = (away > 0);
      if (hasScored === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('both teams to score?') || n.includes('btts?')) {
    const isYes = label.includes('yes');
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      if ((home > 0 && away > 0) === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('half-time/full-time') || n.includes('ht/ft')) {
    if (!lambdaData.h1 || !lambdaData.h2) return null;
    const h1Grid = lambdaData.h1.grid;
    const h2Grid = lambdaData.h2.grid;
    const parts = selectionLabel.split('-').map(p => p.trim());
    if (parts.length !== 2) return null;
    const getRes = (txt) => {
      const t = txt.trim().toLowerCase();
      const h = homeTeam.trim().toLowerCase();
      const a = awayTeam.trim().toLowerCase();
      if (t === 'draw' || t === 'x') return 0;
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const htRes = getRes(parts[0]);
    const ftRes = getRes(parts[1]);
    if (htRes === null || ftRes === null) return null;

    // Joint probability from independent half-grids
    let probJoint = 0;
    h1Grid.forEach(s1 => {
      const s1Res = s1.home > s1.away ? 1 : (s1.home === s1.away ? 0 : 2);
      if (s1Res !== htRes) return;
      h2Grid.forEach(s2 => {
        const fHome = s1.home + s2.home;
        const fAway = s1.away + s2.away;
        const fRes  = fHome > fAway ? 1 : (fHome === fAway ? 0 : 2);
        if (fRes === ftRes) probJoint += s1.prob * s2.prob;
      });
    });

    // HT marginal from h1Grid
    let pHT = 0;
    h1Grid.forEach(({ home, away, prob: p }) => {
      const res = home > away ? 1 : (home === away ? 0 : 2);
      if (res === htRes) pHT += p;
    });

    // FT marginal from solved FT grid (calibrated to market prices)
    let pFT = 0;
    lambdaData.ft.grid.forEach(({ home, away, prob: p }) => {
      const res = home > away ? 1 : (home === away ? 0 : 2);
      if (res === ftRes) pFT += p;
    });

    // The independent Poisson model overestimates HT→FT result stickiness: small
    // half-λ values make score leads unrealistically hard to overturn (P(0-0 H2) is
    // very large). Shrink toward the product of marginals to correct this bias.
    const HTFT_ALPHA = 0.65;
    const prob = HTFT_ALPHA * probJoint + (1 - HTFT_ALPHA) * pHT * pFT;

    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('goals')) {
    const goalCount = parseInt(label);
    if (!isNaN(goalCount) && !n.includes('over/under') && !n.includes('asian') && !label.includes('-')) {
      const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
      const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
      const isPlus = label.includes('+');
      let prob = 0;
      grid.forEach(({ home, away, prob: p }) => {
        let val = home + away;
        if (isHomeMarket && !isAwayMarket) val = home;
        else if (isAwayMarket && !isHomeMarket) val = away;
        if (isPlus) { if (val >= goalCount) prob += p; }
        else        { if (val === goalCount) prob += p; }
      });
      return prob > 0 ? (1 / prob).toFixed(3) : null;
    }
  }

  if (n.includes('win to nil')) {
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    const isYes = label.includes('yes');
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      let condition = false;
      if (isHomeMarket && !isAwayMarket) condition = (home > 0 && away === 0);
      else if (isAwayMarket && !isHomeMarket) condition = (away > 0 && home === 0);
      if (condition === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('goals range') || n.includes('total goals range')) {
    let prob = 0;
    if (label.includes('+')) {
      const minVal = parseInt(label);
      grid.forEach(({ home, away, prob: p }) => { if ((home + away) >= minVal) prob += p; });
    } else if (label.includes('-')) {
      const parts = label.split('-').map(p => parseInt(p.trim()));
      if (parts.length === 2) {
        grid.forEach(({ home, away, prob: p }) => {
          const total = home + away;
          if (total >= parts[0] && total <= parts[1]) prob += p;
        });
      }
    }
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('draw no bet') || n.includes('dnb')) {
    let pH = 0, pA = 0;
    grid.forEach(({ home, away, prob: p }) => {
      if (home > away) pH += p; else if (away > home) pA += p;
    });
    const getRes = (txt) => {
      const t = txt.toLowerCase();
      const h = homeTeam.toLowerCase();
      const a = awayTeam.toLowerCase();
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const target = getRes(selectionLabel);
    return target === 1 ? (1 / (pH / (pH + pA))).toFixed(3)
         : target === 2 ? (1 / (pA / (pH + pA))).toFixed(3)
         : null;
  }

  if (n.includes('double chance')) {
    let pH = 0, pD = 0, pA = 0;
    grid.forEach(({ home, away, prob: p }) => {
      if (home > away) pH += p; else if (home === away) pD += p; else pA += p;
    });
    const ll = selectionLabel.toLowerCase();
    const isHome = ll.includes(homeTeam.toLowerCase()) || ll.includes('home');
    const isAway = ll.includes(awayTeam.toLowerCase()) || ll.includes('away');
    const isDraw = ll.includes('draw') || ll.includes('x');
    let prob = 0;
    if (isHome && isDraw && !isAway) prob = pH + pD;
    else if (isAway && isDraw && !isHome) prob = pD + pA;
    else if (isHome && isAway) prob = pH + pA;
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if ((n.includes('both teams to score') || n.includes('btts')) && (n.includes('winner') || n.includes('result'))) {
    const isYes  = label.includes('yes');
    const parts  = selectionLabel.split('&').map(p => p.trim());
    if (parts.length !== 2) return null;
    const getWinnerRes = (txt) => {
      const t = txt.toLowerCase();
      const h = homeTeam.toLowerCase();
      const a = awayTeam.toLowerCase();
      if (t === 'draw' || t === 'x') return 0;
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const targetRes = getWinnerRes(parts[1]);
    if (targetRes === null) return null;
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const bttsMatch = (home > 0 && away > 0) === isYes;
      const res = home > away ? 1 : (home === away ? 0 : 2);
      if (bttsMatch && res === targetRes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('either team to score')) {
    const isYes = label.includes('yes');
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      if (((home + away) > 0) === isYes) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('winner') && n.includes('total goals')) {
    const parts = selectionLabel.split('&').map(p => p.trim());
    if (parts.length !== 2) return null;
    const ouTxt = parts[1].toLowerCase();
    const getWinnerRes = (txt) => {
      const t = txt.toLowerCase();
      const h = homeTeam.toLowerCase();
      const a = awayTeam.toLowerCase();
      if (t === 'draw' || t === 'x') return 0;
      if (t === h || h.includes(t) || t === 'home' || t === '1') return 1;
      if (t === a || a.includes(t) || t === 'away' || t === '2') return 2;
      return null;
    };
    const targetRes = getWinnerRes(parts[0]);
    if (targetRes === null) return null;
    const isOver    = ouTxt.includes('over');
    const lineMatch = ouTxt.match(/[0-9.]+/);
    const line      = lineMatch ? parseFloat(lineMatch[0]) : 2.5;
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const res   = home > away ? 1 : (home === away ? 0 : 2);
      const total = home + away;
      if (res === targetRes && (isOver ? total > line : total < line)) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if ((n.includes('odd/even') || n.includes('odd & even')) && n.includes('total goals') && (label.includes('over') || label.includes('under'))) {
    const isOdd  = label.includes('odd');
    const isOver = label.includes('over');
    const lineMatch = label.match(/(over|under)\s+([0-9.]+)/);
    const line = lineMatch ? parseFloat(lineMatch[2]) : 2.5;
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      const total = home + away;
      if (((total % 2 !== 0) === isOdd) && ((total > line) === isOver)) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('odd/even') || n.includes('odd & even')) {
    const isOdd        = label.includes('odd');
    const isHomeMarket = n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
    const isAwayMarket = n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
    let prob = 0;
    grid.forEach(({ home, away, prob: p }) => {
      let val = home + away;
      if (isHomeMarket && !isAwayMarket) val = home;
      else if (isAwayMarket && !isHomeMarket) val = away;
      if ((val % 2 !== 0) === isOdd) prob += p;
    });
    return prob > 0 ? (1 / prob).toFixed(3) : null;
  }

  if (n.includes('team total')) {
    const isOver    = label.includes('over');
    const isUnder   = label.includes('under');
    const lineMatch = label.match(/(over|under)\s+([0-9.]+)/);
    if (lineMatch && (isOver || isUnder)) {
      const line    = parseFloat(lineMatch[2]);
      const isHome  = label.includes('home') || (homeTeam && label.includes(homeTeam.toLowerCase())) || n.includes('home') || (homeTeam && n.includes(homeTeam.toLowerCase()));
      const isAway  = label.includes('away') || (awayTeam && label.includes(awayTeam.toLowerCase())) || n.includes('away') || (awayTeam && n.includes(awayTeam.toLowerCase()));
      if (isHome !== isAway) {
        const odds = dcAsianTeamTotalOdds(grid, line, isOver, isAway);
        return odds ? odds.toFixed(3) : null;
      }
    }
  }

  return null;
}
