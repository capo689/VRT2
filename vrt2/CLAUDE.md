# CLAUDE.md — CLAW VRT2 Agent Instructions

**For:** Future-Claude working on VRT2.
**Last updated:** 2026-04-15 (v3.3.0 initial build)
**Port:** 51752 | **DB:** vrt2.db | **Target:** NYSE:VRT

---

## ⚠ MANDATORY SESSION PROTOCOL

1. **Read CHANGELOG.md WIP section first.** Every session, no exceptions.
2. **Check for unfinished work.** If WIP exists, finish or resolve it before anything new.
3. **Grep before fixing.** Confirm a bug is real before writing a fix.
4. **Update CHANGELOG immediately after each change.** Not at session end — now.
5. **Never delete a file without writing its replacement first.**
6. **Test after every change.** `node --check` at minimum; SQL via Python harness.

---

## What VRT2 is

Stock intelligence system for **Vertiv Holdings (NYSE:VRT)**, the AI data center power and thermal infrastructure company. VRT2 is the fourth CLAW fleet member (after VRT v1, CRDO, SOL) and the first to include the full production-discipline layer.

**Phase:** LEARNING. Daily brief is the primary deliverable. All trading decisions are human-only.

**Architecture:** Identical to CRDO v3.2.2 + production-discipline layer:
```
Producers (cron-fired) → browser_tasks → browser_runner_vrt2.js → browser_task_results → process_browser_results_vrt2.js
```
Plus: signal_audit (nightly), regime_detector (daily open), risk_monitor (daily open + post-trade), analyst_revisions (05:00 ET), aws_news (06:30 ET), options_flow_phase1 (10:00 + 14:00 ET).

**Key difference from CRDO:** VRT2 has confidence-tier discounting in composite math. UNTESTED signals contribute at 0.50×, PROVISIONAL at 0.75×, BACKTESTED at 1.0×. The system communicates its own uncertainty.

---

## Critical VRT2-specific facts

### Port and paths
- **Port:** 51752 (NOT 51748=old VRT, NOT 51751=CRDO)
- **DB:** `vrt2.db` (NOT crdo.db, NOT vrt.db)
- **Project root:** `~/CLAW/VRT2/`
- **Findings:** `~/CLAW/VRT2/findings/YYYY-MM-DD/`
- **Daily briefs:** `~/CLAW/VRT2/daily_briefs/YYYY-MM-DD.md`

### Earnings date
**April 22, 2026** — VRT moved Q1 earnings from Apr 29 to Apr 22 (company announcement Apr 8). This is critical for the earnings proximity weighting in composite scores. Update `EARNINGS_DATE` in `claw_server_vrt2.js` after each earnings.

### Tickers
29 tickers. Tier 1 (every cycle): VRT, ETN, NVDA, MSFT, AMZN, META, FCX, XLI, SPY. SPY is new vs v1 (was proxied via XLI — H18 and H24 need SPY directly).

Old v1 tickers kept in DB for backtest but removed from live polling: AA, AMAT, CORZ, DELL, EQT, GNRC, HPE, HUT, LIN, NDSN.

### Killed signals (do not add back)
- **S1_LEAD** — 30% hit rate (27 fires). Removed entirely.
- **S3** — 52% hit rate (noise). Replaced by S-CU (FCX >+2% AND copper_spot >+5% 30d).
- **S4, S9, S10** — all disabled in v1, removed in v2.

### H22_buy — STRICT code='P' filter
The March 26, 2026 cluster of "insider acquisitions" that circulated in financial media were code='A' (DSU accruals on RSUs, $0 cost). They are NOT purchases. `insider_vrt2.js` must gate strictly on `transactionCode === 'P'`. Do not relax this filter.

### S8 volume pipeline bug
VRT v1 had zero S8 fires in 8 days of live data. The WebSocket volume accumulator was not being compared correctly against ADV. VRT2 fixes this by tracking `wsVrtVolume` in the server and comparing against `adv10Cache['VRT']`. Verify S8 fires during first live breakout day.

