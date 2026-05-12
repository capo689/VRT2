// CLAW VRT2 Server v3.3.0 — Vertiv Holdings Stock Intelligence Engine
// Port: 51752 | DB: vrt2.db | Target: NYSE:VRT
//
// Architecture: CRDO v3.2.2 parity + production-discipline layer.
// Zero VRT v1 code — built fresh against CRDO patterns.
//
// Signal evaluation (VRT2-specific vs CRDO):
//   REMOVED: H5_alab, H5_mrvl, H6(CRDO/ALAB corr), H7(CRDO SMH underperf),
//            H8_nbis, H8_crwv, H9(AAOI/AMZN), H20 (CRDO idiosyncratic)
//   ADDED:   S-CU (copper composite), S_ETN_LEAD, H-CORR (VRT/ETN corr),
//            GAP_OPEN_BULL/BEAR, COMPOSITE_BULL (S1_LAG+S2)
//   KEPT:    S1_LAG, S2, S8, S_RS, H19(VIX state machine, uses H24 in VRT2),
//            STACK_BULL/BEAR
//   NEW ENDPOINTS: /position, /regime, /revisions, /risk

'use strict';

require('dotenv').config();

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const WebSocket = require('ws');
const Database  = require('better-sqlite3');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) { console.error('ERROR: FINNHUB_API_KEY not found in .env'); process.exit(1); }

const { PORT }                  = require('./lib/config');
const { getETDateString, getETDayStartMs } = require('./lib/dates');
const { computeHarnessQuality }  = require('./lib/harness_quality');
const { getCurrentRegime, applyRegimeMultiplier, binVix } = require('./lib/regime');
const {
  SIGNAL_CONFIG, SIGNAL_COOLDOWNS, SIGNAL_CORR,
  CONFIDENCE_TIER_DISCOUNTS, REVIEW_CADENCE,
  POSITION_SIZING, POSITION_SIZING_BEAR,
} = require('./lib/signal_config');

