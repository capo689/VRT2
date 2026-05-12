// CLAW VRT2 — Backtest Harness v3
//
// Replays historical daily prices through a portable copy of the signal
// engine to produce empirical hit rates for every hypothesis.
//
// Outputs:
//   - backtest_signals rows written to the signals table with is_backtest=1
//   - backtest_report.md in the CRDO directory
//
// Usage:
//   node jobs/backtest_vrt2.js              # full backtest 2023-01-01 → today
//   node jobs/backtest_vrt2.js --from 2024-06-01 --to 2025-12-31
//   node jobs/backtest_vrt2.js --clean      # wipe existing backtest rows first
//
// NOTE: Backtest runs in DAILY resolution. It cannot replay intraday sympathy
// (H5/H7/H20 that require minute-level price ticks). For those hypotheses,
// we approximate using daily close-to-close moves. Intraday validation will
// come from the live learning loop.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── ARG PARSING ───────────────────────────────────────────────────────────
var args = process.argv.slice(2);
var argFrom = null, argTo = null, clean = false;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--from' && args[i+1]) { argFrom = args[i+1]; i++; }
  else if (args[i] === '--to' && args[i+1]) { argTo = args[i+1]; i++; }
  else if (args[i] === '--clean') { clean = true; }
}

var DEFAULT_FROM = '2023-01-01';
var DEFAULT_TO = new Date().toISOString().slice(0, 10);
var FROM = argFrom || DEFAULT_FROM;
var TO = argTo || DEFAULT_TO;

console.log('CLAW VRT2 Backtest v3');
console.log('From:', FROM);
console.log('To:', TO);
console.log('Clean existing backtest rows:', clean);

// ── SIGNAL CONFIG (mirror of server SIGNAL_CONFIG) ────────────────────────
// Kept in sync with claw_server_vrt2.js SIGNAL_CONFIG. Any server change
// MUST be reflected here until lib/ split in Phase 6 unifies them.
const SIGNAL_CONFIG = {
  H1:  { threshold: 10,      weight: 5, direction: 'CONTEXT', half_life_min: 2880, regime_class: 'EVENT' },
  H2:  { threshold: 1,       weight: 4, direction: 'BEAR',    half_life_min: 1440, regime_class: 'EVENT' },
  H3:  { threshold: 0,       weight: 4, direction: 'BULL',    half_life_min: 7200, regime_class: 'MEAN_REV' },
  H4:  { threshold: 5,       weight: 3, direction: 'BEAR',    half_life_min: 1440, regime_class: 'EVENT' },
  H5:  { threshold: 5,       weight: 3, direction: 'CONTEXT', half_life_min: 240,  regime_class: 'TREND' },
  H6:  { threshold: 0.40,    weight: 3, direction: 'CONTEXT', half_life_min: 1440, regime_class: 'STRUCTURAL' },
  H7:  { threshold: 7,       weight: 2, direction: 'BULL',    half_life_min: 480,  regime_class: 'MEAN_REV' },
  H8:  { threshold: 10,      weight: 3, direction: 'BULL',    half_life_min: 4320, regime_class: 'STRUCTURAL' },
  H9:  { threshold: 500,     weight: 3, direction: 'BEAR',    half_life_min: 4320, regime_class: 'EVENT' },
  H10: { threshold: 25,      weight: 4, direction: 'BULL',    half_life_min: 4320, regime_class: 'STRUCTURAL' },
  H11: { threshold: 5,       weight: 2, direction: 'BULL',    half_life_min: 2880, regime_class: 'EVENT' },
  H12: { threshold: 1,       weight: 5, direction: 'BEAR',    half_life_min: 4320, regime_class: 'EVENT' },
  H13: { threshold: 1,       weight: 4, direction: 'BEAR',    half_life_min: 4320, regime_class: 'EVENT' },
  H14: { threshold: 1,       weight: 4, direction: 'BULL',    half_life_min: 1440, regime_class: 'EVENT' },
  H15: { threshold: 1,       weight: 5, direction: 'BEAR',    half_life_min: 1440, regime_class: 'EVENT' },
  H16: { threshold: 5000000, weight: 3, direction: 'BEAR',    half_life_min: 4320, regime_class: 'STRUCTURAL' },
  H17: { threshold: 3,       weight: 3, direction: 'CONTEXT', half_life_min: 480,  regime_class: 'TREND' },
  H18: { threshold: 20,      weight: 2, direction: 'CONTEXT', half_life_min: 2880, regime_class: 'STRUCTURAL' },
  H19: { threshold: 30,      weight: 2, direction: 'BULL',    half_life_min: 2880, regime_class: 'MEAN_REV' },
  H20: { threshold: 8,       weight: 2, direction: 'BULL',    half_life_min: 480,  regime_class: 'MEAN_REV' },
  H21: { threshold: 1,       weight: 1, direction: 'CONTEXT', half_life_min: 240,  regime_class: 'EVENT' },
  H22: { threshold: 1,       weight: 1, direction: 'BULL',    half_life_min: 1440, regime_class: 'MEAN_REV' },
  H8_lead: { threshold: 8,   weight: 3, direction: 'CONTEXT', half_life_min: 360,  regime_class: 'TREND' },
  };

