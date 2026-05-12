// CLAW CRDO — lib/harness_quality.js
// Computes browser harness data quality for a given ET calendar date.
//
// Used by:
//   jobs/queue_daily_review_crdo.js  — injects quality into synthesis payload
//   claw_server_crdo.js              — exposes via /scan/health and /daily_brief
//
// Quality thresholds:
//   FULL       — uptime_pct >= 90   (hypothesis scoring uses this day normally)
//   DEGRADED   — uptime_pct 50–89   (day flagged; excluded from hit rate window)
//   INCOMPLETE — uptime_pct < 50    (day excluded; brief marked unreliable)
//   UNKNOWN    — no task data found (daemon wasn't running or data gap)
//
// Import with: const { computeHarnessQuality } = require('./lib/harness_quality');
//          or: const { computeHarnessQuality } = require('../lib/harness_quality');

'use strict';

const { getETDayStartMs } = require('./dates');

const QUALITY_FULL_THRESHOLD       = 90;  // % completion for FULL
const QUALITY_DEGRADED_THRESHOLD   = 50;  // % completion for DEGRADED (below = INCOMPLETE)

/**
 * Compute harness quality for a given ET date string ('YYYY-MM-DD').
 *
 * Counts browser_tasks created on that ET day (using ET midnight ms boundaries)
 * with status COMPLETED or FAILED. Excludes PENDING/RUNNING (still in-flight
 * at time of call — don't penalise tasks that haven't had time to run).
 *
 * @param {object} db      - better-sqlite3 database instance (already open)
 * @param {string} etDate  - 'YYYY-MM-DD' in ET (e.g. '2026-04-10')
 * @returns {{
 *   completed: number,
 *   failed: number,
 *   total: number,
 *   uptime_pct: number|null,
 *   quality: 'FULL'|'DEGRADED'|'INCOMPLETE'|'UNKNOWN'
 * }}
 */
function computeHarnessQuality(db, etDate) {
  try {
    // Compute ET midnight ms for the given date and the next day.
    // getETDayStartMs() returns midnight-ET for the day containing the given ms.
    // We fake a ms that lands in the middle of the target ET date.
    const [year, month, day] = etDate.split('-').map(Number);
    // Noon UTC on that calendar date — guaranteed to land in the right ET day
    // for any reasonable timezone offset.
    const noonUTCms = Date.UTC(year, month - 1, day, 12, 0, 0);
    const dayStartMs  = getETDayStartMs(noonUTCms);
    const dayEndMs    = dayStartMs + 86400000; // + exactly 24h

    const completed = db.prepare(
      "SELECT COUNT(*) AS n FROM browser_tasks " +
      "WHERE status = 'COMPLETED' AND created_ts >= ? AND created_ts < ?"
    ).get(dayStartMs, dayEndMs).n;

    const failed = db.prepare(
      "SELECT COUNT(*) AS n FROM browser_tasks " +
      "WHERE status = 'FAILED' AND created_ts >= ? AND created_ts < ?"
    ).get(dayStartMs, dayEndMs).n;

    const total = completed + failed;

    if (total === 0) {
      return { completed: 0, failed: 0, total: 0, uptime_pct: null, quality: 'UNKNOWN' };
    }

    const uptime_pct = Math.round((completed / total) * 100 * 10) / 10; // 1 decimal

    let quality;
    if      (uptime_pct >= QUALITY_FULL_THRESHOLD)     quality = 'FULL';
    else if (uptime_pct >= QUALITY_DEGRADED_THRESHOLD) quality = 'DEGRADED';
    else                                               quality = 'INCOMPLETE';

    return { completed, failed, total, uptime_pct, quality };

  } catch (e) {
    // If the browser_tasks table doesn't exist yet (fresh install before migration),
    // return UNKNOWN rather than crashing the caller.
    console.error('  ⚠ harness_quality computation failed: ' + e.message);
    return { completed: 0, failed: 0, total: 0, uptime_pct: null, quality: 'UNKNOWN' };
  }
}

module.exports = { computeHarnessQuality, QUALITY_FULL_THRESHOLD, QUALITY_DEGRADED_THRESHOLD };