// ── PATHS ─────────────────────────────────────────────────────────────────────
const DIR     = path.join(process.env.HOME || '.', 'CLAW', 'VRT2');
const DB_PATH = path.join(__dirname, 'vrt2.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('CLAW VRT2 Server v3.3.0 — NYSE:VRT');
console.log('Port:    ', PORT);
console.log('DB:      ', DB_PATH);
console.log('Phase:   ', REVIEW_CADENCE.phase);
console.log('');

// ── SCHEMA (inline — safe to run on warm DB, all CREATE IF NOT EXISTS) ────────
// Minimal guard: just enough to ensure tables exist on first cold start
// if setup_db_vrt2.js wasn't run. Full schema lives in setup_db_vrt2.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    ticker TEXT NOT NULL, price REAL NOT NULL, open REAL, high REAL, low REAL,
    volume INTEGER, pct REAL, source TEXT DEFAULT 'finnhub_rest'
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_prices_ts_tk ON prices(ticker, ts);
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    hyp_id TEXT NOT NULL, trigger_val REAL, trigger_desc TEXT, vrt_price REAL,
    active INTEGER DEFAULT 1, direction TEXT, confidence REAL, time_bucket TEXT,
    regime_vix REAL, weight_at_fire REAL, is_backtest INTEGER DEFAULT 0,
    reason TEXT, source TEXT DEFAULT 'live',
    outcome_1d REAL, outcome_5d REAL, outcome_20d REAL,
    xli_1d REAL, xli_5d REAL, xli_20d REAL,
    alpha_1d REAL, alpha_5d REAL, alpha_20d REAL,
    hit INTEGER, outcome_filled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_signals_ts  ON signals(ts);
  CREATE INDEX IF NOT EXISTS idx_vrt2_signals_hyp ON signals(hyp_id);
  CREATE TABLE IF NOT EXISTS signal_weights (
    hyp_id TEXT PRIMARY KEY, weight REAL NOT NULL, base_weight REAL NOT NULL,
    hit_rate REAL, n_signals INTEGER DEFAULT 0,
    avg_alpha_when_hit REAL, avg_alpha_when_miss REAL,
    direction TEXT, half_life_min INTEGER, regime_class TEXT, threshold REAL,
    description TEXT, enabled INTEGER DEFAULT 1, data_source TEXT DEFAULT 'finnhub',
    phase TEXT DEFAULT 'ACTIVE', confidence_tier TEXT DEFAULT 'UNTESTED',
    last_recalibrated_ts INTEGER, updated_ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS signal_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hyp_id TEXT NOT NULL,
    state_key TEXT NOT NULL, state_value TEXT,
    started_ts INTEGER NOT NULL, last_updated_ts INTEGER NOT NULL,
    expires_ts INTEGER, UNIQUE(hyp_id, state_key)
  );
  CREATE TABLE IF NOT EXISTS composite_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
    score REAL NOT NULL, direction TEXT, signals_active TEXT,
    earnings_weight REAL, position_pct REAL, stop_price REAL, target_price REAL,
    regime_label TEXT, confidence_adj REAL, note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_composite_ts ON composite_scores(ts);
  CREATE TABLE IF NOT EXISTS job_health (
    job_name TEXT PRIMARY KEY, last_run_ts INTEGER NOT NULL,
    last_status TEXT NOT NULL, last_error TEXT, rows_written INTEGER, duration_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS risk_state (
    state_key TEXT PRIMARY KEY, state_value TEXT, updated_at INTEGER NOT NULL
  );
`);

// ── TICKERS ───────────────────────────────────────────────────────────────────
const TICKERS = [
  'VRT',
  'ETN', 'NVT',
  'NVDA',
  'MOD', 'CARR', 'JCI',
  'MSFT', 'AMZN', 'META',
  'GOOGL', 'ORCL', 'CRWV',
  'CEG', 'TLN', 'VST',
  'FCX',
  'EQIX', 'DLR',
  'TSM',
  'SPY', 'XLI', 'SMH', 'HYG',
];

const TIER1_TICKERS = ['VRT', 'ETN', 'NVDA', 'MSFT', 'AMZN', 'META', 'FCX', 'XLI', 'SPY'];
const TIER2_TICKERS = TICKERS.filter(function(t) { return TIER1_TICKERS.indexOf(t) < 0; });

// High-volatility tickers — wider sanity check bounds (>15% allowed daily)
const HIGH_VOL_TICKERS = ['CRWV', 'CEG', 'TLN', 'VST'];

// Next VRT earnings — updated per company announcement (was Apr 29, moved to Apr 22)
var EARNINGS_DATE = new Date('2026-04-22T16:00:00-04:00');

// ── SIGNAL_WEIGHTS (live table, seeded by migrate_v3_1_vrt2.js) ──────────────
var SIGNAL_WEIGHTS = {};

function loadSignalWeights() {
  try {
    var rows = db.prepare('SELECT * FROM signal_weights WHERE enabled = 1').all();
    if (rows.length === 0) {
      // Seed from SIGNAL_CONFIG on first run
      console.log('signal_weights empty — seeding from SIGNAL_CONFIG...');
      var insertW = db.prepare(`
        INSERT OR IGNORE INTO signal_weights
        (hyp_id, weight, base_weight, direction, half_life_min, regime_class,
         threshold, description, enabled, data_source, phase, confidence_tier, updated_ts)
        VALUES (@hyp_id, @weight, @weight, @direction, @half_life_min, @regime_class,
                @threshold, @description, @enabled, @data_source, @phase, @confidence_tier, @ts)
      `);
      var now = Date.now();
      Object.entries(SIGNAL_CONFIG).forEach(function(entry) {
        var id = entry[0], cfg = entry[1];
        insertW.run({
          hyp_id: id, weight: cfg.weight, direction: cfg.direction,
          half_life_min: cfg.half_life_min, regime_class: cfg.regime_class,
          threshold: cfg.threshold || 0, description: cfg.description,
          enabled: cfg.enabled ? 1 : 0, data_source: cfg.data_source,
          phase: cfg.enabled ? 'ACTIVE' : 'DISABLED',
          confidence_tier: cfg.confidence_tier || 'UNTESTED', ts: now,
        });
      });
      rows = db.prepare('SELECT * FROM signal_weights WHERE enabled = 1').all();
    }
    SIGNAL_WEIGHTS = {};
    rows.forEach(function(r) { SIGNAL_WEIGHTS[r.hyp_id] = r; });
    console.log('Signal weights loaded:', Object.keys(SIGNAL_WEIGHTS).length, 'active hypotheses');
  } catch (e) {
    console.error('⚠ Failed to load signal_weights, falling back to SIGNAL_CONFIG:', e.message);
    Object.entries(SIGNAL_CONFIG).forEach(function(entry) {
      var id = entry[0], cfg = entry[1];
      SIGNAL_WEIGHTS[id] = { hyp_id: id, weight: cfg.weight, enabled: cfg.enabled ? 1 : 0,
        direction: cfg.direction, half_life_min: cfg.half_life_min, regime_class: cfg.regime_class,
        hit_rate: null, confidence_tier: cfg.confidence_tier || 'UNTESTED' };
    });
  }
}
loadSignalWeights();
setInterval(loadSignalWeights, 60000); // reload every minute

// ── EARNINGS PROXIMITY WEIGHTING ──────────────────────────────────────────────
function earningsProximityWeight() {
  var daysToEarn = (EARNINGS_DATE - Date.now()) / 86400000;
  if (daysToEarn <= 0)  return 1.0;
  if (daysToEarn <= 3)  return 3.0;
  if (daysToEarn <= 7)  return 2.5;
  if (daysToEarn <= 10) return 2.0;
  if (daysToEarn <= 21) return 1.5;
  return 1.0;
}

// ── MARKET HOURS (NYSE: 9:30–16:00 ET) ───────────────────────────────────────
// DST-safe: dynamically compute ET offset using America/New_York locale string.
// Handles EDT (UTC-4) and EST (UTC-5) automatically — no hardcoded offset.
function getETOffsetHours() {
  var now = new Date();
  // Parse the ET hour from a locale string — reliable cross-platform DST detection
  var etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  if (etHour === 24) etHour = 0;
  return now.getUTCHours() - etHour;
}

function getETMinutes() {
  var now = new Date();
  var offset = getETOffsetHours();
  var etH = (now.getUTCHours() - offset + 24) % 24;
  return etH * 60 + now.getUTCMinutes();
}

function isMarketHours() {
  var now = new Date();
  var day = now.getDay();
  if (day === 0 || day === 6) return false;
  var etMin = getETMinutes();
  return etMin >= 570 && etMin <= 960; // 9:30–16:00 ET
}

// ── PRICE CACHE ────────────────────────────────────────────────────────────────
var priceCache  = {};
var lastClose   = {};
var lastDbWrite = {};
var adv10Cache  = {};
var lastVrtUpdateTs = 0;
var fetchHealth = { lastCount: 0, lastCycleTs: 0 };
var vrtLeadCorr = null; // VRT/ETN 20d lead correlation (for H-CORR)
// copperSpot30d: set by options_flow_phase1_vrt2.js or a future Metals-API job.
// S-CU requires copperSpot30d != null to fire — add METALS_API_KEY to .env to enable.
// Without it, S-CU uses FCX price alone (partial signal, not the full composite).
var copperSpot30d = null; // set externally; null disables the full S-CU check
var optionsPCR = null;
var optionsState = {};

// Load previous closes from DB
try {
  TICKERS.forEach(function(t) {
    var row = db.prepare("SELECT price FROM prices WHERE ticker=? AND source='yahoo_historical' ORDER BY ts DESC LIMIT 1").get(t);
    if (row) lastClose[t] = row.price;
  });
  console.log('Prior closes loaded:', Object.keys(lastClose).length, 'tickers');
} catch(e) { console.log('Close load error:', e.message); }

// Calculate 10-day ADV
function calcADV() {
  try {
    var since = Date.now() - 10 * 86400000;
    TICKERS.forEach(function(t) {
      var rows = db.prepare('SELECT volume FROM prices WHERE ticker=? AND ts>? AND volume IS NOT NULL AND volume>0').all(t, since);
      if (rows.length >= 3) adv10Cache[t] = Math.round(rows.reduce(function(s,r){return s+r.volume;},0)/rows.length);
    });
    console.log('ADV10 loaded:', Object.keys(adv10Cache).length, 'tickers');
  } catch(e) {}
}
calcADV();

// ── DECAY / DEDUP / COMPOSITE HELPERS ────────────────────────────────────────
function decayFactor(ageMs, halfLifeMin) {
  return Math.exp(-ageMs / (halfLifeMin * 60000));
}

function confidenceTierDiscount(tier) {
  return CONFIDENCE_TIER_DISCOUNTS[tier] != null ? CONFIDENCE_TIER_DISCOUNTS[tier] : 0.50;
}

function dedupeFactor(activeIds) {
  var factors = {};
  activeIds.forEach(function(a) { factors[a] = 1.0; });
  activeIds.forEach(function(a) {
    var corrs = SIGNAL_CORR[a] || {};
    Object.keys(corrs).forEach(function(b) {
      if (factors[b] != null) {
        var reduction = 1 - (corrs[b] / 2);
        factors[a] = Math.min(factors[a], reduction);
        factors[b] = Math.min(factors[b], reduction);
      }
    });
  });
  return factors;
}

// ── FINNHUB REST ──────────────────────────────────────────────────────────────
var insertPrice = db.prepare(
  'INSERT OR IGNORE INTO prices (ts,ticker,price,open,high,low,volume,pct,source) ' +
  'VALUES (@ts,@ticker,@price,@open,@high,@low,@volume,@pct,@source)'
);

function fetchQuote(ticker, cb) {
  var options = {
    hostname: 'finnhub.io',
    path: '/api/v1/quote?symbol=' + encodeURIComponent(ticker) + '&token=' + FINNHUB_KEY,
    method: 'GET',
    headers: { 'User-Agent': 'CLAW-VRT2/1.0' }
  };
  var body = '';
  var req = https.request(options, function(res) {
    res.on('data', function(d) { body += d; });
    res.on('end', function() {
      try {
        var q = JSON.parse(body);
        if (!q || !q.c || q.c === 0) { cb(null); return; }
        var prev = q.pc || q.c;
        var pct  = isMarketHours() ? Math.round((q.c - prev) / prev * 10000) / 100 : 0;
        if (!lastClose[ticker]) lastClose[ticker] = prev;

        // Sanity bounds
        var isHighVol = HIGH_VOL_TICKERS.indexOf(ticker) >= 0;
        var maxMove   = isHighVol ? 0.30 : 0.20;
        if (Math.abs((q.c - prev) / prev) > maxMove) {
          console.log('[SANITY] ' + ticker + ' price ' + q.c + ' vs prev ' + prev + ' — skip');
          cb(null);
          return;
        }

        var now = Date.now();
        priceCache[ticker] = { price: q.c, pct: pct, open: q.o, high: q.h, low: q.l, volume: q.v, ts: now };
        if (ticker === 'VRT') lastVrtUpdateTs = now;

        // Write to DB at most once per 5 min per ticker
        if (!lastDbWrite[ticker] || now - lastDbWrite[ticker] > 300000) {
          try {
            insertPrice.run({ ts: now, ticker: ticker, price: q.c, open: q.o || null,
              high: q.h || null, low: q.l || null, volume: q.v || null, pct: pct,
              source: 'finnhub_rest' });
            lastDbWrite[ticker] = now;
          } catch(e) {}
        }
        cb(priceCache[ticker]);
      } catch(e) { cb(null); }
    });
  });
  req.on('error', function() { cb(null); });
  req.setTimeout(8000, function() { req.destroy(); });
  req.end();
}

// ── TIER 1 CYCLE ──────────────────────────────────────────────────────────────
function fetchTier1(onDone) {
  var completed = 0, successful = 0;
  TIER1_TICKERS.forEach(function(t) {
    fetchQuote(t, function(data) {
      if (data) successful++;
      if (++completed === TIER1_TICKERS.length) {
        fetchHealth.lastCount = successful;
        fetchHealth.lastCycleTs = Date.now();
        if (onDone) onDone();
      }
    });
  });
}

// ── TIER 2 CYCLE (rotating buckets) ──────────────────────────────────────────
var tier2BucketIdx = 0;
function getTier2Bucket() {
  var bucketSize = Math.ceil(TIER2_TICKERS.length / 5);
  var start = (tier2BucketIdx % 5) * bucketSize;
  tier2BucketIdx++;
  return TIER2_TICKERS.slice(start, Math.min(start + bucketSize, TIER2_TICKERS.length));
}

function fetchAllPrices() {
  fetchTier1(function() {
    var bucket = getTier2Bucket();
    bucket.forEach(function(t) { fetchQuote(t, function(){}); });
    evaluateSignals(priceCache);
    computeCompositeScore();
  });
}

// Compute relative strength cache
function updateRelativeStrength() {
  var vrt = priceCache.VRT;
  if (!vrt) return;
  ['XLI','SMH','SPY','ETN','NVDA'].forEach(function(bench) {
    var b = priceCache[bench];
    if (b) priceCache['_rs_' + bench] = Math.round((vrt.pct - b.pct) * 100) / 100;
  });
}

// ── VRT/ETN LEAD CORRELATION (for H-CORR) ────────────────────────────────────
function calcVrtEtnCorr() {
  try {
    var since = Date.now() - 20 * 86400000;
    var etn = db.prepare('SELECT ts,pct FROM prices WHERE ticker=? AND ts>? ORDER BY ts').all('ETN', since);
    var vrt = db.prepare('SELECT ts,pct FROM prices WHERE ticker=? AND ts>? ORDER BY ts').all('VRT', since);
    if (etn.length < 10 || vrt.length < 10) return;

    // Align by timestamp (nearest 5-min bin)
    var vrtMap = {};
    vrt.forEach(function(r) { vrtMap[Math.round(r.ts / 300000)] = r.pct; });

    var pairs = [];
    etn.forEach(function(r) {
      var bin = Math.round(r.ts / 300000);
      if (vrtMap[bin] != null) pairs.push([r.pct, vrtMap[bin]]);
    });
    if (pairs.length < 10) return;

    var n = pairs.length;
    var meanX = pairs.reduce(function(s,p){return s+p[0];},0)/n;
    var meanY = pairs.reduce(function(s,p){return s+p[1];},0)/n;
    var num = pairs.reduce(function(s,p){return s+(p[0]-meanX)*(p[1]-meanY);},0);
    var dX  = Math.sqrt(pairs.reduce(function(s,p){return s+Math.pow(p[0]-meanX,2);},0));
    var dY  = Math.sqrt(pairs.reduce(function(s,p){return s+Math.pow(p[1]-meanY,2);},0));
    if (dX === 0 || dY === 0) return;
    vrtLeadCorr = Math.round((num / (dX * dY)) * 1000) / 1000;
    console.log(new Date().toLocaleTimeString(), 'ETN→VRT 20d corr:', vrtLeadCorr, '(n=' + n + ')');
  } catch(e) { console.error('calcVrtEtnCorr error:', e.message); }
}
setTimeout(calcVrtEtnCorr, 8000);
setInterval(calcVrtEtnCorr, 3600000);

// ── VIX_LATEST: load from DB (^VIX or VIXY proxy) for H24 state machine ──
// H24 needs a live VIX value but VIX is not on Finnhub free tier.
// Pull from yahoo_historical (set during backfill for ^VIX) or VIXY proxy.
// Refreshed hourly — stale is acceptable since H24 tracks multi-day spikes.
function refreshVixCache() {
  try {
    // Try ^VIX directly (backfilled from Yahoo)
    var vixRow = db.prepare(
      "SELECT price FROM prices WHERE ticker='^VIX' ORDER BY ts DESC LIMIT 1"
    ).get();
    if (vixRow && vixRow.price > 0) {
      priceCache.VIX_LATEST = vixRow.price;
      return;
    }
    // Fallback: VIXY ETF ≈ VIX / 10 (approximate)
    var vixyRow = db.prepare(
      "SELECT price FROM prices WHERE ticker='VIXY' ORDER BY ts DESC LIMIT 1"
    ).get();
    if (vixyRow && vixyRow.price > 0) {
      priceCache.VIX_LATEST = Math.round(vixyRow.price * 10 * 10) / 10;
    }
  } catch(e) {}
}
setTimeout(refreshVixCache, 12000);
setInterval(refreshVixCache, 3600000);

// ── FINNHUB WEBSOCKET (VRT + ETN live ticks) ──────────────────────────────────
var finnhubWs = null;
var wsVrtVolume = 0, wsVrtVolume5mStart = 0;

function connectFinnhubWS() {
  if (finnhubWs) { try { finnhubWs.terminate(); } catch(e) {} }
  finnhubWs = new WebSocket('wss://ws.finnhub.io?token=' + FINNHUB_KEY);
  finnhubWs.on('open', function() {
    finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: 'VRT' }));
    finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol: 'ETN' }));
    console.log(new Date().toLocaleTimeString(), 'Finnhub WS connected — streaming VRT + ETN');
  });
  finnhubWs.on('message', function(raw) {
    try {
      var msg = JSON.parse(raw);
      if (msg.type !== 'trade' || !msg.data) return;
      msg.data.forEach(function(trade) {
        var sym = trade.s;
        if (sym !== 'VRT' && sym !== 'ETN') return;
        var now   = Date.now();
        var prev  = lastClose[sym] || trade.p;
        var pct   = isMarketHours() ? Math.round((trade.p - prev) / prev * 10000) / 100 : 0;
        priceCache[sym] = { price: trade.p, pct: pct, volume: trade.v, ts: now };

        if (sym === 'VRT') {
          lastVrtUpdateTs = now;
          wsVrtVolume += (trade.v || 0);
          // S8: volume accumulation > 1.5× ADV in current 5-min window
          var adv = adv10Cache['VRT'];
          // Update 5-min volume cache — S8 evaluation happens in evaluateSignals()
          priceCache._vrt_ws_volume = wsVrtVolume;
          // Write WS tick to DB (throttled)
          if (!lastDbWrite['VRT_WS'] || now - lastDbWrite['VRT_WS'] > 60000) {
            try {
              insertPrice.run({ ts: now, ticker: 'VRT', price: trade.p, open: null,
                high: null, low: null, volume: trade.v || null, pct: pct, source: 'finnhub_ws' });
              lastDbWrite['VRT_WS'] = now;
            } catch(e) {}
          }
          evaluateSignals(priceCache);
        }
      });
    } catch(e) {}
  });
  finnhubWs.on('error', function(e) { console.log('WS error:', e.message); });
  finnhubWs.on('close', function() {
    console.log(new Date().toLocaleTimeString(), 'WS closed — reconnecting in 5min (free tier)');
    setTimeout(connectFinnhubWS, 300000);
  });
}
setTimeout(connectFinnhubWS, 3000);

// Reset 5-min WS volume window every 5 minutes.
// wsVrtVolume accumulates ticks within each 5-min window then resets.
// S8 compares the 5-min window total against expected 5-min ADV slice.
// NYSE has ~78 five-minute periods per trading day.
var VRT_5MIN_PERIODS_PER_DAY = 78;
setInterval(function() {
  wsVrtVolume = 0;           // RESET: start fresh each 5-min window
  wsVrtVolume5mStart = 0;    // reset reference too
  priceCache._vrt_ws_volume = 0;  // clear cached value so S8 re-evaluates
}, 300000);

// ── SIGNAL FIRING ─────────────────────────────────────────────────────────────
var lastSignalTs   = {};
var activeSignalsThisCycle = {};

var insertSignal = db.prepare(`
  INSERT INTO signals (ts, hyp_id, trigger_val, trigger_desc, vrt_price,
    direction, confidence, time_bucket, weight_at_fire, is_backtest, source)
  VALUES (@ts, @hyp_id, @trigger_val, @trigger_desc, @vrt_price,
    @direction, @confidence, @time_bucket, @weight_at_fire, 0, 'live')
`);

function getTimeBucket() {
  var etMin = getETMinutes(); // DST-safe via getETOffsetHours()
  if (etMin < 570)  return 'pre_market';
  if (etMin < 600)  return 'open_30min';
  if (etMin < 690)  return 'mid_morning';
  if (etMin < 750)  return 'lunch';
  if (etMin < 870)  return 'afternoon';
  if (etMin < 930)  return 'power_hour';
  if (etMin < 960)  return 'close_30min';
  return 'after_hours';
}

function fireSignal(hypId, triggerVal, desc, vrtPrice, opts) {
  opts = opts || {};
  var now     = Date.now();
  var w       = SIGNAL_WEIGHTS[hypId];
  var cfg     = SIGNAL_CONFIG[hypId];
  var cooldown = SIGNAL_COOLDOWNS[hypId] || 3600000;

  if (!w && !cfg) {
    console.log('⚠ fireSignal: unknown hypothesis', hypId);
    return;
  }
  if (w && w.enabled === 0) return;
  if (lastSignalTs[hypId] && now - lastSignalTs[hypId] < cooldown) return;

  var direction = opts.direction || (w && w.direction) || (cfg && cfg.direction) || 'CONTEXT';
  var weight    = w ? w.weight : (cfg ? cfg.weight : 0);

  try {
    insertSignal.run({
      ts: now, hyp_id: hypId, trigger_val: triggerVal,
      trigger_desc: desc.substring(0, 500),
      vrt_price: vrtPrice || (priceCache.VRT ? priceCache.VRT.price : null),
      direction: direction, confidence: opts.confidence || 1.0,
      time_bucket: getTimeBucket(), weight_at_fire: weight,
    });
    lastSignalTs[hypId] = now;
    activeSignalsThisCycle[hypId] = true;
    console.log(new Date().toLocaleTimeString(), '🔔', hypId, '(' + direction + ')',
      'weight=' + weight, '| ' + desc.substring(0, 80));
    push('signal');
  } catch(e) {
    console.error('fireSignal INSERT error:', e.message);
  }
}

// ── EVALUATESIGNALS (VRT2-specific) ──────────────────────────────────────────
function evaluateSignals(p) {
  activeSignalsThisCycle = {};
  var vrt = p.VRT;
  if (!vrt) return;

  updateRelativeStrength();

  // ── REGIME FILTER: HYG credit spread ────────────────────────────────────
  var hyg = p.HYG;
  var riskOffRegime = (hyg && hyg.pct <= -2);
  if (riskOffRegime) {
    console.log(new Date().toLocaleTimeString(),
      '⚠ Risk-off — HYG ' + hyg.pct + '% — suppressing mean-reversion signals');
  }

  // ── S1_LAG: VRT lagging ETN >5% ──────────────────────────────────────────
  var etn = p.ETN;
  if (etn && isMarketHours()) {
    var lagDiff = etn.pct - vrt.pct;
    if (lagDiff > 5) {
      // VRT is lagging ETN — catch-up signal (67% pre-inclusion hit rate)
      activeSignalsThisCycle.S1_LAG = true;
      fireSignal('S1_LAG', lagDiff,
        'VRT lagging ETN by ' + lagDiff.toFixed(1) + '% — catch-up signal (67% pre-inclusion hit rate)',
        vrt.price);
    }
    // S_ETN_LEAD: ETN moves first, VRT follows within same session
    // Fire when ETN is strongly positive and VRT hasn't moved yet this session
    if (etn.pct > 1.5 && Math.abs(vrt.pct) < 0.5 && isMarketHours()) {
      activeSignalsThisCycle.S_ETN_LEAD = true;
      fireSignal('S_ETN_LEAD', etn.pct,
        'ETN +' + etn.pct + '% leading VRT ' + vrt.pct + '% — intraday lead signal',
        vrt.price);
    }
  }

  // ── S2: VRT + NVDA directional alignment >1.5% ───────────────────────────
  var nvda = p.NVDA;
  if (nvda && Math.abs(vrt.pct) >= 1.5 && Math.abs(nvda.pct) >= 1.5 &&
      Math.sign(vrt.pct) === Math.sign(nvda.pct)) {
    activeSignalsThisCycle.S2 = true;
    var s2dir = vrt.pct > 0 ? 'BULL' : 'BEAR';
    fireSignal('S2', vrt.pct,
      'VRT ' + (vrt.pct > 0 ? '+' : '') + vrt.pct + '% aligns NVDA ' +
      (nvda.pct > 0 ? '+' : '') + nvda.pct + '% — momentum continuation (56% hit rate)',
      vrt.price, { direction: s2dir });
  }

  // ── S8: Volume accumulation >1.5× ADV ────────────────────────────────────
  // NOTE: S8 in v1 had zero fires due to a pipeline bug.
  // v2 fix: accumulate WebSocket volume in wsVrtVolume and check against ADV.
  // Also check REST-reported volume on each tick.
  // S8: 5-min WebSocket volume > 3× expected 5-min ADV slice.
  // wsVrtVolume resets every 5 minutes (see setInterval below).
  // Expected volume per 5-min period = adv10Cache['VRT'] / 78 trading periods.
  // Threshold of 3× catches institutional block prints; 1.5× on daily total
  // was the v1 bug that fired all day once triggered.
  var adv = adv10Cache['VRT'];
  if (adv) {
    var adv5min    = adv / VRT_5MIN_PERIODS_PER_DAY;  // expected per 5-min window
    var wsVolume   = priceCache._vrt_ws_volume || 0;
    if (wsVolume > adv5min * 3 && isMarketHours()) {
      activeSignalsThisCycle.S8 = true;
      var volX = Math.round(wsVolume / adv5min * 10) / 10;
      fireSignal('S8', volX,
        'VRT 5-min volume ' + volX + '× expected pace (ADV/78=' + Math.round(adv5min).toLocaleString() + ') — institutional block',
        vrt.price);
    }
  }

  // ── S_RS: VRT relative strength vs XLI ───────────────────────────────────
  // S_RS: VRT outperforming XLI by >2.5% — strong sector-relative move.
  // Threshold raised from 1.0% (fired every green day) to 2.5% (genuine outperformance).
  var rs = priceCache['_rs_XLI'];
  if (rs != null && rs > 2.5) {
    activeSignalsThisCycle.S_RS = true;
    fireSignal('S_RS', rs,
      'VRT RS vs XLI: +' + rs + '% — significant sector outperformance',
      vrt.price);
  }

  // ── S-CU: Copper composite signal ────────────────────────────────────────
  // Full signal: FCX >+2% AND copper_spot >+5% 30d (requires Metals-API key)
  // Partial signal: FCX >+3% alone (higher bar, no API required)
  var fcx = p.FCX;
  if (fcx && fcx.pct > 2) {
    if (copperSpot30d != null && copperSpot30d > 5) {
      // Full composite — both legs confirmed
      fireSignal('S-CU', fcx.pct,
        'FCX +' + fcx.pct + '% AND copper +' + copperSpot30d.toFixed(1) + '% 30d — VRT margin pressure (full)',
        vrt.price, { direction: 'BEAR' });
    } else if (fcx.pct > 3) {
      // Partial — FCX alone at higher threshold (lower confidence, still informative)
      fireSignal('S-CU', fcx.pct,
        'FCX +' + fcx.pct + '% — copper proxy signal (partial: no Metals-API key)',
        vrt.price, { direction: 'BEAR', confidence: 0.6 });
    }
  }

  // ── GAP_OPEN_BULL / GAP_OPEN_BEAR ─────────────────────────────────────────
  // Only check once near open (after 9:35 ET, before 10:00 ET)
  if (isMarketHours()) {
    var prev = lastClose['VRT'];
    if (prev && Math.abs(vrt.pct) >= 3) {
      var etMin = getETMinutes(); // DST-safe
      if (etMin >= 575 && etMin <= 600) { // 9:35–10:00 ET window
        var gapId = vrt.pct > 0 ? 'GAP_OPEN_BULL' : 'GAP_OPEN_BEAR';
        fireSignal(gapId, vrt.pct,
          'VRT gapped ' + (vrt.pct > 0 ? 'up' : 'down') + ' ' +
          Math.abs(vrt.pct) + '% at open vs prior close $' + prev,
          vrt.price, { direction: vrt.pct > 0 ? 'BULL' : 'BEAR' });
      }
    }
  }

  // ── COMPOSITE_BULL: S1_LAG + S2 both firing ───────────────────────────────
  // Cache DB check result for 5 minutes — this runs on every WS tick
  var nowMs = Date.now();
  if (!evaluateSignals._compositeBullCache || nowMs - evaluateSignals._compositeBullCache.ts > 300000) {
    try {
      var s1n = db.prepare("SELECT COUNT(*) as n FROM signals WHERE hyp_id='S1_LAG' AND ts>? AND is_backtest=0").get(nowMs - 86400000).n;
      var s2n = db.prepare("SELECT COUNT(*) as n FROM signals WHERE hyp_id='S2' AND ts>? AND is_backtest=0").get(nowMs - 86400000).n;
      evaluateSignals._compositeBullCache = { ts: nowMs, s1: s1n, s2: s2n };
    } catch(e) { evaluateSignals._compositeBullCache = { ts: nowMs, s1: 0, s2: 0 }; }
  }
  if (evaluateSignals._compositeBullCache.s1 > 0 && evaluateSignals._compositeBullCache.s2 > 0) {
    fireSignal('COMPOSITE_BULL', vrt.pct,
      'S1_LAG + S2 both firing in last 24h — highest-confidence composite (67% hit rate, +3.65% avg 3d)',
      vrt.price, { direction: 'BULL' });
  }
}

// ── COMPOSITE SCORE (with confidence-tier discounting) ────────────────────────
var lastCompScore = null;

function computeCompositeScore() {
  var now = Date.now();
  var windowStart = now - 24 * 3600000;
  var regime = getCurrentRegime(db);

  var recentSignals;
  try {
    recentSignals = db.prepare(`
      SELECT id, hyp_id, ts, direction, confidence, trigger_val, weight_at_fire
      FROM signals WHERE is_backtest=0 AND ts>=? ORDER BY ts DESC
    `).all(windowStart);
  } catch(e) { recentSignals = []; }

  // Most recent fire per hypothesis
  var latestByHyp = {};
  recentSignals.forEach(function(r) {
    if (!latestByHyp[r.hyp_id] || r.ts > latestByHyp[r.hyp_id].ts)
      latestByHyp[r.hyp_id] = r;
  });

  var activeIds = Object.keys(latestByHyp);
  var dedup     = dedupeFactor(activeIds);
  var earnW     = earningsProximityWeight();
  var contributions = [];
  var bullScore = 0, bearScore = 0;

  activeIds.forEach(function(id) {
    var sig = latestByHyp[id];
    var w   = SIGNAL_WEIGHTS[id];
    if (!w || w.enabled === 0) return;

    var ageMs    = now - sig.ts;
    var halfLife = w.half_life_min || 240;
    var decay    = decayFactor(ageMs, halfLife);
    if (decay < 0.05) return;

    var hitRate  = w.hit_rate != null ? Math.max(0.30, w.hit_rate) : 0.50;
    var conf     = sig.confidence || 1.0;
    var dedup_m  = dedup[id] || 1.0;
    var regime_m = applyRegimeMultiplier(id, 1.0, regime.label);
    var tier_m   = confidenceTierDiscount(w.confidence_tier || 'UNTESTED');

    var dirSign  = sig.direction === 'BULL' ? 1 : sig.direction === 'BEAR' ? -1 : 0;
    var contrib  = w.weight * hitRate * conf * dirSign * decay * dedup_m * regime_m * tier_m * earnW;
    contrib = Math.round(contrib * 100) / 100;

    if (dirSign > 0) bullScore += contrib;
    else if (dirSign < 0) bearScore += contrib;

    contributions.push({
      hyp_id: id, direction: sig.direction,
      weight: w.weight, hit_rate: w.hit_rate, confidence_tier: w.confidence_tier,
      decay: Math.round(decay * 1000) / 1000,
      regime_mult: regime_m, tier_disc: tier_m, contribution: contrib,
      age_min: Math.round(ageMs / 60000),
    });
  });

  var score = Math.round((bullScore + bearScore) * 10) / 10;

  var direction = 'NEUTRAL';
  if (score >= 8)       direction = 'STRONG_BULL';
  else if (score >= 4)  direction = 'BULL';
  else if (score >= 1.5) direction = 'LEAN_BULL';
  else if (score <= -8) direction = 'STRONG_BEAR';
  else if (score <= -4) direction = 'BEAR';
  else if (score <= -1.5) direction = 'LEAN_BEAR';

  lastCompScore = {
    score: score, bull_score: Math.round(bullScore*10)/10,
    bear_score: Math.round(bearScore*10)/10,
    direction: direction, n_active: activeIds.length,
    earnings_weight: earnW, regime: regime.label, regime_vector: regime.vector,
    contributions: contributions.sort(function(a,b){return Math.abs(b.contribution)-Math.abs(a.contribution);}),
    ts: now,
  };

  // Position sizing (from POSITION_SIZING in signal_config.js — imported at top)
  var absScore = Math.abs(score);
  var posEntry = null;
  var table = score >= 0 ? POSITION_SIZING : POSITION_SIZING_BEAR;
  for (var i = 0; i < table.length; i++) {
    if (absScore >= table[i].min && absScore <= table[i].max) {
      posEntry = table[i];
      break;
    }
  }
  lastCompScore.position = posEntry || { pct: 0, label: 'FLAT' };

  // Persist composite snapshot every 5 min
  if (!computeCompositeScore._lastPersist || now - computeCompositeScore._lastPersist > 300000) {
    try {
      db.prepare(`
        INSERT INTO composite_scores
        (ts, score, direction, signals_active, earnings_weight, position_pct, regime_label, confidence_adj)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(now, score, direction, JSON.stringify(activeIds), earnW,
             posEntry ? posEntry.pct : 0, regime.label,
             contributions.reduce(function(s,c){return s+c.tier_disc;},0)/Math.max(1,contributions.length));
      computeCompositeScore._lastPersist = now;
    } catch(e) {
      if (!computeCompositeScore._persistFailLogged) {
        console.error('⚠ composite_scores INSERT failed:', e.message);
        computeCompositeScore._persistFailLogged = true;
      }
    }
  }
}

