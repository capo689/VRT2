// CLAW VRT2 — v3.1 Migration
//
// Seeds signal_weights with all VRT2 hypotheses from lib/signal_config.js.
// Idempotent — INSERT OR IGNORE, safe to run multiple times.
// Also updates data_source, phase, and confidence_tier columns.
//
// Run after setup_db_vrt2.js: node migrate_v3_1_vrt2.js

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');
const { SIGNAL_CONFIG } = require('./lib/signal_config');

const DB_PATH = path.join(__dirname, 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('CLAW VRT2 — v3.1 schema migration');
console.log('Database:', DB_PATH);
console.log('');

// ── Ensure confidence_tier column exists ──────────────────────────────────────
// (included in setup_db_vrt2.js from day one, but guard for safety)
try {
  db.exec('ALTER TABLE signal_weights ADD COLUMN confidence_tier TEXT DEFAULT \'UNTESTED\'');
  console.log('+ confidence_tier column added to signal_weights');
} catch (e) {
  if (!e.message.includes('duplicate column')) throw e;
  console.log('· confidence_tier column already exists');
}

// ── Seed signal_weights from SIGNAL_CONFIG ────────────────────────────────────
console.log('');
console.log('Seeding signal_weights from lib/signal_config.js...');

var insertHyp = db.prepare(`
  INSERT OR IGNORE INTO signal_weights (
    hyp_id, weight, base_weight, hit_rate, n_signals,
    direction, half_life_min, regime_class, threshold,
    description, enabled, data_source, phase,
    confidence_tier, updated_ts
  ) VALUES (
    @hyp_id, @weight, @weight, NULL, 0,
    @direction, @half_life_min, @regime_class, @threshold,
    @description, @enabled, @data_source, @phase,
    @confidence_tier, @updated_ts
  )
`);

var updateHyp = db.prepare(`
  UPDATE signal_weights SET
    weight          = @weight,
    base_weight     = @weight,
    direction       = @direction,
    half_life_min   = @half_life_min,
    regime_class    = @regime_class,
    threshold       = @threshold,
    description     = @description,
    enabled         = @enabled,
    data_source     = @data_source,
    phase           = @phase,
    confidence_tier = @confidence_tier,
    updated_ts      = @updated_ts
  WHERE hyp_id = @hyp_id
`);

var now = Date.now();
var inserted = 0;
var updated  = 0;

Object.entries(SIGNAL_CONFIG).forEach(function(entry) {
  var id  = entry[0];
  var cfg = entry[1];

  var row = {
    hyp_id:           id,
    weight:           cfg.weight,
    direction:        cfg.direction,
    half_life_min:    cfg.half_life_min,
    regime_class:     cfg.regime_class,
    threshold:        cfg.threshold || 0,
    description:      cfg.description,
    enabled:          cfg.enabled ? 1 : 0,
    data_source:      cfg.data_source,
    phase:            cfg.enabled ? 'ACTIVE' : 'DISABLED',
    confidence_tier:  cfg.confidence_tier || 'UNTESTED',
    updated_ts:       now,
  };

  var res = insertHyp.run(row);
  if (res.changes > 0) {
    inserted++;
    console.log('  + ' + id.padEnd(20) + ' weight=' + cfg.weight +
      ' dir=' + cfg.direction.padEnd(8) + ' src=' + cfg.data_source +
      ' tier=' + (cfg.confidence_tier || 'UNTESTED'));
  } else {
    // Update config values but preserve live hit_rate and n_signals
    updateHyp.run(row);
    updated++;
    console.log('  · ' + id.padEnd(20) + ' updated (preserved hit_rate/n_signals)');
  }
});

// ── Mark parked/disabled signals ──────────────────────────────────────────────
var PARKED = ['H-OPT', 'H25'];
var setParked = db.prepare(
  "UPDATE signal_weights SET phase = 'PARKED', enabled = 0 WHERE hyp_id = ?"
);
console.log('');
console.log('Marking parked hypotheses...');
PARKED.forEach(function(id) {
  var r = setParked.run(id);
  if (r.changes > 0) console.log('  ~ ' + id + ' → PARKED');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log('═'.repeat(60));
console.log('Migration complete');
console.log('═'.repeat(60));
console.log('');
console.log('Rows inserted:', inserted);
console.log('Rows updated: ', updated);
console.log('');

var counts = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN phase = 'PARKED' THEN 1 ELSE 0 END) AS parked,
    SUM(CASE WHEN confidence_tier = 'PROVISIONAL' THEN 1 ELSE 0 END) AS provisional,
    SUM(CASE WHEN confidence_tier = 'UNTESTED' THEN 1 ELSE 0 END) AS untested
  FROM signal_weights
`).get();

console.log('Signal weight counts:');
console.log('  Total:       ' + counts.total);
console.log('  Active:      ' + counts.active);
console.log('  Parked:      ' + counts.parked);
console.log('  PROVISIONAL: ' + counts.provisional);
console.log('  UNTESTED:    ' + counts.untested);
console.log('');

var bySrc = db.prepare(
  'SELECT data_source, COUNT(*) AS n FROM signal_weights WHERE enabled = 1 GROUP BY data_source ORDER BY n DESC'
).all();
console.log('Active signals by data source:');
bySrc.forEach(function(s) {
  console.log('  ' + s.data_source.padEnd(20) + s.n);
});
console.log('');

db.close();
console.log('Done.');
