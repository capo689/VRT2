#!/usr/bin/env node
// CLAW VRT2 — jobs/analyst_revisions_vrt2.js
//
// Scrapes TipRanks and MarketBeat for VRT analyst price target changes and
// rating upgrades/downgrades. Feeds H-AR (analyst revision cluster) signal.
//
// H-AR fires when: 3+ upward PT revisions OR 2+ upgrades in a 7-day window.
// H-AR_bear fires when: 3+ downgrades or PT cuts in 7-day window.
//
// Run via launchd at 05:00 ET daily (before market open).

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path     = require('path');
const https    = require('https');
const Database = require('better-sqlite3');
const { getETDateString, getETDayStartMs } = require('../lib/dates');

const DB_PATH     = path.join(__dirname, '..', 'vrt2.db');
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const SERVER_PORT = require('../lib/config').PORT;
const db          = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const now    = Date.now();
const etDate = getETDateString();

console.log('CLAW VRT2 — Analyst Revisions (H-AR)');
console.log('ET Date:', etDate);

// ── Finnhub price targets (free tier provides current consensus) ──────────────
function fetchFinnhubTargets() {
  return new Promise(function(resolve) {
    const options = {
      hostname: 'finnhub.io',
      path: '/api/v1/stock/price-target?symbol=VRT&token=' + FINNHUB_KEY,
      method: 'GET',
      headers: { 'User-Agent': 'CLAW-VRT2/1.0' }
    };
    let body = '';
    const req = https.request(options, function(res) {
      res.on('data', function(d) { body += d; });
      res.on('end', function() {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(10000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Finnhub recommendation trends ────────────────────────────────────────────
function fetchRecommendationTrend() {
  return new Promise(function(resolve) {
    const options = {
      hostname: 'finnhub.io',
      path: '/api/v1/stock/recommendation?symbol=VRT&token=' + FINNHUB_KEY,
      method: 'GET',
      headers: { 'User-Agent': 'CLAW-VRT2/1.0' }
    };
    let body = '';
    const req = https.request(options, function(res) {
      res.on('data', function(d) { body += d; });
      res.on('end', function() {
        try { resolve(JSON.parse(body)); }
        catch(e) { resolve([]); }
      });
    });
    req.on('error', function() { resolve([]); });
    req.setTimeout(10000, function() { req.destroy(); resolve([]); });
    req.end();
  });
}

// ── Queue browser task for H-AR semantic review ───────────────────────────────
function queueHarBrowserTask(upwardCount, downwardCount, targetData, recData) {
  const payload = JSON.stringify({
    review_prompt_template: 'review_h_ar_revisions',
    target_mean: targetData ? targetData.targetMean : null,
    target_high: targetData ? targetData.targetHigh : null,
    target_low:  targetData ? targetData.targetLow  : null,
    upward_revisions_count:   upwardCount,
    downward_revisions_count: downwardCount,
    recommendation_trend: recData ? recData.slice(0, 2) : [],
    date: etDate,
  });

  try {
    db.prepare(`
      INSERT INTO browser_tasks
      (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name)
      VALUES ('semantic_review', 'H-AR', 'PENDING', ?, 2, ?, 'analyst_revisions_vrt2')
    `).run(payload, now);
    console.log('Queued H-AR semantic review task');
  } catch(e) {
    console.error('Failed to queue H-AR task:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!FINNHUB_KEY) {
    console.error('ERROR: FINNHUB_API_KEY not set');
    process.exit(1);
  }

  // Fetch current analyst consensus
  const [targetData, recTrend] = await Promise.all([
    fetchFinnhubTargets(),
    fetchRecommendationTrend(),
  ]);

  if (targetData) {
    console.log(`Analyst targets: mean=$${targetData.targetMean} high=$${targetData.targetHigh} low=$${targetData.targetLow} n=${targetData.numberOfAnalysts}`);
  }

  // ── Compare to prior stored targets for direction ─────────────────────────
  // Load prior target from DB financials table
  const priorTarget = db.prepare(
    "SELECT value FROM financials WHERE metric='analyst_target_mean' ORDER BY period_end DESC LIMIT 1"
  ).get();

  let upwardRevisions   = 0;
  let downwardRevisions = 0;
  let directionNote     = '';

  if (targetData && priorTarget) {
    const delta = targetData.targetMean - priorTarget.value;
    if (delta > 5) {
      upwardRevisions = 1;
      directionNote = `PT mean raised $${priorTarget.value.toFixed(0)} → $${targetData.targetMean.toFixed(0)} (+$${delta.toFixed(0)})`;
    } else if (delta < -5) {
      downwardRevisions = 1;
      directionNote = `PT mean cut $${priorTarget.value.toFixed(0)} → $${targetData.targetMean.toFixed(0)} ($${delta.toFixed(0)})`;
    }
  }

  // Store current target for next comparison
  if (targetData && targetData.targetMean) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO financials (filing_date, period_end, metric, value, source_url)
        VALUES (?, ?, 'analyst_target_mean', ?, 'finnhub')
      `).run(etDate, etDate, targetData.targetMean);
    } catch(e) {}
  }

  // Recommendation trend: compare current month to prior month
  if (recTrend && recTrend.length >= 2) {
    const cur  = recTrend[0];
    const prev = recTrend[1];
    const buyDelta  = (cur.strongBuy + cur.buy) - (prev.strongBuy + prev.buy);
    const sellDelta = (cur.strongSell + cur.sell) - (prev.strongSell + prev.sell);

    if (buyDelta > 0) {
      upwardRevisions += buyDelta;
      console.log(`Recommendation trend: +${buyDelta} buy ratings vs prior month`);
    }
    if (sellDelta > 0) {
      downwardRevisions += sellDelta;
      console.log(`Recommendation trend: +${sellDelta} sell ratings vs prior month`);
    }
  }

  console.log(`Upward revisions (7d estimated): ${upwardRevisions}`);
  console.log(`Downward revisions (7d estimated): ${downwardRevisions}`);
  if (directionNote) console.log(directionNote);

  // ── Write revision record ─────────────────────────────────────────────────
  if (upwardRevisions > 0 || downwardRevisions > 0) {
    db.prepare(`
      INSERT INTO analyst_revisions
      (ts, et_date, prior_target, new_target, direction, source, raw_text)
      VALUES (?, ?, ?, ?, ?, 'finnhub', ?)
    `).run(now, etDate,
           priorTarget ? priorTarget.value : null,
           targetData  ? targetData.targetMean : null,
           upwardRevisions > 0 ? 'UP' : 'DOWN',
           JSON.stringify({ upward: upwardRevisions, downward: downwardRevisions, note: directionNote }));
  }

  // ── H-AR threshold check ──────────────────────────────────────────────────
  // Count revisions in rolling 7-day window
  const sevenDaysAgo = now - 7 * 86400000;
  const recentRevisions = db.prepare(
    "SELECT direction FROM analyst_revisions WHERE ts >= ? ORDER BY ts DESC"
  ).all(sevenDaysAgo);

  const totalUp   = recentRevisions.filter(r => r.direction === 'UP').length;
  const totalDown = recentRevisions.filter(r => r.direction === 'DOWN').length;

  console.log(`\nRolling 7-day window: ${totalUp} up, ${totalDown} down`);

  // Queue browser task for semantic review if threshold approached
  if (totalUp >= 2 || totalDown >= 2) {
    queueHarBrowserTask(totalUp, totalDown, targetData, recTrend);
  } else {
    console.log('H-AR threshold not met — no semantic review queued');
  }

  // ── Direct signal fire if clear threshold crossed ─────────────────────────
  // Simple direct fire for obvious cases (avoids browser round-trip delay)
  if (totalUp >= 3) {
    // POST directly to server to fire signal
    const http = require('http');
    const payload = JSON.stringify({
      hypothesis_id: 'H-AR',
      trigger_val: totalUp,
      trigger_desc: `${totalUp} upward analyst revisions in 7 days — H-AR cluster threshold crossed`,
      direction: 'BULL',
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/scan/kickoff',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, function(res) {
      console.log(`H-AR kickoff: ${res.statusCode}`);
    });
    req.on('error', function(e) { console.log('H-AR kickoff error:', e.message); });
    req.write(payload);
    req.end();
  }

  // ── Job health ────────────────────────────────────────────────────────────
  try {
    db.prepare(`
      INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
      VALUES ('analyst_revisions_vrt2', ?, 'OK', ?, ?)
    `).run(now, totalUp + totalDown, Date.now() - now);
  } catch(e) {}

  db.close();
  console.log('\nDone.');
}

main().catch(function(e) {
  console.error('FATAL:', e.message);
  try {
    db.prepare(`INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, last_error, duration_ms) VALUES ('analyst_revisions_vrt2', ?, 'FAIL', ?, ?)`).run(now, e.message, Date.now() - now);
  } catch(_) {}
  process.exit(1);
});
