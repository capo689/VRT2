# CLAW VRT2 — Session Handoff
**Created:** 2026-04-15 (v3.3.0 initial build)
**Read this file first, then CHANGELOG.md WIP section.**

---

## Current state

**Last release:** v3.3.0 — initial build complete, staged for deployment
**Active WIP:** None
**All files:** Syntax-verified, SQL-validated, ready for Mac Studio deployment

---

## How to deploy (run these in order on Mac Studio)

```bash
cd ~/CLAW/VRT2

# 1. Install dependencies
npm install
npx playwright install chromium

# 2. Create DB + backfill historical prices (2022-present, 29 tickers)
node setup_db_vrt2.js

# 3. Import VRT v1 history (162,439 price rows + 134 signals + 291 composites)
python3 migrate_vrt_from_v1.py ~/CLAW/VRT/vrt.db

# 4. Seed signal_weights with all 42 hypotheses
node migrate_v3_1_vrt2.js

# 5. Verify harness quality columns
node migrate_v3_2_vrt2.js

# 6. PRIORITY: H-INV backtest (VRT earnings Apr 22 — 7 days away)
python3 backtest_harness_vrt2.py

# 7. Login to claude.ai in persistent Chromium profile
node jobs/browser_runner_vrt2.js --login

# 8. Start server
node claw_server_vrt2.js

# 9. Open dashboard
open http://127.0.0.1:51752

# 10. Install launchd agents (after verifying server runs clean)
./install.sh
```

---

## Why H-INV backtest is FIRST

CRDO's equivalent signal (H10, VRT InventoryNet build >25% QoQ) is **5/5 historical hits** and is labeled the strongest fundamental signal in the CRDO system. VRT is a pure-play hardware manufacturer — inventory build is a more direct tell on forward shipments than for CRDO (which is fabless).

VRT Q1 earnings are **April 22, 2026** — 7 days away at time of this handoff. If the most recent VRT 10-Q shows InventoryNet >25% QoQ, H-INV is currently firing at weight 5 (UNTESTED tier = 0.50× discount → effectively +2.5 to composite) heading into earnings. That's actionable today.

The backtest harness hits EDGAR companyfacts API which is blocked in the Claude dev sandbox. It runs fine on the Mac Studio.

---

## Architecture summary

```
Producers (cron-fired)     →  browser_tasks  →  browser_runner_vrt2.js  →  browser_task_results  →  process_browser_results_vrt2.js
                                                  (API calls to claude-sonnet-4-6)
                                                  (uses ANTHROPIC_API_KEY from .env)
```

Plus nightly/daily production-discipline jobs:
- `signal_audit_vrt2.js` — 02:00 ET — auto-kill weak signals at n=15/<55%
- `regime_detector_vrt2.js` — 09:31 ET — 4D regime vector (VIX/PMI/rates/HYG)
- `risk_monitor_vrt2.js` — 09:31 ET — drawdown kill-switch
- `analyst_revisions_vrt2.js` — 05:00 ET — H-AR feed
- `aws_news_vrt2.js` — 06:30 ET — H-AWS daily
- `options_flow_phase1_vrt2.js` — 10:00 + 14:00 ET — H-OPT Phase 1

**Key difference from CRDO:** VRT2 has confidence-tier discounting. UNTESTED=0.50×, PROVISIONAL=0.75×, BACKTESTED=1.0× in composite math. System communicates its own uncertainty.

---

## What's working (verified pre-deployment)

| Component | Status | Verified via |
|-----------|--------|-------------|
| All 20 JS files | ✅ SYNTAX_OK | `node --check` |
| 2 Python files | ✅ SYNTAX_OK | `python3 -m py_compile` |
| scheduler_dispatch.sh | ✅ SYNTAX_OK | `bash -n` |
| setup_db_vrt2.js schema | ✅ SQL_VERIFIED | Python sqlite3 in-memory |
| migrate_v3_1_vrt2.js SQL | ✅ SQL_VERIFIED | Python sqlite3 harness |
| claw_server_vrt2.js SQL | ✅ SQL_VERIFIED | Python sqlite3 harness |
| lib/regime.js | ✅ RUNTIME_VERIFIED | Node assertions (all bin fns) |
| lib/signal_config.js | ✅ RUNTIME_VERIFIED | Node (42 signals, correct counts) |
| migrate_vrt_from_v1.py | ✅ RUNTIME_VERIFIED | Dry-run against real vrt.db |

**Not yet verified (requires Mac Studio):**
- Server startup with live better-sqlite3
- Signal fires from Finnhub
- Browser harness end-to-end
- H-INV backtest (EDGAR)

---

## Open priorities after deployment

| Priority | Item | Effort |
|----------|------|--------|
| 🔴 DAY 1 | H-INV backtest | 30 min — `python3 backtest_harness_vrt2.py` |
| 🔴 DAY 1 | Verify S8 fires during live trading | Debug if zero fires after first market day |
| 🔴 WEEK 1 | H8 threshold recalibration | Run VRT/ETN ratio backtest post-Mar-23 2026 |
| 🔴 WEEK 1 | PJM DataMiner account | Free signup — unblocks H5 + H15 |
| 🟡 WEEK 2 | H-CORR threshold calibration | Is 0.40 right for VRT/ETN? Test vs CRDO/ALAB 0.40 |
| 🟡 WEEK 2 | EDGAR Form 4 automation verify | Confirm insider_vrt2.js correctly filters code='P' |
| 🟡 MONTH 1 | Earnings event study | backtest_harness_vrt2.py — H-INV + H-AR + 6 others vs 16 VRT quarters |
| 🟢 MONTH 1 | Signal tier promotions | As live fires accumulate, signal_audit promotes UNTESTED→PROVISIONAL |

