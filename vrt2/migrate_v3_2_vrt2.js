// CLAW VRT2 — v3.2 Migration
//
// Verifies harness quality columns exist in daily_briefs and regime_log.
// These were included in setup_db_vrt2.js from day one (lesson from CRDO),
// so this migration is primarily a verification + idempotent guard.
//
// Also initialises harness_quality module path check.
//
// Run: node migrate_v3_2_vrt2.js

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('CLAW VRT2 — v3.2 schema migration (quality columns verification)');
console.log('Database:', DB_PATH);
console.log('');

// ── daily_briefs quality columns ──────────────────────────────────────────────
var qualityCols = [
  ['data_quality',       "TEXT DEFAULT 'UNKNOWN'"],
  ['tasks_completed',    'INTEGER'],
  ['tasks_failed',       'INTEGER'],
  ['tasks_total',        'INTEGER'],
  ['harness_uptime_pct', 'REAL'],
];

console.log('Verifying daily_briefs quality columns...');
qualityCols.forEach(function(col) {
  try {
    db.exec('ALTER TABLE daily_briefs ADD COLUMN ' + col[0] + ' ' + col[1]);
    console.log('  + daily_briefs.' + col[0] + ' (added — was missing from setup)');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('  ✓ daily_briefs.' + col[0] + ' already present');
    } else {
      throw e;
    }
  }
});

// ── Create quality index if missing ──────────────────────────────────────────
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_vrt2_briefs_quality ON daily_briefs(data_quality)');
  console.log('  ✓ idx_vrt2_briefs_quality index OK');
} catch (e) {
  console.log('  ! Index error:', e.message);
}

// ── regime_log verification ───────────────────────────────────────────────────
console.log('');
console.log('Verifying regime_log table...');
try {
  var regimeCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='regime_log'"
  ).get();
  if (regimeCheck) {
    console.log('  ✓ regime_log table present');
  } else {
    // Create it if missing (shouldn't happen after setup_db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS regime_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        et_date         TEXT NOT NULL,
        vix_value       REAL,
        vix_regime      TEXT,
        pmi_value       REAL,
        pmi_regime      TEXT,
        rates_delta_bps REAL,
        rates_regime    TEXT,
        hyg_30d_pct     REAL,
        risk_regime     TEXT,
        full_vector     TEXT,
        is_transition   INTEGER DEFAULT 0,
        UNIQUE(et_date)
      );
      CREATE INDEX IF NOT EXISTS idx_vrt2_regime_ts   ON regime_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_vrt2_regime_date ON regime_log(et_date);
    `);
    console.log('  + regime_log table created (was missing)');
  }
} catch (e) {
  console.log('  ! regime_log check error:', e.message);
}

// ── positions and risk_state verification ─────────────────────────────────────
console.log('');
console.log('Verifying production-discipline tables...');
var newTables = [
  'positions', 'risk_state', 'analyst_revisions',
  'options_flow', 'signal_overrides', 'regime_log'
];
newTables.forEach(function(t) {
  var row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(t);
  console.log('  ' + (row ? '✓' : '✗') + ' ' + t);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log('═'.repeat(60));
console.log('v3.2 migration complete');
console.log('═'.repeat(60));
console.log('');

var allTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all();
console.log('Total tables in vrt2.db:', allTables.length);

db.close();
console.log('Done.');
