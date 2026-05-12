#!/usr/bin/env node
// CLAW VRT2 — jobs/signal_audit_vrt2.js
//
// Nightly signal performance audit. Reads signal outcome data, computes
// rolling hit rates, auto-promotes/pauses/kills signals based on BACKTEST_GATES.
// Logs all tier changes to signal_overrides table.
//
// Run via launchd at 02:00 ET daily.
// Can also be run manually: node jobs/signal_audit_vrt2.js

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path     = require('path');
const Database = require('better-sqlite3');
const { getETDateString } = require('../lib/dates');
const { BACKTEST_GATES }  = require('../lib/signal_config');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db      = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('CLAW VRT2 — Signal Audit');
console.log('DB:', DB_PATH);
console.log('ET Date:', getETDateString());
console.log('');

const now = Date.now();

// ── Load all active signal weights ────────────────────────────────────────────
const weights = db.prepare(
  "SELECT * FROM signal_weights WHERE phase NOT IN ('KILLED','DISABLED')"
).all();

console.log('Signals under review:', weights.length);
console.log('');

let promoted = 0, paused = 0, killed = 0, unchanged = 0;

const insertOverride = db.prepare(`
  INSERT INTO signal_overrides (ts, hyp_id, from_tier, to_tier, reason, set_by)
  VALUES (?, ?, ?, ?, ?, 'signal_audit_vrt2')
`);

const updateWeight = db.prepare(`
  UPDATE signal_weights
  SET confidence_tier = ?, phase = ?, hit_rate = ?, n_signals = ?,
      avg_alpha_when_hit = ?, avg_alpha_when_miss = ?, last_recalibrated_ts = ?, updated_ts = ?
  WHERE hyp_id = ?
`);

// ── Rolling 60-day hit rates (post-inclusion only: after Mar 23 2026) ─────────
const INCLUSION_TS = new Date('2026-03-23').getTime();
const WINDOW_MS    = 60 * 86400000;
const windowStart  = Math.max(now - WINDOW_MS, INCLUSION_TS);

