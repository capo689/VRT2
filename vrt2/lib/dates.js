// ════════════════════════════════════════════════════════════════════════
// lib/dates.js · CLAW CRDO
//
// ET-aware date helpers. The CRDO system operates on ET schedule (market
// hours, daily review at 6am ET, etc.) but several v3.1 code paths used
// UTC dates which caused after-8pm-ET scans to be filed under tomorrow's
// UTC date and reviewed a full day late (#A5 in CHANGELOG).
//
// The pattern here is the same one already proven in scan_watchdog_crdo.js:
// `toLocaleDateString('en-CA', { timeZone: 'America/New_York' })` returns
// a YYYY-MM-DD date string in the America/New_York time zone, automatically
// handling DST (EDT vs EST) without manual offset arithmetic.
//
// USAGE:
//   const { getETDateString, getETYesterday, getETHour, getETMinute } = require('./dates');
//
//   const today = getETDateString();           // "2026-04-10" (in ET)
//   const today2 = getETDateString(Date.now()); // same
//   const yesterday = getETYesterday();         // "2026-04-09" (in ET)
//   const hour = getETHour();                   // 0-23, current ET hour
//
// All functions accept an optional `ms` parameter (Date.now() default)
// so they can be unit-tested with deterministic timestamps.
// ════════════════════════════════════════════════════════════════════════

const ET_TZ = 'America/New_York';

/**
 * Returns the ET-local date string in YYYY-MM-DD format for the given
 * timestamp (defaults to now). Uses en-CA locale because it natively
 * formats dates as YYYY-MM-DD without separator surprises.
 *
 * @param {number} [ms=Date.now()] - milliseconds since epoch
 * @returns {string} - "YYYY-MM-DD" in the America/New_York time zone
 */
function getETDateString(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  return d.toLocaleDateString('en-CA', { timeZone: ET_TZ });
}

/**
 * Returns the ET-local date string for "the day before the given timestamp".
 * Used by the daily review producer to compute "yesterday's findings"
 * correctly across time zone boundaries.
 *
 * NOTE: this is not "ms minus 24 hours then format" because that breaks at
 * DST transitions. We compute the ET date string for `ms`, parse it, subtract
 * one day, and format the result.
 *
 * @param {number} [ms=Date.now()] - milliseconds since epoch
 * @returns {string} - "YYYY-MM-DD" representing yesterday in ET
 */
function getETYesterday(ms) {
  const todayStr = getETDateString(ms);
  // Parse YYYY-MM-DD and subtract one day. Using UTC arithmetic on the
  // date-only string is safe because we're working with calendar days,
  // not wall-clock times.
  const parts = todayStr.split('-').map(function(p) { return parseInt(p, 10); });
  const utcMs = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const yesterdayUtcMs = utcMs - 24 * 60 * 60 * 1000;
  const y = new Date(yesterdayUtcMs);
  // Format the result as YYYY-MM-DD using UTC components (since we
  // constructed it from UTC midnight). This is purely string arithmetic.
  const yyyy = y.getUTCFullYear();
  const mm = String(y.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(y.getUTCDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

/**
 * Returns the current ET hour as an integer 0-23.
 *
 * @param {number} [ms=Date.now()] - milliseconds since epoch
 * @returns {number} - hour 0-23 in ET
 */
function getETHour(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  const hourStr = d.toLocaleString('en-US', {
    timeZone: ET_TZ,
    hour: '2-digit',
    hour12: false
  });
  return parseInt(hourStr, 10);
}

/**
 * Returns the current ET minute as an integer 0-59.
 *
 * @param {number} [ms=Date.now()] - milliseconds since epoch
 * @returns {number} - minute 0-59 in ET
 */
function getETMinute(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  const minStr = d.toLocaleString('en-US', {
    timeZone: ET_TZ,
    minute: '2-digit'
  });
  return parseInt(minStr, 10);
}

/**
 * Returns a structured ET time object — convenient for callers that need
 * multiple components from the same instant (avoids race conditions where
 * the timestamp changes between getETHour() and getETMinute() calls).
 *
 * @param {number} [ms=Date.now()] - milliseconds since epoch
 * @returns {{date: string, hour: number, minute: number}} - ET time components
 */
function getETTime(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  const hour = parseInt(d.toLocaleString('en-US', {
    timeZone: ET_TZ, hour: '2-digit', hour12: false
  }), 10);
  const minute = parseInt(d.toLocaleString('en-US', {
    timeZone: ET_TZ, minute: '2-digit'
  }), 10);
  const date = d.toLocaleDateString('en-CA', { timeZone: ET_TZ });
  return { date: date, hour: hour, minute: minute };
}

/**
 * Returns the millisecond timestamp of midnight ET on the calendar day that
 * contains the given timestamp. Used by SQL queries that need a "since
 * start of today in ET" filter and can't call JS functions to compare dates
 * row-by-row.
 *
 * Strategy: get the ET date string, parse out year/month/day, then walk a
 * candidate UTC midnight backwards until its ET-projection matches. This
 * handles DST automatically because we let the locale formatter do the work.
 *
 * @param {number} [ms=Date.now()] - milliseconds since epoch
 * @returns {number} - millisecond timestamp of 00:00:00 ET on that calendar day
 */
function getETDayStartMs(ms) {
  const targetDate = getETDateString(ms);
  const parts = targetDate.split('-').map(function(p) { return parseInt(p, 10); });
  // Start by guessing UTC midnight on the same calendar date.
  // ET is UTC-4 (EDT) or UTC-5 (EST), so ET midnight is 4-5 hours AHEAD of
  // UTC midnight on the same calendar date. We add 4 hours and check whether
  // that lands on the same ET date; if not, add one more hour for EST.
  let candidate = Date.UTC(parts[0], parts[1] - 1, parts[2], 4, 0, 0, 0);  // EDT guess
  if (getETDateString(candidate) !== targetDate) {
    candidate = Date.UTC(parts[0], parts[1] - 1, parts[2], 5, 0, 0, 0);  // EST
  }
  // Verify by walking back 1 hour at a time if we overshot (defensive)
  while (getETDateString(candidate - 1) === targetDate) {
    candidate -= 60 * 60 * 1000;
  }
  return candidate;
}

module.exports = {
  getETDateString: getETDateString,
  getETYesterday: getETYesterday,
  getETHour: getETHour,
  getETMinute: getETMinute,
  getETTime: getETTime,
  getETDayStartMs: getETDayStartMs,
  ET_TZ: ET_TZ
};