// ── LOAD HISTORICAL DATA INTO MEMORY ──────────────────────────────────────
console.log('\nLoading historical prices…');
var allPrices = db.prepare(`
  SELECT ts, ticker, price, open, high, low, volume, pct
  FROM prices
  WHERE source = 'yahoo_historical'
  AND date(ts/1000, 'unixepoch') >= ?
  AND date(ts/1000, 'unixepoch') <= ?
  ORDER BY ts ASC
`).all(FROM, TO);

console.log('Loaded', allPrices.length, 'historical price rows');

if (allPrices.length === 0) {
  console.error('ERROR: No historical prices found. Run setup_db_crdo.js first to backfill.');
  process.exit(1);
}

// Index by date string (YYYY-MM-DD) → ticker → row
var byDate = {};
allPrices.forEach(function(row) {
  var d = new Date(row.ts).toISOString().slice(0, 10);
  if (!byDate[d]) byDate[d] = {};
  byDate[d][row.ticker] = row;
});
var sortedDates = Object.keys(byDate).sort();
console.log('Date range:', sortedDates[0], '→', sortedDates[sortedDates.length - 1]);
console.log('Trading days:', sortedDates.length);

// ── PRIOR-DAY LOOKUP (for pct calc fallback) ─────────────────────────────
function priorDayClose(ticker, dateStr) {
  var idx = sortedDates.indexOf(dateStr);
  while (idx > 0) {
    idx--;
    var prior = byDate[sortedDates[idx]][ticker];
    if (prior) return prior.price;
  }
  return null;
}

// ── BUILD SYNTHETIC PRICE CACHE FOR A GIVEN DATE ─────────────────────────
function buildPriceCache(dateStr) {
  var snap = byDate[dateStr];
  if (!snap) return null;
  var cache = {};
  Object.keys(snap).forEach(function(ticker) {
    var row = snap[ticker];
    var pct = row.pct;
    // If pct is missing, compute from prior close
    if (pct == null || pct === 0) {
      var prior = priorDayClose(ticker, dateStr);
      if (prior && prior > 0) pct = Math.round((row.price - prior) / prior * 10000) / 100;
      else pct = 0;
    }
    cache[ticker] = {
      price: row.price,
      pct: pct,
      prev: row.price * (1 - pct/100),
      open: row.open, high: row.high, low: row.low,
      volume: row.volume,
      ts: row.ts
    };
  });
  return cache;
}

