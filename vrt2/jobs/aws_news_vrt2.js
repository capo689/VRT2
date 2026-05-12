#!/usr/bin/env node
// CLAW VRT2 — jobs/aws_news_vrt2.js
//
// Daily AWS news page diff for H-AWS hypothesis.
// AMZN is a top-3 VRT customer — AWS events can directly signal VRT order flow.
//
// Sub-trigger classification (done by semantic review):
//   AWS Trainium/in-house silicon → BEAR
//   AWS region expansion          → BULL
//   AWS + VRT partnership         → STRONG BULL
//   re:Invent power/cooling news  → BULL
//   Generic AWS news              → NEUTRAL
//
// Run via launchd at 06:30 ET daily (after brief, before market open).

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path     = require('path');
const Database = require('better-sqlite3');
const { getETDateString } = require('../lib/dates');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db      = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const now    = Date.now();
const etDate = getETDateString();

console.log('CLAW VRT2 — AWS News (H-AWS)');
console.log('ET Date:', etDate);

// ── Queue browser tasks for AWS monitoring ────────────────────────────────────
const awsTasks = [
  {
    task_type:     'fetch_page',
    hypothesis_id: 'H-AWS',
    priority:      4,
    payload: JSON.stringify({
      url: 'https://aws.amazon.com/new/',
      extraction: {
        container_selector: '.m-card',
        title_selector:     '.m-card-headline',
        date_selector:      '.m-card-date',
        summary_selector:   '.m-card-description',
        max_items:          20,
      },
      compare_against: 'page_versions.aws_whatsnew',
    }),
  },
  {
    task_type:     'scan_search',
    hypothesis_id: 'H-AWS',
    priority:      4,
    payload: JSON.stringify({
      queries: [
        'AWS Trainium connectivity 2026',
        'AWS data center infrastructure announcement',
        'Amazon Web Services Vertiv partnership',
        'AWS region expansion power cooling',
        're:Invent connectivity keynote',
      ],
      url_template: 'https://html.duckduckgo.com/html/?q={query}',
      extraction: {
        container_selector: '.result__body',
        title_selector:     '.result__title',
        snippet_selector:   '.result__snippet',
        max_results_per_query: 5,
      },
      trigger_keywords: ['Trainium', 'in-house', 'Vertiv', 'region', 'cooling', 'power', 'partnership', 'AEC'],
      trigger_threshold: 2,
    }),
  },
];

// Only queue if we haven't queued today
const todayQueued = db.prepare(
  "SELECT COUNT(*) n FROM browser_tasks WHERE hypothesis_id='H-AWS' AND created_ts>=?"
).get(now - 86400000);

if (todayQueued && todayQueued.n >= 2) {
  console.log('H-AWS tasks already queued today — skip');
} else {
  let queued = 0;
  for (const task of awsTasks) {
    try {
      db.prepare(`
        INSERT INTO browser_tasks
        (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name)
        VALUES (?, ?, 'PENDING', ?, ?, ?, 'aws_news_vrt2')
      `).run(task.task_type, task.hypothesis_id, task.payload, task.priority, now);
      queued++;
    } catch(e) {
      console.error('Failed to queue task:', e.message);
    }
  }
  console.log(`Queued ${queued} H-AWS browser tasks`);

  // Queue semantic review to follow (will be picked up after fetch tasks complete)
  // The daily synthesis covers H-AWS — no separate semantic review needed unless
  // the fetch task finds new items. The browser_runner handles this via the
  // findings diff mechanism.
}

// ── Job health ────────────────────────────────────────────────────────────────
try {
  db.prepare(`
    INSERT OR REPLACE INTO job_health (job_name, last_run_ts, last_status, rows_written, duration_ms)
    VALUES ('aws_news_vrt2', ?, 'OK', ?, ?)
  `).run(now, awsTasks.length, Date.now() - now);
} catch(e) {}

db.close();
console.log('Done.');
