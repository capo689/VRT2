#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// jobs/process_browser_results_vrt2.js · CLAW VRT2 · v3.1
//
// Consumer. Reads completed tasks from browser_task_results, dispatches by
// task_type and hypothesis_id to appropriate handlers. Writes structured
// data to news_events, concentration, signal_state, etc. and fires signals
// where appropriate.
//
// Idempotent — uses consumer_processed flag on browser_task_results to
// avoid double-processing. Designed to run every 5 minutes via launchd.
//
// Usage: node jobs/process_browser_results_vrt2.js
// ════════════════════════════════════════════════════════════════════════

const path = require('path');
const Database = require('better-sqlite3');
const { getETDateString } = require('../lib/dates');
const { computeHarnessQuality } = require('../lib/harness_quality');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('CLAW VRT2 — process_browser_results v3.1');
console.log('');

// Fetch unprocessed successful results.
// LIMIT 500 (was 100): each consumer run handles up to 500 results, which at
// 5-minute cadence is 6000 results/hour — well above any realistic rate.
// The watchdog (CHECK 7) alerts if backlog exceeds 200 unprocessed.
const BATCH_LIMIT = 500;
const unprocessed = db.prepare(
  "SELECT * FROM browser_task_results WHERE consumer_processed = 0 ORDER BY result_id ASC LIMIT ?"
).all(BATCH_LIMIT);

console.log('Unprocessed results:', unprocessed.length);

// Also count the total backlog so we can warn if we're not keeping up
const totalBacklog = db.prepare(
  "SELECT COUNT(*) AS n FROM browser_task_results WHERE consumer_processed = 0"
).get().n;
if (totalBacklog > BATCH_LIMIT) {
  console.log('⚠ Backlog: ' + totalBacklog + ' total unprocessed (only handling ' + BATCH_LIMIT + ' this run)');
}

if (unprocessed.length === 0) {
  console.log('Nothing to process');
  db.close();
  process.exit(0);
}

// ── HELPER: insert news_event row ──────────────────────────────────────
// Writes to both legacy columns (headline, category, url NOT NULL)
// and v3.1 extensions (hyp_id, severity, direction, title, summary).
// The migration adds the extensions; this function populates both sides.
function insertNewsEvent(hypId, severity, direction, title, summary, url) {
  try {
    // url is UNIQUE in legacy schema — use a synthetic URL for browser events
    // that don't have one, so duplicates within the same event get deduped
    // by content hash instead of raw URL
    const safeUrl = url && url.length > 0
      ? url
      : ('browser://' + hypId + '/' + Date.now() + '/' + Math.random().toString(36).slice(2, 8));

    const stmt = db.prepare(
      "INSERT OR IGNORE INTO news_events " +
      "(ts, category, headline, url, source, sentiment, hyp_link, notes, " +
      " hyp_id, severity, direction, title, summary) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    stmt.run(
      Date.now(),
      hypId || 'unknown',              // category (NOT NULL) — we reuse hyp_id as the category
      (title || summary || 'browser event').slice(0, 500),  // headline (NOT NULL)
      safeUrl,                          // url (UNIQUE)
      'browser_scan',                   // source
      direction || 'NEUTRAL',           // sentiment
      hypId || null,                    // hyp_link
      summary || null,                  // notes
      // v3.1 extensions
      hypId || null,
      severity || 'med',
      direction || 'NEUTRAL',
      title || null,
      summary || null
    );
    return true;
  } catch (e) {
    console.error('  news_events insert failed for ' + hypId + ': ' + e.message);
    return false;
  }
}

// ── HELPER: insert signal fire ─────────────────────────────────────────
// Writes to the actual signals table schema: trigger_val, trigger_desc,
// vrt_price, active, direction, plus v3.1 extensions (reason, source).
function fireSignalFromBrowser(hypId, value, reason, direction) {
  try {
    db.prepare(
      "INSERT INTO signals " +
      "(ts, hyp_id, trigger_val, trigger_desc, vrt_price, active, direction, " +
      " reason, source, is_backtest) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      Date.now(),
      hypId,
      value || 1,
      (reason || '').slice(0, 1000),   // trigger_desc
      null,                             // vrt_price — not available in browser context
      1,                                // active
      direction || 'NEUTRAL',
      reason || '',                     // reason (v3.1 extension)
      'browser',                        // source (v3.1 extension)
      0                                 // is_backtest
    );
    return true;
  } catch (e) {
    console.error('  signal insert failed for ' + hypId + ': ' + e.message);
    return false;
  }
}

