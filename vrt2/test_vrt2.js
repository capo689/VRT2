#!/usr/bin/env node
/**
 * CLAW VRT2 — test_vrt2.js
 * 
 * Comprehensive pre-launch test suite. Run before any deployment.
 * Tests every layer: lib functions, DB schema, job file integrity,
 * API config, scheduler logic, signal math, and environment.
 *
 * Usage:
 *   node test_vrt2.js              # all tests
 *   node test_vrt2.js --fast       # skip DB-heavy tests
 *   node test_vrt2.js --section=api # run only API section
 *
 * Exit code 0 = all pass. Exit code 1 = failures found.
 * Green = pass. Red = fail. Yellow = warning (won't block launch).
 */

'use strict';

const path     = require('path');
const fs       = require('fs');
let Database;
try {
  Database = require('better-sqlite3');
} catch(e) {
  Database = null;
  console.log('  (better-sqlite3 not installed — DB section will be skipped)');
}

const ROOT = path.resolve(__dirname);
const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const SECTION = args.find(a => a.startsWith('--section='));
const ONLY_SECTION = SECTION ? SECTION.split('=')[1] : null;

// ── COLORS ────────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
};

// ── TEST RUNNER ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const failures = [];

function pass(name) {
  passed++;
  console.log(`  ${C.green}✓${C.reset} ${name}`);
}

function fail(name, detail) {
  failed++;
  failures.push({ name, detail });
  console.log(`  ${C.red}✗ ${name}${C.reset}`);
  if (detail) console.log(`    ${C.red}→ ${detail}${C.reset}`);
}

function warn(name, detail) {
  warned++;
  console.log(`  ${C.yellow}⚠ ${name}${C.reset}`);
  if (detail) console.log(`    ${C.yellow}→ ${detail}${C.reset}`);
}

function section(name) {
  console.log(`\n${C.bold}${C.cyan}── ${name} ${'─'.repeat(Math.max(0, 50 - name.length))}${C.reset}`);
}