// ── SIGNAL EVALUATOR (daily resolution port of server evaluateSignals) ──
// This is a simplified version of claw_server_vrt2.js::evaluateSignals()
// adapted for daily bars. Returns array of {hyp_id, trigger_val, trigger_desc, direction}.
function evaluateDailySignals(cache, dateStr) {
  var fires = [];
  var crdo = cache.CRDO;
  if (!crdo) return fires;

  // HYG regime filter
  var hyg = cache.HYG;
  var riskOffRegime = (hyg && hyg.pct <= -2);

  // H5 — Peer sympathy (best-of ALAB/AVGO/MRVL)
  var h5Best = null;
  ['ALAB','AVGO','MRVL'].forEach(function(peer) {
    var pr = cache[peer];
    if (!pr || Math.abs(pr.pct) < 5) return;
    var sameSign = (Math.sign(pr.pct) === Math.sign(crdo.pct));
    var magRatio = Math.abs(crdo.pct / pr.pct);
    if (sameSign && magRatio >= 0.8) {
      if (!h5Best || Math.abs(pr.pct) > Math.abs(h5Best.pct)) {
        h5Best = { peer: peer, pct: pr.pct, magRatio: magRatio };
      }
    }
  });
  if (h5Best) {
    fires.push({
      hyp_id: 'H5',
      trigger_val: h5Best.pct,
      trigger_desc: h5Best.peer + ' ' + h5Best.pct.toFixed(1) + '%, CRDO ' + crdo.pct.toFixed(1) + '%',
      direction: crdo.pct > 0 ? 'BULL' : 'BEAR'
    });
  }

  // H7 — CRDO underperforming SMH by >7% (v3.1: tightened from -5%)
  var smh = cache.SMH;
  if (!riskOffRegime && smh && (crdo.pct - smh.pct) < -7) {
    fires.push({
      hyp_id: 'H7',
      trigger_val: crdo.pct - smh.pct,
      trigger_desc: 'CRDO ' + crdo.pct.toFixed(1) + '% vs SMH ' + smh.pct.toFixed(1) + '%',
      direction: 'BULL'
    });
  }

  // H20 — Sharper drawdown
  if (!riskOffRegime && smh && crdo.pct <= -8 && smh.pct > -3) {
    fires.push({
      hyp_id: 'H20',
      trigger_val: crdo.pct,
      trigger_desc: 'CRDO ' + crdo.pct.toFixed(1) + '% with SMH ' + smh.pct.toFixed(1) + '%',
      direction: 'BULL'
    });
  }

  // H8_lead KILLED in v3.1 (49% backtest hit rate — SMCI proxy failed)
  // Block removed.

  // H8_nbis — NBIS >10% same-direction up
  var nbis = cache.NBIS;
  if (nbis && nbis.pct > 10 && crdo.pct > 0) {
    fires.push({
      hyp_id: 'S_ETN_LEAD',
      trigger_val: nbis.pct,
      trigger_desc: 'NBIS +' + nbis.pct.toFixed(1) + '%, CRDO +' + crdo.pct.toFixed(1) + '%',
      direction: 'BULL'
    });
  }

  // H8_crwv — CoreWeave >10% same-direction up (v3.1 NEW)
  var crwv = cache.CRWV;
  if (crwv && crwv.pct > 10 && crdo.pct > 0) {
    fires.push({
      hyp_id: 'H-CORR',
      trigger_val: crwv.pct,
      trigger_desc: 'CRWV +' + crwv.pct.toFixed(1) + '%, CRDO +' + crdo.pct.toFixed(1) + '%',
      direction: 'BULL'
    });
  }

  return fires;
}

// ── H6 STREAK TRACKER (multi-day hypothesis) ─────────────────────────────
// Tracks CRDO/ALAB 20-day rolling correlation. Fires when correlation <0.40
// for 3+ consecutive sessions.
var h6StreakCount = 0;
var h6LastValue = null;

