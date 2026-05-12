# CLAW VRT2

**Stock intelligence engine for Vertiv Holdings (NYSE:VRT).**
**v3.3.0** · Node.js + SQLite + Anthropic API · Port 51752 · [MIT License](LICENSE)

A production-discipline trading research system. Collects 27 data streams throughout the day, runs semantic review at 6am ET, and produces a daily intelligence brief. Auto-kills its own signals when they fail. Pauses itself on drawdown.

---

## What it does

VRT2 watches one company. It watches it from 27 angles. Finnhub for tick data. EDGAR for XBRL filings and Form 4 insider transactions. Yahoo Finance for backfill. Earnings transcripts from the entire AI infrastructure supply chain (NVDA, ETN, MOD, EQIX, CRWV, TSMC, AMD, ARM). Analyst price target revisions from TipRanks and MarketBeat. FRED macro feeds. LME copper and gold prices. Section 232 tariff monitoring. PJM grid demand data. arXiv AI research drift.

Then it asks Claude. A scheduled browser agent runs against claude.ai with structured prompts that synthesize the day's data into a daily brief. The brief gets written to disk. A human reads it. Nothing trades automatically.

The system distinguishes itself in one respect: it does not trust itself. Every hypothesis carries a confidence tier. UNTESTED hypotheses get their composite score discounted to 0.50×. PROVISIONAL signals run at 0.75×. Only BACKTESTED signals get full weight. A nightly audit job re-checks every active signal. If hit rate falls below 55% at n=15, the signal auto-kills. A drawdown kill-switch shuts the whole system down at 20%.

## Why it exists

Most retail trading systems chase signals. They add new ones. They never kill the old ones. The hit rate degrades over years until the system is noise. VRT2's thesis is that the auto-kill gate matters more than any individual signal. Signals are disposable. The discipline is the asset.

## What's in this repo

```
claw_server_vrt2.js              Main server. WebSocket tick ingest, signal computation, REST API.
setup_db_vrt2.js                 Schema. 27 tables. Historical backfill 2022-present.
backtest_harness_vrt2.py         H-INV inventory build backtest. EDGAR XBRL pull.
dashboard_vrt2.html              Single-file dashboard. Position, Regime, Risk, Revisions tabs.
install.sh                       launchd installer for macOS. Idempotent. Path-templates plists.
test_vrt2.js                     Smoke tests. Schema sanity, env loading, ranking checks.

lib/
  config.js                      Port, paths, constants.
  signal_config.js               42 signals, 23 hypotheses, 6 tiers, regime weights, position sizing.
  regime.js                      4D regime classifier (VIX, HYG, PMI, 10Y).
  dates.js                       ET-aware date helpers.
  harness_quality.js             Backtest quality flag application.

jobs/
  browser_runner_vrt2.js         Playwright agent against claude.ai. Persistent profile.
  process_browser_results_vrt2.js Findings ingestion.
  queue_scan_tasks_vrt2.js       Hypothesis scan queue.
  queue_daily_review_vrt2.js     06:00 ET daily brief job.
  queue_news_tasks_vrt2.js       News queue at 06:00, 12:00, 18:00 ET.
  edgar_vrt2.js                  10-Q + 10-K XBRL pull. 8-K monitor.
  insider_vrt2.js                Form 4 ingest. Open-market purchases only (code='P').
  options_flow_phase1_vrt2.js    Options chain pull. IV, skew, put/call.
  correlation_vrt2.js            Rolling correlation matrix (29 tickers).
  regime_detector_vrt2.js        09:31 ET regime vector + multiplier application.
  risk_monitor_vrt2.js           Drawdown tracking. Kill-switch trigger.
  signal_audit_vrt2.js           Nightly auto-kill (n=15, <55%).
  analyst_revisions_vrt2.js      H-AR data feed.
  aws_news_vrt2.js               H-AWS daily scrape.
  recalibrate_weights_vrt2.js    Signal weight recalibration from outcome data.
  fill_outcomes_vrt2.js          3-day forward outcome resolution.
  scan_watchdog_vrt2.js          Browser session health check. 8 daily windows.
  backtest_vrt2.js               In-loop backtest runner.
  scheduler_dispatch.sh          launchd dispatch entry point.

migrate_vrt_from_v1.py           Imports VRT v1 history. 162,439 price rows. S1 → S1_LAG rename.
migrate_v3_1_vrt2.js             Seeds signal_weights from SIGNAL_CONFIG.
migrate_v3_2_vrt2.js             Verifies harness quality columns.

com.adamcagle.claw.vrt2.scan.plist     launchd: browser_runner cycle.
com.adamcagle.claw.vrt2.queue.plist    launchd: scheduler dispatch.

CHANGELOG.md                     Verification states for every change. Read first.
CLAUDE.md                        Repo conventions for AI coding agents.
HANDOFF.md                       Deploy and operations runbook.
backtest_report_vrt2.md          Sample backtest output.
```

