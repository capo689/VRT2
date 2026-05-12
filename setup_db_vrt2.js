// CLAW VRT2 — Database Setup + Historical Backfill
// Run once: node setup_db_vrt2.js
// Creates vrt2.db with full CRDO v3.2-parity schema + VRT2-specific tables
// Then backfills 2022-present for all 29 VRT2 cohort tickers.
//
// Architecture: CRDO setup_db_crdo.js parity. Zero VRT v1 code.
// Port: 51752 | DB: vrt2.db

'use strict';

const Database = require('better-sqlite3');
const https    = require('https');
const path     = require('path');

const DB_PATH = path.join(__dirname, 'vrt2.db');
const db      = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────────────────────────────

db.exec(`
  -- ── Core price history ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS prices (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    ticker    TEXT NOT NULL,
    price     REAL NOT NULL,
    open      REAL,
    high      REAL,
    low       REAL,
    volume    INTEGER,
    pct       REAL,
    source    TEXT DEFAULT 'finnhub_rest'
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_prices_ts     ON prices(ts);
  CREATE INDEX IF NOT EXISTS idx_vrt2_prices_ticker ON prices(ticker);
  CREATE INDEX IF NOT EXISTS idx_vrt2_prices_ts_tk  ON prices(ticker, ts);

  -- ── Signal firings (inline outcomes — CRDO v3 schema) ───────────────────
  CREATE TABLE IF NOT EXISTS signals (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                    INTEGER NOT NULL,
    hyp_id                TEXT NOT NULL,
    trigger_val           REAL,
    trigger_desc          TEXT,
    vrt_price             REAL,
    active                INTEGER DEFAULT 1,
    direction             TEXT,
    confidence            REAL,
    time_bucket           TEXT,
    regime_vix            REAL,
    weight_at_fire        REAL,
    is_backtest           INTEGER DEFAULT 0,
    reason                TEXT,
    source                TEXT DEFAULT 'live',
    -- outcome columns (filled by fill_outcomes_vrt2.js)
    outcome_1d            REAL,
    outcome_5d            REAL,
    outcome_20d           REAL,
    xli_1d                REAL,
    xli_5d                REAL,
    xli_20d               REAL,
    alpha_1d              REAL,
    alpha_5d              REAL,
    alpha_20d             REAL,
    hit                   INTEGER,
    outcome_filled_at     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_signals_ts     ON signals(ts);
  CREATE INDEX IF NOT EXISTS idx_vrt2_signals_hyp    ON signals(hyp_id);
  CREATE INDEX IF NOT EXISTS idx_vrt2_signals_bt     ON signals(is_backtest);
  CREATE INDEX IF NOT EXISTS idx_vrt2_signals_filled ON signals(outcome_filled_at);

  -- ── Signal weights (learning loop — seeded by migrate_v3_1_vrt2.js) ────
  CREATE TABLE IF NOT EXISTS signal_weights (
    hyp_id                TEXT PRIMARY KEY,
    weight                REAL NOT NULL,
    base_weight           REAL NOT NULL,
    hit_rate              REAL,
    n_signals             INTEGER DEFAULT 0,
    avg_alpha_when_hit    REAL,
    avg_alpha_when_miss   REAL,
    direction             TEXT,
    half_life_min         INTEGER,
    regime_class          TEXT,
    threshold             REAL,
    description           TEXT,
    enabled               INTEGER DEFAULT 1,
    data_source           TEXT DEFAULT 'finnhub',
    phase                 TEXT DEFAULT 'ACTIVE',
    confidence_tier       TEXT DEFAULT 'UNTESTED',
    last_recalibrated_ts  INTEGER,
    updated_ts            INTEGER NOT NULL
  );

  -- ── Signal state (multi-day hypothesis state machines) ──────────────────
  CREATE TABLE IF NOT EXISTS signal_state (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    hyp_id          TEXT NOT NULL,
    state_key       TEXT NOT NULL,
    state_value     TEXT,
    started_ts      INTEGER NOT NULL,
    last_updated_ts INTEGER NOT NULL,
    expires_ts      INTEGER,
    UNIQUE(hyp_id, state_key)
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_state_hyp ON signal_state(hyp_id);
  CREATE INDEX IF NOT EXISTS idx_vrt2_state_exp ON signal_state(expires_ts);

  -- ── Job health tracking ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS job_health (
    job_name     TEXT PRIMARY KEY,
    last_run_ts  INTEGER NOT NULL,
    last_status  TEXT NOT NULL,
    last_error   TEXT,
    rows_written INTEGER,
    duration_ms  INTEGER
  );

  -- ── Intraday snapshots ───────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS intraday_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    ticker         TEXT NOT NULL,
    price          REAL NOT NULL,
    volume         INTEGER,
    pct            REAL,
    interval_label TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_snap_ts_tk ON intraday_snapshots(ticker, ts);

  -- ── Composite scores over time ───────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS composite_scores (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    score           REAL NOT NULL,
    direction       TEXT,
    signals_active  TEXT,
    earnings_weight REAL,
    position_pct    REAL,
    stop_price      REAL,
    target_price    REAL,
    regime_label    TEXT,
    confidence_adj  REAL,
    note            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_composite_ts ON composite_scores(ts);

  -- ── Browser harness tables ───────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS browser_tasks (
    task_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type        TEXT NOT NULL,
    hypothesis_id    TEXT,
    status           TEXT NOT NULL DEFAULT 'PENDING',
    payload_json     TEXT NOT NULL,
    priority         INTEGER DEFAULT 5,
    created_ts       INTEGER NOT NULL,
    scheduled_for_ts INTEGER,
    started_ts       INTEGER,
    completed_ts     INTEGER,
    attempts         INTEGER DEFAULT 0,
    max_attempts     INTEGER DEFAULT 2,
    parent_task_id   INTEGER,
    producer_name    TEXT NOT NULL,
    notes            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_bt_status ON browser_tasks(status, priority, created_ts);
  CREATE INDEX IF NOT EXISTS idx_vrt2_bt_hyp    ON browser_tasks(hypothesis_id);

  CREATE TABLE IF NOT EXISTS browser_task_results (
    result_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             INTEGER NOT NULL,
    task_type           TEXT NOT NULL,
    hypothesis_id       TEXT,
    completed_ts        INTEGER NOT NULL,
    status              TEXT NOT NULL,
    raw_output          TEXT,
    parsed_json         TEXT,
    findings_md_path    TEXT,
    error_message       TEXT,
    duration_ms         INTEGER,
    consumer_processed  INTEGER DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES browser_tasks(task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_results_task    ON browser_task_results(task_id);
  CREATE INDEX IF NOT EXISTS idx_vrt2_results_unconsumed ON browser_task_results(consumer_processed, completed_ts);

  CREATE TABLE IF NOT EXISTS scan_heartbeats (
    heartbeat_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    daemon_name           TEXT NOT NULL,
    ts                    INTEGER NOT NULL,
    status                TEXT NOT NULL,
    current_task_id       INTEGER,
    tasks_completed_today INTEGER DEFAULT 0,
    tasks_failed_today    INTEGER DEFAULT 0,
    notes                 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_hb_daemon_ts ON scan_heartbeats(daemon_name, ts DESC);

  CREATE TABLE IF NOT EXISTS page_versions (
    page_key        TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    last_seen_ts    INTEGER NOT NULL,
    content_hash    TEXT NOT NULL,
    content_summary TEXT,
    notes           TEXT
  );

  -- ── Daily briefs (v3.2 quality-tracking columns included from day one) ───
  CREATE TABLE IF NOT EXISTS daily_briefs (
    brief_date          TEXT PRIMARY KEY,
    generated_ts        INTEGER NOT NULL,
    brief_md            TEXT NOT NULL,
    composite_score     REAL,
    signals_fired       INTEGER DEFAULT 0,
    signals_suppressed  INTEGER DEFAULT 0,
    generation_task_id  INTEGER,
    data_quality        TEXT DEFAULT 'UNKNOWN',
    tasks_completed     INTEGER,
    tasks_failed        INTEGER,
    tasks_total         INTEGER,
    harness_uptime_pct  REAL
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_briefs_quality ON daily_briefs(data_quality);

  -- ── News events ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS news_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    category  TEXT NOT NULL,
    headline  TEXT NOT NULL,
    url       TEXT UNIQUE,
    source    TEXT,
    sentiment TEXT,
    hyp_link  TEXT,
    hyp_id    TEXT,
    severity  TEXT,
    direction TEXT,
    title     TEXT,
    summary   TEXT,
    notes     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_news_ts  ON news_events(ts);
  CREATE INDEX IF NOT EXISTS idx_vrt2_news_cat ON news_events(category);

  -- ── Insider transactions (Form 4 — strict code filter in insider_vrt2.js) ─
  CREATE TABLE IF NOT EXISTS insider_transactions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    filing_date        TEXT NOT NULL,
    transaction_date   TEXT NOT NULL,
    insider_name       TEXT,
    insider_title      TEXT,
    transaction_code   TEXT,
    shares             REAL,
    price_per_share    REAL,
    total_value        REAL,
    shares_owned_after REAL,
    aff10b5_one        INTEGER DEFAULT 0,
    h22_variant        TEXT,
    accession_number   TEXT UNIQUE,
    source_url         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_insider_date ON insider_transactions(transaction_date);
  CREATE INDEX IF NOT EXISTS idx_vrt2_insider_code ON insider_transactions(transaction_code);

  -- ── EDGAR filings index ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS filings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    accession     TEXT UNIQUE NOT NULL,
    form_type     TEXT NOT NULL,
    filed_date    TEXT NOT NULL,
    period_end    TEXT,
    filing_url    TEXT,
    processed     INTEGER DEFAULT 0,
    notes         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_filings_type ON filings(form_type);
  CREATE INDEX IF NOT EXISTS idx_vrt2_filings_date ON filings(filed_date);

  -- ── Balance sheet / XBRL financials (H-INV source) ──────────────────────
  CREATE TABLE IF NOT EXISTS financials (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filing_date TEXT NOT NULL,
    period_end  TEXT NOT NULL,
    metric      TEXT NOT NULL,
    value       REAL,
    unit        TEXT DEFAULT 'USD',
    source_url  TEXT,
    UNIQUE(period_end, metric)
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_fin_period ON financials(period_end);

  -- ── Rolling correlations (VRT vs ETN etc — H-CORR) ──────────────────────
  CREATE TABLE IF NOT EXISTS correlations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    ticker_a    TEXT NOT NULL,
    ticker_b    TEXT NOT NULL,
    window_days INTEGER NOT NULL,
    corr_value  REAL,
    n_obs       INTEGER,
    UNIQUE(ts, ticker_a, ticker_b, window_days)
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_corr_ts ON correlations(ts);

  -- ── Lawsuits (CourtListener — H-VRT-IR adjacent) ─────────────────────────
  CREATE TABLE IF NOT EXISTS lawsuits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    filed_date     TEXT NOT NULL,
    court          TEXT,
    case_number    TEXT,
    case_name      TEXT,
    plaintiff      TEXT,
    defendant      TEXT,
    nature_of_suit TEXT,
    docket_url     TEXT UNIQUE,
    first_seen_ts  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_suit_date ON lawsuits(filed_date);

  -- ── Options activity snapshots (H-OPT Phase 1 free stack) ───────────────
  CREATE TABLE IF NOT EXISTS options_activity (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER NOT NULL,
    call_volume      INTEGER,
    put_volume       INTEGER,
    call_oi          INTEGER,
    put_oi           INTEGER,
    pcr              REAL,
    call_vol_20d_avg INTEGER,
    put_vol_20d_avg  INTEGER,
    call_vol_ratio   REAL,
    put_vol_ratio    REAL,
    unusual_flag     INTEGER DEFAULT 0,
    source           TEXT DEFAULT 'free_tier'
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_opt_ts ON options_activity(ts);

  -- ── Hyperscaler transcript keywords (H1/H14) ─────────────────────────────
  CREATE TABLE IF NOT EXISTS transcript_keywords (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company         TEXT NOT NULL,
    fiscal_period   TEXT NOT NULL,
    call_date       TEXT NOT NULL,
    keyword_group   TEXT NOT NULL,
    keyword         TEXT NOT NULL,
    count           INTEGER DEFAULT 0,
    context_snippet TEXT,
    source_url      TEXT,
    UNIQUE(company, fiscal_period, keyword)
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_tk_company ON transcript_keywords(company);
  CREATE INDEX IF NOT EXISTS idx_vrt2_tk_period  ON transcript_keywords(fiscal_period);

  -- ── VRT2-SPECIFIC NEW TABLES (production discipline layer) ───────────────

  -- Regime log (4D regime vector, daily from regime_detector_vrt2.js)
  CREATE TABLE IF NOT EXISTS regime_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    et_date       TEXT NOT NULL,
    vix_value     REAL,
    vix_regime    TEXT,
    pmi_value     REAL,
    pmi_regime    TEXT,
    rates_delta_bps REAL,
    rates_regime  TEXT,
    hyg_30d_pct   REAL,
    risk_regime   TEXT,
    full_vector   TEXT,
    is_transition INTEGER DEFAULT 0,
    UNIQUE(et_date)
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_regime_ts   ON regime_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_vrt2_regime_date ON regime_log(et_date);

  -- Positions (open and closed trades — position_sizer_vrt2.js)
  CREATE TABLE IF NOT EXISTS positions (
    position_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at           INTEGER NOT NULL,
    direction           TEXT NOT NULL,
    composite_at_entry  REAL,
    regime_at_entry     TEXT,
    position_pct        REAL NOT NULL,
    entry_price         REAL,
    stop_price          REAL,
    target_price        REAL,
    status              TEXT NOT NULL DEFAULT 'OPEN',
    closed_at           INTEGER,
    exit_price          REAL,
    exit_reason         TEXT,
    outcome_pct         REAL,
    is_hit              INTEGER,
    notes               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_pos_status ON positions(status);
  CREATE INDEX IF NOT EXISTS idx_vrt2_pos_opened ON positions(opened_at DESC);

  -- Risk state (kill-switch tracking — risk_monitor_vrt2.js)
  CREATE TABLE IF NOT EXISTS risk_state (
    state_key   TEXT PRIMARY KEY,
    state_value TEXT,
    updated_at  INTEGER NOT NULL
  );

  -- Analyst revisions (H-AR source — analyst_revisions_vrt2.js)
  CREATE TABLE IF NOT EXISTS analyst_revisions (
    revision_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    et_date        TEXT NOT NULL,
    firm           TEXT,
    analyst        TEXT,
    prior_target   REAL,
    new_target     REAL,
    direction      TEXT,
    rating_from    TEXT,
    rating_to      TEXT,
    rating_change  TEXT,
    source         TEXT,
    raw_text       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_rev_ts   ON analyst_revisions(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_vrt2_rev_date ON analyst_revisions(et_date);

  -- Options flow aggregated (H-OPT Phase 1 convergence tracking)
  CREATE TABLE IF NOT EXISTS options_flow (
    flow_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    et_date      TEXT NOT NULL,
    source       TEXT NOT NULL,
    unusual_flag INTEGER DEFAULT 0,
    call_put_ratio REAL,
    score        INTEGER DEFAULT 0,
    notes        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_flow_ts ON options_flow(ts DESC);

  -- Signal overrides (human pin / signal_audit auto-kills)
  CREATE TABLE IF NOT EXISTS signal_overrides (
    override_id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    hyp_id      TEXT NOT NULL,
    from_tier   TEXT,
    to_tier     TEXT,
    reason      TEXT,
    expires_at  INTEGER,
    set_by      TEXT DEFAULT 'signal_audit'
  );
  CREATE INDEX IF NOT EXISTS idx_vrt2_override_hyp ON signal_overrides(hyp_id);
`);

