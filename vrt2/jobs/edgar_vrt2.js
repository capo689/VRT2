// CLAW VRT2 — SEC EDGAR XBRL parser
// Pulls customer concentration (H1) + inventory/financials (H10) from CRDO 10-Q/10-K filings
//
// Run: node jobs/edgar_vrt2.js
// Or scheduled via cron: 0 6 * * * (every day 6am, filings usually post overnight)
//
// Uses SEC EDGAR Company Facts API (free, no auth needed)
// CRDO CIK: 0001807794

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db      = new Database(DB_PATH);

const CIK          = '0001807794';
const CIK_PADDED   = CIK.padStart(10, '0');
const USER_AGENT   = 'CLAW VRT2 Research adam@agency689.com'; // SEC requires identifiable UA

// ── HTTP HELPER ───────────────────────────────────────────────────────────
function secGet(hostname, pathStr, cb) {
  var options = {
    hostname: hostname,
    path: pathStr,
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Host': hostname
    }
  };
  var body = '';
  var req = https.request(options, function(res) {
    res.on('data', function(d) { body += d; });
    res.on('end', function() {
      try {
        if (res.statusCode !== 200) {
          cb(new Error('HTTP ' + res.statusCode), null);
          return;
        }
        cb(null, JSON.parse(body));
      } catch(e) {
        cb(e, null);
      }
    });
  });
  req.on('error', function(e) { cb(e, null); });
  req.setTimeout(20000, function() { req.destroy(new Error('timeout')); });
  req.end();
}

// ── COMPANY FACTS (financials by tag) ─────────────────────────────────────
// Endpoint: data.sec.gov/api/xbrl/companyfacts/CIK{padded}.json
// Returns all reported XBRL tags with historical values

function fetchCompanyFacts(callback) {
  var urlPath = '/api/xbrl/companyfacts/CIK' + CIK_PADDED + '.json';
  secGet('data.sec.gov', urlPath, callback);
}

// ── INVENTORY PARSER (H10) ────────────────────────────────────────────────
// US GAAP tag: InventoryNet

function parseInventory(facts) {
  var results = [];
  try {
    var inv = facts.facts && facts.facts['us-gaap'] && facts.facts['us-gaap'].InventoryNet;
    if (!inv || !inv.units || !inv.units.USD) return results;
    inv.units.USD.forEach(function(entry) {
      // entry format: { start, end, val, accn, fy, fp, form, filed, frame }
      if (entry.form === '10-Q' || entry.form === '10-K') {
        results.push({
          filing_date: entry.filed,
          period_end:  entry.end,
          metric:      'InventoryNet',
          value:       entry.val,
          unit:        'USD',
          source_url:  buildFilingUrl(entry.accn)
        });
      }
    });
  } catch(e) { console.error('parseInventory error:', e.message); }
  return results;
}

// ── REVENUE + OTHER CORE LINE ITEMS ───────────────────────────────────────
function parseFinancialLine(facts, tag, alias) {
  var results = [];
  try {
    var node = facts.facts && facts.facts['us-gaap'] && facts.facts['us-gaap'][tag];
    if (!node || !node.units || !node.units.USD) return results;
    node.units.USD.forEach(function(entry) {
      if (entry.form === '10-Q' || entry.form === '10-K') {
        results.push({
          filing_date: entry.filed,
          period_end:  entry.end,
          metric:      alias || tag,
          value:       entry.val,
          unit:        'USD',
          source_url:  buildFilingUrl(entry.accn)
        });
      }
    });
  } catch(e) { console.error('parseFinancialLine error for', tag, e.message); }
  return results;
}

// ── FILING URL BUILDER ────────────────────────────────────────────────────
function buildFilingUrl(accession) {
  // accession format: 0001628280-25-054428
  var clean = accession.replace(/-/g, '');
  return 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' + CIK + '&type=10-Q&dateb=&owner=include&count=40';
}

// ── FILINGS INDEX (for customer concentration text parsing) ───────────────
// Concentration is in narrative tables, not a single XBRL tag.
// We pull recent 10-Q/10-K index + hand off to web_search or manual parse.

function fetchRecentFilings(callback) {
  var urlPath = '/submissions/CIK' + CIK_PADDED + '.json';
  secGet('data.sec.gov', urlPath, function(err, data) {
    if (err) return callback(err, null);
    try {
      var recent = data.filings && data.filings.recent;
      if (!recent) return callback(new Error('no recent filings'), null);
      var filings = [];
      for (var i = 0; i < recent.form.length; i++) {
        if (recent.form[i] === '10-Q' || recent.form[i] === '10-K') {
          filings.push({
            form:        recent.form[i],
            filing_date: recent.filingDate[i],
            period_end:  recent.reportDate[i],
            accession:   recent.accessionNumber[i],
            primary_doc: recent.primaryDocument[i]
          });
        }
      }
      callback(null, filings);
    } catch(e) { callback(e, null); }
  });
}

// ── CONCENTRATION RISK EXTRACTOR (H1) ─────────────────────────────────────
// The concentration table lives in filing HTML, not structured XBRL.
// We fetch the primary filing doc, grep for concentration risk context, and
// extract customer percentages via regex patterns matching the recurring
// format observed in CRDO's 10-Qs.