function updateH6State(dateStr) {
  var fires = [];
  var idx = sortedDates.indexOf(dateStr);
  if (idx < 20) return fires;

  // Compute 20-day rolling correlation between CRDO and ALAB
  var crdoRets = [], alabRets = [];
  for (var i = idx - 19; i <= idx; i++) {
    var day = byDate[sortedDates[i]];
    if (day && day.CRDO && day.ALAB && day.CRDO.pct != null && day.ALAB.pct != null) {
      crdoRets.push(day.CRDO.pct);
      alabRets.push(day.ALAB.pct);
    }
  }
  if (crdoRets.length < 15) return fires;

  var mean = function(a) { return a.reduce(function(s,x){return s+x;},0) / a.length; };
  var mx = mean(crdoRets), my = mean(alabRets);
  var num = 0, dx = 0, dy = 0;
  for (var j = 0; j < crdoRets.length; j++) {
    num += (crdoRets[j]-mx) * (alabRets[j]-my);
    dx  += (crdoRets[j]-mx) * (crdoRets[j]-mx);
    dy  += (alabRets[j]-my) * (alabRets[j]-my);
  }
  var corr = (dx > 0 && dy > 0) ? num / Math.sqrt(dx*dy) : 0;
  h6LastValue = corr;

  if (corr < 0.40) {
    h6StreakCount++;
    if (h6StreakCount === 3) {
      var crdo = byDate[dateStr].CRDO;
      if (crdo) {
        fires.push({
          hyp_id: 'H6',
          trigger_val: corr,
          trigger_desc: 'CRDO/ALAB 20d corr = ' + corr.toFixed(3) + ' (3rd consecutive day below 0.40)',
          direction: 'CONTEXT'  // resolved at outcome time based on which name led
        });
      }
    }
  } else {
    h6StreakCount = 0;
  }
  return fires;
}

// ── H19 VIX STATE MACHINE ─────────────────────────────────────────────────
// Fires when VIX spikes >30 and then recovers <22 within 10 trading days.
// Backtest note: VIX is not in the equities cohort. It's in yahoo_historical
// under ^VIX. We pull it separately.
var vixByDate = {};
try {
  var vixRows = db.prepare(`
    SELECT ts, price FROM prices
    WHERE ticker = '^VIX' AND source = 'yahoo_historical'
    ORDER BY ts ASC
  `).all();
  vixRows.forEach(function(r) {
    vixByDate[new Date(r.ts).toISOString().slice(0, 10)] = r.price;
  });
  console.log('Loaded', vixRows.length, 'VIX rows');
} catch (e) {
  console.log('No VIX data — H19 will be skipped');
}

var h19SpikeAt = null;     // index of spike day
var h19SpikeValue = null;

function updateH19State(dateStr) {
  var fires = [];
  var vix = vixByDate[dateStr];
  if (vix == null) return fires;

  var idx = sortedDates.indexOf(dateStr);

  if (h19SpikeAt === null && vix > 30) {
    h19SpikeAt = idx;
    h19SpikeValue = vix;
  } else if (h19SpikeAt !== null) {
    var daysSinceSpike = idx - h19SpikeAt;
    if (daysSinceSpike > 10) {
      // Expired — reset
      h19SpikeAt = null;
      h19SpikeValue = null;
    } else if (vix < 22) {
      // Recovery within window — fire H19
      fires.push({
        hyp_id: 'H19',
        trigger_val: vix,
        trigger_desc: 'VIX spiked to ' + h19SpikeValue.toFixed(1) + ', recovered to ' + vix.toFixed(1) + ' in ' + daysSinceSpike + ' days',
        direction: 'BULL'
      });
      h19SpikeAt = null;
      h19SpikeValue = null;
    }
  }
  return fires;
}

