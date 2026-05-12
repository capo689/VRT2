// CLAW VRT2 — Rolling Correlation Engine
// Supports H5 (peer sympathy), H6 (ALAB correlation break)
//
// Run: node jobs/correlation_vrt2.js
// Scheduled: 30 16 * * 1-5 (4:30pm ET weekdays, after market close)
//
// Computes rolling 5-day and 20-day Pearson correlations between CRDO and
// each peer/benchmark ticker using daily % changes from the prices table.

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db      = new Database(DB_PATH);

// Tickers to correlate against CRDO (v2 — post-analyst review)
// Priority order: closest trading peers first, then benchmarks, then structural leads
const PEERS = [
  // Trading peers (most important)
  'ALAB',   // closest peer — THE correlation to watch
  'AVGO',
  'MRVL',
  'MTSI',
  'RMBS',   // NEW — SerDes IP competitor
  // AI/semis benchmarks
  'NVDA',
  'SMH',    // TRUE benchmark (not SPY)
  'SOXX',
  'XLK',
  'QQQ',    // NEW — tech risk vs broad market
  // Module maker ecosystem
  'COHR',
  'LITE',
  'FN',
  'AAOI',
  'POET',   // NEW — silicon photonics pure play, LPO/CPO sentiment
  'CIEN',   // moved from old Cohort 5 (coherent DSP overlap)
  // Downstream / demand
  'ANET',
  'SMCI',   // NEW — AI server OEM demand lead (should show high correlation when demand signal is the driver)
  'NBIS',   // NEW — neocloud deployment proxy
  'CRWV',
  // Upstream
  'TSM',
  'AMD',    // NEW — Ultra Ethernet Consortium trajectory
  // Risk regime
  'HYG'     // NEW — credit spread early warning (should be POSITIVELY correlated; break = risk-off)
];

const WINDOWS = [5, 20];

// ── PEARSON CORRELATION ───────────────────────────────────────────────────
function pearson(xs, ys) {
  var n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  var sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (var i = 0; i < n; i++) {
    sx  += xs[i];
    sy  += ys[i];
    sxy += xs[i] * ys[i];
    sx2 += xs[i] * xs[i];
    sy2 += ys[i] * ys[i];
  }
  var num = n * sxy - sx * sy;
  var den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  if (den === 0) return 0;
  return Math.round(num / den * 1000) / 1000;
}

// ── DAILY PCT SERIES ──────────────────────────────────────────────────────
// Returns ordered array of { date, pct } using last price per trading day
function getDailySeries(ticker, days) {
  // Pull last N+5 days of prices, then reduce to one per calendar date
  var since = Date.now() - (days + 10) * 86400000;
  var rows = db.prepare(`
    SELECT ts, pct, price
    FROM prices
    WHERE ticker = ? AND ts > ?
    ORDER BY ts DESC
  `).all(ticker, since);

  var byDate = {};
  rows.forEach(function(r) {
    var d = new Date(r.ts).toISOString().slice(0, 10);
    if (!byDate[d]) byDate[d] = { date: d, pct: r.pct, price: r.price };
  });

  var series = Object.values(byDate).sort(function(a, b) {
    return a.date.localeCompare(b.date);
  });

  return series.slice(-days);
}

// ── ALIGN TWO SERIES BY DATE ──────────────────────────────────────────────
function alignSeries(seriesA, seriesB) {
  var mapB = {};
  seriesB.forEach(function(r) { mapB[r.date] = r.pct; });
  var xs = [], ys = [];
  seriesA.forEach(function(r) {
    if (mapB[r.date] !== undefined) {
      xs.push(r.pct);
      ys.push(mapB[r.date]);
    }
  });
  return { xs: xs, ys: ys };
}

// ── DB WRITER ─────────────────────────────────────────────────────────────
var insertCorr = db.prepare(`
  INSERT OR REPLACE INTO correlations (ts, ticker_a, ticker_b, window_days, corr_value, n_obs)
  VALUES (@ts, @ticker_a, @ticker_b, @window_days, @corr_value, @n_obs)
`);

// ── MAIN JOB ──────────────────────────────────────────────────────────────
function main() {
  console.log('CLAW VRT2 — Rolling correlation engine');
  console.log('Peers:', PEERS.length, '| Windows:', WINDOWS.join('d, ') + 'd');

  var now = Date.now();
  var results = [];
  var crdoLastPrice = null;

  WINDOWS.forEach(function(window) {
    var vrtSeries  = getDailySeries('VRT',  window);
    if (!crdoLastPrice && vrtSeries.length > 0) {
      crdoLastPrice = vrtSeries[vrtSeries.length - 1].price;
    }

    console.log('\n── ' + window + '-day correlations (n='+vrtSeries.length+') ──');

    if (vrtSeries.length < window) {
      console.log('  Insufficient CRDO data — need ' + window + ' sessions, have ' + vrtSeries.length);
      return;
    }

    PEERS.forEach(function(peer) {
      var peerSeries = getDailySeries(peer, window);
      if (peerSeries.length < window) {
        console.log('  ' + peer.padEnd(6) + 'insufficient data (' + peerSeries.length + '/' + window + ')');
        return;
      }
      var aligned = alignSeries(vrtSeries, peerSeries);
      if (aligned.xs.length < 2) {
        console.log('  ' + peer.padEnd(6) + 'no overlap');
        return;
      }
      var corr = pearson(aligned.xs, aligned.ys);
      var marker = '';
      if (peer === 'ALAB' && window === 20) {
        if (corr > 0.65) marker = '  [normal sympathy]';
        else if (corr < 0.40) marker = '  [*** H6 TRIGGER: correlation break ***]';
        else marker = '  [watch]';
      }
      console.log('  ' + peer.padEnd(6) + (corr !== null ? corr.toFixed(3) : 'null').padStart(7) +
                  '  n=' + aligned.xs.length + marker);
      insertCorr.run({
        ts:          now,
        ticker_a:    'VRT',
        ticker_b:    peer,
        window_days: window,
        corr_value:  corr,
        n_obs:       aligned.xs.length
      });
      results.push({ peer: peer, window: window, corr: corr });
    });
  });

  // H6 specific check — CRDO/ALAB 20-day correlation
  var alab20 = results.find(function(r) { return r.peer === 'ALAB' && r.window === 20; });
  if (alab20 && alab20.corr !== null) {
    console.log('\n── H6 Status ──');
    console.log('  CRDO/ALAB 20d correlation: ' + alab20.corr.toFixed(3));
    if (alab20.corr < 0.40) {
      console.log('  *** H6 TRIGGERED: correlation below 0.40 ***');
      console.log('  Requires 3 consecutive sessions below threshold before firing signal');

      // Check prior 3 days
      var priorCorrs = db.prepare(`
        SELECT ts, corr_value
        FROM correlations
        WHERE ticker_a='VRT'  AND ticker_b='ETN'  AND window_days=20
        ORDER BY ts DESC LIMIT 3
      `).all();
      var allLow = priorCorrs.length === 3 && priorCorrs.every(function(r) { return r.corr_value < 0.40; });
      if (allLow) {
        console.log('  *** H6 CONFIRMED: 3+ sessions below 0.40 — signal ready to fire ***');
      } else {
        console.log('  Still counting: ' + priorCorrs.filter(function(r) { return r.corr_value < 0.40; }).length + '/3 days');
      }
    } else if (alab20.corr > 0.65) {
      console.log('  Normal peer sympathy regime');
    } else {
      console.log('  Intermediate — watch for further movement');
    }
  }

  db.close();
  console.log('\nCorrelation snapshot complete');
}

main();
