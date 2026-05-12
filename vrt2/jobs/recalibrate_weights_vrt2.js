// CLAW VRT2 — recalibrate_weights_vrt2.js
//
// Recomputes signal_weights.weight for every hypothesis based on rolling
// 60-day hit rate and precision. Reads from signals table (both live rows and
// backtest rows, weighted differently). Runs weekly + once after each backtest.
//
// Weight formula:
//   new_weight = base_weight × hit_rate × precision_multiplier × sample_adjustment
//
//   hit_rate            = hits / (hits + misses) over rolling window
//   precision_multiplier= clamp(avg_alpha_when_hit / 5.0, 0.5, 2.0)
//   sample_adjustment   = clamp(sqrt(n / 30), 0.5, 1.5)
//     (penalize tiny samples, reward larger ones, cap the boost)
//
// Hypotheses with hit_rate < 0.40 get weight clamped to 0.1 × base (effectively muted).
// Hypotheses with n_signals < 5 keep their base weight (insufficient evidence to change).
// Backtest rows and live rows are combined with live rows counting 2x (more recent = more signal).
//
// Usage: node jobs/recalibrate_weights_vrt2.js
//        node jobs/recalibrate_weights_vrt2.js --days 60       # custom window
//        node jobs/recalibrate_weights_vrt2.js --seed-from-backtest  # first run after backtest

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { getETDateString } = require('../lib/dates');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

var args = process.argv.slice(2);
var ROLLING_DAYS = 60;
var SEED_MODE = false;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i+1]) { ROLLING_DAYS = parseInt(args[i+1], 10); i++; }
  else if (args[i] === '--seed-from-backtest') { SEED_MODE = true; }
}

console.log('CLAW VRT2 — recalibrate_weights_vrt2 v3');
console.log('Rolling window:', ROLLING_DAYS, 'days');
console.log('Seed mode:', SEED_MODE);

// ── SEED TABLE IF EMPTY ──────────────────────────────────────────────────
// Source of truth: lib/signal_config.js — never hardcode signals here.
// If signal_weights is empty (shouldn't happen after migrate_v3_1_vrt2.js),
// seed from SIGNAL_CONFIG. This is the safety net for cold starts only.
const { SIGNAL_CONFIG } = require('../lib/signal_config');

var existing = db.prepare('SELECT COUNT(*) AS n FROM signal_weights').get();
if (existing.n === 0) {
  console.log('signal_weights table empty — seeding from lib/signal_config.js');
  console.log('(Run node migrate_v3_1_vrt2.js for a proper seed with all fields)');
  var insertSeed = db.prepare(`
    INSERT OR IGNORE INTO signal_weights
    (hyp_id, weight, base_weight, direction, half_life_min, regime_class,
     threshold, description, enabled, data_source, phase, confidence_tier, updated_ts)
    VALUES (@hyp_id, @weight, @weight, @direction, @half_life_min, @regime_class,
            @threshold, @description, @enabled, @data_source, @phase, @confidence_tier, @updated_ts)
  `);
  var seedTx = db.transaction(function() {
    var now = Date.now();
    Object.entries(SIGNAL_CONFIG).forEach(function(entry) {
      var h = entry[0], cfg = entry[1];
      insertSeed.run({
        hyp_id: h, weight: cfg.weight, direction: cfg.direction,
        half_life_min: cfg.half_life_min, regime_class: cfg.regime_class,
        threshold: cfg.threshold || 0, description: cfg.description,
        enabled: cfg.enabled ? 1 : 0, data_source: cfg.data_source,
        phase: cfg.enabled ? 'ACTIVE' : 'DISABLED',
        confidence_tier: cfg.confidence_tier || 'UNTESTED', updated_ts: now
      });
    });
  });
  seedTx();
  console.log('Seeded', Object.keys(SIGNAL_CONFIG).length, 'hypotheses from SIGNAL_CONFIG');
}

// ── RECALIBRATE ───────────────────────────────────────────────────────────
var windowMs = ROLLING_DAYS * 86400000;
var since = Date.now() - windowMs;

console.log('\nRecalibrating weights from signals since', new Date(since).toISOString().slice(0, 10));

// v3.2.0 #F1: Build set of ET date strings that were DEGRADED or INCOMPLETE.
// Signals fired on these days are excluded from hit rate calculations because
// the underlying data was incomplete — scoring against them would poison the
// hypothesis quality tracking during the LEARNING phase.
var degradedDates = new Set();
try {
  var degradedRows = db.prepare(
    "SELECT brief_date FROM daily_briefs " +
    "WHERE data_quality IN ('DEGRADED', 'INCOMPLETE') " +
    "AND generated_ts >= ?"
  ).all(since);
  degradedRows.forEach(function(r) { degradedDates.add(r.brief_date); });
  if (degradedDates.size > 0) {
    console.log('Excluding ' + degradedDates.size + ' degraded/incomplete day(s) from hit rate window:',
      Array.from(degradedDates).join(', '));
  }
} catch (e) {
  // daily_briefs.data_quality column may not exist if migrate_v3_2.js hasn't run.
  // In that case proceed without exclusions — safer than crashing.
  console.log('  · data_quality column not found — skipping degraded-day exclusion (run migrate_v3_2.js)');
}

var hypRows = db.prepare('SELECT * FROM signal_weights').all();
var updated = 0;

var updateStmt = db.prepare(`
  UPDATE signal_weights
  SET weight = @weight,
      hit_rate = @hit_rate,
      n_signals = @n_signals,
      avg_alpha_when_hit = @avg_alpha_when_hit,
      avg_alpha_when_miss = @avg_alpha_when_miss,
      last_recalibrated_ts = @last_recalibrated_ts,
      updated_ts = @updated_ts
  WHERE hyp_id = @hyp_id
`);

