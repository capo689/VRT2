// CLAW VRT2 — SEC Form 4 Insider Transaction Tracker
// Supports H16: insider selling >$5M in rolling 30 days → underperform signal
//
// Run: node jobs/insider_vrt2.js
// Scheduled: 0 7 * * * (daily 7am — Form 4 filings post within 2 business days)
//
// Data source: SEC EDGAR Atom feed for CRDO CIK 0001807794
// Also uses companyconcept API for structured ownership changes where possible

const https    = require('https');
const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db      = new Database(DB_PATH);

const CIK        = '0001807794';
const CIK_PADDED = CIK.padStart(10, '0');
const USER_AGENT = 'CLAW VRT2 Research adam@agency689.com';

// ── HTTP HELPER ───────────────────────────────────────────────────────────
function secGet(hostname, pathStr, cb) {
  var options = {
    hostname: hostname,
    path: pathStr,
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/xml, application/xml, text/html',
      'Host': hostname
    }
  };
  var body = '';
  var req = https.request(options, function(res) {
    res.on('data', function(d) { body += d; });
    res.on('end', function() {
      if (res.statusCode !== 200) {
        cb(new Error('HTTP ' + res.statusCode), null);
        return;
      }
      cb(null, body);
    });
  });
  req.on('error', function(e) { cb(e, null); });
  req.setTimeout(20000, function() { req.destroy(new Error('timeout')); });
  req.end();
}

// ── FORM 4 ATOM FEED ──────────────────────────────────────────────────────
// EDGAR browse atom feed for Form 4 filings by CIK
function fetchForm4Feed(callback) {
  var urlPath = '/cgi-bin/browse-edgar?action=getcompany&CIK=' + CIK_PADDED +
                '&type=4&dateb=&owner=only&count=40&output=atom';
  secGet('www.sec.gov', urlPath, function(err, body) {
    if (err) return callback(err, null);
    // Parse atom feed entries
    var entries = [];
    var entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
    var entryMatch;
    while ((entryMatch = entryPattern.exec(body)) !== null) {
      var entryXml = entryMatch[1];
      var accession = (entryXml.match(/<accession-number>([^<]+)<\/accession-number>/) || [])[1];
      var filingDate = (entryXml.match(/<filing-date>([^<]+)<\/filing-date>/) || [])[1];
      var filingHref = (entryXml.match(/<filing-href>([^<]+)<\/filing-href>/) || [])[1];
      var title = (entryXml.match(/<title>([^<]+)<\/title>/) || [])[1];
      if (accession && filingDate) {
        entries.push({
          accession:   accession,
          filing_date: filingDate,
          filing_href: filingHref,
          title:       title
        });
      }
    }
    callback(null, entries);
  });
}

