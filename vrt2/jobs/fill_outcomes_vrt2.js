// CLAW VRT2 — fill_outcomes_vrt2.js
//
// Daily job: for every live (non-backtest) signal where 1d/5d/20d has elapsed
// since fire, compute VRT % change, XLI % change, alpha, and hit outcome.
// Writes back to the signal row directly. Idempotent.
//
// Usage: node jobs/fill_outcomes_vrt2.js
// Cron:  Run nightly at ~1:00 AM ET after market close + settle time.

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const START_TS = Date.now();
console.log('CLAW VRT2 — fill_outcomes_vrt2 v3');

// ── FETCH PRICE AT TIMESTAMP ─────────────────────────────────────────────
// Returns the closest price to the target ts for a given ticker.
// Uses WAP (weighted average price) if multiple rows exist in a day.
function priceNearTs(ticker, targetTs, maxWindowMs) {
  maxWindowMs = maxWindowMs || 86400000 * 2; // within 2 days
  var row = db.prepare(`
    SELECT price, ts FROM prices
    WHERE ticker = ? AND ts BETWEEN ? AND ?
    ORDER BY ABS(ts - ?) ASC
    LIMIT 1
  `).get(ticker, targetTs - maxWindowMs, targetTs + maxWindowMs, targetTs);
  return row ? row.price : null;
}

function priceAtOffset(ticker, startTs, daysOffset) {
  var targetTs = startTs + (daysOffset * 86400000);
  // Weekend adjustment: push to Monday if target lands on Sat/Sun
  var targetDate = new Date(targetTs);
  var day = targetDate.getUTCDay();
  if (day === 6) targetTs += 2 * 86400000;
  else if (day === 0) targetTs += 1 * 86400000;
  return priceNearTs(ticker, targetTs);
}

// ── FIND SIGNALS NEEDING OUTCOMES ────────────────────────────────────────
// Signals qualify for outcome filling if:
//   1. Not a backtest row (those are filled inline during backtest)
//   2. outcome_filled_at IS NULL
//   3. At least 20 trading days have passed since fire (for the 20d window)
//      OR at least 1 day has passed and partial fill is OK.

var now = Date.now();
var minAgeForPartialMs = 24 * 3600000;         // 1 day for any outcome
var minAgeForFullMs = 20 * 86400000 + 7 * 86400000; // 20 trading days + 7 day buffer

var signals = db.prepare(`
  SELECT id, ts, hyp_id, direction, vrt_price, outcome_1d, outcome_5d, outcome_20d
  FROM signals
  WHERE is_backtest = 0
    AND (outcome_filled_at IS NULL OR outcome_20d IS NULL)
    AND ts < ?
  ORDER BY ts ASC
`).all(now - minAgeForPartialMs);

console.log('Signals needing outcome fill:', signals.length);
if (signals.length === 0) {
  db.close();
  process.exit(0);
}

var upd = db.prepare(`
  UPDATE signals
  SET outcome_1d = @outcome_1d,
      outcome_5d = @outcome_5d,
      outcome_20d = @outcome_20d,
      xli_1d = @xli_1d,
      xli_5d = @xli_5d,
      xli_20d = @xli_20d,
      alpha_1d = @alpha_1d,
      alpha_5d = @alpha_5d,
      alpha_20d = @alpha_20d,
      hit = @hit,
      outcome_filled_at = @outcome_filled_at
  WHERE id = @id
`);

var filled = 0, partial = 0, failed = 0;
var tx = db.transaction(function(rows) {
  rows.forEach(function(s) {
    var ageMs = now - s.ts;
    var startVrt = s.vrt_price;
    var startXli = priceNearTs('XLI', s.ts);

    var pctChange = function(endPrice, startPrice) {
      if (startPrice == null || endPrice == null || startPrice === 0) return null;
      return Math.round((endPrice - startPrice) / startPrice * 10000) / 100;
    };

    // Only fill windows where enough time has elapsed
    var vrt_1d   = ageMs >= 1  * 86400000 ? pctChange(priceAtOffset('VRT',  s.ts, 1),  startVrt) : null;
    var vrt_5d   = ageMs >= 5  * 86400000 ? pctChange(priceAtOffset('VRT',  s.ts, 5),  startVrt) : null;
    var vrt_20d  = ageMs >= 20 * 86400000 ? pctChange(priceAtOffset('VRT',  s.ts, 20), startVrt) : null;
    var xli_1d   = ageMs >= 1  * 86400000 ? pctChange(priceAtOffset('XLI',  s.ts, 1),  startXli)  : null;
    var xli_5d   = ageMs >= 5  * 86400000 ? pctChange(priceAtOffset('XLI',  s.ts, 5),  startXli)  : null;
    var xli_20d  = ageMs >= 20 * 86400000 ? pctChange(priceAtOffset('XLI',  s.ts, 20), startXli)  : null;

    var alpha_1d  = (vrt_1d  != null && xli_1d  != null) ? Math.round((vrt_1d  - xli_1d)  * 100) / 100 : null;
    var alpha_5d  = (vrt_5d  != null && xli_5d  != null) ? Math.round((vrt_5d  - xli_5d)  * 100) / 100 : null;
    var alpha_20d = (vrt_20d != null && xli_20d != null) ? Math.round((vrt_20d - xli_20d) * 100) / 100 : null;

    // Hit determination: use 5-day alpha as primary outcome window
    var hit = null;
    if (alpha_5d != null) {
      if (s.direction === 'BULL') hit = alpha_5d > 0 ? 1 : 0;
      else if (s.direction === 'BEAR') hit = alpha_5d < 0 ? 1 : 0;
      else if (s.direction === 'CONTEXT') hit = Math.abs(vrt_5d || 0) > 3 ? 1 : 0;
    }

    // Only mark fully filled once 20d window is complete
    var fullyFilled = (vrt_20d != null);
    var filledAt = fullyFilled ? now : (vrt_5d != null ? now : null);

    try {
      upd.run({
        id: s.id,
        outcome_1d: vrt_1d, outcome_5d: vrt_5d, outcome_20d: vrt_20d,
        xli_1d: xli_1d, xli_5d: xli_5d, xli_20d: xli_20d,
        alpha_1d: alpha_1d, alpha_5d: alpha_5d, alpha_20d: alpha_20d,
        hit: hit,
        outcome_filled_at: filledAt
      });
      if (fullyFilled) filled++;
      else if (vrt_5d != null) partial++;
    } catch (e) {
      failed++;
      console.error('update failed for signal', s.id, ':', e.message);
    }
  });
});

tx(signals);

console.log('Fully filled:', filled);
console.log('Partial fill:', partial);
console.log('Failed:', failed);

// ── JOB HEALTH ────────────────────────────────────────────────────────────
try {
  db.prepare(`
    INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
    VALUES ('fill_outcomes_vrt2', ?, ?, ?, ?)
  `).run(Date.now(), failed > 0 ? 'PARTIAL' : 'OK', filled + partial, Date.now() - START_TS);
} catch (e) { console.error('  ⚠ job_health write failed (run migrate_v3_1.js?): ' + e.message); }

db.close();
console.log('\nDone.');