## Quick start

```bash
git clone https://github.com/adamcagle/vrt2.git
cd vrt2

cp .env.example .env             # Add FINNHUB_API_KEY and ANTHROPIC_API_KEY
npm install
npx playwright install chromium

node setup_db_vrt2.js            # Schema + 2022-present backfill
node migrate_v3_1_vrt2.js        # Seed signal_weights
node migrate_v3_2_vrt2.js        # Verify quality columns

python3 backtest_harness_vrt2.py # PRIORITY. Run before first trading day.

node jobs/browser_runner_vrt2.js --login   # One-time claude.ai authentication
node claw_server_vrt2.js                   # Start server

open http://127.0.0.1:51752      # Dashboard
```

If you already have a v1 database from a prior CLAW install:

```bash
python3 migrate_vrt_from_v1.py ~/CLAW/VRT/vrt.db
```

To install launchd agents for unattended operation on macOS:

```bash
./install.sh
```

## Environment

```
FINNHUB_API_KEY=...              # Required. Free tier: 60 req/min.
ANTHROPIC_API_KEY=...            # Required. Haiku for routine review, Sonnet for H-AR.
FRED_API_KEY=...                 # Optional. ISM PMI and 10Y yield for regime.
METALS_API_KEY=...               # Optional. Copper / gold / aluminum for H2 + H19.
PJM_USERNAME=...                 # Optional. Grid demand for H5 + H15.
PJM_PASSWORD=...
```