// ── FETCH INDIVIDUAL FORM 4 XML ───────────────────────────────────────────
// Each Form 4 filing has multiple XML files in its index page. We need the
// PRIMARY Form 4 XML — not the MetaLinks, not the stylesheet wrapper, not
// any rendered XSL output. SEC has used several naming patterns over time:
//   - primary_doc.xml                    (newer filings)
//   - wf-form4_NNNNNNNNNN.xml            (older filings)
//   - form4_NNNNNNNNNN.xml
//   - edgardoc.xml
// Strategy: collect all .xml hrefs from the index, score them, pick best.
function fetchForm4Xml(accession, callback) {
  var cleanAcc = accession.replace(/-/g, '');
  var indexPath = '/Archives/edgar/data/' + parseInt(CIK, 10) + '/' + cleanAcc + '/' + accession + '-index.htm';

  secGet('www.sec.gov', indexPath, function(err, html) {
    if (err) return callback(err, null);

    // Collect ALL .xml hrefs from the index page
    var xmlCandidates = [];
    var xmlPattern = /href="([^"]+\.xml)"/gi;
    var m;
    while ((m = xmlPattern.exec(html)) !== null) {
      xmlCandidates.push(m[1]);
    }
    if (xmlCandidates.length === 0) {
      return callback(new Error('no XML found in index'), null);
    }

    // Score each candidate — higher score = more likely to be the real Form 4
    function scoreXml(href) {
      var lower = href.toLowerCase();
      // Skip metadata files entirely
      if (lower.indexOf('metalinks') !== -1) return -100;
      if (lower.indexOf('financialreport') !== -1) return -100;
      if (lower.indexOf('xslf') !== -1) return -50;  // XSL stylesheet renders
      if (lower.indexOf('/xsl') !== -1) return -50;
      // Strong positive matches
      if (lower.indexOf('primary_doc.xml') !== -1) return 100;
      if (/wf-form4|wk-form4/.test(lower)) return 90;
      if (/form4.*\.xml/.test(lower)) return 80;
      if (lower.indexOf('edgardoc') !== -1) return 70;
      // Generic .xml file in the filing dir — might be it
      return 10;
    }

    xmlCandidates.sort(function(a, b) { return scoreXml(b) - scoreXml(a); });
    var best = xmlCandidates[0];

    // Normalize relative path → absolute
    if (best.indexOf('/Archives/') !== 0) {
      // strip any leading ./ or path prefix
      var fileName = best.split('/').pop();
      best = '/Archives/edgar/data/' + parseInt(CIK, 10) + '/' + cleanAcc + '/' + fileName;
    }
    secGet('www.sec.gov', best, callback);
  });
}

// ── FORM 4 XML PARSER (rewritten v3.1) ───────────────────────────────────
// Real CRDO Form 4 XML structure (verified via debug_form4.js):
//
//   <ownershipDocument>
//     <reportingOwner>
//       <reportingOwnerId>
//         <rptOwnerName>Cheng Chi Fung</rptOwnerName>          ← DIRECT TEXT
//       </reportingOwnerId>
//       <reportingOwnerRelationship>
//         <isDirector>1</isDirector>
//         <isOfficer>1</isOfficer>
//         <officerTitle>Chief Technology Officer</officerTitle> ← DIRECT TEXT
//       </reportingOwnerRelationship>
//     </reportingOwner>
//     <nonDerivativeTable>
//       <nonDerivativeTransaction>
//         <securityTitle><value>Ordinary Shares</value></securityTitle>
//         <transactionDate><value>2026-04-05</value></transactionDate>
//         <transactionCoding>
//           <transactionCode>F</transactionCode>                ← DIRECT TEXT inside coding block
//         </transactionCoding>
//         <transactionAmounts>
//           <transactionShares><value>2434</value></transactionShares>
//           <transactionPricePerShare><value>101.45</value></transactionPricePerShare>
//         </transactionAmounts>
//         <postTransactionAmounts>
//           <sharesOwnedFollowingTransaction><value>108786</value></sharesOwnedFollowingTransaction>
//         </postTransactionAmounts>
//       </nonDerivativeTransaction>
//     </nonDerivativeTable>
//   </ownershipDocument>
//
// Some fields are DIRECT TEXT, others are VALUE-WRAPPED. We must use the
// right pattern for each field — mixing them caused v3.0 to grab wrong data.
//
// Transaction codes of interest:
//   S = Open market sale (counted toward H16)
//   P = Open market purchase
//   M = Exercise of options
//   A = Grant/award
//   F = Tax-withholding disposition (NOT a real sale, excluded from H16)
//   D = Disposition to issuer
//   G = Gift

// Extract direct text from a tag inside an optional scope.
// Returns null if not found. Anchors to first occurrence in the scope only.
function extractDirect(scope, tagName) {
  var rx = new RegExp('<' + tagName + '>([^<]*)</' + tagName + '>');
  var m = scope.match(rx);
  return m ? m[1].trim() : null;
}

