#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// jobs/queue_news_tasks_vrt2.js · CLAW VRT2 · v3.1
//
// Producer. Queues fetch_page tasks for known IR pages and news sources.
// The browser fetches each, the consumer diffs against page_versions.
// Used for H14 (CRDO product GA), H2 (hyperscaler in-house silicon),
// H4 variants (capex commentary), H15 (lawsuits).
//
// Schedule: every 6 hours via launchd.
// ════════════════════════════════════════════════════════════════════════

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'vrt2.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('CLAW VRT2 — queue_news_tasks v3.1');
console.log('');

const NEWS_SOURCES = [
  // CRDO own news (H14)
  {
    page_key: 'crdo_ir_news',
    hypothesis_id: 'H14',
    cadence_hours: 4,
    payload: {
      url: 'https://investors.credosemi.com/news-events/news',
      page_key: 'crdo_ir_news',
      extraction: {
        container_selector: 'article, .news-item, .views-row, [class*="news"]',
        title_selector: 'h2, h3, .news-title, [class*="title"]',
        date_selector: '.news-date, time, [class*="date"]',
        summary_selector: '.summary, p',
        max_items: 15
      }
    }
  },
  // Hyperscaler news pages (H2, H4)
  {
    page_key: 'aws_news',
    hypothesis_id: 'H23',
    cadence_hours: 6,
    payload: {
      url: 'https://aws.amazon.com/about-aws/whats-new/recent/',
      page_key: 'aws_news',
      extraction: {
        container_selector: 'article, .aws-card-content, [class*="card"]',
        title_selector: 'h3, .heading',
        date_selector: '.date, time',
        max_items: 20
      }
    }
  },
  {
    page_key: 'msft_news',
    hypothesis_id: 'H4_bear',
    cadence_hours: 12,
    payload: {
      url: 'https://news.microsoft.com/source/topics/ai/',
      page_key: 'msft_news',
      extraction: {
        container_selector: 'article',
        title_selector: 'h2, h3',
        max_items: 15
      }
    }
  },
  // Competitor news (H5_alab, H5_mrvl)
  {
    page_key: 'alab_ir_news',
    hypothesis_id: 'H24',
    cadence_hours: 12,
    payload: {
      url: 'https://www.asteralabs.com/investors/news/',
      page_key: 'alab_ir_news',
      extraction: {
        container_selector: 'article, .news-item, [class*="press"]',
        title_selector: 'h2, h3',
        max_items: 15
      }
    }
  },
  {
    page_key: 'mrvl_ir_news',
    hypothesis_id: 'H-CORR',
    cadence_hours: 12,
    payload: {
      url: 'https://investor.marvell.com/news-events/press-releases',
      page_key: 'mrvl_ir_news',
      extraction: {
        container_selector: 'article, .news-item',
        title_selector: 'h2, h3',
        max_items: 15
      }
    }
  },
  // NVDA earnings/news (H8)
  {
    page_key: 'nvda_news',
    hypothesis_id: 'H8',
    cadence_hours: 24,
    payload: {
      url: 'https://nvidianews.nvidia.com/news',
      page_key: 'nvda_news',
      extraction: {
        container_selector: 'article, .news-card',
        title_selector: 'h3, h2',
        max_items: 15
      }
    }
  }
];

const insertTask = db.prepare(
  "INSERT INTO browser_tasks (task_type, hypothesis_id, status, payload_json, priority, created_ts, producer_name) " +
  "VALUES (?, ?, 'PENDING', ?, ?, ?, ?)"
);

const checkExisting = db.prepare(
  "SELECT task_id FROM browser_tasks " +
  "WHERE task_type = 'fetch_page' " +
  "  AND payload_json LIKE ? " +
  "  AND status IN ('PENDING','RUNNING') " +
  "  AND created_ts > ? " +
  "LIMIT 1"
);

const now = Date.now();
let queued = 0;
let skipped = 0;

NEWS_SOURCES.forEach(function(item) {
  const cadenceMs = item.cadence_hours * 60 * 60 * 1000;
  const existing = checkExisting.get('%' + item.page_key + '%', now - cadenceMs);
  if (existing) {
    console.log('  · ' + item.page_key + ' (skip — task ' + existing.task_id + ' active within ' + item.cadence_hours + 'h)');
    skipped++;
    return;
  }

  const result = insertTask.run(
    'fetch_page',
    item.hypothesis_id,
    JSON.stringify(item.payload),
    5,
    now,
    'queue_news_tasks'
  );
  console.log('  + ' + item.page_key + ' → ' + item.hypothesis_id + ' (task ' + result.lastInsertRowid + ')');
  queued++;
});

console.log('');
console.log('Queued: ' + queued + ', skipped: ' + skipped);
db.close();