---

## Known potential issues

### Issue 1: S8 volume pipeline (HIGH)
VRT v1 had zero S8 fires in 8 days. The v2 fix accumulates WebSocket volume in `wsVrtVolume` and compares against `adv10Cache['VRT']`. If S8 still shows zero fires after the first live breakout day, debug the WebSocket volume accumulation in `claw_server_vrt2.js` lines ~570-600.

### Issue 2: H8 threshold (MEDIUM)
VRT/ETN ratio was 0.726 on Apr 6, expanded to ~0.795 by Apr 14. Post-S&P inclusion, VRT's premium vs ETN may have structurally expanded, making the 0.70 trigger permanently inactive. Run `python3 -c "import sqlite3; ..."` against vrt2.db to check post-Mar-23 ratio history.

### Issue 3: claude.ai profile login (if browser harness is used)
The browser_runner_vrt2.js uses the Anthropic API directly (not browser navigation to claude.ai). The `--login` flag still opens a browser for the persistent profile, but API calls go to `api.anthropic.com`. Ensure `ANTHROPIC_API_KEY` is set in `.env`.

### Issue 4: model string
browser_runner_vrt2.js uses `claude-haiku-4-5-20251001` for non-web-search reviews and `claude-sonnet-4-6` for web-search reviews (H-AR revisions, H-AWS, ETN reaction). These are the correct model strings as of Apr 2026.

---

## CRDO process rules that apply here too

1. **Read CHANGELOG WIP before touching code**
2. **CHANGELOG updated immediately after every change** — not at session end
3. **Test after every change** — `node --check` minimum
4. **Never delete a file without writing replacement first**
5. **Verification language is precise:** SYNTAX_OK ≠ SQL_VERIFIED ≠ RUNTIME_VERIFIED ≠ PRODUCTION_VERIFIED
6. **Self-introduced bugs get logged in CHANGELOG** with root cause and process fix

---

## File inventory (v3.3.0)

### Root (11 files)
- `CHANGELOG.md` — THIS IS THE SOURCE OF TRUTH for what's done
- `CLAUDE.md` — agent instructions (this sibling document)
- `HANDOFF.md` — THIS FILE
- `README.md` — project overview
- `claw_server_vrt2.js` — main server (1,304 lines)
- `setup_db_vrt2.js` — schema + backfill
- `migrate_v3_1_vrt2.js` — seeds signal_weights
- `migrate_v3_2_vrt2.js` — verifies quality columns
- `migrate_vrt_from_v1.py` — imports vrt.db history
- `backtest_harness_vrt2.py` — H-INV + H-AR backtest (run on Mac Studio)
- `dashboard_vrt2.html` — UI (Position/Regime/Revisions tabs new)
- `install.sh` — launchd installer
- `package.json`
- `.env` — FINNHUB_API_KEY + ANTHROPIC_API_KEY
- `com.adamcagle.claw.vrt2.scan.plist`
- `com.adamcagle.claw.vrt2.queue.plist`

### lib/ (5 files)
- `lib/config.js` — PORT=51752
- `lib/dates.js` — ET-aware date helpers (from CRDO, unchanged)
- `lib/harness_quality.js` — harness quality computation (from CRDO, unchanged)
- `lib/signal_config.js` — 42 signals, REGIME_WEIGHTS, POSITION_SIZING, all gates
- `lib/regime.js` — regime detection helpers

### jobs/ (19 files)
- `browser_runner_vrt2.js` — API-based semantic review daemon
- `process_browser_results_vrt2.js` — consumer
- `queue_daily_review_vrt2.js` — 06:00 ET producer
- `queue_scan_tasks_vrt2.js` — scan producer
- `queue_news_tasks_vrt2.js` — news producer
- `edgar_vrt2.js` — EDGAR filings
- `insider_vrt2.js` — Form 4 (strict code='P' filter)
- `fill_outcomes_vrt2.js` — fills signal outcome columns
- `recalibrate_weights_vrt2.js` — rolling hit rate recalibration
- `correlation_vrt2.js` — VRT/ETN and peer correlations
- `scan_watchdog_vrt2.js` — heartbeat monitor
- `backtest_vrt2.js` — price-driven backtest runner
- `signal_audit_vrt2.js` — nightly auto-kill gate (NEW)
- `regime_detector_vrt2.js` — 4D regime vector (NEW)
- `risk_monitor_vrt2.js` — drawdown kill-switch (NEW)
- `analyst_revisions_vrt2.js` — H-AR data feed (NEW)
- `aws_news_vrt2.js` — H-AWS daily (NEW)
- `options_flow_phase1_vrt2.js` — H-OPT free stack (NEW)
- `scheduler_dispatch.sh` — bash dispatcher

---

## TL;DR for the next session

1. Read this file + CHANGELOG.md WIP
2. Deploy to Mac Studio (steps above)
3. **Run H-INV backtest first** — Apr 22 earnings are 7 days away
4. Start server, verify signal fires, check S8 volume pipeline
5. If any issue surfaces, follow CRDO protocol: grep first, fix surgical, CHANGELOG immediately, test after

Port: 51752 | DB: vrt2.db | Target: NYSE:VRT | Phase: LEARNING