### H-CORR vs CRDO H6
VRT2's H-CORR (VRT/ETN 20d correlation <0.40 for 3+ days) mirrors CRDO's H6 (CRDO/ALAB correlation). CRDO H6 is 5/5 historical hits. VRT2 threshold may need calibration — ETN/VRT structural coupling is tighter than CRDO/ALAB, so 0.40 may be too tight. Run backtest against 2022-present before promoting above UNTESTED.

---

## Common tasks

**"Add a new hypothesis"** → 4 places:
1. `lib/signal_config.js` SIGNAL_CONFIG entry
2. `migrate_v3_1_vrt2.js` NEW_HYPOTHESES array (INSERT OR IGNORE)
3. `jobs/queue_scan_tasks_vrt2.js` if browser-driven
4. `jobs/browser_runner_vrt2.js` TEMPLATES if needs custom prompt

**"Tune a threshold or weight"** → 2 places:
1. `lib/signal_config.js` (seed value)
2. `signal_weights` table directly (live value)

**"Browser harness broken"** → check in order:
1. `logs/browser_runner-YYYY-MM-DD.log`
2. `scan_heartbeats` table — last heartbeat timestamp
3. `browser_tasks` table — stuck RUNNING entries
4. `node jobs/browser_runner_vrt2.js --login` if claude.ai session expired

**"Signal audit auto-killed a signal"** → check:
1. `signal_overrides` table — reason and timestamp
2. If you disagree, use `signal_overrides` to pin it back with a human justification and 30-day expiry

**"Earnings date changed"** → update in exactly 2 places:
1. `claw_server_vrt2.js` — `var EARNINGS_DATE = new Date(...)` 
2. `CLAUDE.md` (this file) — the "Earnings date" section above

---

## Production-discipline layer (new vs CRDO)

| Job | When | Purpose |
|-----|------|---------|
| `signal_audit_vrt2.js` | 02:00 ET nightly | Auto-kill weak signals, promote strong ones |
| `regime_detector_vrt2.js` | 09:31 ET daily | Compute 4D regime vector |
| `risk_monitor_vrt2.js` | 09:31 ET + post-trade | Consecutive loser tracking, drawdown kill-switch |
| `analyst_revisions_vrt2.js` | 05:00 ET daily | H-AR feed (analyst revision clusters) |
| `aws_news_vrt2.js` | 06:30 ET daily | H-AWS (AWS news page diff) |
| `options_flow_phase1_vrt2.js` | 10:00 + 14:00 ET | H-OPT Phase 1 free-tier options stack |

### Composite scoring formula (VRT2)
```
score = Σ (weight × hit_rate × direction × decay × dedup × regime_mult × confidence_tier_discount × earnings_proximity)
```
Where `confidence_tier_discount` = 1.0 (BACKTESTED) / 0.75 (PROVISIONAL) / 0.50 (UNTESTED) / 0.0 (KILLED).

### Position sizing
Composite → recommended % of VRT_BOOK (exposed via `/position` endpoint):
- 0–9: FLAT
- 10–14: 10% (5-day horizon)
- 15–19: 25% (5–10 days)
- 20–27: 50% (10–20 days)
- 28–35: 75% (10–30 days)
- 36+: 100% (extreme — H22_buy + STACK_BULL + H-INV convergence)

Kill-switch overrides to 0% regardless of composite.

---

## What NOT to propose

- VRT v1 code — not a single line
- API-based scheduled scans (Adam pays for claude.ai, not Anthropic API for semantic review)
- Paid data sources unless behind the Day-30 gate (only exception: Finnhub options if Phase 1 fails)
- Architecture rewrites — VRT2 is CRDO parity, not innovation

---

## Sandbox limitations (dev environment only)

- EDGAR blocked (403) — H-INV backtest must run on Mac Studio
- Yahoo Finance REST API blocked — Yahoo CSV works (already used for backfill)
- `better-sqlite3` not available — use `node --check` for syntax, Python sqlite3 for SQL validation
- All SQL validation uses: `python3 -c "import sqlite3; conn=sqlite3.connect(':memory:'); ..."`

---

*Generated 2026-04-15 for CLAW VRT2 v3.3.0 initial build.*