// ── TEMPORAL SIGNAL EVALUATOR ─────────────────────────────────────────────────
var _signalStateFailLogged = false;
function _logStateErr(op, e) {
  if (!_signalStateFailLogged) {
    console.error('⚠ signal_state ' + op + ' failed:', e.message);
    _signalStateFailLogged = true;
  }
}
function getState(hypId, key) {
  try { return db.prepare('SELECT * FROM signal_state WHERE hyp_id=? AND state_key=?').get(hypId, key); }
  catch(e) { _logStateErr('SELECT', e); return null; }
}
function setState(hypId, key, value, expiresInMs) {
  var now = Date.now();
  try {
    db.prepare(`
      INSERT INTO signal_state (hyp_id, state_key, state_value, started_ts, last_updated_ts, expires_ts)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(hyp_id, state_key) DO UPDATE SET
        state_value=excluded.state_value, last_updated_ts=excluded.last_updated_ts, expires_ts=excluded.expires_ts
    `).run(hypId, key, String(value), now, now, expiresInMs ? now + expiresInMs : null);
  } catch(e) { _logStateErr('UPSERT', e); }
}
function clearState(hypId, key) {
  try { db.prepare('DELETE FROM signal_state WHERE hyp_id=? AND state_key=?').run(hypId, key); }
  catch(e) { _logStateErr('DELETE', e); }
}