console.log('VRT2 schema created at', DB_PATH);

// ── VRT2 TICKER UNIVERSE (29 tickers per v2 spec) ────────────────────────────
const TICKERS = [
  // Target
  'VRT',
  // Competitors — CRITICAL
  'ETN', 'NVT',
  // Supply chain
  'NVDA',
  // Competitors — MEDIUM
  'MOD', 'CARR', 'JCI',
  // Buyers — CRITICAL
  'MSFT', 'AMZN', 'META',
  // Buyers — HIGH
  'GOOGL', 'ORCL', 'CRWV',
  // Power infra
  'CEG', 'TLN', 'VST',
  // Copper proxy
  'FCX',
  // DC REITs
  'EQIX', 'DLR',
  // Foundry
  'TSM',
  // Macro benchmarks
  'SPY', 'XLI', 'SMH', 'HYG',
];

// Tier 1 — polled every cycle
const TIER1 = ['VRT', 'ETN', 'NVDA', 'MSFT', 'AMZN', 'META', 'FCX', 'XLI', 'SPY'];

console.log('\nVRT2 ticker universe:', TICKERS.length, 'tickers');
console.log('Tier 1 (every cycle):', TIER1.join(', '));
console.log('Backfill window: 2022-01-01 → present\n');

// ── YAHOO FINANCE HISTORICAL FETCHER ─────────────────────────────────────────
function fetchHistory(ticker, cb) {
  var period1 = Math.floor(new Date('2022-01-01').getTime() / 1000);
  var period2 = Math.floor(Date.now() / 1000);
  var encoded = encodeURIComponent(ticker);
  var urlPath  = '/v8/finance/chart/' + encoded +
    '?interval=1d&period1=' + period1 + '&period2=' + period2 + '&events=history';

  var options = {
    hostname: 'query1.finance.yahoo.com',
    path: urlPath,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
    }
  };

  var body = '';
  var req = https.request(options, function(res) {
    res.on('data', function(d) { body += d; });
    res.on('end', function() {
      try {
        var data   = JSON.parse(body);
        var result = data.chart && data.chart.result && data.chart.result[0];
        if (!result) { cb(null, []); return; }

        var timestamps = result.timestamp || [];
        var quotes     = result.indicators.quote[0];
        var rows = [];

        for (var i = 0; i < timestamps.length; i++) {
          var close = quotes.close && quotes.close[i];
          if (!close) continue;
          var prev = i > 0 ? quotes.close[i-1] : close;
          rows.push({
            ts:     timestamps[i] * 1000,
            ticker: ticker,
            price:  Math.round(close * 10000) / 10000,
            open:   quotes.open   && quotes.open[i]   ? Math.round(quotes.open[i]   * 10000) / 10000 : null,
            high:   quotes.high   && quotes.high[i]   ? Math.round(quotes.high[i]   * 10000) / 10000 : null,
            low:    quotes.low    && quotes.low[i]    ? Math.round(quotes.low[i]    * 10000) / 10000 : null,
            volume: quotes.volume && quotes.volume[i] ? quotes.volume[i] : null,
            pct:    prev ? Math.round((close - prev) / prev * 10000) / 100 : 0,
            source: 'yahoo_historical'
          });
        }
        cb(null, rows);
      } catch(e) {
        cb(e, []);
      }
    });
  });
  req.on('error', cb);
  req.setTimeout(20000, function() { req.destroy(); });
  req.end();
}