`.env` is gitignored. Do not commit it. The system will refuse to start without `FINNHUB_API_KEY` and `ANTHROPIC_API_KEY`.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           Producers (launchd)           │
                    │  scan, news, edgar, insider, regime,    │
                    │  risk, analyst-revisions, options-flow  │
                    └────────────────┬────────────────────────┘
                                     │ writes to
                                     ▼
                          ┌──────────────────┐
                          │  browser_tasks   │
                          │  (SQLite queue)  │
                          └────────┬─────────┘
                                   │ polled by
                                   ▼
                    ┌──────────────────────────────┐
                    │  browser_runner_vrt2.js      │
                    │  Playwright → claude.ai      │
                    │  (persistent session)        │
                    └────────────┬─────────────────┘
                                 │ writes
                                 ▼
                        ┌──────────────────┐
                        │     results      │
                        └────────┬─────────┘
                                 │ consumed by
                                 ▼
                    ┌──────────────────────────────┐
                    │  process_browser_results     │
                    │  → findings/*.md             │
                    │  → daily_briefs/YYYY-MM-DD.md│
                    └──────────────────────────────┘
```

Plus the production-discipline layer running in parallel: signal_audit (02:00 ET nightly), regime_detector (09:31 ET market open), risk_monitor (09:31 ET continuous), analyst_revisions (05:00 ET pre-market), aws_news (06:30 ET), options_flow_phase1 (10:00 ET + 14:00 ET).

All times are stored as ET. The host runs PDT (UTC-7), so launchd `StartCalendarInterval` hours are shifted -3 from ET in the plists.

## Active signals (v3.3.0)

| Signal | Weight | Description |
|--------|--------|-------------|
| S1_LAG | 3 | VRT lagging ETN >5%. Catch-up. 67% pre-inclusion hit rate. |
| S2 | 3 | VRT + NVDA directional alignment >1.5%. |
| S8 | 4 | Volume >1.5× ADV. Institutional accumulation. |
| S_RS | 2 | VRT relative strength vs XLI. |
| S_ETN_LEAD | 4 | ETN intraday lead. VRT follows. |
| S-CU | 2 | FCX +2% AND copper spot +5% in 30d. Margin pressure. |
| COMPOSITE_BULL | 8 | S1_LAG + S2 both firing. 67% hit. +3.65% average over 3d. |
| STACK_BULL / STACK_BEAR | 8 | Three or more uncorrelated signals in 24h. |
| GAP_OPEN | 4 | VRT opens >3%. |
| H-CORR | 3 | VRT / ETN 20d correlation <0.40 for 3+ days. |

Killed in this cut: S1_LEAD (30% hit), S3 (52%, replaced by S-CU), S4 / S9 / S10.

## Hypotheses (23 active, 6 tiers)

| Tier | Hypotheses |
|------|------------|
| 1. Fundamental | H1 (Big-4 capex), H3 (ETN orders), H10 (CRWV backlog), H11 (ETN EPS), H-INV (VRT inventory build) |
| 2. Peer | H8 (VRT / ETN ratio), H12 (aluminum), H-CORR |
| 3. AI Infrastructure | H5, H15 (PJM, blocked until DataMiner account created) |
| 4. VRT-specific | H6 (NVDA GTC, ✅ validated), H13, H14, H-VRT-IR, H22, H22_buy |
| 5. Macro | H18 (S&P inclusion), H19 (copper / gold), H24 (VIX recovery), H26 (tariff) |
| 6. New in v3.3.0 | H-AR (analyst revisions), H-ETN-LEAD, H-AWS, H-EFFIC |

## REST API

```
GET  /                  Dashboard HTML
GET  /position          Current recommended position size from composite + risk state
GET  /regime            Current 4D regime vector + 7-day history
GET  /risk              Kill-switch status, consecutive losers, drawdown
GET  /revisions         Analyst revision history (H-AR feed)
GET  /signals           Currently firing signals
GET  /findings          Today's findings
GET  /brief             Today's daily brief
```

## Data sources

Finnhub REST + WebSocket. Yahoo Finance CSV. EDGAR XBRL + Form 4 + 8-K + 10-Q. Finnhub News. DuckDuckGo browser search. VRT IR page diff. claude.ai semantic review. Anthropic API (Haiku for daily reviews, Sonnet for H-AR / H-AWS / H-ETN-LEAD). Earnings transcripts from MSFT, GOOGL, AMZN, META, ETN, MOD, EQIX, CRWV, TSMC, AMD, ARM, NVDA. PJM DataMiner. Section 232 tariff monitor. LME Metals-API (copper, gold, aluminum). CEG and TLN news. StockTwits + Unusual Whales. FRED (VIX, ISM PMI, 10Y yield, HYG credit). TipRanks + MarketBeat (analyst revisions). AWS news. arXiv AI research.

## What is intentionally not in this repo

This is a research codebase. The following are generated at runtime and excluded from version control by `.gitignore`:

```
.env                    API keys
.browser_profile/       Authenticated claude.ai session cookies
vrt2.db                 Live trading database. Positions, signal history, P&L.
logs/                   Operational logs
state/                  launchd dispatch state markers
findings/               Per-task signal scan output
daily_briefs/           Human-readable daily intelligence briefs
```

To run this system you supply your own API keys, build your own database from `setup_db_vrt2.js`, and authenticate your own claude.ai session.

## Verification discipline

Every change in this repo passes through five verification states. Each is logged in CHANGELOG.md with the change.

```
UNVERIFIED            Change is written, untested
SYNTAX_OK             node --check / python3 -m py_compile / bash -n passes
SQL_VERIFIED          SQL statements validated against in-memory schema
RUNTIME_VERIFIED      Imports cleanly. Test cases pass.
PRODUCTION_VERIFIED   Observed firing correctly against live market data.
```

No change ships without at least SYNTAX_OK. Trading-touching changes do not run live until PRODUCTION_VERIFIED.

## License

[MIT](LICENSE). See LICENSE for the full text and the disclaimer on financial use.

This software is research code. It is not investment advice. Signals have not been independently audited. Past backtest performance does not guarantee future results. Use at your own risk.

---

**Author:** Adam R. Cagle · [adamcagle.com](https://adamcagle.com) · [Agency689](https://agency689.com) / [Agentic689](https://agentic689.com) · Bend, Oregon

*Part of the Agentic Womb fleet. Sister to CRDO. Built on CRDO v3.2.2 architecture with a production-discipline layer added.*