function evaluateTemporalSignals() {
  var now = Date.now();
  try { db.prepare('DELETE FROM signal_state WHERE expires_ts IS NOT NULL AND expires_ts<?').run(now); }
  catch(e) {}

  // ── H-CORR: VRT/ETN 20d correlation <0.40 for 3+ days (CRDO H6 analog) ─
  if (typeof vrtLeadCorr === 'number') {
    var hcorrState = getState('H-CORR', 'corr_streak');
    if (vrtLeadCorr < 0.40) {
      var streak = hcorrState ? parseInt(hcorrState.state_value, 10) + 1 : 1;
      setState('H-CORR', 'corr_streak', streak, 5 * 86400000);
      if (streak === 3) {
        fireSignal('H-CORR', vrtLeadCorr,
          'VRT/ETN 20d correlation = ' + vrtLeadCorr.toFixed(3) + ' for 3rd consecutive day — relationship breakdown',
          priceCache.VRT ? priceCache.VRT.price : null, { direction: 'CONTEXT' });
      }
    } else if (hcorrState) {
      clearState('H-CORR', 'corr_streak');
    }
  }

  // ── H24: VIX spike >30 then recovery <22 within 10d ─────────────────────
  // (H19 in VRT v1, H24 in VRT2 — renamed for clarity)
  var vix = priceCache.VIX_LATEST;
  if (typeof vix === 'number') {
    var h24state = getState('H24', 'vix_spike');
    if (h24state) {
      try {
        var d = JSON.parse(h24state.state_value);
        var daysSince = (now - d.spikedAt) / 86400000;
        if (vix < 22 && daysSince <= 10) {
          fireSignal('H24', vix,
            'VIX spiked to ' + d.spikeValue.toFixed(1) + ' → recovered to ' + vix.toFixed(1) +
            ' in ' + daysSince.toFixed(1) + 'd — reflation trade (H24)',
            priceCache.VRT ? priceCache.VRT.price : null, { direction: 'BULL' });
          clearState('H24', 'vix_spike');
        }
      } catch(e) {}
    } else if (vix > 30) {
      setState('H24', 'vix_spike', JSON.stringify({ spikedAt: now, spikeValue: vix }), 10 * 86400000);
      console.log('H24 state opened — VIX spike at', vix.toFixed(1));
    }
  }

  // ── H18: S&P 500 inclusion alpha tracking ────────────────────────────────
  // VRT added Mar 23 2026. Track VRT vs SPY running alpha.
  // Evaluate at most once per trading day — this hits the DB; don't run on every WS tick.
  var vrtEntry = 265.0; // approximate inclusion price
  var inclDate = new Date('2026-03-23').getTime();
  var daysSinceIncl = (now - inclDate) / 86400000;
  if (daysSinceIncl > 0 && daysSinceIncl < 365) {
    var etDay = getETDateString ? getETDateString() : new Date().toISOString().slice(0,10);
    if (evaluateTemporalSignals._lastH18Day !== etDay) {
      evaluateTemporalSignals._lastH18Day = etDay;
    var spy = priceCache.SPY;
    var vrtCurrent = priceCache.VRT;
    // Rough alpha check — fires once when >20% threshold crossed
    // Actual tracking via daily briefs and correlation job
    if (spy && vrtCurrent) {
      var h18state = getState('H18', 'alpha_fired');
      if (!h18state) {
        // Calculate running VRT return vs SPY return since inclusion
        try {
          // Query SPY price at/near VRT S&P inclusion date (Mar 23 2026), not latest row
          var spyAtIncl = db.prepare(
            "SELECT price FROM prices WHERE ticker='SPY' AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) ASC LIMIT 1"
          ).get(inclDate - 86400000 * 3, inclDate + 86400000 * 3, inclDate);
          if (spyAtIncl) {
            var vrtReturn = (vrtCurrent.price - vrtEntry) / vrtEntry * 100;
            var spyReturn = (spy.price - spyAtIncl.price) / spyAtIncl.price * 100;
            var alpha = vrtReturn - spyReturn;
            if (alpha > 20) {
              fireSignal('H18', alpha,
                'VRT +' + vrtReturn.toFixed(1) + '% vs SPY ' + spyReturn.toFixed(1) + '% since S&P inclusion = +' +
                alpha.toFixed(1) + '% alpha in ' + Math.round(daysSinceIncl) + 'd (H18 BULL threshold: >20%)',
                vrtCurrent.price, { direction: 'BULL' });
              setState('H18', 'alpha_fired', '1', 86400000 * 365); // don't re-fire for a year
            }
          }
        } catch(e) {}
      }
    }
    } // end once-per-day gate
  }
}