// ── HANDLERS by task_type/hypothesis combination ──────────────────────

function handleScanSearchResult(result, parsed) {
  if (!parsed) return { processed: false, reason: 'no parsed_json' };
  if (!parsed.triggered) {
    return { processed: true, action: 'no trigger', signal_fired: false };
  }
  // Triggered — fire the signal
  const matched = parsed.matched_snippets || [];
  const summary = matched.length > 0 ?
    matched[0].title + ' (' + matched.length + ' keyword matches across ' + parsed.query_count + ' queries)' :
    'Triggered scan_search for ' + result.hypothesis_id;
  insertNewsEvent(result.hypothesis_id, 'med', 'CONTEXT', summary, '', matched[0] ? matched[0].url : '');
  fireSignalFromBrowser(result.hypothesis_id, parsed.keyword_hits, summary, 'CONTEXT');
  return { processed: true, action: 'fired', signal_fired: true };
}

function handleFetchPageResult(result, parsed) {
  if (!parsed) return { processed: false, reason: 'no parsed_json' };

  // Diff against page_versions
  const pageKey = parsed.url ? Buffer.from(parsed.url).toString('base64').slice(0, 60) : 'unknown';
  let isNew = false;
  let isDiff = false;
  try {
    const existing = db.prepare("SELECT * FROM page_versions WHERE page_key = ?").get(pageKey);
    if (!existing) {
      isNew = true;
      db.prepare(
        "INSERT INTO page_versions (page_key, url, last_seen_ts, content_hash, content_summary) " +
        "VALUES (?, ?, ?, ?, ?)"
      ).run(pageKey, parsed.url, Date.now(), parsed.content_hash || '',
            JSON.stringify((parsed.items || []).slice(0, 5)));
    } else if (existing.content_hash !== parsed.content_hash) {
      isDiff = true;
      db.prepare(
        "UPDATE page_versions SET last_seen_ts = ?, content_hash = ?, content_summary = ? WHERE page_key = ?"
      ).run(Date.now(), parsed.content_hash || '',
            JSON.stringify((parsed.items || []).slice(0, 5)), pageKey);
    }
  } catch (e) {
    // page_versions might not exist yet
  }

  if (isNew || isDiff) {
    const action = isNew ? 'first_seen' : 'content_changed';
    const topItem = (parsed.items && parsed.items[0]) || {};
    insertNewsEvent(
      result.hypothesis_id, 'med', 'CONTEXT',
      action + ' on ' + parsed.url,
      'Top item: ' + (topItem.title || '(unknown)'),
      topItem.href || parsed.url
    );
    return { processed: true, action: action, signal_fired: false };
  }

  return { processed: true, action: 'no change', signal_fired: false };
}

function handleFetchFilingResult(result, parsed) {
  // Filing fetch result is consumed by the chained semantic_review task,
  // not directly. We just log that the fetch completed.
  return { processed: true, action: 'awaiting semantic review', signal_fired: false };
}