// Extract value-wrapped text: <tagName>...<value>X</value>...</tagName>
// The <value> may have sibling elements (e.g. <footnoteId/>) between it and
// the closing parent tag. We just need to make sure the <value> is INSIDE
// the parent — so first locate the parent block, then pull <value> from it.
function extractValueWrapped(scope, tagName) {
  var blockRx = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)</' + tagName + '>');
  var blockMatch = scope.match(blockRx);
  if (!blockMatch) return null;
  var inner = blockMatch[1];
  var valMatch = inner.match(/<value>([^<]*)<\/value>/);
  return valMatch ? valMatch[1].trim() : null;
}

// Pull a single named XML element block (with its content) from a scope.
// Returns the inner text of <tagName>...</tagName>, or null.
function extractBlock(scope, tagName) {
  var rx = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)</' + tagName + '>');
  var m = scope.match(rx);
  return m ? m[1] : null;
}

function parseForm4(xml, accession, filingHref) {
  var results = [];
  try {
    // Step 1: scope to <reportingOwner> block, extract name and title from inside.
    // (There can be multiple reportingOwners on a single Form 4 — we use the first.)
    var ownerBlock = extractBlock(xml, 'reportingOwner');
    var insiderName  = ownerBlock ? extractDirect(ownerBlock, 'rptOwnerName') : null;
    var insiderTitle = ownerBlock ? extractDirect(ownerBlock, 'officerTitle')  : null;
    if (!insiderName) insiderName = 'Unknown';
    if (!insiderTitle) {
      // Fall back to relationship flags
      var isDir = ownerBlock && /<isDirector>1<\/isDirector>/.test(ownerBlock);
      var isOff = ownerBlock && /<isOfficer>1<\/isOfficer>/.test(ownerBlock);
      if (isDir) insiderTitle = 'Director';
      else if (isOff) insiderTitle = 'Officer';
      else insiderTitle = '';
    }

    // Step 2: walk every <nonDerivativeTransaction> block, parse each in isolation.
    var txPattern = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
    var txMatch;
    while ((txMatch = txPattern.exec(xml)) !== null) {
      var tx = txMatch[1];

      // transactionCode is DIRECT TEXT inside <transactionCoding>.
      // Scope to that sub-block first to avoid matching codes from sibling
      // elements like <transactionFormType> which is right next to it.
      var codingBlock = extractBlock(tx, 'transactionCoding');
      var txCode = codingBlock ? extractDirect(codingBlock, 'transactionCode') : null;

      // v3.1: Extract aff10b5One flag for H16_plan vs H16_discretionary classification.
      // This appears as <transactionTimeliness> sibling or as <aff10b5One>1</aff10b5One>
      // direct text inside the coding block. Check both locations.
      var aff10b5One = 0;
      if (codingBlock && /<aff10b5One>1<\/aff10b5One>/.test(codingBlock)) aff10b5One = 1;
      else if (/<aff10b5One>1<\/aff10b5One>/.test(tx)) aff10b5One = 1;

      // transactionDate, transactionShares, transactionPricePerShare are VALUE-WRAPPED.
      var txDate     = extractValueWrapped(tx, 'transactionDate');
      var shares     = extractValueWrapped(tx, 'transactionShares');
      var price      = extractValueWrapped(tx, 'transactionPricePerShare');
      var ownedAfter = extractValueWrapped(tx, 'sharesOwnedFollowingTransaction');

      if (!txDate || !txCode) continue;

      var sharesNum = parseFloat(shares) || 0;
      var priceNum  = parseFloat(price)  || 0;
      var totalValue = Math.round(sharesNum * priceNum * 100) / 100;

      // v3.1: Tag the transaction variant for H16 routing
      // S + aff10b5One=1  → H16_plan (programmatic, no signal)
      // S + aff10b5One=0  → H16_discretionary (real bear signal)
      // F                 → H16_tax (RSU vesting, no signal)
      // P                 → H26 (open market PURCHASE — strong bull)
      var h16Variant = null;
      if (txCode === 'P') h16Variant = 'H26_buy';
      else if (txCode === 'F') h16Variant = 'H16_tax';
      else if (txCode === 'S' && aff10b5One === 1) h16Variant = 'H16_plan';
      else if (txCode === 'S' && aff10b5One === 0) h16Variant = 'H16_discretionary';

      results.push({
        transaction_date:   txDate,
        insider_name:       insiderName,
        insider_title:      insiderTitle,
        transaction_code:   txCode,
        shares:             sharesNum,
        price_per_share:    priceNum,
        total_value:        totalValue,
        shares_owned_after: parseFloat(ownedAfter) || null,
        accession_number:   accession,
        source_url:         filingHref,
        aff10b5_one:        aff10b5One,
        h16_variant:        h16Variant
      });
    }
  } catch(e) { console.error('parseForm4 error:', e.message); }
  return results;
}