for (const w of weights) {
  // Pull all filled outcome rows for this signal in the rolling window
  const rows = db.prepare(`
    SELECT outcome_5d, alpha_5d, hit, ts
    FROM signals
    WHERE hyp_id = ? AND is_backtest = 0
      AND outcome_filled_at IS NOT NULL
      AND ts >= ?
    ORDER BY ts DESC
  `).all(w.hyp_id, windowStart);

  const n = rows.length;
  if (n === 0) {
    console.log(`  ${w.hyp_id.padEnd(20)} n=0 — insufficient data, skip`);
    unchanged++;
    continue;
  }

  const hits    = rows.filter(r => r.hit === 1).length;
  const hitRate = hits / n;
  const alphaHit  = rows.filter(r => r.hit === 1 && r.alpha_5d != null)
    .reduce((s, r) => s + r.alpha_5d, 0) / Math.max(1, hits);
  const alphaMiss = rows.filter(r => r.hit === 0 && r.alpha_5d != null)
    .reduce((s, r) => s + r.alpha_5d, 0) / Math.max(1, n - hits);

  const oldTier  = w.confidence_tier || 'UNTESTED';
  const oldPhase = w.phase || 'ACTIVE';
  let newTier    = oldTier;
  let newPhase   = oldPhase;
  let action     = null;

  // Apply gate logic
  if (n >= BACKTEST_GATES.n_for_kill) {
    if (hitRate < BACKTEST_GATES.kill_threshold) {
      newTier  = 'KILLED';
      newPhase = 'KILLED';
      action   = `AUTO-KILL: hit rate ${(hitRate*100).toFixed(1)}% < ${BACKTEST_GATES.kill_threshold*100}% at n=${n}`;
      killed++;
    } else if (hitRate >= BACKTEST_GATES.backtested_threshold) {
      newTier  = 'BACKTESTED';
      newPhase = 'ACTIVE';
      action   = `PROMOTE→BACKTESTED: hit rate ${(hitRate*100).toFixed(1)}% >= ${BACKTEST_GATES.backtested_threshold*100}% at n=${n}`;
      promoted++;
    }
  } else if (n >= BACKTEST_GATES.n_for_pause_check && hitRate < BACKTEST_GATES.pause_threshold) {
    newTier  = 'UNTESTED';
    newPhase = 'PAUSED';
    action   = `AUTO-PAUSE: hit rate ${(hitRate*100).toFixed(1)}% < ${BACKTEST_GATES.pause_threshold*100}% at n=${n}`;
    paused++;
  } else if (n >= BACKTEST_GATES.n_early_pause && n < BACKTEST_GATES.n_for_pause_check
      && hitRate < BACKTEST_GATES.early_pause_threshold) {
    newTier  = 'UNTESTED';
    newPhase = 'PAUSED';
    action   = `EARLY-PAUSE: hit rate ${(hitRate*100).toFixed(1)}% < ${BACKTEST_GATES.early_pause_threshold*100}% at n=${n}`;
    paused++;
  } else if (n >= BACKTEST_GATES.n_for_backtested && oldTier === 'PROVISIONAL'
      && hitRate >= BACKTEST_GATES.backtested_threshold) {
    newTier  = 'BACKTESTED';
    action   = `PROMOTE→BACKTESTED: hit rate ${(hitRate*100).toFixed(1)}% at n=${n}`;
    promoted++;
  } else if (n >= 5 && oldTier === 'UNTESTED' && hitRate >= 0.45) {
    newTier  = 'PROVISIONAL';
    action   = `PROMOTE→PROVISIONAL: n=${n}, hit rate ${(hitRate*100).toFixed(1)}%`;
    promoted++;
  } else {
    unchanged++;
  }

  // Write update
  updateWeight.run(newTier, newPhase, hitRate, n, alphaHit, alphaMiss, now, now, w.hyp_id);

  if (action) {
    insertOverride.run(now, w.hyp_id, oldTier, newTier, action);
    const marker = newPhase === 'KILLED' ? '💀' : newPhase === 'PAUSED' ? '⏸' : '⬆';
    console.log(`  ${marker} ${w.hyp_id.padEnd(20)} n=${n} hit=${(hitRate*100).toFixed(1)}% → ${newTier} | ${action}`);
  } else {
    console.log(`  · ${w.hyp_id.padEnd(20)} n=${n} hit=${(hitRate*100).toFixed(1)}% | ${oldTier} (no change)`);
  }
}

// ── Cold streak tracking (3 consecutive misses → double half-life) ────────────
console.log('\nChecking cold streaks...');
const allActive = db.prepare(
  "SELECT hyp_id FROM signal_weights WHERE phase='ACTIVE' AND enabled=1"
).all();

for (const { hyp_id } of allActive) {
  const last3 = db.prepare(`
    SELECT hit FROM signals
    WHERE hyp_id=? AND is_backtest=0 AND outcome_filled_at IS NOT NULL
    ORDER BY ts DESC LIMIT 3
  `).all(hyp_id);

  if (last3.length === 3 && last3.every(r => r.hit === 0)) {
    // 3 consecutive misses — check if we've already logged this
    const alreadyDoubled = db.prepare(`
      SELECT 1 FROM signal_overrides
      WHERE hyp_id=? AND reason LIKE 'COLD_STREAK%' AND ts > ?
    `).get(hyp_id, now - 7 * 86400000);

    if (!alreadyDoubled) {
      insertOverride.run(now, hyp_id, null, null,
        'COLD_STREAK: 3 consecutive misses — half-life doubled until next hit',
        'signal_audit_vrt2');
      console.log(`  ❄ ${hyp_id} — 3-miss cold streak logged`);
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('Signal audit complete');
console.log('═'.repeat(55));
console.log(`  Promoted:  ${promoted}`);
console.log(`  Paused:    ${paused}`);
console.log(`  Killed:    ${killed}`);
console.log(`  Unchanged: ${unchanged}`);
console.log('');

// Job health write
try {
  db.prepare(`
    INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
    VALUES ('signal_audit_vrt2', ?, 'OK', ?, ?)
  `).run(now, promoted + paused + killed, Date.now() - now);
} catch(e) {
  console.warn('⚠ job_health write failed:', e.message);
}

db.close();
console.log('Done.');