// ── INSERT HELPERS ────────────────────────────────────────────────────────────
var insertRow = db.prepare(
  'INSERT OR IGNORE INTO prices (ts, ticker, price, open, high, low, volume, pct, source) ' +
  'VALUES (@ts, @ticker, @price, @open, @high, @low, @volume, @pct, @source)'
);
var insertMany = db.transaction(function(rows) {
  for (var i = 0; i < rows.length; i++) insertRow.run(rows[i]);
});

// ── INITIALIZE RISK STATE ─────────────────────────────────────────────────────
var initRiskState = db.prepare(
  "INSERT OR IGNORE INTO risk_state (state_key, state_value, updated_at) VALUES (?, ?, ?)"
);
var now = Date.now();
[
  ['consecutive_losers',    '0'],
  ['peak_book_value',       '0'],
  ['current_drawdown_pct',  '0'],
  ['kill_switch_active',    '0'],
  ['half_size_active',      '0'],
  ['halt_trading_active',   '0'],
].forEach(function(row) {
  initRiskState.run(row[0], row[1], now);
});
console.log('Risk state initialized.\n');

// ── BACKFILL LOOP ─────────────────────────────────────────────────────────────
var idx = 0;
var totalRows = 0;
var failed = [];

function next() {
  if (idx >= TICKERS.length) {
    // Summary
    var count  = db.prepare('SELECT COUNT(*) as n FROM prices').get();
    var tickers = db.prepare(
      'SELECT ticker, COUNT(*) as n FROM prices GROUP BY ticker ORDER BY ticker'
    ).all();

    console.log('\nBackfill complete.');
    console.log('Total rows:', count.n);
    if (failed.length > 0) {
      console.log('\nFailed tickers (no data or error):', failed.join(', '));
      console.log('These can be re-run manually or will be picked up by the live server.');
    }
    console.log('\nRows per ticker:');
    tickers.forEach(function(t) {
      console.log('  ' + t.ticker.padEnd(8) + t.n);
    });
    console.log('\nDatabase ready at:', DB_PATH);
    console.log('\nNext steps:');
    console.log('  1. python3 migrate_vrt_from_v1.py   # import vrt.db price history');
    console.log('  2. node migrate_v3_1_vrt2.js         # seed signal_weights');
    console.log('  3. node migrate_v3_2_vrt2.js         # verify harness quality columns');
    console.log('  4. python3 backtest_harness_vrt2.py  # H-INV backtest (PRIORITY)');
    console.log('  5. node claw_server_vrt2.js          # start server');
    db.close();
    return;
  }

  var ticker = TICKERS[idx++];
  process.stdout.write('  ' + ticker.padEnd(8) + '... ');

  fetchHistory(ticker, function(err, rows) {
    if (err || !rows.length) {
      console.log('FAILED - ' + (err ? err.message : 'no data'));
      failed.push(ticker);
    } else {
      insertMany(rows);
      totalRows += rows.length;
      console.log(rows.length + ' rows');
    }
    setTimeout(next, 600); // 600ms between requests — polite to Yahoo
  });
}

console.log('Starting backfill...');
next();