function handleSemanticReviewResult(result, parsed) {
  if (!parsed) return { processed: false, reason: 'no parsed_json' };

  const hypId = result.hypothesis_id;

  // Concentration review writes to concentration table.
  // v3.1: The schema extension added top1_pct, top3_combined_pct, etc.
  // The legacy UNIQUE(period_end, customer_id) constraint still exists,
  // so we use customer_id='SUMMARY' for the rollup row (doesn't collide
  // with legacy per-customer rows if the old parser ever ran).
  if (hypId === 'H1' || hypId === 'H1_div') {
    if (parsed.period_end && parsed.customers && parsed.customers.length > 0) {
      try {
        const filingDate = parsed.filing_date || parsed.period_end;
        const accession = parsed.filing_accession || ('browser_' + result.task_id);

        // Write the SUMMARY row (one per filing)
        db.prepare(
          "INSERT OR REPLACE INTO concentration " +
          "(filing_date, period_end, customer_id, pct_revenue, raw_context, source_url, " +
          " filing_accession, top1_pct, top3_combined_pct, customer_count, raw_quote, ts) " +
          "VALUES (?, ?, 'SUMMARY', ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          filingDate,
          parsed.period_end,
          parsed.top_1_pct || 0,           // pct_revenue on the summary row = top1
          parsed.raw_quote || '',           // raw_context (legacy)
          parsed.source_url || null,
          accession,
          parsed.top_1_pct || 0,
          parsed.top_3_combined_pct || 0,
          parsed.customers.length,
          parsed.raw_quote || '',
          Date.now()
        );

        // Also write individual customer rows for per-customer tracking
        parsed.customers.forEach(function(c) {
          if (!c.label || c.pct_revenue == null) return;
          try {
            db.prepare(
              "INSERT OR REPLACE INTO concentration " +
              "(filing_date, period_end, customer_id, pct_revenue, raw_context, source_url, filing_accession, ts) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            ).run(
              filingDate,
              parsed.period_end,
              c.label,
              c.pct_revenue,
              parsed.raw_quote || '',
              parsed.source_url || null,
              accession,
              Date.now()
            );
          } catch (e) {}
        });

        console.log('  concentration written for ' + parsed.period_end +
                    ' (top1=' + (parsed.top_1_pct || 0) + '%, top3=' + (parsed.top_3_combined_pct || 0) + '%)');
      } catch (e) {
        console.error('  concentration insert failed: ' + e.message);
      }
    }
    return { processed: true, action: 'concentration written', signal_fired: false };
  }

  // H2/H4/H22/H23/H27 - keyword/event detection style reviews
  if (parsed.triggered === true || parsed.severity === 'high') {
    const events = parsed.events || [];
    events.slice(0, 5).forEach(function(ev) {
      insertNewsEvent(
        hypId,
        parsed.severity || 'med',
        ev.direction || (parsed.direction || 'CONTEXT'),
        ev.title || ev.summary || 'Review-triggered event',
        ev.summary || ev.why_relevant || '',
        ev.url || ''
      );
    });
    fireSignalFromBrowser(
      hypId,
      events.length || 1,
      'Semantic review triggered (' + (parsed.severity || 'med') + ')',
      parsed.direction || 'CONTEXT'
    );
    return { processed: true, action: 'fired with ' + events.length + ' events', signal_fired: true };
  }

  // H5_alab/H5_mrvl - peer context review
  if (hypId === 'H-CORR' || hypId === 'S_ETN_LEAD') {
    if (parsed.classification && parsed.direction_for_crdo && parsed.direction_for_crdo !== 'NEUTRAL') {
      fireSignalFromBrowser(
        hypId,
        1,
        parsed.classification + ': ' + (parsed.key_evidence || ''),
        parsed.direction_for_crdo
      );
      return { processed: true, action: 'fired ' + parsed.direction_for_crdo, signal_fired: true };
    }
    return { processed: true, action: 'classified neutral', signal_fired: false };
  }

  // Generic review with direction
  if (parsed.direction && parsed.direction !== 'NEUTRAL') {
    fireSignalFromBrowser(hypId, 1, parsed.summary || '', parsed.direction);
    return { processed: true, action: 'fired generic', signal_fired: true };
  }

  return { processed: true, action: 'review complete, no signal', signal_fired: false };
}

