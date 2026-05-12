#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// jobs/queue_scan_tasks_vrt2.js · CLAW VRT2 · v3.1
//
// Producer. Reads the playbook and queues mechanical scan tasks for narrative
// hypotheses. Designed to run on launchd every 4 hours during market hours
// and every 6 hours after-hours.
//
// Idempotent — checks for existing pending tasks per hypothesis per day before
// inserting, so re-running it doesn't duplicate work.
//
// Usage: node jobs/queue_scan_tasks_vrt2.js
// ════════════════════════════════════════════════════════════════════════

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── PLAYBOOK ────────────────────────────────────────────────────────────
// Each entry defines a scan_search task. The browser daemon picks these up
// and runs the search, then writes findings markdown for the daily review.

const SCAN_PLAYBOOK = [
  {
    hypothesis_id: 'H2',
    cadence_hours: 6,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'AWS Trainium connectivity 2026',
        'Microsoft Azure Maia interconnect',
        'Amazon AEC in-house networking',
        'Google TPU networking silicon',
        'hyperscaler internal connectivity chip 2026'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 8
      },
      trigger_keywords: ['in-house', 'trainium', 'internal', 'develops own', 'acquires connectivity', 'custom asic'],
      trigger_threshold: 2
    }
  },
  {
    hypothesis_id: 'H12',
    cadence_hours: 12,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'LPO 1.6T deployment hyperscaler',
        'linear pluggable optics 2026',
        'LPO commitment data center'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 8
      },
      trigger_keywords: ['lpo', 'linear pluggable', '1.6t deployment', 'production'],
      trigger_threshold: 2
    }
  },
  {
    hypothesis_id: 'H13',
    cadence_hours: 24,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'co-packaged optics general availability 2026',
        'CPO production NVDA AVGO',
        'co-packaged optics deployment'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 8
      },
      trigger_keywords: ['co-packaged', 'cpo', 'general availability', 'production'],
      trigger_threshold: 2
    }
  },
  {
    hypothesis_id: 'H22',
    cadence_hours: 12,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'AI efficiency breakthrough paper 2026',
        'model efficiency new architecture',
        'DeepSeek successor efficiency'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 6
      },
      trigger_keywords: ['breakthrough', 'efficiency', 'orders of magnitude', 'new architecture'],
      trigger_threshold: 1
    }
  },
  {
    hypothesis_id: 'H23',
    cadence_hours: 6,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'AWS connectivity announcement 2026',
        'Amazon AWS Trainium 2026',
        'AWS region expansion 2026',
        're:Invent connectivity infrastructure'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 8
      },
      trigger_keywords: ['aws', 'amazon', 'trainium', 're:invent', 'region'],
      trigger_threshold: 3
    }
  },
  {
    hypothesis_id: 'H27',
    cadence_hours: 24,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'TSMC advanced node capacity 2026',
        'TSMC N3 N2 capacity tightness',
        'AVGO foundry commentary advanced node'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 6
      },
      trigger_keywords: ['capacity', 'tightness', 'shortage', 'advanced node', 'lead time'],
      trigger_threshold: 1
    }
  },
  {
    hypothesis_id: 'H9',
    cadence_hours: 24,
    payload: {
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      queries: [
        'AAOI Amazon contract 2026',
        'Applied Optoelectronics AWS commitment',
        'AAOI revenue concentration Amazon'
      ],
      extraction: {
        container_selector: '.result__body',
        title_selector: '.result__title',
        snippet_selector: '.result__snippet',
        max_results_per_query: 6
      },
      trigger_keywords: ['amazon', 'aws', 'commitment', 'million', 'contract'],
      trigger_threshold: 2
    }
  }
];

// ── PRODUCER LOGIC ──────────────────────────────────────────────────────
const insertTask = db.prepare(
  "INSERT INTO browser_tasks (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name) " +
  "VALUES (?, ?, 'PENDING', ?, ?, ?, ?)"
);

const checkExisting = db.prepare(
  "SELECT task_id FROM browser_tasks " +
  "WHERE hypothesis_id = ? " +
  "  AND task_type = 'scan_search' " +
  "  AND status IN ('PENDING','RUNNING') " +
  "  AND created_ts > ? " +
  "LIMIT 1"
);

console.log('CLAW VRT2 — queue_scan_tasks v3.1');
console.log('Database:', DB_PATH);
console.log('');

const now = Date.now();
let queued = 0;
let skipped = 0;

SCAN_PLAYBOOK.forEach(function(item) {
  // Check if a task within the cadence window already exists
  const cadenceMs = item.cadence_hours * 60 * 60 * 1000;
  const existing = checkExisting.get(item.hypothesis_id, now - cadenceMs);

  if (existing) {
    console.log('  · ' + item.hypothesis_id + ' (skip — task ' + existing.task_id + ' active within ' + item.cadence_hours + 'h)');
    skipped++;
    return;
  }

  const result = insertTask.run(
    'scan_search',
    item.hypothesis_id,
    JSON.stringify(item.payload),
    5,
    now,
    'queue_scan_tasks'
  );
  console.log('  + ' + item.hypothesis_id + ' (task ' + result.lastInsertRowid + ', ' + (item.payload.queries || []).length + ' queries)');
  queued++;
});

console.log('');
console.log('Queued: ' + queued + ', skipped: ' + skipped);
db.close();