// ── STACK DETECTOR ────────────────────────────────────────────────────────────
function evaluateStacks() {
  var now = Date.now();
  var windowStart = now - 24 * 3600000;
  var recent;
  try {
    recent = db.prepare(`
      SELECT hyp_id, direction, ts, confidence FROM signals
      WHERE is_backtest=0 AND ts>=? AND direction IN ('BULL','BEAR') ORDER BY ts DESC
    `).all(windowStart);
  } catch(e) { return; }

  var latestByHyp = {};
  recent.forEach(function(r) {
    if (!latestByHyp[r.hyp_id] || r.ts > latestByHyp[r.hyp_id].ts) latestByHyp[r.hyp_id] = r;
  });

  function largestUncorrelated(signals) {
    var sorted = signals.slice().sort(function(a,b){return (b.confidence||1)-(a.confidence||1);});
    var subset = [];
    sorted.forEach(function(s) {
      var conflicts = subset.some(function(inc) {
        return ((SIGNAL_CORR[s.hyp_id] && SIGNAL_CORR[s.hyp_id][inc.hyp_id]) || 0) >= 0.5;
      });
      if (!conflicts) subset.push(s);
    });
    return subset;
  }

  var bull = Object.values(latestByHyp).filter(function(s){return s.direction==='BULL';});
  var bear = Object.values(latestByHyp).filter(function(s){return s.direction==='BEAR';});
  var bullStack = largestUncorrelated(bull);
  var bearStack = largestUncorrelated(bear);
  var COOLDOWN = 4 * 3600000;
  var vrtPx = priceCache.VRT ? priceCache.VRT.price : null;

  if (bullStack.length >= 3 && (!lastSignalTs.STACK_BULL || now - lastSignalTs.STACK_BULL > COOLDOWN)) {
    fireSignal('STACK_BULL', bullStack.length,
      bullStack.length + ' uncorrelated BULL signals in 24h: ' + bullStack.map(function(s){return s.hyp_id;}).join(', '),
      vrtPx, { direction: 'BULL' });
  }
  if (bearStack.length >= 3 && (!lastSignalTs.STACK_BEAR || now - lastSignalTs.STACK_BEAR > COOLDOWN)) {
    fireSignal('STACK_BEAR', bearStack.length,
      bearStack.length + ' uncorrelated BEAR signals in 24h: ' + bearStack.map(function(s){return s.hyp_id;}).join(', '),
      vrtPx, { direction: 'BEAR' });
  }
}