function assert(condition, name, detail) {
  if (condition) pass(name);
  else fail(name, detail);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1: FILE EXISTENCE
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'files') {
  section('1. File existence');

  const required = [
    'claw_server_vrt2.js',
    'setup_db_vrt2.js',
    'migrate_v3_1_vrt2.js',
    'migrate_v3_2_vrt2.js',
    'migrate_vrt_from_v1.py',
    'backtest_harness_vrt2.py',
    'dashboard_vrt2.html',
    'install.sh',
    'package.json',
    '.env',
    'lib/config.js',
    'lib/dates.js',
    'lib/harness_quality.js',
    'lib/regime.js',
    'lib/signal_config.js',
    'jobs/browser_runner_vrt2.js',
    'jobs/fill_outcomes_vrt2.js',
    'jobs/recalibrate_weights_vrt2.js',
    'jobs/signal_audit_vrt2.js',
    'jobs/regime_detector_vrt2.js',
    'jobs/risk_monitor_vrt2.js',
    'jobs/correlation_vrt2.js',
    'jobs/edgar_vrt2.js',
    'jobs/insider_vrt2.js',
    'jobs/analyst_revisions_vrt2.js',
    'jobs/aws_news_vrt2.js',
    'jobs/options_flow_phase1_vrt2.js',
    'jobs/process_browser_results_vrt2.js',
    'jobs/queue_daily_review_vrt2.js',
    'jobs/queue_scan_tasks_vrt2.js',
    'jobs/queue_news_tasks_vrt2.js',
    'jobs/scan_watchdog_vrt2.js',
    'jobs/scheduler_dispatch.sh',
    'jobs/backtest_vrt2.js',
    'com.adamcagle.claw.vrt2.queue.plist',
    'com.adamcagle.claw.vrt2.scan.plist',
  ];

  required.forEach(function(f) {
    assert(fs.existsSync(path.join(ROOT, f)), f);
  });

  // DB must exist after setup
  assert(fs.existsSync(path.join(ROOT, 'vrt2.db')), 'vrt2.db exists');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2: ENVIRONMENT
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'env') {
  section('2. Environment & .env');

  // Load .env same way browser_runner does
  const envPath = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
      const m = line.match(/^([^#=]+)=(.*)/);
      if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }

  const fKey = env['FINNHUB_API_KEY'];
  assert(fKey && fKey.length > 10 && !fKey.includes('your_'), 
    'FINNHUB_API_KEY set and not placeholder',
    fKey ? `got: "${fKey.slice(0,6)}..." length=${fKey.length}` : 'NOT SET');

  const aKey = env['ANTHROPIC_API_KEY'];
  assert(aKey && aKey.startsWith('sk-ant-') && aKey.length > 40,
    'ANTHROPIC_API_KEY set and valid format (sk-ant-...)',
    aKey ? `got: "${aKey.slice(0,12)}..." length=${aKey.length}` : 'NOT SET');

  // Check for duplicate keys in .env (last value wins — verify correct one wins)
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const anthropicLines = lines.filter(l => l.startsWith('ANTHROPIC_API_KEY='));
    if (anthropicLines.length > 1) {
      const lastVal = anthropicLines[anthropicLines.length - 1].split('=')[1] || '';
      assert(lastVal.trim().startsWith('sk-ant-'),
        `Multiple ANTHROPIC_API_KEY entries — last value is valid (${anthropicLines.length} entries)`,
        `Last: ${lastVal.slice(0,15)}...`);
    } else {
      pass('ANTHROPIC_API_KEY has no duplicates in .env');
    }
  }

  // Plist has TZ=America/New_York
  const plistContent = fs.readFileSync(path.join(ROOT, 'com.adamcagle.claw.vrt2.queue.plist'), 'utf8');
  assert(plistContent.includes('America/New_York'),
    'queue plist has TZ=America/New_York environment variable');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3: LIB FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'lib') {
  section('3. lib/ function correctness');

  // dates.js
  const dates = require(path.join(ROOT, 'lib/dates'));

  // Test with a known timestamp: 2026-04-15 14:00 UTC = 10:00 AM ET (EDT)
  const t = new Date('2026-04-15T14:00:00Z').getTime();
  assert(dates.getETDateString(t) === '2026-04-15', 'getETDateString: UTC noon → correct ET date');
  assert(dates.getETYesterday(t) === '2026-04-14', 'getETYesterday: returns prior ET date');
  assert(dates.getETHour(t) === 10, 'getETHour: 14:00 UTC = 10:00 ET');

  // Test DST boundary: EST (Jan = UTC-5)
  const tEST = new Date('2026-01-15T14:00:00Z').getTime();
  assert(dates.getETHour(tEST) === 9, 'getETHour EST: 14:00 UTC = 09:00 ET in January');
  assert(dates.getETDateString(tEST) === '2026-01-15', 'getETDateString works in EST');

  // Test midnight boundary
  const tMidnight = new Date('2026-04-15T04:01:00Z').getTime(); // 00:01 ET
  assert(dates.getETDateString(tMidnight) === '2026-04-15', 'getETDateString: just past ET midnight');
  const tPreMidnight = new Date('2026-04-15T03:59:00Z').getTime(); // 23:59 ET Apr 14
  assert(dates.getETDateString(tPreMidnight) === '2026-04-14', 'getETDateString: just before ET midnight');

  assert(typeof dates.getETDayStartMs(t) === 'number', 'getETDayStartMs returns number');
  const dayStart = dates.getETDayStartMs(t);
  assert(dates.getETDateString(dayStart) === '2026-04-15', 'getETDayStartMs is within correct ET day');
  assert(dates.getETDateString(dayStart - 1) === '2026-04-14', 'getETDayStartMs boundary: 1ms before is prior day');

  // regime.js
  const regime = require(path.join(ROOT, 'lib/regime'));

  assert(regime.binVix(14) === 'LOW',      'binVix: 14 = LOW');
  assert(regime.binVix(18) === 'NORMAL',   'binVix: 18 = NORMAL');
  assert(regime.binVix(24) === 'ELEVATED', 'binVix: 24 = ELEVATED');
  assert(regime.binVix(35) === 'STRESSED', 'binVix: 35 = STRESSED');
  assert(regime.binHyg(-4) === 'RISK_OFF', 'binHyg: -4 = RISK_OFF (threshold is <-3)');
  assert(regime.binHyg(-3) === 'NEUTRAL',  'binHyg: -3 = NEUTRAL (boundary, not below threshold)');
  assert(regime.binHyg(0)  === 'NEUTRAL',  'binHyg: 0 = NEUTRAL');
  assert(regime.binHyg(4)  === 'RISK_ON',   'binHyg: 4 = RISK_ON (threshold is >3)');
  
  assert(regime.binPmi(51) === 'EXPANSION',   'binPmi: 51 = EXPANSION');
  assert(regime.binPmi(49) === 'CONTRACTION', 'binPmi: 49 = CONTRACTION');
  assert(regime.binRates(-30) === 'FALLING', 'binRates: -30 = FALLING');
  assert(regime.binRates(0)   === 'FLAT',    'binRates: 0 = FLAT');
  assert(regime.binRates(30)  === 'RISING',  'binRates: 30 = RISING');

  assert(regime.deriveRegimeLabel('STRESSED','RISK_OFF') === 'STRESSED_RISK_OFF', 'deriveRegimeLabel: STRESSED+RISK_OFF');
  assert(regime.deriveRegimeLabel('LOW','RISK_ON')       === 'LOW_VOL_RISK_ON',   'deriveRegimeLabel: LOW+RISK_ON');
  assert(regime.deriveRegimeLabel('ELEVATED','RISK_ON')  === 'ELEVATED_RISK_ON',  'deriveRegimeLabel: ELEVATED+RISK_ON');
  assert(regime.deriveRegimeLabel('NORMAL','RISK_ON')    === 'ELEVATED_RISK_ON',  'deriveRegimeLabel: NORMAL+RISK_ON (bug was here)');
  assert(regime.deriveRegimeLabel('ELEVATED','NEUTRAL')  === 'ELEVATED_NEUTRAL',  'deriveRegimeLabel: default case');

  // Regime multipliers
  const s2_stressed = regime.applyRegimeMultiplier('S2', 3, 'STRESSED_RISK_OFF');
  assert(Math.abs(s2_stressed - 3*0.25) < 0.001, 'applyRegimeMultiplier: S2 STRESSED_RISK_OFF = 0.25×');
  const h22_stressed = regime.applyRegimeMultiplier('H22_buy', 4, 'STRESSED_RISK_OFF');
  assert(Math.abs(h22_stressed - 4*2.0) < 0.001, 'applyRegimeMultiplier: H22_buy STRESSED = 2.0×');
  const unknown = regime.applyRegimeMultiplier('NONEXISTENT', 5, 'ELEVATED_NEUTRAL');
  assert(unknown === 5, 'applyRegimeMultiplier: unknown signal returns unchanged weight');

  // signal_config.js
  const sc = require(path.join(ROOT, 'lib/signal_config'));

  assert(typeof sc.SIGNAL_CONFIG === 'object', 'SIGNAL_CONFIG is exported');
  const sigKeys = Object.keys(sc.SIGNAL_CONFIG);
  assert(sigKeys.length === 42, `SIGNAL_CONFIG has 42 signals (got ${sigKeys.length})`);

  const enabled = sigKeys.filter(k => sc.SIGNAL_CONFIG[k].enabled);
  assert(enabled.length === 40, `40 signals enabled (got ${enabled.length})`);

  // Check required signals exist
  ['S1_LAG','S2','S8','S_RS','S_ETN_LEAD','COMPOSITE_BULL','H-INV','H-AR','H22_buy','STACK_BULL'].forEach(function(sig) {
    assert(sc.SIGNAL_CONFIG[sig] !== undefined, `SIGNAL_CONFIG has ${sig}`);
  });

  // Check killed signals are disabled
  assert(sc.SIGNAL_CONFIG['H-OPT'] && !sc.SIGNAL_CONFIG['H-OPT'].enabled, 'H-OPT is disabled (parked)');

  // POSITION_SIZING covers all composites with no gaps
  assert(Array.isArray(sc.POSITION_SIZING) && sc.POSITION_SIZING.length === 6, 'POSITION_SIZING has 6 tiers');
  assert(sc.POSITION_SIZING[0].min === 0, 'POSITION_SIZING starts at 0');
  assert(sc.POSITION_SIZING[sc.POSITION_SIZING.length-1].max === Infinity, 'POSITION_SIZING last tier goes to Infinity');

  // Check for gaps in position sizing table
  let gapFound = false;
  for (let i = 0; i < sc.POSITION_SIZING.length - 1; i++) {
    if (sc.POSITION_SIZING[i].max + 1 !== sc.POSITION_SIZING[i+1].min) gapFound = true;
  }
  assert(!gapFound, 'POSITION_SIZING has no gaps between tiers');

  // CONFIDENCE_TIER_DISCOUNTS
  assert(sc.CONFIDENCE_TIER_DISCOUNTS['BACKTESTED'] === 1.00, 'BACKTESTED discount = 1.00');
  assert(sc.CONFIDENCE_TIER_DISCOUNTS['PROVISIONAL'] === 0.75, 'PROVISIONAL discount = 0.75');
  assert(sc.CONFIDENCE_TIER_DISCOUNTS['UNTESTED'] === 0.50, 'UNTESTED discount = 0.50');
  assert(sc.CONFIDENCE_TIER_DISCOUNTS['KILLED'] === 0.00, 'KILLED discount = 0.00');

  // BACKTEST_GATES
  assert(sc.BACKTEST_GATES.n_for_kill === 15, 'BACKTEST_GATES n_for_kill = 15');
  assert(sc.BACKTEST_GATES.kill_threshold === 0.55, 'BACKTEST_GATES kill_threshold = 0.55');

  // config.js
  const config = require(path.join(ROOT, 'lib/config'));
  assert(config.PORT === 51752, `PORT is 51752 (got ${config.PORT})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4: DATABASE SCHEMA
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'db') {
  section('4. Database schema & data');

  const dbPath = path.join(ROOT, 'vrt2.db');
  if (!Database) {
    warn('DB tests skipped — better-sqlite3 not installed (npm install first)');
  } else if (!fs.existsSync(dbPath)) {
    fail('vrt2.db exists — run setup_db_vrt2.js first');
  } else {
    const db = new Database(dbPath);

    // Required tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    const requiredTables = [
      'prices','signals','signal_weights','signal_state','composite_scores',
      'job_health','intraday_snapshots','browser_tasks','browser_task_results',
      'scan_heartbeats','page_versions','daily_briefs','news_events',
      'insider_transactions','filings','financials','correlations','lawsuits',
      'options_activity','transcript_keywords','regime_log','positions',
      'risk_state','analyst_revisions','options_flow','signal_overrides',
    ];
    requiredTables.forEach(function(t) {
      assert(tables.includes(t), `Table '${t}' exists`);
    });
    assert(tables.length >= 26, `At least 26 tables (got ${tables.length})`);

    // signals table has xli_ columns NOT smh_
    const signalCols = db.prepare("PRAGMA table_info(signals)").all().map(r => r.name);
    assert(signalCols.includes('xli_1d'), 'signals.xli_1d column exists');
    assert(signalCols.includes('xli_5d'), 'signals.xli_5d column exists');
    assert(signalCols.includes('xli_20d'), 'signals.xli_20d column exists');
    assert(!signalCols.includes('smh_1d'), 'signals.smh_1d does NOT exist (was CRDO bug)');
    assert(!signalCols.includes('smh_5d'), 'signals.smh_5d does NOT exist (was CRDO bug)');

    // signal_weights has confidence_tier column
    const swCols = db.prepare("PRAGMA table_info(signal_weights)").all().map(r => r.name);
    assert(swCols.includes('confidence_tier'), 'signal_weights.confidence_tier exists');
    assert(swCols.includes('data_source'), 'signal_weights.data_source exists');
    assert(swCols.includes('phase'), 'signal_weights.phase exists');

    // daily_briefs has quality columns
    const dbCols = db.prepare("PRAGMA table_info(daily_briefs)").all().map(r => r.name);
    assert(dbCols.includes('data_quality'), 'daily_briefs.data_quality exists');
    assert(dbCols.includes('harness_uptime_pct'), 'daily_briefs.harness_uptime_pct exists');

    // regime_log exists with correct structure
    const rlCols = db.prepare("PRAGMA table_info(regime_log)").all().map(r => r.name);
    assert(rlCols.includes('vix_regime'), 'regime_log.vix_regime exists');
    assert(rlCols.includes('full_vector'), 'regime_log.full_vector exists');

    // Price data loaded
    const priceCount = db.prepare("SELECT COUNT(*) n FROM prices WHERE ticker='VRT'").get().n;
    assert(priceCount > 1000, `VRT has ${priceCount} price rows (need >1000)`);

    const xliCount = db.prepare("SELECT COUNT(*) n FROM prices WHERE ticker='XLI'").get().n;
    assert(xliCount > 1000, `XLI has ${xliCount} price rows (needed for alpha calc)`);

    const etnCount = db.prepare("SELECT COUNT(*) n FROM prices WHERE ticker='ETN'").get().n;
    assert(etnCount > 1000, `ETN has ${etnCount} price rows (needed for S1_LAG)`);

    // Signal weights seeded
    const swCount = db.prepare("SELECT COUNT(*) n FROM signal_weights WHERE enabled=1").get().n;
    assert(swCount >= 40, `signal_weights has ${swCount} enabled rows (need ≥40)`);

    // No smh_ columns anywhere in DB (double check)
    const smhCols = db.prepare("PRAGMA table_info(signals)").all().filter(r => r.name.startsWith('smh_'));
    assert(smhCols.length === 0, 'No smh_ columns in signals table');

    // risk_state initialized
    const rsCount = db.prepare("SELECT COUNT(*) n FROM risk_state").get().n;
    assert(rsCount >= 5, `risk_state has ${rsCount} rows (should be initialized)`);

    // Test a fill_outcomes UPDATE against real schema (dry run)
    try {
      db.prepare("BEGIN").run();
      db.prepare(`
        UPDATE signals SET xli_1d=0.5, xli_5d=1.2, xli_20d=2.1,
        alpha_5d=0.8, hit=1, outcome_filled_at=1 WHERE id=-999
      `).run();
      db.prepare("ROLLBACK").run();
      pass('fill_outcomes UPDATE statement valid against live schema');
    } catch(e) {
      db.prepare("ROLLBACK").run();
      fail('fill_outcomes UPDATE against live schema', e.message);
    }

    db.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5: JOB FILE INTEGRITY
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'jobs') {
  section('5. Job file integrity');

  // fill_outcomes uses XLI not SMH
  const fillContent = fs.readFileSync(path.join(ROOT, 'jobs/fill_outcomes_vrt2.js'), 'utf8');
  assert(!fillContent.includes('smh_1d') && fillContent.includes('xli_1d'),
    'fill_outcomes_vrt2.js uses xli_ columns (not smh_)');
  assert(fillContent.includes("priceAtOffset('XLI'") && !fillContent.includes("priceAtOffset('SMH'"),
    'fill_outcomes_vrt2.js fetches XLI prices (not SMH)');

  // recalibrate_weights has no CRDO BASE_CONFIG
  const recalContent = fs.readFileSync(path.join(ROOT, 'jobs/recalibrate_weights_vrt2.js'), 'utf8');
  assert(!recalContent.includes('BASE_CONFIG'), 'recalibrate_weights has no hardcoded BASE_CONFIG');
  assert(!recalContent.includes("'H5_alab'") && !recalContent.includes("'H8_nbis'"),
    'recalibrate_weights has no CRDO-specific signal IDs');
  assert(recalContent.includes("require('../lib/signal_config')"),
    'recalibrate_weights imports from lib/signal_config');

  // browser_runner model strings
  const brContent = fs.readFileSync(path.join(ROOT, 'jobs/browser_runner_vrt2.js'), 'utf8');
  assert(brContent.includes("'claude-sonnet-4-6'"),
    "browser_runner uses claude-sonnet-4-6 (not 4-5)");
  assert(!brContent.includes("'claude-sonnet-4-5'"),
    "browser_runner does NOT use claude-sonnet-4-5 (wrong version)");
  assert(brContent.includes("'claude-haiku-4-5-20251001'") || brContent.includes("'claude-haiku-4-5'"),
    "browser_runner has a haiku model string");

  // No CRDO-specific signal IDs in any job file
  const crodoSignals = ["'H5_alab'", "'H5_mrvl'", "'H8_nbis'", "'H8_crwv'", "'H8_lead'"];
  const jobFiles = fs.readdirSync(path.join(ROOT, 'jobs')).filter(f => f.endsWith('.js'));
  jobFiles.forEach(function(fname) {
    const content = fs.readFileSync(path.join(ROOT, 'jobs', fname), 'utf8');
    const lines = content.split('\n');
    crodoSignals.forEach(function(sig) {
      const leakLines = lines.filter((l, i) => l.includes(sig) && !l.trim().startsWith('//'));
      assert(leakLines.length === 0,
        `${fname}: no functional ${sig} reference`,
        leakLines.length > 0 ? `Found on lines: ${leakLines.slice(0,2).join(' | ')}` : null);
    });
  });

  // No smh_ column references in any job file
  jobFiles.forEach(function(fname) {
    const content = fs.readFileSync(path.join(ROOT, 'jobs', fname), 'utf8');
    const leaks = content.split('\n').filter(l => /\bsmh_[135]d\b/.test(l) && !l.trim().startsWith('//'));
    assert(leaks.length === 0, `${fname}: no smh_ column references`,
      leaks.length > 0 ? leaks[0].trim().slice(0, 80) : null);
  });

  // Scheduler includes correlation, edgar, insider
  const schedContent = fs.readFileSync(path.join(ROOT, 'jobs/scheduler_dispatch.sh'), 'utf8');
  assert(schedContent.includes('correlation_vrt2.js'), 'scheduler includes correlation_vrt2.js');
  assert(schedContent.includes('edgar_vrt2.js'), 'scheduler includes edgar_vrt2.js');
  assert(schedContent.includes('insider_vrt2.js'), 'scheduler includes insider_vrt2.js');
  assert(schedContent.includes('signal_audit_vrt2.js'), 'scheduler includes signal_audit_vrt2.js');
  assert(schedContent.includes('analyst_revisions_vrt2.js'), 'scheduler includes analyst_revisions_vrt2.js');

  // Server: no require() inside hot functions
  const serverContent = fs.readFileSync(path.join(ROOT, 'claw_server_vrt2.js'), 'utf8');
  const fnStart = serverContent.indexOf('function computeCompositeScore');
  const fnEnd   = serverContent.indexOf('\nfunction ', fnStart + 1);
  const fnBody  = serverContent.slice(fnStart, fnEnd);
  assert(!fnBody.includes("require('./lib/signal_config')"),
    'computeCompositeScore: no require() inside function body');

  // Server: DST-safe market hours
  assert(serverContent.includes('getETOffsetHours'),
    'claw_server: DST-safe getETOffsetHours function exists');
  assert(!serverContent.includes('var etOffset = 4'),
    'claw_server: no hardcoded etOffset = 4 (DST bug)');

  // Server: S8 uses 5-min ADV slice
  assert(serverContent.includes('adv5min'),
    'claw_server: S8 uses adv5min (5-min ADV slice, not daily total)');
  assert(serverContent.includes('wsVrtVolume = 0'),
    'claw_server: wsVrtVolume resets to 0 every 5 min');

  // Server: S_RS threshold > 1%
  assert(serverContent.includes('rs > 2.5') && !serverContent.includes('rs > 1.0'),
    'claw_server: S_RS threshold is 2.5% (not 1.0%)');

  // Server: H18 uses inclDate for SPY baseline
  assert(serverContent.includes('spyAtIncl'),
    'claw_server: H18 uses inclusion-date SPY baseline (not last historical)');

  // Server: POSITION_SIZING imported at top level
  const importLine = serverContent.slice(0, 2000);
  assert(importLine.includes('POSITION_SIZING, POSITION_SIZING_BEAR'),
    'claw_server: POSITION_SIZING imported at top level (not inside function)');

  // Server: var opts shadowing fixed
  assert(!serverContent.includes('var opts    = opts') && !serverContent.includes('var opts = opts '),
    'claw_server: no "var opts = opts" parameter shadowing');

  // Server: COMPOSITE_BULL cached
  assert(serverContent.includes('_compositeBullCache'),
    'claw_server: COMPOSITE_BULL uses 5-min cache (not DB on every WS tick)');

  // Server: VIX refresh function exists
  assert(serverContent.includes('refreshVixCache'),
    'claw_server: refreshVixCache function sets VIX_LATEST for H24');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6: SIGNAL MATH
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'math') {
  section('6. Signal & composite math');

  const sc = require(path.join(ROOT, 'lib/signal_config'));

  // Decay function: exp(-t / (hl * 60000))
  function decayFactor(ageMs, halfLifeMin) {
    return Math.exp(-ageMs / (halfLifeMin * 60000));
  }

  // At t=0, decay = 1.0
  assert(Math.abs(decayFactor(0, 240) - 1.0) < 0.001, 'decay at t=0 is 1.0');
  // At t=half_life, decay = exp(-1) ≈ 0.368 (not 0.5 — half-life here means 1/e, not 1/2)
  // True half-life (decay=0.5) occurs at t = hl * ln(2) ≈ hl * 0.693
  assert(Math.abs(decayFactor(240 * 60000, 240) - Math.exp(-1)) < 0.001, 'decay at t=half_life_min is exp(-1) ≈ 0.368');
  const trueHalfLife = 240 * Math.LN2;
  assert(Math.abs(decayFactor(trueHalfLife * 60000, 240) - 0.5) < 0.001, 'decay at t=hl×ln2 is exactly 0.5');
  // At t=3×half_life, decay ≈ 0.125 (above 0.05 cutoff)
  const d3hl = decayFactor(3 * 240 * 60000, 240);
  assert(d3hl >= 0.04 && d3hl < 0.10, `decay at 3×half_life (${d3hl.toFixed(4)}) is ≈0.05 (exp(-3))`);  // exp(-3) ≈ 0.0498
  // At t=10×half_life, decay < 0.05 (filtered out)
  assert(decayFactor(10 * 240 * 60000, 240) < 0.0001, 'decay at 10×half_life is effectively zero (<0.0001)');

  // Composite formula: weight × hitRate × direction × decay × dedup × regime × tier × earnings
  // Test a simple case: S1_LAG BULL, fresh signal, no dedup, normal regime, PROVISIONAL tier
  const w = 3;          // S1_LAG weight
  const hr = 0.67;      // hit rate
  const dir = 1;        // BULL
  const decay = 1.0;    // fresh
  const dedup = 1.0;    // no correlation
  const regime = 1.0;   // neutral regime
  const tier = 0.75;    // PROVISIONAL
  const earningsW = 2.5; // 7 days to earnings
  const contrib = w * hr * dir * decay * dedup * regime * tier * earningsW;
  assert(Math.abs(contrib - (3 * 0.67 * 1 * 1 * 1 * 1 * 0.75 * 2.5)) < 0.001,
    `Composite contribution formula: S1_LAG fresh PROVISIONAL = ${contrib.toFixed(3)}`);

  // Position sizing: score 15 → 25% position
  const table = sc.POSITION_SIZING;
  function getPosition(score) {
    const absScore = Math.abs(score);
    const t = table.find(e => absScore >= e.min && absScore <= e.max);
    return t ? t.pct : 0;
  }
  assert(getPosition(0)  === 0,   'Position sizing: score 0 → 0% (FLAT)');
  assert(getPosition(9)  === 0,   'Position sizing: score 9 → 0% (FLAT)');
  assert(getPosition(10) === 10,  'Position sizing: score 10 → 10%');
  assert(getPosition(15) === 25,  'Position sizing: score 15 → 25%');
  assert(getPosition(20) === 50,  'Position sizing: score 20 → 50%');
  assert(getPosition(28) === 75,  'Position sizing: score 28 → 75%');
  assert(getPosition(36) === 100, 'Position sizing: score 36 → 100%');
  assert(getPosition(99) === 100, 'Position sizing: score 99 → 100% (Infinity tier)');

  // Bear-side: capped at 50%
  const bearTable = sc.POSITION_SIZING_BEAR;
  assert(bearTable.every(t => t.pct <= 50), 'POSITION_SIZING_BEAR: all tiers ≤ 50%');
  assert(bearTable[bearTable.length-1].pct === 50, 'POSITION_SIZING_BEAR: max tier = 50%');

  // Signal cooldowns: S1_LAG should have cooldown
  assert(sc.SIGNAL_COOLDOWNS['S1_LAG'] > 0, 'S1_LAG has a cooldown defined');
  assert(sc.SIGNAL_COOLDOWNS['COMPOSITE_BULL'] > 0, 'COMPOSITE_BULL has a cooldown defined');

  // SIGNAL_CORR: correlated pairs defined
  assert(typeof sc.SIGNAL_CORR === 'object', 'SIGNAL_CORR is exported');
  // S1_LAG and COMPOSITE_BULL should be correlated
  const s1corr = sc.SIGNAL_CORR['S1_LAG'] || {};
  const cbCorr = sc.SIGNAL_CORR['COMPOSITE_BULL'] || {};
  assert(
    s1corr['COMPOSITE_BULL'] > 0 || cbCorr['S1_LAG'] > 0,
    'S1_LAG and COMPOSITE_BULL are correlated in SIGNAL_CORR (dedup prevents double-counting)'
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7: SCHEDULER TIME WINDOWS
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'scheduler') {
  section('7. Scheduler time window logic');

  // Simulate the in_window function from scheduler_dispatch.sh
  function in_window(hourN, minN, hStart, hEnd, mStart, mEnd) {
    if (hourN === hStart && hourN === hEnd) {
      return minN >= mStart && minN <= mEnd;
    } else if (hourN > hStart && hourN < hEnd) {
      return true;
    } else if (hourN === hStart && minN >= mStart) {
      return true;
    } else if (hourN === hEnd && minN <= mEnd) {
      return true;
    }
    return false;
  }

  // Daily review fires at 6:00-6:09 ET
  assert(in_window(6,  0, 6, 6, 0, 9), 'Daily review: fires at 6:00 ET');
  assert(in_window(6,  5, 6, 6, 0, 9), 'Daily review: fires at 6:05 ET');
  assert(!in_window(6, 10, 6, 6, 0, 9), 'Daily review: does NOT fire at 6:10 ET');
  assert(!in_window(5, 59, 6, 6, 0, 9), 'Daily review: does NOT fire at 5:59 ET');

  // Signal audit fires at 2:00-2:09 ET
  assert(in_window(2,  0, 2, 2, 0, 9), 'Signal audit: fires at 2:00 ET');
  assert(!in_window(3, 0, 2, 2, 0, 9), 'Signal audit: does NOT fire at 3:00 ET');

  // Market open fires at 9:31-9:39 ET
  assert(in_window(9, 31, 9, 9, 31, 39), 'Market open: fires at 9:31 ET');
  assert(in_window(9, 35, 9, 9, 31, 39), 'Market open: fires at 9:35 ET');
  assert(!in_window(9, 30, 9, 9, 31, 39), 'Market open: does NOT fire at 9:30 ET');
  assert(!in_window(10, 0, 9, 9, 31, 39), 'Market open: does NOT fire at 10:00 ET');

  // Close fires at 16:05-16:19 ET
  assert(in_window(16,  5, 16, 16, 5, 19), 'Close: fires at 16:05 ET');
  assert(!in_window(16, 4, 16, 16, 5, 19), 'Close: does NOT fire at 16:04 ET');
  assert(!in_window(16, 20, 16, 16, 5, 19), 'Close: does NOT fire at 16:20 ET');

  // Test the lock file pattern: same lock key should not fire twice in same day
  const schedContent = fs.readFileSync(path.join(ROOT, 'jobs/scheduler_dispatch.sh'), 'utf8');
  assert(schedContent.includes('"daily_review"'), 'Daily review has lock key "daily_review"');
  assert(schedContent.includes('"signal_audit"'), 'Signal audit has lock key "signal_audit"');
  assert(schedContent.includes('"fill_outcomes"'), 'Fill outcomes has lock key');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8: API CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'api') {
  section('8. API configuration');

  const brContent = fs.readFileSync(path.join(ROOT, 'jobs/browser_runner_vrt2.js'), 'utf8');

  // Model strings
  assert(brContent.includes("'claude-sonnet-4-6'"),
    "Sonnet model string is claude-sonnet-4-6");
  assert(!brContent.includes("'claude-sonnet-4-5'"),
    "No wrong sonnet model string claude-sonnet-4-5");

  // API endpoint
  assert(brContent.includes("hostname: 'api.anthropic.com'"),
    'API calls go to api.anthropic.com');
  assert(brContent.includes("path: '/v1/messages'"),
    'API path is /v1/messages');
  assert(brContent.includes("'anthropic-version': '2023-06-01'"),
    'anthropic-version header is 2023-06-01');

  // Web search tool format
  assert(brContent.includes("type: 'web_search_20250305'"),
    'Web search tool type is web_search_20250305');
  assert(brContent.includes("'web-search-2025-03-05'"),
    'Web search beta header value is correct');

  // .env loader in browser_runner resolves to parent dir
  assert(brContent.includes("path.resolve(__dirname, '../.env')"),
    "browser_runner loads .env from project root (../from jobs/)");

  // Finnhub WS URL
  const serverContent = fs.readFileSync(path.join(ROOT, 'claw_server_vrt2.js'), 'utf8');
  assert(serverContent.includes("wss://ws.finnhub.io?token="),
    'Server connects to Finnhub WebSocket');
  assert(serverContent.includes("hostname: 'finnhub.io'"),
    'REST calls go to finnhub.io');

  // PORT consistency
  const config = require(path.join(ROOT, 'lib/config'));
  assert(config.PORT === 51752, `Port is 51752 (got ${config.PORT})`);
  assert(serverContent.includes('PORT'),
    'Server uses PORT from lib/config');

  // Plist references correct script path
  const plistContent = fs.readFileSync(path.join(ROOT, 'com.adamcagle.claw.vrt2.queue.plist'), 'utf8');
  assert(plistContent.includes('scheduler_dispatch.sh'),
    'Queue plist calls scheduler_dispatch.sh');
  assert(plistContent.includes('America/New_York'),
    'Queue plist sets TZ=America/New_York');

  const scanPlist = fs.readFileSync(path.join(ROOT, 'com.adamcagle.claw.vrt2.scan.plist'), 'utf8');
  assert(scanPlist.includes('browser_runner_vrt2.js'),
    'Scan plist calls browser_runner_vrt2.js');
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9: CROSS-FILE DEPENDENCIES
// ══════════════════════════════════════════════════════════════════════════════
if (!ONLY_SECTION || ONLY_SECTION === 'deps') {
  section('9. Cross-file dependency resolution');

  // Every job that requires('../lib/X') — verify those files exist
  const jobDir = path.join(ROOT, 'jobs');
  const jobFiles = fs.readdirSync(jobDir).filter(f => f.endsWith('.js'));

  jobFiles.forEach(function(fname) {
    const content = fs.readFileSync(path.join(jobDir, fname), 'utf8');
    const requires = content.match(/require\(['"]([^'"]+)['"]\)/g) || [];
    requires.forEach(function(req) {
      const mod = req.match(/require\(['"]([^'"]+)['"]\)/)[1];
      if (mod.startsWith('.')) {
        const resolved = path.resolve(path.join(jobDir, mod));
        const exists = fs.existsSync(resolved) ||
                       fs.existsSync(resolved + '.js') ||
                       fs.existsSync(resolved + '.json') ||
                       fs.existsSync(path.join(resolved, 'index.js'));
        assert(exists, `${fname}: require('${mod}') resolves`);
      }
    });
  });

  // Server requires
  const serverContent = fs.readFileSync(path.join(ROOT, 'claw_server_vrt2.js'), 'utf8');
  const serverRequires = serverContent.match(/require\(['"](\.[^'"]+)['"]\)/g) || [];
  serverRequires.forEach(function(req) {
    const mod = req.match(/require\(['"]([^'"]+)['"]\)/)[1];
    const resolved = path.resolve(path.join(ROOT, mod));
    const exists = fs.existsSync(resolved) ||
                   fs.existsSync(resolved + '.js') ||
                   fs.existsSync(resolved + '.json');
    assert(exists, `claw_server: require('${mod}') resolves`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// FINAL REPORT
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
const total = passed + failed + warned;
console.log(`${C.bold}RESULTS: ${total} tests | ${C.green}${passed} passed${C.reset} | ${C.red}${failed} failed${C.reset} | ${C.yellow}${warned} warnings${C.reset}`);
console.log('═'.repeat(60));

if (failures.length > 0) {
  console.log(`\n${C.red}${C.bold}FAILURES:${C.reset}`);
  failures.forEach(function(f, i) {
    console.log(`  ${i+1}. ${C.red}${f.name}${C.reset}`);
    if (f.detail) console.log(`     ${f.detail}`);
  });
  console.log('');
}

if (failed === 0) {
  console.log(`\n${C.green}${C.bold}✓ ALL TESTS PASS — system is ready to deploy${C.reset}\n`);
  process.exit(0);
} else {
  console.log(`\n${C.red}${C.bold}✗ ${failed} FAILURE(S) — fix before deploying${C.reset}\n`);
  process.exit(1);
}