// ── DB WRITER ─────────────────────────────────────────────────────────────
// v3.1: Add aff10b5_one and h16_variant columns if missing
try { db.exec('ALTER TABLE insider_transactions ADD COLUMN aff10b5_one INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE insider_transactions ADD COLUMN h16_variant TEXT'); } catch(e) {}

var insertTx = db.prepare(`
  INSERT OR IGNORE INTO insider_transactions
  (filing_date, transaction_date, insider_name, insider_title, transaction_code,
   shares, price_per_share, total_value, shares_owned_after, accession_number, source_url,
   aff10b5_one, h16_variant)
  VALUES
  (@filing_date, @transaction_date, @insider_name, @insider_title, @transaction_code,
   @shares, @price_per_share, @total_value, @shares_owned_after, @accession_number, @source_url,
   @aff10b5_one, @h16_variant)
`);

// ── ROLLING 30-DAY AGGREGATE — H16 v3.1 VARIANTS ──────────────────────────
// v3.1 split: original H16 conflated three different transaction types.
//   H16_plan          — 10b5-1 plan sales (programmatic, NEUTRAL — no signal)
//   H16_discretionary — Non-plan code='S' sales (>$2M threshold → BEAR)
//   H16_tax           — code='F' RSU tax withholding (recorded only, no signal)
//   H26               — code='P' open market purchase (STRONG BULL, any amount)
function check30DayWindow() {
  console.log('\n── v3.1 Insider Activity (rolling 30 days) ──');

  // H16_discretionary — the bear signal
  var discretionary = db.prepare(`
    SELECT SUM(total_value) as total, COUNT(*) as n
    FROM insider_transactions
    WHERE h16_variant = 'H16_discretionary'
      AND date(transaction_date) >= date('now', '-30 days')
  `).get();

  var disTotal = discretionary.total || 0;
  var disCount = discretionary.n || 0;
  console.log('  H16_discretionary: $' + (disTotal / 1e6).toFixed(2) + 'M across ' + disCount + ' txns');
  var h16dis_triggered = disTotal >= 2000000;
  if (h16dis_triggered) {
    console.log('  *** H16_discretionary FIRED: non-plan sales >$2M in 30d ***');
  }

  // H16_plan — recorded only
  var plan = db.prepare(`
    SELECT SUM(total_value) as total, COUNT(*) as n
    FROM insider_transactions
    WHERE h16_variant = 'H16_plan'
      AND date(transaction_date) >= date('now', '-30 days')
  `).get();
  console.log('  H16_plan (recorded): $' + ((plan.total || 0) / 1e6).toFixed(2) + 'M across ' + (plan.n || 0) + ' txns');

  // H16_tax — recorded only
  var tax = db.prepare(`
    SELECT SUM(total_value) as total, COUNT(*) as n
    FROM insider_transactions
    WHERE h16_variant = 'H16_tax'
      AND date(transaction_date) >= date('now', '-30 days')
  `).get();
  console.log('  H16_tax (recorded): $' + ((tax.total || 0) / 1e6).toFixed(2) + 'M across ' + (tax.n || 0) + ' txns');

  // H26 — STRONG BULL — any open-market purchase fires
  var purchases = db.prepare(`
    SELECT SUM(total_value) as total, COUNT(*) as n,
           MAX(transaction_date) as latest_date,
           GROUP_CONCAT(insider_name, '; ') as names
    FROM insider_transactions
    WHERE h16_variant = 'H26_buy'
      AND date(transaction_date) >= date('now', '-30 days')
  `).get();

  var h26_triggered = (purchases.n || 0) > 0;
  if (h26_triggered) {
    console.log('  *** H26 FIRED — INSIDER PURCHASE: $' + ((purchases.total || 0) / 1e6).toFixed(2) +
                'M across ' + purchases.n + ' txns by ' + (purchases.names || 'unknown') + ' ***');
  } else {
    console.log('  H26 (insider buys): none in last 30 days');
  }

  return {
    H16_discretionary: { triggered: h16dis_triggered, total: disTotal, count: disCount },
    H16_plan:          { triggered: false, total: plan.total || 0, count: plan.n || 0 },
    H16_tax:           { triggered: false, total: tax.total || 0, count: tax.n || 0 },
    H26:               { triggered: h26_triggered, total: purchases.total || 0, count: purchases.n || 0 }
  };
}