function handleDailySynthesisResult(result, parsed) {
  // Daily brief result writes to daily_briefs table.
  // v3.1 fix: the runner stores the full markdown brief in raw_output when
  // the task_type is daily_synthesis (no truncation). Parsed JSON is null
  // in this flow because the prompt asks for raw markdown, not JSON.
  // v3.1.1 fix #A5: ET date, not UTC. Fallback only triggers when neither the
  // task payload nor the parsed JSON contains a date — should be rare but the
  // fallback should still pick the right operational day.
  // v3.2.0 #F1: harness_quality injected by queue_daily_review into the synthesis
  // task payload. If missing (kickoff-triggered), compute it now from browser_tasks.
  const briefDate = (parsed && parsed.date) || getETDateString();

  // Resolve harness quality — prefer injected value (computed pre-queue), fall back to now.
  let hq = (parsed && parsed.harness_quality) || null;
  if (!hq || !hq.quality) {
    hq = computeHarnessQuality(db, briefDate);
    console.log('  harness quality computed at consume time:', hq.quality,
      '(' + hq.completed + ' completed, ' + hq.failed + ' failed)');
  } else {
    console.log('  harness quality (from payload):', hq.quality,
      '(' + hq.completed + ' completed, ' + hq.failed + ' failed)');
  }

  // Build brief markdown — prepend quality warning banner when not FULL.
  let briefMd = result.raw_output
    || (parsed && parsed.brief_md)
    || '(empty brief)';

  if (hq.quality === 'DEGRADED') {
    briefMd = '> ⚠️ **DATA QUALITY: DEGRADED** — ' + hq.uptime_pct + '% harness uptime on ' + briefDate +
      ' (' + hq.completed + ' completed, ' + hq.failed + ' failed).\n' +
      '> Signals may be incomplete. **This day is excluded from hit rate calculations.**\n\n' +
      briefMd;
  } else if (hq.quality === 'INCOMPLETE') {
    briefMd = '> 🔴 **DATA QUALITY: INCOMPLETE** — ' + hq.uptime_pct + '% harness uptime on ' + briefDate +
      ' (' + hq.completed + ' completed, ' + hq.failed + ' failed).\n' +
      '> Brief is built on severely degraded data. Do not use for trading decisions.\n' +
      '> **This day is excluded from hit rate calculations.**\n\n' +
      briefMd;
  } else if (hq.quality === 'UNKNOWN') {
    briefMd = '> ℹ️ **DATA QUALITY: UNKNOWN** — No browser task records found for ' + briefDate + '.\n' +
      '> The harness may not have been running. Brief content may reflect stale findings.\n\n' +
      briefMd;
  }
  // FULL: no banner, brief renders clean.

  try {
    db.prepare(
      "INSERT OR REPLACE INTO daily_briefs " +
      "(brief_date, generated_ts, brief_md, signals_fired, signals_suppressed, generation_task_id, " +
      " data_quality, tasks_completed, tasks_failed, tasks_total, harness_uptime_pct) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      briefDate, Date.now(), briefMd,
      (parsed && parsed.signals_fired) || 0,
      (parsed && parsed.signals_suppressed) || 0,
      result.task_id,
      hq.quality,
      hq.completed,
      hq.failed,
      hq.total,
      hq.uptime_pct
    );
    console.log('  daily brief saved for ' + briefDate +
      ' (' + briefMd.length + ' chars, quality=' + hq.quality + ')');
  } catch (e) {
    console.error('  brief insert failed: ' + e.message);
  }
  return { processed: true, action: 'brief saved', signal_fired: false };
}

// ── DISPATCHER ─────────────────────────────────────────────────────────
const DISPATCH = {
  'scan_search': handleScanSearchResult,
  'fetch_page': handleFetchPageResult,
  'fetch_filing': handleFetchFilingResult,
  'fetch_transcript': handleFetchPageResult,
  'semantic_review': handleSemanticReviewResult,
  'daily_synthesis': handleDailySynthesisResult
};

let processed = 0;
let failed = 0;
let signalsFired = 0;

unprocessed.forEach(function(result) {
  if (result.status !== 'SUCCESS') {
    // Mark failed results as processed too — they don't produce signals
    db.prepare("UPDATE browser_task_results SET consumer_processed = 1 WHERE result_id = ?").run(result.result_id);
    console.log('  · result ' + result.result_id + ' (' + result.task_type + ') status=' + result.status + ' — skipping');
    failed++;
    return;
  }

  let parsed = null;
  try {
    parsed = result.parsed_json ? JSON.parse(result.parsed_json) : null;
  } catch (e) {
    console.log('  · result ' + result.result_id + ' parsed_json invalid — skipping');
    db.prepare("UPDATE browser_task_results SET consumer_processed = 1 WHERE result_id = ?").run(result.result_id);
    failed++;
    return;
  }

  const handler = DISPATCH[result.task_type];
  if (!handler) {
    console.log('  · result ' + result.result_id + ' unknown task_type=' + result.task_type);
    db.prepare("UPDATE browser_task_results SET consumer_processed = 1 WHERE result_id = ?").run(result.result_id);
    failed++;
    return;
  }

  try {
    const out = handler(result, parsed);
    if (out.signal_fired) signalsFired++;
    db.prepare("UPDATE browser_task_results SET consumer_processed = 1 WHERE result_id = ?").run(result.result_id);
    console.log('  ✓ ' + result.task_type + '/' + (result.hypothesis_id || '-') + ': ' + out.action);
    processed++;
  } catch (e) {
    console.error('  ✗ result ' + result.result_id + ' handler error: ' + e.message);
    failed++;
  }
});

console.log('');
console.log('Processed: ' + processed + ', failed: ' + failed + ', signals fired: ' + signalsFired);
db.close();
