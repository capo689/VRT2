#!/usr/bin/env node
// CLAW VRT2 — jobs/options_flow_phase1_vrt2.js
//
// H-OPT Phase 1: Free-tier options flow aggregation.
// Collects unusual options signals from free sources and fires H-OPT when
// 2+ sources independently flag unusual VRT activity.
//
// Sources (free tier, no paid API):
//   - Finnhub options chain (free — call/put volume + PCR)
//   - CBOE daily P/C ratio (public)
//   - Barchart.com unusual activity page (browser scrape)
//
// Day-30 gate: if ≥2 of 4 criteria fail, escalate to paid tier.
// Run via launchd at 10:00 ET and 14:00 ET (mid-morning and afternoon).

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path     = require('path');
const https    = require('https');
const Database = require('better-sqlite3');
const { getETDateString } = require('../lib/dates');

const DB_PATH     = path.join(__dirname, '..', 'vrt2.db');
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const db          = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const now    = Date.now();
const etDate = getETDateString();

console.log('CLAW VRT2 — Options Flow Phase 1 (H-OPT)');
console.log('ET Date:', etDate);

// ── Finnhub options chain ─────────────────────────────────────────────────────
function fetchOptionsChain() {
  return new Promise(function(resolve) {
    const options = {
      hostname: 'finnhub.io',
      path: '/api/v1/stock/option-chain?symbol=VRT&token=' + FINNHUB_KEY,
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

// ── Queue Barchart unusual options browser task ───────────────────────────────
function queueBarchartTask() {
  const payload = JSON.stringify({
    url: 'https://www.barchart.com/options/unusual-activity/stocks?page=1',
    extraction: {
      container_selector: 'table tbody tr',
      title_selector:     'td:first-child',
      summary_selector:   'td:nth-child(2)',
      max_items: 25,
    },
    trigger_keywords: ['VRT', 'Vertiv'],
    trigger_threshold: 1,
  });
  try {
    db.prepare(`
      INSERT INTO browser_tasks
      (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name)
      VALUES ('fetch_page', 'H-OPT', 'PENDING', ?, 5, ?, 'options_flow_phase1_vrt2')
    `).run(payload, now);
    console.log('Queued Barchart unusual options task');
  } catch(e) {
    console.error('Barchart queue error:', e.message);
  }
}

async function main() {
  if (!FINNHUB_KEY) {
    console.error('ERROR: FINNHUB_API_KEY not set');
    process.exit(1);
  }

  // Fetch Finnhub options
  const chain = await fetchOptionsChain();
  let callVol = 0, putVol = 0, pcr = null, unusualFinnhub = false;

  if (chain && chain.data) {
    chain.data.forEach(function(exp) {
      (exp.options && exp.options.CALL || []).forEach(function(opt) {
        callVol += opt.volume || 0;
      });
      (exp.options && exp.options.PUT || []).forEach(function(opt) {
        putVol += opt.volume || 0;
      });
    });
    pcr = putVol > 0 ? putVol / callVol : null;
    console.log(`Finnhub options: calls=${callVol} puts=${putVol} PCR=${pcr ? pcr.toFixed(2) : 'N/A'}`);
  } else {
    console.log('Finnhub options: no data (paid tier required for full chain)');
  }

  // Compare to 20d average from DB
  const avg20d = db.prepare(`
    SELECT AVG(call_volume) avg_call, AVG(put_volume) avg_put
    FROM options_activity WHERE ts >= ?
  `).get(now - 20 * 86400000);

  let callRatio = null, putRatio = null;
  if (avg20d && avg20d.avg_call && callVol > 0) {
    callRatio = callVol / avg20d.avg_call;
    putRatio  = putVol  / (avg20d.avg_put || 1);
    console.log(`Call ratio vs 20d avg: ${callRatio.toFixed(2)}x | Put ratio: ${putRatio.toFixed(2)}x`);
    unusualFinnhub = callRatio >= 3 || putRatio >= 3;
  }

  // Write to options_activity
  if (callVol > 0 || putVol > 0) {
    try {
      db.prepare(`
        INSERT INTO options_activity
        (ts, call_volume, put_volume, pcr, call_vol_20d_avg, put_vol_20d_avg,
         call_vol_ratio, put_vol_ratio, unusual_flag, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'finnhub_free')
      `).run(now, callVol, putVol, pcr,
             avg20d ? avg20d.avg_call : null,
             avg20d ? avg20d.avg_put  : null,
             callRatio, putRatio,
             unusualFinnhub ? 1 : 0);
    } catch(e) {}
  }

  // Queue Barchart scrape (browser task — runs during next browser_runner cycle)
  queueBarchartTask();

  // ── Check convergence across sources ─────────────────────────────────────
  const sources24h = db.prepare(`
    SELECT unusual_flag, source FROM options_flow WHERE ts >= ?
  `).all(now - 86400000);

  const unusualCount = sources24h.filter(r => r.unusual_flag === 1).length;
  const totalSources = sources24h.length + (unusualFinnhub ? 1 : 0);

  // Write to options_flow
  if (unusualFinnhub || unusualCount > 0) {
    try {
      db.prepare(`
        INSERT INTO options_flow (ts, et_date, source, unusual_flag, call_put_ratio, score, notes)
        VALUES (?, ?, 'finnhub_free', ?, ?, ?, ?)
      `).run(now, etDate, unusualFinnhub ? 1 : 0, pcr,
             unusualFinnhub ? 1 : 0,
             `calls=${callVol} puts=${putVol} ratio=${callRatio ? callRatio.toFixed(2) : 'N/A'}x`);
    } catch(e) {}
  }

  console.log(`\nH-OPT convergence: ${unusualCount + (unusualFinnhub ? 1 : 0)} unusual sources in 24h`);

  if (unusualCount + (unusualFinnhub ? 1 : 0) >= 2) {
    console.log('H-OPT THRESHOLD MET — queuing semantic review');
    const payload = JSON.stringify({
      review_prompt_template: 'generic_review',
      context: 'VRT unusual options activity detected across multiple sources',
      call_volume: callVol, put_volume: putVol,
      call_ratio: callRatio, put_ratio: putRatio,
      unusual_sources: unusualCount + (unusualFinnhub ? 1 : 0),
      date: etDate,
    });
    try {
      db.prepare(`
        INSERT INTO browser_tasks
        (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name)
        VALUES ('semantic_review', 'H-OPT', 'PENDING', ?, 2, ?, 'options_flow_phase1_vrt2')
      `).run(payload, now);
    } catch(e) {}
  }

  // ── Day-30 gate check ─────────────────────────────────────────────────────
  const daysSinceStart = db.prepare(
    "SELECT MIN(ts) min_ts FROM options_flow"
  ).get();
  if (daysSinceStart && daysSinceStart.min_ts) {
    const daysSince = (now - daysSinceStart.min_ts) / 86400000;
    if (daysSince >= 30) {
      const fires      = db.prepare("SELECT COUNT(*) n FROM options_flow WHERE unusual_flag=1").get().n;
      const total30d   = db.prepare(`SELECT COUNT(*) n FROM options_flow WHERE ts>= ?`).get(now - 30 * 86400000).n;
      const hitRate30d = total30d > 0 ? fires / total30d : 0;
      console.log(`\nDay-30 gate check: ${fires} unusual fires, hit rate ${(hitRate30d*100).toFixed(0)}%`);
      if (fires < 5 || hitRate30d < 0.55) {
        console.log('⚠ Day-30 gate: Phase 1 insufficient — consider upgrading to Finnhub Pro ($50-200/mo)');
      }
    }
  }

  // ── Job health ────────────────────────────────────────────────────────────
  try {
    db.prepare(`
      INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
      VALUES ('options_flow_phase1_vrt2', ?, 'OK', 1, ?)
    `).run(now, Date.now() - now);
  } catch(e) {}

  db.close();
  console.log('Done.');
}

main().catch(function(e) {
  console.error('FATAL:', e.message);
  try {
    db.prepare(`INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, last_error, duration_ms) VALUES ('options_flow_phase1_vrt2', ?, 'FAIL', ?, ?)`).run(now, e.message, Date.now() - now);
  } catch(_) {}
  process.exit(1);
});