// ── MAIN JOB ──────────────────────────────────────────────────────────────
function main() {
  console.log('CLAW VRT2 — Insider transaction job starting');
  console.log('CIK:', CIK);

  fetchForm4Feed(function(err, entries) {
    if (err) {
      console.error('Form 4 feed fetch failed:', err.message);
      db.close();
      return;
    }
    console.log('Found', entries.length, 'Form 4 filings in feed');

    if (entries.length === 0) {
      check30DayWindow();
      db.close();
      return;
    }

    // Process each filing (with polite 1-second spacing)
    var idx = 0;
    var totalTxInserted = 0;

    function processNext() {
      if (idx >= entries.length) {
        console.log('\nProcessed', entries.length, 'filings,', totalTxInserted, 'transactions inserted');

        var recent = db.prepare(`
          SELECT transaction_date, insider_name, insider_title, transaction_code,
                 shares, price_per_share, total_value
          FROM insider_transactions
          ORDER BY transaction_date DESC LIMIT 10
        `).all();
        if (recent.length > 0) {
          console.log('\nMost recent insider transactions:');
          recent.forEach(function(r) {
            var valStr = '$' + (r.total_value / 1e6).toFixed(2) + 'M';
            console.log('  ' + r.transaction_date + '  ' + r.transaction_code + '  ' +
                        (r.insider_name || 'Unknown').substring(0, 25).padEnd(27) +
                        r.shares.toString().padStart(10) + ' @ $' +
                        (r.price_per_share || 0).toFixed(2).padStart(7) + '  ' + valStr);
          });
        }

        check30DayWindow();
        db.close();
        return;
      }

      var entry = entries[idx++];
      process.stdout.write('  ' + entry.filing_date + ' ... ');

      fetchForm4Xml(entry.accession, function(err, xml) {
        if (err) {
          console.log('FAILED - ' + err.message);
          setTimeout(processNext, 1000);
          return;
        }
        var txs = parseForm4(xml, entry.accession, entry.filing_href);
        txs.forEach(function(t) {
          t.filing_date = entry.filing_date;
          try {
            var result = insertTx.run(t);
            if (result.changes > 0) totalTxInserted++;
          } catch(e) {
            console.error('  ⚠ insertTx failed [' + entry.accession + ']: ' + e.message);
          }
        });
        console.log(txs.length + ' transactions');
        setTimeout(processNext, 1000); // 1s between filings
      });
    }
    processNext();
  });
}

main();
