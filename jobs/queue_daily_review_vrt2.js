#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// jobs/queue_daily_review_vrt2.js · CLAW VRT2 · v3.1
//
// Producer. Fires once daily at 6am ET via launchd. Scans yesterday's
// findings directory, queues a semantic_review task for each hypothesis
// with findings, then queues a single daily_synthesis task that depends
// on all of them.
//
// In LEARNING phase, this is the ONLY semantic review run per day.
// In RECOMMENDATION/TRADING phases, the cadence increases (config flag
// in lib/signal_config.js controls this).
//
// Usage: node jobs/queue_daily_review_vrt2.js [--date YYYY-MM-DD]
// ════════════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getETYesterday, getETDayStartMs } = require('../lib/dates');
const { computeHarnessQuality } = require('../lib/harness_quality');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'vrt2.db');
const FINDINGS_DIR = path.join(ROOT, 'findings');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Load review cadence config
let REVIEW_CADENCE;
try {
  ({ REVIEW_CADENCE } = require(path.join(ROOT, 'lib', 'signal_config.js')));
} catch (e) {
  REVIEW_CADENCE = { phase: 'LEARNING', daily_review_time: '06:00' };
}

console.log('CLAW VRT2 — queue_daily_review v3.1');
console.log('Phase:', REVIEW_CADENCE.phase);
console.log('');

// Determine target date — defaults to YESTERDAY in ET (we review the day that just ended)
// v3.1.1 fix #A5: previously used UTC date arithmetic which broke when run in
// the ET morning before UTC date rolled forward. getETYesterday() handles DST,
// month/year boundaries, and leap years correctly.
let targetDate;
const dateArg = process.argv.indexOf('--date');
if (dateArg !== -1 && process.argv[dateArg + 1]) {
  targetDate = process.argv[dateArg + 1];
} else {
  targetDate = getETYesterday();
}
console.log('Target review date:', targetDate, '(ET)');

const dayDir = path.join(FINDINGS_DIR, targetDate);
if (!fs.existsSync(dayDir)) {
  console.log('  (no findings directory for ' + targetDate + ')');
  // Still queue a daily synthesis so the brief gets generated even if empty
}

// Group findings files by hypothesis_id
const byHyp = {};
if (fs.existsSync(dayDir)) {
  fs.readdirSync(dayDir).filter(function(f) { return f.endsWith('.md'); }).forEach(function(f) {
    // Filename pattern: H{N}_{task_type}_{task_id}.md
    const m = f.match(/^([A-Z][A-Za-z0-9_]+)_/);
    if (!m) return;
    const hyp = m[1];
    if (!byHyp[hyp]) byHyp[hyp] = [];
    byHyp[hyp].push(path.join('findings', targetDate, f));
  });
}

console.log('Findings by hypothesis:');
Object.keys(byHyp).forEach(function(h) {
  console.log('  ' + h + ': ' + byHyp[h].length + ' files');
});
console.log('');

const insertTask = db.prepare(
  "INSERT INTO browser_tasks (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name) " +
  "VALUES (?, ?, 'PENDING', ?, ?, ?, ?)"
);

// v3.1.1 fix #A5: was using SQL DATE('now') which compares UTC dates.
// Now we filter by created_ts >= start of today in ET, computed in JS.
// This is checking "did we already queue a review for this hypothesis today?"
// to make the producer idempotent if launchd accidentally fires it twice.
const todayETStartMs = getETDayStartMs();
const checkExisting = db.prepare(
  "SELECT task_id FROM browser_tasks " +
  "WHERE task_type = 'semantic_review' " +
  "  AND hypothesis_id = ? " +
  "  AND created_ts >= ? " +
  "  AND status IN ('PENDING','RUNNING','COMPLETED') " +
  "LIMIT 1"
);

// Map hypothesis to its review prompt template
const TEMPLATE_MAP = {
  H1: 'review_concentration',
  H1_div: 'review_concentration',
  H2: 'review_h2_in_house_silicon',
  H3_disclosure: 'generic_review',
  H4_bear: 'generic_review',
  H4_bull: 'generic_review',
  
  
  H8: 'generic_review',
  H9: 'generic_review',
  H11: 'generic_review',
  H12: 'generic_review',
  H13: 'generic_review',
  H14: 'generic_review',
  H15: 'generic_review',
  H15_resolution: 'generic_review',
  H22: 'generic_review',
  H23: 'generic_review',
  H24: 'generic_review',
  H27: 'generic_review'
};