// ── STALENESS MONITOR ─────────────────────────────────────────────────────────
setInterval(function() {
  if (!isMarketHours()) return;
  var stale = Date.now() - lastVrtUpdateTs;
  if (stale > 5 * 60000) {
    console.log('⚠ VRT data stale ' + Math.round(stale/60000) + 'min — reconnecting WS');
    connectFinnhubWS();
  }
}, 60000);

// ── MAIN POLL INTERVALS ───────────────────────────────────────────────────────
setInterval(function() { if (isMarketHours()) fetchAllPrices(); }, 300000);  // 5-min REST poll
setInterval(function() { if (isMarketHours()) evaluateTemporalSignals(); }, 60000);
setInterval(function() { if (isMarketHours()) evaluateStacks(); }, 15 * 60000);
fetchAllPrices(); // initial fetch on boot

// ── SSE ───────────────────────────────────────────────────────────────────────
var sseClients = [];
function push(eventType) {
  var payload = 'event: ' + eventType + '\ndata: ' + JSON.stringify({ ts: Date.now() }) + '\n\n';
  sseClients.forEach(function(c) { try { c.write(payload); } catch(e) {} });
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
var server = http.createServer(function(req, res) {
  var url = req.url.split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /status ────────────────────────────────────────────────────────────
  if (url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'online', version: 'VRT2 v3.3.0', port: PORT,
      ws_state: finnhubWs ? finnhubWs.readyState : -1,
      prices_cached: Object.keys(priceCache).filter(function(k){return !k.startsWith('_');}).length,
      market_hours: isMarketHours(),
      last_composite: lastCompScore,
      vrt_etn_corr: vrtLeadCorr,
      earnings_date: EARNINGS_DATE.toISOString(),
      earnings_weight: earningsProximityWeight(),
      copper_spot_30d: copperSpot30d,
      clients: sseClients.length,
      uptime: process.uptime(),
      fetch_health: fetchHealth,
      stale_mins: lastVrtUpdateTs > 0 ? Math.round((Date.now()-lastVrtUpdateTs)/60000*10)/10 : null,
    }));
    return;
  }

  // ── /prices ────────────────────────────────────────────────────────────
  if (url === '/prices') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(priceCache));
    return;
  }

  // ── /signals ───────────────────────────────────────────────────────────
  if (url === '/signals') {
    var rows = db.prepare('SELECT * FROM signals WHERE ts>? ORDER BY ts DESC').all(Date.now()-12*3600000);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rows));
    return;
  }

  // ── /composite ─────────────────────────────────────────────────────────
  if (url === '/composite') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(lastCompScore || { score: 0, direction: 'NEUTRAL', position: { pct: 0, label: 'FLAT' } }));
    return;
  }

  // ── /position (NEW in VRT2) ────────────────────────────────────────────
  if (url === '/position') {
    try {
      var riskRow = db.prepare("SELECT state_value FROM risk_state WHERE state_key='kill_switch_active'").get();
      var haltRow = db.prepare("SELECT state_value FROM risk_state WHERE state_key='halt_trading_active'").get();
      var halfRow = db.prepare("SELECT state_value FROM risk_state WHERE state_key='half_size_active'").get();
      var regime  = getCurrentRegime(db);
      var comp    = lastCompScore || { score: 0, position: { pct: 0, label: 'FLAT' } };
      var pos     = comp.position || { pct: 0, label: 'FLAT' };
      var killSwitch = riskRow && riskRow.state_value === '1';
      var halt       = haltRow && haltRow.state_value === '1';
      var halfSize   = halfRow && halfRow.state_value === '1';

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        composite: comp.score, direction: comp.direction,
        recommended_pct: killSwitch || halt ? 0 : halfSize ? pos.pct / 2 : pos.pct,
        label: killSwitch ? 'KILL_SWITCH' : halt ? 'HALTED' : halfSize ? 'HALF_SIZE_' + pos.label : pos.label,
        regime: regime.label, regime_vector: regime.vector,
        kill_switch: killSwitch, halt: halt, half_size: halfSize,
        earnings_weight: earningsProximityWeight(),
        ts: Date.now(),
      }));
    } catch(e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /regime (NEW in VRT2) ──────────────────────────────────────────────
  if (url === '/regime') {
    try {
      var regime = getCurrentRegime(db);
      var recent = db.prepare('SELECT * FROM regime_log ORDER BY ts DESC LIMIT 7').all();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ current: regime, recent: recent }));
    } catch(e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ current: { label: 'UNKNOWN' }, recent: [] }));
    }
    return;
  }

  // ── /risk (NEW in VRT2) ────────────────────────────────────────────────
  if (url === '/risk') {
    try {
      var states = db.prepare('SELECT * FROM risk_state').all();
      var riskMap = {};
      states.forEach(function(r) { riskMap[r.state_key] = r.state_value; });
      var losers = db.prepare(`
        SELECT COUNT(*) n FROM positions
        WHERE status='CLOSED' AND is_hit=0
        ORDER BY closed_at DESC LIMIT 5
      `).get();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ risk_state: riskMap, recent_losers: losers ? losers.n : 0 }));
    } catch(e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /revisions (NEW in VRT2) ───────────────────────────────────────────
  if (url === '/revisions') {
    try {
      var revs = db.prepare('SELECT * FROM analyst_revisions ORDER BY ts DESC LIMIT 20').all();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(revs));
    } catch(e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([]));

    }
    return;
  }

  // ── /correlations ──────────────────────────────────────────────────────
  if (url === '/correlations') {
    var rows = db.prepare(`
      SELECT ticker_b, window_days, corr_value, n_obs, ts
      FROM correlations WHERE ticker_a='VRT' AND ts>? ORDER BY ts DESC, ticker_b
    `).all(Date.now() - 2 * 86400000);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rows));
    return;
  }

  // ── /insiders ──────────────────────────────────────────────────────────
  if (url === '/insiders') {
    var rows = db.prepare(`
      SELECT transaction_date, insider_name, insider_title, transaction_code,
             shares, price_per_share, total_value, h22_variant
      FROM insider_transactions ORDER BY transaction_date DESC LIMIT 30
    `).all();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rows));
    return;
  }

  // ── /financials ────────────────────────────────────────────────────────
  if (url === '/financials') {
    var rows = db.prepare('SELECT period_end, metric, value, filing_date FROM financials ORDER BY period_end DESC LIMIT 60').all();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rows));
    return;
  }

  // ── /news ──────────────────────────────────────────────────────────────
  if (url === '/news') {
    var rows = db.prepare('SELECT * FROM news_events ORDER BY ts DESC LIMIT 30').all();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(rows));
    return;
  }

  // ── /weights ───────────────────────────────────────────────────────────
  if (url === '/weights') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(Object.values(SIGNAL_WEIGHTS)));
    return;
  }

  // ── /scan/health ───────────────────────────────────────────────────────
  if (url === '/scan/health') {
    try {
      var heartbeat = db.prepare('SELECT * FROM scan_heartbeats ORDER BY ts DESC LIMIT 1').get();
      var pendingTasks = db.prepare("SELECT COUNT(*) n FROM browser_tasks WHERE status='PENDING'").get();
      var failedToday  = db.prepare(`
        SELECT COUNT(*) n FROM browser_tasks WHERE status='FAILED' AND created_ts>?
      `).get(getETDayStartMs());
      var todayBrief   = db.prepare(
        "SELECT brief_date, data_quality, harness_uptime_pct FROM daily_briefs ORDER BY brief_date DESC LIMIT 1"
      ).get();
      var quality = computeHarnessQuality(db, getETDateString());
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        daemon: heartbeat || null,
        pending_tasks: pendingTasks ? pendingTasks.n : 0,
        failed_today:  failedToday  ? failedToday.n  : 0,
        today_brief: todayBrief || null,
        harness_quality: quality,
        vrt_etn_corr: vrtLeadCorr,
      }));
    } catch(e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /daily_brief ───────────────────────────────────────────────────────
  if (url === '/daily_brief') {
    var brief = db.prepare('SELECT * FROM daily_briefs ORDER BY brief_date DESC LIMIT 1').get();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(brief || null));
    return;
  }

  // ── /browser/queue (browser harness — claim task) ─────────────────────
  if (url === '/browser/queue' && req.method === 'GET') {
    try {
      var task = db.transaction(function() {
        var t = db.prepare(`
          SELECT * FROM browser_tasks WHERE status='PENDING'
          ORDER BY priority ASC, created_ts ASC LIMIT 1
        `).get();
        if (!t) return null;
        var payload;
        try { payload = JSON.parse(t.payload_json); }
        catch(e) {
          db.prepare(
            "UPDATE browser_tasks SET status='FAILED', notes=? WHERE task_id=?"
          ).run('JSON parse error: ' + e.message, t.task_id);
          return null;
        }
        db.prepare(
          "UPDATE browser_tasks SET status='RUNNING', started_ts=?, attempts=attempts+1 WHERE task_id=?"
        ).run(Date.now(), t.task_id);
        return { ...t, payload };
      })();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(task));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /browser/results (browser harness — submit result) ────────────────
  if (url === '/browser/results' && req.method === 'POST') {
    var body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', function() {
      try {
        var result = JSON.parse(body);
        db.prepare(`
          INSERT INTO browser_task_results
          (task_id, task_type, hypothesis_id, completed_ts, status, raw_output, parsed_json,
           findings_md_path, error_message, duration_ms)
          VALUES (@task_id, @task_type, @hypothesis_id, @completed_ts, @status, @raw_output,
                  @parsed_json, @findings_md_path, @error_message, @duration_ms)
        `).run({
          task_id: result.task_id, task_type: result.task_type || '',
          hypothesis_id: result.hypothesis_id || null,
          completed_ts: Date.now(), status: result.status || 'UNKNOWN',
          raw_output: result.raw_output || null,
          parsed_json: result.parsed_json ? JSON.stringify(result.parsed_json) : null,
          findings_md_path: result.findings_md_path || null,
          error_message: result.error_message || null,
          duration_ms: result.duration_ms || null,
        });
        db.prepare(
          "UPDATE browser_tasks SET status=?, completed_ts=? WHERE task_id=?"
        ).run(result.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED', Date.now(), result.task_id);
        push('scan_result');
        res.writeHead(200);
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /browser/heartbeat ────────────────────────────────────────────────
  if (url === '/browser/heartbeat' && req.method === 'POST') {
    var body2 = '';
    req.on('data', function(d) { body2 += d; });
    req.on('end', function() {
      try {
        var hb = JSON.parse(body2);
        db.prepare(`
          INSERT INTO scan_heartbeats (daemon_name, ts, status, current_task_id, tasks_completed_today, tasks_failed_today)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('browser_runner_vrt2', Date.now(), hb.status || 'OK', hb.current_task_id || null,
               hb.tasks_completed_today || 0, hb.tasks_failed_today || 0);
        res.writeHead(200);
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /scan/kickoff (manual operator trigger) ────────────────────────────
  if (url === '/scan/kickoff' && req.method === 'POST') {
    var body3 = '';
    req.on('data', function(d) { body3 += d; });
    req.on('end', function() {
      try {
        var opts2 = JSON.parse(body3 || '{}');
        db.prepare(`
          INSERT INTO browser_tasks (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name)
          VALUES ('scan_search', ?, 'PENDING', ?, 1, ?, 'kickoff_endpoint')
        `).run(opts2.hypothesis_id || null,
               JSON.stringify({ manual: true, note: opts2.note || 'operator kickoff' }),
               Date.now());
        res.writeHead(200);
        res.end('{"ok":true,"msg":"scan task queued"}');
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /events (SSE) ─────────────────────────────────────────────────────
  if (url === '/events') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(':connected\n\n');
    sseClients.push(res);
    req.on('close', function() {
      sseClients = sseClients.filter(function(c){ return c !== res; });
    });
    return;
  }

  // ── Dashboard HTML ────────────────────────────────────────────────────
  if (url === '/' || url === '/dashboard') {
    var dashPath = path.join(__dirname, 'dashboard_vrt2.html');
    if (fs.existsSync(dashPath)) {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(dashPath, 'utf8'));
    } else {
      res.writeHead(404);
      res.end('Dashboard not found. Run setup and ensure dashboard_vrt2.html exists.');
    }
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found', endpoints: [
    '/', '/status', '/prices', '/signals', '/composite', '/position', '/regime', '/risk',
    '/revisions', '/correlations', '/insiders', '/financials', '/news', '/weights',
    '/scan/health', '/scan/kickoff', '/daily_brief', '/browser/queue', '/browser/results',
    '/browser/heartbeat', '/events',
  ]}));
});

server.listen(PORT, '127.0.0.1', function() {
  console.log('');
  console.log('═'.repeat(55));
  console.log('CLAW VRT2 listening on http://127.0.0.1:' + PORT);
  console.log('═'.repeat(55));
  console.log('');
  console.log('  Target:        NYSE:VRT (Vertiv Holdings)');
  console.log('  Earnings:      ' + EARNINGS_DATE.toDateString() + ' (Apr 22 2026)');
  console.log('  Tickers:       ' + TICKERS.length + ' (' + TIER1_TICKERS.length + ' Tier 1, ' + TIER2_TICKERS.length + ' Tier 2)');
  console.log('  Hypotheses:    ' + Object.keys(SIGNAL_WEIGHTS).length + ' active');
  console.log('  Phase:         ' + REVIEW_CADENCE.phase);
  console.log('  Daily review:  ' + REVIEW_CADENCE.daily_review_time + ' ET');
  console.log('');
  console.log('  Endpoints:     /position /regime /risk (new in VRT2)');
  console.log('');
  console.log('Day 1 priority: python3 backtest_harness_vrt2.py (H-INV backtest)');
  console.log('');
});