// ── OUTCOME COMPUTATION ──────────────────────────────────────────────────
// For a signal fired on date D with CRDO price P, compute:
//   outcome_1d  = % change from P to close on D+1
//   outcome_5d  = % change from P to close on D+5
//   outcome_20d = % change from P to close on D+20
//   alpha_Nd    = outcome_Nd - smh_Nd
//   hit         = (direction === 'BULL' && alpha_5d > 0) || (direction === 'BEAR' && alpha_5d < 0)
function computeOutcome(dateStr, signalRow) {
  var startIdx = sortedDates.indexOf(dateStr);
  if (startIdx === -1) return null;

  function priceAtOffset(ticker, offset) {
    var targetIdx = startIdx + offset;
    if (targetIdx >= sortedDates.length) return null;
    var d = sortedDates[targetIdx];
    return (byDate[d] && byDate[d][ticker]) ? byDate[d][ticker].price : null;
  }

  var startVrt = signalRow.vrt_price;
  var startXli = byDate[dateStr] && byDate[dateStr].SMH ? byDate[dateStr].SMH.price : null;

  function pctChange(ticker, offset, startPrice) {
    if (startPrice == null) return null;
    var end = priceAtOffset(ticker, offset);
    if (end == null) return null;
    return Math.round((end - startPrice) / startPrice * 10000) / 100;
  }

  var o = {
    outcome_1d:  pctChange('VRT', 1,  startVrt),
    outcome_5d:  pctChange('VRT', 5,  startVrt),
    outcome_20d: pctChange('VRT', 20, startVrt),
    xli_1d:      pctChange('XLI',  1,  startXli),
    xli_5d:      pctChange('XLI',  5,  startXli),
    xli_20d:     pctChange('XLI',  20, startXli)
  };
  o.alpha_1d  = (o.outcome_1d  != null && o.xli_1d  != null) ? Math.round((o.outcome_1d  - o.xli_1d)  * 100) / 100 : null;
  o.alpha_5d  = (o.outcome_5d  != null && o.xli_5d  != null) ? Math.round((o.outcome_5d  - o.xli_5d)  * 100) / 100 : null;
  o.alpha_20d = (o.outcome_20d != null && o.xli_20d != null) ? Math.round((o.outcome_20d - o.xli_20d) * 100) / 100 : null;

  // Hit determination: use 5-day alpha as the primary outcome window
  var dir = signalRow.direction;
  var hit = null;
  if (o.alpha_5d != null) {
    if (dir === 'BULL') hit = o.alpha_5d > 0 ? 1 : 0;
    else if (dir === 'BEAR') hit = o.alpha_5d < 0 ? 1 : 0;
    else if (dir === 'CONTEXT') hit = Math.abs(o.outcome_5d || 0) > 3 ? 1 : 0; // CONTEXT signals "hit" if the stock moved meaningfully
  }
  o.hit = hit;
  o.outcome_filled_at = Date.now();
  return o;
}

// ── MAIN BACKTEST LOOP ────────────────────────────────────────────────────
if (clean) {
  console.log('\nCleaning existing backtest signals…');
  db.prepare('DELETE FROM signals WHERE is_backtest = 1').run();
}

var insertBacktestSignal = db.prepare(`
  INSERT INTO signals (
    ts, hyp_id, trigger_val, trigger_desc, vrt_price,
    direction, confidence, is_backtest,
    outcome_1d, outcome_5d, outcome_20d,
    xli_1d, xli_5d, xli_20d,
    alpha_1d, alpha_5d, alpha_20d,
    hit, outcome_filled_at
  ) VALUES (
    @ts, @hyp_id, @trigger_val, @trigger_desc, @vrt_price,
    @direction, @confidence, 1,
    @outcome_1d, @outcome_5d, @outcome_20d,
    @xli_1d, @xli_5d, @xli_20d,
    @alpha_1d, @alpha_5d, @alpha_20d,
    @hit, @outcome_filled_at
  )
`);

var insertTx = db.transaction(function(signals) {
  signals.forEach(function(s) { insertBacktestSignal.run(s); });
});

console.log('\nReplaying', sortedDates.length, 'trading days…');
var totalFires = 0;
var batch = [];
var BATCH_SIZE = 500;

