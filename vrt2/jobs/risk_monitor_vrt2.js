#!/usr/bin/env node
// CLAW VRT2 — jobs/risk_monitor_vrt2.js
//
// Real-time drawdown tracking and kill-switch enforcement.
// Reads positions table, tracks consecutive losers and drawdown from peak.
// Writes risk_state table. Runs at market open + after every position close.
//
// Run via launchd: once at 09:31 ET, and triggered after trade closes.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path     = require('path');
const Database = require('better-sqlite3');
const { DRAWDOWN_PROTOCOL } = require('../lib/signal_config');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db      = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const now = Date.now();
console.log('CLAW VRT2 — Risk Monitor');
console.log(new Date(now).toISOString());

function getRiskState(key) {
  const row = db.prepare('SELECT state_value FROM risk_state WHERE state_key=?').get(key);
  return row ? row.state_value : null;
}

function setRiskState(key, value) {
  db.prepare(
    'INSERT OR REPLACE INTO risk_state (state_key, state_value, updated_at) VALUES (?, ?, ?)'
  ).run(key, String(value), now);
}

// ── Read closed positions from DB ─────────────────────────────────────────────
let positions;
try {
  positions = db.prepare(
    "SELECT * FROM positions WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 20"
  ).all();
} catch(e) {
  console.log('positions table not yet populated — skipping drawdown check');
  positions = [];
}

// ── Consecutive loser tracking ────────────────────────────────────────────────
let consecutiveLosers = 0;
for (const pos of positions) {
  if (pos.is_hit === 0) {
    consecutiveLosers++;
  } else {
    break; // stop at first win
  }
}

setRiskState('consecutive_losers', consecutiveLosers);

const prevHalf = getRiskState('half_size_active');
const prevHalt = getRiskState('halt_trading_active');

let halfSize = false;
let haltTrading = false;

if (consecutiveLosers >= DRAWDOWN_PROTOCOL.consecutive_losers_halt) {
  haltTrading = true;
  console.log(`⛔ HALT: ${consecutiveLosers} consecutive losers — trading halted pending review`);
} else if (consecutiveLosers >= DRAWDOWN_PROTOCOL.consecutive_losers_half_size) {
  halfSize = true;
  console.log(`⚠ HALF-SIZE: ${consecutiveLosers} consecutive losers`);
} else {
  console.log(`Consecutive losers: ${consecutiveLosers} — within normal range`);
}

setRiskState('half_size_active',   halfSize   ? '1' : '0');
setRiskState('halt_trading_active', haltTrading ? '1' : '0');

// ── Drawdown from peak (using all closed positions) ───────────────────────────
let allPositions;
try {
  allPositions = db.prepare(
    "SELECT outcome_pct, is_hit FROM positions WHERE status='CLOSED' ORDER BY closed_at ASC"
  ).all();
} catch(e) { allPositions = []; }

let bookValue = 100; // index from 100
let peakValue = 100;
let maxDrawdown = 0;
let currentDrawdown = 0;

for (const pos of allPositions) {
  if (pos.outcome_pct != null) {
    bookValue *= (1 + pos.outcome_pct / 100);
    if (bookValue > peakValue) peakValue = bookValue;
    currentDrawdown = (peakValue - bookValue) / peakValue * 100;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
  }
}

setRiskState('peak_book_value',     peakValue.toFixed(4));
setRiskState('current_drawdown_pct', currentDrawdown.toFixed(2));
setRiskState('max_drawdown_pct',     maxDrawdown.toFixed(2));

console.log(`Drawdown: current=${currentDrawdown.toFixed(1)}%, max=${maxDrawdown.toFixed(1)}%, peak=${peakValue.toFixed(2)}`);

// ── Hard kill-switch ──────────────────────────────────────────────────────────
const prevKill = getRiskState('kill_switch_active');
let killSwitch = false;

if (currentDrawdown >= DRAWDOWN_PROTOCOL.max_drawdown_pct_kill) {
  killSwitch = true;
  console.log(`💀 KILL-SWITCH: ${currentDrawdown.toFixed(1)}% drawdown >= ${DRAWDOWN_PROTOCOL.max_drawdown_pct_kill}% limit`);
  console.log('   All trading halted. Post-mortem required before resume.');
}

// Monthly loss check (approximate: sum of last 22 trading days of closed positions)
const monthStart = now - 22 * 86400000;
let monthlyPL = 0;
try {
  const monthPositions = db.prepare(
    "SELECT outcome_pct FROM positions WHERE status='CLOSED' AND closed_at>=?"
  ).all(monthStart);
  for (const p of monthPositions) {
    if (p.outcome_pct != null) monthlyPL += p.outcome_pct;
  }
  if (monthlyPL <= -DRAWDOWN_PROTOCOL.monthly_loss_pct_pause) {
    console.log(`⚠ MONTHLY LOSS: ${monthlyPL.toFixed(1)}% — strategy paused for ${DRAWDOWN_PROTOCOL.pause_days} days`);
    killSwitch = true;
  }
} catch(e) {}

setRiskState('kill_switch_active', killSwitch ? '1' : '0');

// Log transitions
if (killSwitch && prevKill === '0') {
  console.log('KILL-SWITCH TRIPPED — position_sizer_vrt2.js will return 0% for all signals');
}
if (!killSwitch && prevKill === '1') {
  console.log('KILL-SWITCH CLEARED — trading may resume');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\nRisk state:');
console.log(`  kill_switch_active:   ${killSwitch}`);
console.log(`  halt_trading_active:  ${haltTrading}`);
console.log(`  half_size_active:     ${halfSize}`);
console.log(`  consecutive_losers:   ${consecutiveLosers}`);
console.log(`  current_drawdown_pct: ${currentDrawdown.toFixed(2)}`);
console.log(`  peak_book_value:      ${peakValue.toFixed(2)}`);

// ── Job health ────────────────────────────────────────────────────────────────
try {
  db.prepare(`
    INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
    VALUES ('risk_monitor_vrt2', ?, 'OK', 1, ?)
  `).run(now, Date.now() - now);
} catch(e) {}

db.close();