var updateTx = db.transaction(function() {
  hypRows.forEach(function(h) {
    // In seed mode, weight backtest rows fully. In normal mode, prefer live rows.
    var liveWeight = SEED_MODE ? 1 : 2;
    var backtestWeight = 1;

    var liveStats = db.prepare(`
      SELECT
        COUNT(*) AS n,
        SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits,
        SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) AS misses,
        AVG(CASE WHEN hit = 1 THEN alpha_5d END) AS avg_hit_alpha,
        AVG(CASE WHEN hit = 0 THEN alpha_5d END) AS avg_miss_alpha
      FROM signals
      WHERE hyp_id = ? AND is_backtest = 0 AND ts >= ? AND hit IS NOT NULL
    `).all(h.hyp_id, since).filter(function(row) {
      // Exclude signals from degraded/incomplete days using ET date comparison.
      // .all() instead of .get() so we can filter before aggregating.
      return true; // placeholder — aggregation is done below after filtering
    });

    // Re-implement the aggregation after filtering out degraded days.
    // Pull raw rows so we can filter by ET date, then aggregate manually.
    var liveRows = db.prepare(`
      SELECT ts, hit, alpha_5d
      FROM signals
      WHERE hyp_id = ? AND is_backtest = 0 AND ts >= ? AND hit IS NOT NULL
    `).all(h.hyp_id, since).filter(function(row) {
      if (degradedDates.size === 0) return true;
      return !degradedDates.has(getETDateString(row.ts));
    });

    liveStats = {
      n:             liveRows.length,
      hits:          liveRows.filter(function(r) { return r.hit === 1; }).length,
      misses:        liveRows.filter(function(r) { return r.hit === 0; }).length,
      avg_hit_alpha: (function() {
        var hitAlphas = liveRows.filter(function(r) { return r.hit === 1 && r.alpha_5d != null; }).map(function(r) { return r.alpha_5d; });
        return hitAlphas.length ? hitAlphas.reduce(function(a, b) { return a + b; }, 0) / hitAlphas.length : null;
      })(),
      avg_miss_alpha: (function() {
        var missAlphas = liveRows.filter(function(r) { return r.hit === 0 && r.alpha_5d != null; }).map(function(r) { return r.alpha_5d; });
        return missAlphas.length ? missAlphas.reduce(function(a, b) { return a + b; }, 0) / missAlphas.length : null;
      })()
    };

    var backtestStats = db.prepare(`
      SELECT
        COUNT(*) AS n,
        SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits,
        SUM(CASE WHEN hit = 0 THEN 1 ELSE 0 END) AS misses,
        AVG(CASE WHEN hit = 1 THEN alpha_5d END) AS avg_hit_alpha,
        AVG(CASE WHEN hit = 0 THEN alpha_5d END) AS avg_miss_alpha
      FROM signals
      WHERE hyp_id = ? AND is_backtest = 1 AND hit IS NOT NULL
    `).get(h.hyp_id);

    var totalHits   = (liveStats.hits   || 0) * liveWeight + (backtestStats.hits   || 0) * backtestWeight;
    var totalMisses = (liveStats.misses || 0) * liveWeight + (backtestStats.misses || 0) * backtestWeight;
    var totalN = totalHits + totalMisses;

    if (totalN < 5) {
      // Insufficient data — keep base weight, don't touch
      return;
    }

    var hitRate = totalHits / totalN;

    // Precision multiplier: how much alpha when we're right?
    var avgHitAlpha = liveStats.avg_hit_alpha || backtestStats.avg_hit_alpha || 0;
    var avgMissAlpha = liveStats.avg_miss_alpha || backtestStats.avg_miss_alpha || 0;
    var precision = Math.max(0.5, Math.min(2.0, Math.abs(avgHitAlpha) / 5.0));

    // Sample adjustment: reward larger samples, cap the boost
    var sampleAdj = Math.max(0.5, Math.min(1.5, Math.sqrt(totalN / 30)));

    var newWeight;
    if (hitRate < 0.40) {
      // Worse than coin flip — mute to near-zero
      newWeight = h.base_weight * 0.1;
    } else {
      newWeight = h.base_weight * hitRate * precision * sampleAdj;
    }
    newWeight = Math.round(newWeight * 100) / 100;

    updateStmt.run({
      hyp_id: h.hyp_id,
      weight: newWeight,
      hit_rate: Math.round(hitRate * 10000) / 10000,
      n_signals: totalN,
      avg_alpha_when_hit: avgHitAlpha ? Math.round(avgHitAlpha * 100) / 100 : null,
      avg_alpha_when_miss: avgMissAlpha ? Math.round(avgMissAlpha * 100) / 100 : null,
      last_recalibrated_ts: Date.now(),
      updated_ts: Date.now()
    });

    console.log('  ' + h.hyp_id + ': base ' + h.base_weight + ' → ' + newWeight.toFixed(2) +
                ' (hit rate ' + (hitRate * 100).toFixed(0) + '%, n=' + totalN + ')');
    updated++;
  });
});

updateTx();

console.log('\nRecalibrated', updated, 'hypotheses');

// ── JOB HEALTH ────────────────────────────────────────────────────────────
try {
  db.prepare(`
    INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written)
    VALUES ('recalibrate_weights_vrt2', ?, 'OK', ?)
  `).run(Date.now(), updated);
} catch (e) { console.error('  ⚠ job_health write failed (run migrate_v3_1.js?): ' + e.message); }

db.close();
console.log('Done.');