for (var di = 0; di < sortedDates.length; di++) {
  var dateStr = sortedDates[di];
  var cache = buildPriceCache(dateStr);
  if (!cache || !cache.CRDO) continue;

  // Collect fires from daily evaluator + temporal evaluators
  var fires = evaluateDailySignals(cache, dateStr);
  fires = fires.concat(updateH6State(dateStr));
  fires = fires.concat(updateH19State(dateStr));

  fires.forEach(function(f) {
    var cfg = SIGNAL_CONFIG[f.hyp_id];
    if (!cfg) return;
    var confidence = 1.0;
    if (cfg.threshold && cfg.threshold > 0) {
      confidence = Math.min(Math.max(Math.abs(f.trigger_val) / cfg.threshold, 0.5), 3.0);
    }
    var row = {
      ts: cache.CRDO.ts,
      hyp_id: f.hyp_id,
      trigger_val: f.trigger_val,
      trigger_desc: f.trigger_desc,
      vrt_price: cache.CRDO.price,
      direction: f.direction,
      confidence: confidence
    };
    var outcome = computeOutcome(dateStr, row);
    if (outcome) {
      Object.assign(row, outcome);
    } else {
      row.outcome_1d = row.outcome_5d = row.outcome_20d = null;
      row.xli_1d = row.xli_5d = row.xli_20d = null;
      row.alpha_1d = row.alpha_5d = row.alpha_20d = null;
      row.hit = null;
      row.outcome_filled_at = null;
    }
    batch.push(row);
    totalFires++;
  });

  if (batch.length >= BATCH_SIZE) {
    insertTx(batch);
    batch = [];
  }

  if (di % 100 === 0 && di > 0) {
    console.log('  processed', di, 'of', sortedDates.length, 'days — fires:', totalFires);
  }
}
if (batch.length > 0) insertTx(batch);

console.log('\nBacktest complete.');
console.log('Total signals fired:', totalFires);

// ── HIT RATE REPORT ───────────────────────────────────────────────────────
console.log('\nComputing hit rate report…');

var hypIds = db.prepare(`
  SELECT DISTINCT hyp_id FROM signals WHERE is_backtest = 1 ORDER BY hyp_id
`).all().map(function(r) { return r.hyp_id; });

var reportRows = hypIds.map(function(h) {
  var stats = db.prepare(`
    SELECT
      COUNT(*)                                      AS n_signals,
      SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END)      AS n_hits,
      SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END)      AS n_misses,
      SUM(CASE WHEN hit IS NULL THEN 1 ELSE 0 END)  AS n_unfilled,
      AVG(CASE WHEN hit = 1 THEN alpha_5d END)      AS avg_alpha_hit,
      AVG(CASE WHEN hit = 0 THEN alpha_5d END)      AS avg_alpha_miss,
      AVG(outcome_5d)                               AS avg_outcome_5d,
      AVG(outcome_20d)                              AS avg_outcome_20d
    FROM signals
    WHERE is_backtest = 1 AND hyp_id = ?
  `).get(h);

  var filled = (stats.n_hits || 0) + (stats.n_misses || 0);
  var hitRate = filled > 0 ? (stats.n_hits / filled) : null;
  var recommendation;
  if (stats.n_signals < 5) recommendation = 'INSUFFICIENT_DATA';
  else if (hitRate == null) recommendation = 'UNFILLED';
  else if (hitRate >= 0.60) recommendation = 'KEEP';
  else if (hitRate >= 0.50) recommendation = 'REVIEW';
  else if (hitRate >= 0.40) recommendation = 'DOWNGRADE';
  else recommendation = 'KILL';

  return {
    hyp_id: h,
    n_signals: stats.n_signals,
    n_hits: stats.n_hits || 0,
    n_misses: stats.n_misses || 0,
    n_unfilled: stats.n_unfilled || 0,
    hit_rate: hitRate,
    avg_alpha_hit: stats.avg_alpha_hit,
    avg_alpha_miss: stats.avg_alpha_miss,
    avg_outcome_5d: stats.avg_outcome_5d,
    avg_outcome_20d: stats.avg_outcome_20d,
    recommendation: recommendation
  };
});

