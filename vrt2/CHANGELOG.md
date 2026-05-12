# CLAW VRT2 — Changelog

**Purpose:** Authoritative log of every fix, feature, and architectural change.
Read this file FIRST at the start of every session. Update BEFORE and AFTER any change.

**Format rules:**
- Every entry includes: issue reference, root cause, fix summary, files touched, verification state, timestamp
- Verification states: `UNVERIFIED` → `SYNTAX_OK` → `SQL_VERIFIED` → `RUNTIME_VERIFIED` → `PRODUCTION_VERIFIED`
- WIP entries at the top — if you see one, finish it before starting new work

---

## WIP — Work in Progress

**No active WIP.** v3.3.0 initial build complete and staged for deployment.

### Next session priorities

1. **Run H-INV backtest** — `python3 backtest_harness_vrt2.py` on Mac Studio (EDGAR access required). H-INV may be firing right now into Apr 22 earnings.
2. **Deploy to Mac Studio** — `npm install && node setup_db_vrt2.js && python3 migrate_vrt_from_v1.py && node migrate_v3_1_vrt2.js && node migrate_v3_2_vrt2.js`
3. **Login to claude.ai** — `node jobs/browser_runner_vrt2.js --login`
4. **Start server** — `node claw_server_vrt2.js`
5. **Verify S8 volume pipeline** — confirm S8 fires during live trading (was zero in VRT v1 — pipeline bug)
6. **H8 threshold recalibration** — run backtest on post-Mar 23 VRT/ETN ratio data; 0.70 may never trigger post-S&P-inclusion

---

## [v3.3.0] — 2026-04-15

### Initial VRT2 build — CRDO architecture, VRT intelligence

**Summary:** Complete new project built from CRDO v3.2.2 codebase. Zero VRT v1 code. VRT cohorts, hypotheses, and signals ported with CRDO-architecture upgrades and the full production-discipline layer new in VRT2.

**Architecture:** CRDO v3.2.2 parity + production-discipline layer (new beyond CRDO):
- Confidence tiers (BACKTESTED/PROVISIONAL/UNTESTED/KILLED) with composite discounting
- Auto-kill gate via `signal_audit_vrt2.js` (nightly, n=15 + <55% → KILL)
- 4D regime detector with per-signal weight multipliers
- Position sizing table (composite score → % of VRT_BOOK)
- Stop-loss protocol per position tier
- Drawdown kill-switch (20% → hard shutdown)
- H-AR (analyst revision cluster) — the signal that would have called the Apr 7-10 rip
- H-INV (VRT InventoryNet build) — CRDO H10 analog, highest-priority Day 1 backtest

**Files created (all new or transformed from CRDO):**
- `lib/config.js` — PORT=51752
- `lib/dates.js` — verbatim from CRDO (ET-aware date helpers)
- `lib/harness_quality.js` — verbatim from CRDO
- `lib/signal_config.js` — VRT2-specific: 42 signals, 23 hypotheses, 6 tiers, REGIME_WEIGHTS, POSITION_SIZING, STOP_LOSS, DRAWDOWN_PROTOCOL, BACKTEST_GATES
- `lib/regime.js` — VRT2 regime detection (binVix/binHyg/binPmi/binRates), all functions tested
- `setup_db_vrt2.js` — 27 tables including regime_log, positions, risk_state, analyst_revisions, options_flow, signal_overrides
- `migrate_v3_1_vrt2.js` — seeds signal_weights from SIGNAL_CONFIG
- `migrate_v3_2_vrt2.js` — verifies harness quality columns
- `migrate_vrt_from_v1.py` — imports 162,439 price rows from vrt.db; renames S1→S1_LAG; marks killed signals as is_backtest=1
- `backtest_harness_vrt2.py` — H-INV + H-AR backtest (run on Mac Studio with EDGAR access)
- `claw_server_vrt2.js` — VRT2 server: S1_LAG, S2, S8 (pipeline bug fix), S_RS, S_ETN_LEAD, S-CU, GAP_OPEN, H-CORR, COMPOSITE_BULL, H18, H24. New endpoints: /position, /regime, /risk, /revisions
- `jobs/browser_runner_vrt2.js` — VRT2 prompts: review_vrt_financials, review_h1_capex, review_h_ar_revisions, review_h_aws, review_etn_reaction, daily_brief
- `jobs/signal_audit_vrt2.js` — nightly auto-kill/pause (NEW beyond CRDO)
- `jobs/regime_detector_vrt2.js` — 4D regime vector (NEW beyond CRDO)
- `jobs/risk_monitor_vrt2.js` — drawdown kill-switch (NEW beyond CRDO)
- `jobs/analyst_revisions_vrt2.js` — H-AR data feed (NEW beyond CRDO)
- `jobs/aws_news_vrt2.js` — H-AWS daily AWS news (NEW beyond CRDO)
- `jobs/options_flow_phase1_vrt2.js` — H-OPT free stack (NEW beyond CRDO)
- All 11 CRDO base jobs transformed: browser_runner, process_browser_results, queue_daily_review, queue_scan_tasks, queue_news_tasks, edgar, insider, fill_outcomes, recalibrate_weights, correlation, scan_watchdog, backtest
- `jobs/scheduler_dispatch.sh` — VRT2 schedule (regime+risk at open, H-AR at 05:00, signal_audit at 02:00, options flow at 10:00+14:00)
- `dashboard_vrt2.html` — full CRDO dashboard + Position tab, Regime tab, Revisions tab (new)
- `install.sh`, `package.json`, plists

**Verification:**
- `SYNTAX_OK` — all 20 JS files pass `node --check`
- `SYNTAX_OK` — 2 Python files pass `python3 -m py_compile`
- `SYNTAX_OK` — scheduler_dispatch.sh passes `bash -n`
- `SQL_VERIFIED` — setup_db_vrt2.js schema: 27 tables created cleanly in sqlite3 in-memory
- `SQL_VERIFIED` — migrate_v3_1_vrt2.js INSERT OR IGNORE and UPDATE verified
- `SQL_VERIFIED` — claw_server_vrt2.js SQL statements validated against schema
- `RUNTIME_VERIFIED` — lib/regime.js: all bin functions, regime label derivation, multiplier application tested with assertions
- `RUNTIME_VERIFIED` — lib/signal_config.js: 42 signals loaded, exports verified, POSITION_SIZING counts correct
- `RUNTIME_VERIFIED` — migrate_vrt_from_v1.py: dry-run against real vrt.db confirmed 162,439 rows, S1→S1_LAG rename, killed signal detection

**Not yet verified (requires Mac Studio with live dependencies):**
- `RUNTIME_VERIFIED` on server startup (requires better-sqlite3, .env with FINNHUB_API_KEY)
- `RUNTIME_VERIFIED` on backtest harness (requires EDGAR + Yahoo Finance access)
- Signal fires from live market data
- Browser harness end-to-end (requires Playwright + claude.ai login)

**Killed signals vs VRT v1:** S1_LEAD (30% hit), S3 (52% → replaced by S-CU), S4/S9/S10 (disabled in v1, removed entirely)

**Port:** 51752 (51748=old VRT, 51749=SOL, 51750=RED, 51751=CRDO)

---

*CHANGELOG format inherited from CRDO v3.2.2. See CRDO CHANGELOG for prior architectural decisions that inform this build.*