const now = Date.now();
let queued = 0;
let skipped = 0;
const reviewTaskIds = [];

Object.keys(byHyp).forEach(function(hyp) {
  // v3.1.1 fix #A5: pass todayETStartMs as second parameter — the prepared
  // statement now filters by created_ts >= todayETStartMs (was DATE('now') UTC)
  const existing = checkExisting.get(hyp, todayETStartMs);
  if (existing) {
    console.log('  · ' + hyp + ' review already queued (' + existing.task_id + ')');
    skipped++;
    reviewTaskIds.push(existing.task_id);
    return;
  }

  const payload = {
    source_findings_paths: byHyp[hyp],
    review_prompt_template: TEMPLATE_MAP[hyp] || 'generic_review',
    review_date: targetDate
  };

  const result = insertTask.run(
    'semantic_review',
    hyp,
    JSON.stringify(payload),
    2, // higher priority than background scans
    now,
    'queue_daily_review'
  );
  reviewTaskIds.push(result.lastInsertRowid);
  console.log('  + ' + hyp + ' review queued (task ' + result.lastInsertRowid + ', ' + byHyp[hyp].length + ' findings)');
  queued++;
});

// Compute harness data quality for targetDate before building synthesis payload.
// This tells the brief generator (and later, recalibrate_weights) how complete
// the underlying data is. A DEGRADED or INCOMPLETE day should be flagged in
// the brief and excluded from hypothesis hit rate calculations.
const harnessQuality = computeHarnessQuality(db, targetDate);
console.log('Harness quality for ' + targetDate + ':',
  harnessQuality.quality,
  '(' + harnessQuality.completed + ' completed, ' + harnessQuality.failed + ' failed' +
  (harnessQuality.uptime_pct !== null ? ', ' + harnessQuality.uptime_pct + '% uptime' : ', no task data') + ')'
);
if (harnessQuality.quality !== 'FULL') {
  console.log('  ⚠ Data quality is ' + harnessQuality.quality +
    ' — brief will be flagged and this day excluded from hit rate calculations.');
}
console.log('');

// Queue the daily synthesis — depends on all reviews completing first.
// v3.1.1: We enforce this TWO ways for safety:
//   (1) scheduled_for_ts set to "now + 15 min" — synthesis won't be picked
//       up until reviews have had time to finish
//   (2) parent_task_id set to the LAST review task — the queue endpoint
//       skips tasks whose parent isn't COMPLETED
// Both mechanisms together mean synthesis runs AFTER reviews, not during.
const synthPayload = {
  date: targetDate,
  source_findings_dir: 'findings/' + targetDate + '/',
  depends_on: reviewTaskIds,  // informational — actual enforcement via parent_task_id + scheduled_for_ts
  review_prompt_template: 'daily_brief',
  harness_quality: harnessQuality  // injected for consumer + brief generator
};

const existingSynth = db.prepare(
  "SELECT task_id FROM browser_tasks WHERE task_type = 'daily_synthesis' " +
  "AND payload_json LIKE ? AND status IN ('PENDING','RUNNING','COMPLETED') LIMIT 1"
).get('%' + targetDate + '%');

if (existingSynth) {
  console.log('  · daily_synthesis already queued (' + existingSynth.task_id + ')');
} else {
  // Synthesis scheduled for 15 minutes in the future to let reviews finish
  const synthScheduledFor = now + (15 * 60 * 1000);
  // Parent = last review task (if any exist). If no reviews, no parent gate.
  const lastReviewId = reviewTaskIds.length > 0 ? reviewTaskIds[reviewTaskIds.length - 1] : null;

  const synthResult = db.prepare(
    "INSERT INTO browser_tasks " +
    "(task_type, hypothesis_id, status, payload_json, priority, created_ts, " +
    " scheduled_for_ts, parent_task_id, producer_name) " +
    "VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)"
  ).run(
    'daily_synthesis',
    null,
    JSON.stringify(synthPayload),
    3,
    now,
    synthScheduledFor,
    lastReviewId,
    'queue_daily_review'
  );
  console.log('  + daily_synthesis queued (task ' + synthResult.lastInsertRowid +
              ', scheduled for +15min, parent=' + (lastReviewId || 'none') + ')');
}

console.log('');
console.log('Queued: ' + queued + ' reviews + 1 synthesis, skipped: ' + skipped);
db.close();