// ── WRITE MARKDOWN REPORT ────────────────────────────────────────────────
var reportLines = [];
reportLines.push('# CLAW VRT2 — Backtest Report v3');
reportLines.push('');
reportLines.push('**Generated:** ' + new Date().toISOString());
reportLines.push('**Date range:** ' + FROM + ' → ' + TO);
reportLines.push('**Trading days replayed:** ' + sortedDates.length);
reportLines.push('**Total signal fires:** ' + totalFires);
reportLines.push('');
reportLines.push('## Hypothesis Hit Rates');
reportLines.push('');
reportLines.push('Hit = direction matched with positive alpha on 5-day window.');
reportLines.push('CONTEXT hypotheses hit if CRDO moved >3% in either direction on 5-day window.');
reportLines.push('');
reportLines.push('| Hypothesis | N | Hits | Misses | Hit Rate | Avg α (hit) | Avg α (miss) | Avg 5d | Avg 20d | Recommendation |');
reportLines.push('|---|---|---|---|---|---|---|---|---|---|');
reportRows.forEach(function(r) {
  var fmt = function(x, d) { return (x == null) ? '—' : x.toFixed(d || 2); };
  var hrPct = r.hit_rate == null ? '—' : (r.hit_rate * 100).toFixed(0) + '%';
  reportLines.push('| ' + r.hyp_id + ' | ' + r.n_signals + ' | ' + r.n_hits + ' | ' + r.n_misses +
    ' | ' + hrPct + ' | ' + fmt(r.avg_alpha_hit) + ' | ' + fmt(r.avg_alpha_miss) +
    ' | ' + fmt(r.avg_outcome_5d) + '% | ' + fmt(r.avg_outcome_20d) + '% | **' + r.recommendation + '** |');
});
reportLines.push('');
reportLines.push('## Recommendation Legend');
reportLines.push('');
reportLines.push('- **KEEP** — Hit rate ≥60%. Use as-is, seed with full base weight.');
reportLines.push('- **REVIEW** — Hit rate 50-60%. Marginal edge. Keep but monitor in live phase.');
reportLines.push('- **DOWNGRADE** — Hit rate 40-50%. Near coin-flip. Reduce weight to 30% of base.');
reportLines.push('- **KILL** — Hit rate <40%. Worse than random. Set weight to 0.');
reportLines.push('- **INSUFFICIENT_DATA** — Under 5 fires in backtest window. Cannot evaluate.');
reportLines.push('- **UNFILLED** — Fires at end of window where outcome cannot be computed yet.');
reportLines.push('');
reportLines.push('## Notes');
reportLines.push('');
reportLines.push('- Backtest runs at daily resolution. Intraday hypotheses (H5 intraday sympathy, tick-level H17) are approximated by daily close-to-close moves.');
reportLines.push('- H1, H2, H3, H4, H9, H10, H11, H12, H13, H14, H15, H16, H17, H18, H21, H22 require event-driven data (earnings, filings, news) and cannot fire in a price-only backtest. They will begin producing data only in live operation.');
reportLines.push('- The hypotheses above are the ones the backtest COULD evaluate: H5, H6, H7, H8_lead, H8_nbis, H19, H20.');
reportLines.push('- Recalibration job will use these hit rates as initial weight seeds. Weights will continue learning in live operation.');

var reportPath = path.join(__dirname, '..', 'backtest_report.md');
fs.writeFileSync(reportPath, reportLines.join('\n'));
console.log('\nReport written to:', reportPath);

// ── JOB HEALTH ────────────────────────────────────────────────────────────
try {
  db.prepare(`
    INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
    VALUES ('backtest_vrt2', ?, 'OK', ?, ?)
  `).run(Date.now(), totalFires, 0);
} catch (e) { console.error('  ⚠ job_health write failed (run migrate_v3_1.js?): ' + e.message); }

console.log('\nDone.');
db.close();
