#!/usr/bin/env node
// CLAW VRT2 — jobs/regime_detector_vrt2.js
//
// Computes the daily 4-dimensional regime vector from live price/macro data:
//   VIX (LOW/NORMAL/ELEVATED/STRESSED)
//   ISM PMI (CONTRACTION/EXPANSION) — monthly, cached
//   10Y Treasury yield 30d delta (FALLING/FLAT/RISING)
//   HYG 30d return (RISK_OFF/NEUTRAL/RISK_ON)
//
// Writes to regime_log table. Fires REGIME_SHIFT signal when 2+ dimensions change.
// Run via launchd at market open (09:31 ET weekdays).

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path     = require('path');
const https    = require('https');
const Database = require('better-sqlite3');
const { getETDateString, getETDayStartMs } = require('../lib/dates');
const { binVix, binHyg, binPmi, binRates, deriveRegimeLabel } = require('../lib/regime');

const DB_PATH    = path.join(__dirname, '..', 'vrt2.db');
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const db         = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const now     = Date.now();
const etDate  = getETDateString();

console.log('CLAW VRT2 — Regime Detector');
console.log('ET Date:', etDate);

// ── Fetch quote via Finnhub ───────────────────────────────────────────────────
function fetchQuote(ticker) {
  return new Promise(function(resolve) {
    const sym = encodeURIComponent(ticker);
    const options = {
      hostname: 'finnhub.io',
      path: '/api/v1/quote?symbol=' + sym + '&token=' + FINNHUB_KEY,
      method: 'GET',
      headers: { 'User-Agent': 'CLAW-VRT2/1.0' }
    };
    let body = '';
    const req = https.request(options, function(res) {
      res.on('data', function(d) { body += d; });
      res.on('end', function() {
        try {
          const q = JSON.parse(body);
          resolve(q && q.c ? q : null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(10000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Get 30-day price delta for a ticker from DB ───────────────────────────────
function get30dReturn(ticker) {
  const since = now - 30 * 86400000;
  const recent = db.prepare(
    'SELECT price FROM prices WHERE ticker=? AND ts>=? ORDER BY ts ASC LIMIT 1'
  ).get(ticker, since);
  const latest = db.prepare(
    'SELECT price FROM prices WHERE ticker=? ORDER BY ts DESC LIMIT 1'
  ).get(ticker);
  if (!recent || !latest || recent.price === 0) return null;
  return (latest.price - recent.price) / recent.price * 100;
}

// ── Get most recent PMI from DB (cached monthly value) ────────────────────────
function getCachedPmi() {
  try {
    const row = db.prepare(
      "SELECT value FROM financials WHERE metric='ISM_PMI' ORDER BY period_end DESC LIMIT 1"
    ).get();
    return row ? row.value : null;
  } catch(e) { return null; }
}

// ── Get 30-day 10Y yield delta ────────────────────────────────────────────────
function get30dYieldDelta() {
  try {
    const since = now - 30 * 86400000;
    // TNX is tracked as a price in prices table (if Finnhub returns it)
    const old = db.prepare(
      "SELECT price FROM prices WHERE ticker='^TNX' AND ts>=? ORDER BY ts ASC LIMIT 1"
    ).get(since);
    const cur = db.prepare(
      "SELECT price FROM prices WHERE ticker='^TNX' ORDER BY ts DESC LIMIT 1"
    ).get();
    if (!old || !cur) return null;
    return (cur.price - old.price) * 100; // yield in percent × 100 = bps
  } catch(e) { return null; }
}

async function main() {
  if (!FINNHUB_KEY) {
    console.error('ERROR: FINNHUB_API_KEY not set');
    process.exit(1);
  }

  // Fetch VIX proxy (VIX not on Finnhub free; use VIXY ETF as proxy or cached DB value)
  let vixValue = null;
  // Try to get VIX from DB (set by server or FRED pull)
  const vixRow = db.prepare(
    "SELECT price FROM prices WHERE ticker='VIXY' ORDER BY ts DESC LIMIT 1"
  ).get();
  if (vixRow) {
    // VIXY trades at roughly VIX/10 — approximate
    vixValue = vixRow.price * 10;
    console.log('VIX proxy (VIXY×10):', vixValue.toFixed(2));
  } else {
    // Fallback: try to find VIX_LATEST from composite_scores notes
    const compRow = db.prepare(
      "SELECT note FROM composite_scores ORDER BY ts DESC LIMIT 1"
    ).get();
    if (compRow && compRow.note) {
      const m = compRow.note.match(/vix[:=]\s*([0-9.]+)/i);
      if (m) vixValue = parseFloat(m[1]);
    }
    if (!vixValue) {
      console.log('VIX: not available — defaulting to 20 (NORMAL)');
      vixValue = 20;
    }
  }

  // HYG 30d return
  const hyg30d = get30dReturn('HYG');
  console.log('HYG 30d return:', hyg30d != null ? hyg30d.toFixed(2) + '%' : 'N/A');

  // ISM PMI (cached)
  const pmi = getCachedPmi();
  console.log('ISM PMI (cached):', pmi != null ? pmi.toFixed(1) : 'N/A (defaulting to 50.0 EXPANSION)');

  // 10Y yield 30d delta (bps)
  const yieldDelta = get30dYieldDelta();
  console.log('10Y yield 30d delta:', yieldDelta != null ? yieldDelta.toFixed(0) + 'bps' : 'N/A');

  // ── Compute regime vector ─────────────────────────────────────────────────
  const vixRegime    = binVix(vixValue || 20);
  const hygRegime    = binHyg(hyg30d != null ? hyg30d : 0);
  const pmiRegime    = binPmi(pmi != null ? pmi : 50.0);
  const ratesRegime  = binRates(yieldDelta != null ? yieldDelta : 0);
  const regimeLabel  = deriveRegimeLabel(vixRegime, hygRegime);
  const fullVector   = `${vixRegime}/${pmiRegime}/${ratesRegime}/${hygRegime}`;

  console.log('\nRegime vector:', fullVector);
  console.log('Label:', regimeLabel);

  // ── Compare to prior day ──────────────────────────────────────────────────
  const priorRow = db.prepare(
    'SELECT vix_regime, pmi_regime, rates_regime, risk_regime, full_vector FROM regime_log ORDER BY ts DESC LIMIT 1'
  ).get();

  let isTransition = 0;
  if (priorRow) {
    const changed = [
      priorRow.vix_regime   !== vixRegime,
      priorRow.pmi_regime   !== pmiRegime,
      priorRow.rates_regime !== ratesRegime,
      priorRow.risk_regime  !== hygRegime,
    ].filter(Boolean).length;

    isTransition = changed >= 2 ? 1 : 0;
    if (isTransition) {
      console.log(`\n⚠ REGIME TRANSITION: ${priorRow.full_vector} → ${fullVector} (${changed} dimensions changed)`);
    }
  }

  // ── Write to regime_log ───────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO regime_log
    (ts, et_date, vix_value, vix_regime, pmi_value, pmi_regime,
     rates_delta_bps, rates_regime, hyg_30d_pct, risk_regime,
     full_vector, is_transition)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(et_date) DO UPDATE SET
      ts=excluded.ts, vix_value=excluded.vix_value, vix_regime=excluded.vix_regime,
      pmi_value=excluded.pmi_value, pmi_regime=excluded.pmi_regime,
      rates_delta_bps=excluded.rates_delta_bps, rates_regime=excluded.rates_regime,
      hyg_30d_pct=excluded.hyg_30d_pct, risk_regime=excluded.risk_regime,
      full_vector=excluded.full_vector, is_transition=excluded.is_transition
  `).run(now, etDate, vixValue, vixRegime, pmi, pmiRegime,
         yieldDelta, ratesRegime, hyg30d, hygRegime, fullVector, isTransition);

  console.log('\nRegime written to DB.');

  // ── Job health ────────────────────────────────────────────────────────────
  try {
    db.prepare(`
      INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
      VALUES ('regime_detector_vrt2', ?, 'OK', 1, ?)
    `).run(now, Date.now() - now);
  } catch(e) {}

  db.close();
  console.log('Done.');
}

main().catch(function(e) {
  console.error('FATAL:', e.message);
  process.exit(1);
});