function fetchFilingDoc(accession, primaryDoc, callback) {
  var cleanAcc = accession.replace(/-/g, '');
  var urlPath = '/Archives/edgar/data/' + parseInt(CIK, 10) + '/' + cleanAcc + '/' + primaryDoc;
  var options = {
    hostname: 'www.sec.gov',
    path: urlPath,
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Host': 'www.sec.gov'
    }
  };
  var body = '';
  var req = https.request(options, function(res) {
    res.on('data', function(d) { body += d; });
    res.on('end', function() {
      if (res.statusCode !== 200) {
        callback(new Error('HTTP ' + res.statusCode), null);
        return;
      }
      callback(null, body);
    });
  });
  req.on('error', function(e) { callback(e, null); });
  req.setTimeout(30000, function() { req.destroy(new Error('timeout')); });
  req.end();
}

// ── DB WRITERS ────────────────────────────────────────────────────────────
var insertFinancial = db.prepare(`
  INSERT OR REPLACE INTO financials (filing_date, period_end, metric, value, unit, source_url)
  VALUES (@filing_date, @period_end, @metric, @value, @unit, @source_url)
`);

// NOTE: Concentration data is no longer extracted from raw filing HTML by this
// job. The regex parser was unreliable (success rate ~25%). v3.1 routes
// concentration extraction through the browser harness as fetch_filing +
// semantic_review tasks. See queue_concentration_tasks_crdo.js.

var insertManyFin = db.transaction(function(rows) {
  for (var i = 0; i < rows.length; i++) insertFinancial.run(rows[i]);
});

// ── MAIN JOB ──────────────────────────────────────────────────────────────
function main() {
  console.log('CLAW VRT2 — SEC EDGAR job starting');
  console.log('CIK:', CIK);

  fetchCompanyFacts(function(err, facts) {
    if (err) {
      console.error('companyfacts fetch failed:', err.message);
      return;
    }
    console.log('Company facts fetched —', (facts.entityName || 'Credo'));

    // Pull balance sheet line items we care about
    var allRows = [];
    var lines = [
      ['InventoryNet',                          'InventoryNet'],
      ['Revenues',                              'Revenues'],
      ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenue'],
      ['GrossProfit',                           'GrossProfit'],
      ['CashAndCashEquivalentsAtCarryingValue', 'Cash'],
      ['AccountsReceivableNetCurrent',          'AccountsReceivable'],
      ['OperatingIncomeLoss',                   'OperatingIncome'],
      ['NetIncomeLoss',                         'NetIncome'],
      ['StockholdersEquity',                    'StockholdersEquity'],
      ['LongTermDebt',                          'LongTermDebt']
    ];

    lines.forEach(function(l) {
      var rows = parseFinancialLine(facts, l[0], l[1]);
      allRows = allRows.concat(rows);
    });

    if (allRows.length > 0) {
      insertManyFin(allRows);
      console.log('Wrote', allRows.length, 'financial line items');
    } else {
      console.log('No financial line items parsed');
    }

    // Inventory summary for quick visibility
    var invRows = db.prepare(`
      SELECT period_end, value
      FROM financials
      WHERE metric = 'InventoryNet'
      ORDER BY period_end DESC LIMIT 8
    `).all();
    if (invRows.length > 0) {
      console.log('\nRecent InventoryNet (for H10):');
      invRows.forEach(function(r) {
        console.log('  ' + r.period_end + '  $' + (r.value / 1e6).toFixed(1) + 'M');
      });
    }

    // v3.1: Concentration extraction is now BROWSER-DRIVEN.
    // The regex parser caught only 1/4 recent filings due to phrasing variation.
    // Instead, we record each 10-Q/10-K into the filings table; the
    // queue_concentration_tasks_crdo.js producer picks them up and queues
    // browser fetch_filing + semantic_review tasks that use claude.ai to
    // extract concentration data reliably from any phrasing variant.
    console.log('\nFetching recent filings list (v3.1: queue for browser extraction)...');
    fetchRecentFilings(function(err2, filings) {
      if (err2) {
        console.error('filings fetch failed:', err2.message);
        db.close();
        return;
      }
      console.log('Found', filings.length, '10-Q/10-K filings');

      // Ensure filings table exists for the queue producer to read
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS filings (
            accession TEXT PRIMARY KEY,
            form_type TEXT,
            filing_date TEXT,
            period_end TEXT,
            url TEXT,
            primary_doc TEXT,
            ts INTEGER
          )
        `);
      } catch(e) {}

      var insertFiling = db.prepare(
        "INSERT OR REPLACE INTO filings (accession, form_type, filing_date, period_end, url, primary_doc, ts) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      );

      var recordedCount = 0;
      filings.slice(0, 8).forEach(function(f) {
        try {
          insertFiling.run(
            f.accession, f.form, f.filing_date, f.period_end,
            buildFilingUrl(f.accession),
            f.primary_doc || '',
            Date.now()
          );
          recordedCount++;
        } catch(e) {}
      });
      console.log('Recorded ' + recordedCount + ' filings into filings table');
      console.log('Run: node jobs/queue_concentration_tasks_crdo.js to queue browser extraction');

      db.close();
    });
  });
}

main();
