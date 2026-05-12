// CLAW VRT2 — lib/signal_config.js v3.3.0
//
// Authoritative SIGNAL_CONFIG, REVIEW_CADENCE, SIGNAL_CORR, and REGIME_WEIGHTS.
// Shared by claw_server_vrt2.js, jobs/backtest_vrt2.js, and the browser
// harness producers/consumers.
//
// Architecture: CRDO v3.2.2 parity + production-discipline layer (new in VRT2).
// Zero VRT v1 code — built fresh against CRDO patterns.
//
// data_source values:
//   'finnhub'       — live price data via Finnhub REST/WebSocket
//   'edgar_xbrl'    — SEC structured financials (companyfacts API)
//   'edgar_filing'  — SEC filing text (browser-extracted windows)
//   'browser_scan'  — narrative web data via browser harness + semantic review
//   'computed'      — derived from other signals server-side
//   'external_paid' — requires paid API tier (currently disabled)
//
// confidence_tier values:
//   'BACKTESTED'  — n≥15 post-inclusion fires, hit rate ≥55%, p<0.10 → 1.0× composite
//   'PROVISIONAL' — n≥5 fires, mechanism grounded, directionally correct → 0.75× composite
//   'UNTESTED'    — newly added or n<5 → 0.50× composite
//   'KILLED'      — hit rate <55% at n=15 in current regime → 0.0× (excluded)
//
// Killed signals: S1_LEAD (30% hit), S3 (52% near-random → replaced by S-CU),
//                 S4 (40%), S9 (50%), S10 (36%)

// ── REVIEW CADENCE ───────────────────────────────────────────────────────────
const REVIEW_CADENCE = {
  phase: 'LEARNING',
  daily_review_time: '06:00',
  daily_review_tz: 'America/New_York',
  intraday_review: false,
  intraday_cadence_hours: 4,       // used in RECOMMENDATION+ phase
  alert_threshold_composite: null,  // only set in TRADING phase
  brief_target_time: '07:00',
  brief_target_tz: 'America/New_York',
};

// ── SIGNAL CONFIG ─────────────────────────────────────────────────────────────
// Each entry: { threshold, weight, direction, half_life_min, regime_class,
//               description, data_source, confidence_tier, enabled }
//
// weight: composite contribution at full BACKTESTED tier (1–8 scale)
// half_life_min: minutes until signal fire contributes 50% of original weight
// confidence_tier: starting tier — updated nightly by signal_audit_vrt2.js
// regime_class: used by regime_detector to apply regime multipliers

const SIGNAL_CONFIG = {

  // ─── Price-driven signals (server-computed in evaluateSignals()) ──────────

  S1_LAG: {
    threshold: 5, weight: 3, direction: 'BULL',
    half_life_min: 4320,  // 3 days
    regime_class: 'MEAN_REV',
    data_source: 'finnhub', confidence_tier: 'PROVISIONAL', enabled: true,
    description: 'VRT lagging ETN >5% — catch-up signal (67% pre-inclusion, n=6; downgraded from weight 5 pending n≥20 post-inclusion)',
  },
  // S1_LEAD: KILLED — 30% hit rate (27 fires). Removed entirely.

  S2: {
    threshold: 1.5, weight: 3, direction: 'CONTEXT',
    half_life_min: 480,   // 8 hours
    regime_class: 'TREND',
    data_source: 'finnhub', confidence_tier: 'PROVISIONAL', enabled: true,
    description: 'VRT+NVDA directional align >1.5% — momentum continuation (56% hit rate, 30 fires)',
  },

  S8: {
    threshold: 1.5, weight: 4, direction: 'BULL',
    half_life_min: 1440,  // 1 day
    regime_class: 'TREND',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Volume accumulation >1.5× ADV — institutional buying (zero fires in v1 — pipeline bug to fix)',
  },

  S_RS: {
    threshold: 1, weight: 2, direction: 'BULL',
    half_life_min: 2880,  // 2 days
    regime_class: 'TREND',
    data_source: 'finnhub', confidence_tier: 'PROVISIONAL', enabled: true,
    description: 'VRT relative strength vs XLI — sector outperformance streak (38 fires, persistent)',
  },

  S_ETN_LEAD: {
    threshold: 0.6, weight: 4, direction: 'BULL',
    half_life_min: 1440,  // 1 day
    regime_class: 'TREND',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'ETN→VRT intraday lead signal — ETN moves, VRT follows within session (n=2 pre-inclusion)',
  },

  'S-CU': {
    threshold: 2, weight: 2, direction: 'BEAR',
    half_life_min: 4320,  // 3 days
    regime_class: 'STRUCTURAL',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'FCX >+2% AND copper spot >+5% 30d → VRT margin pressure (replaces killed S3 with theory-grounded trigger)',
  },
  // S3: KILLED — 52% hit rate (near-random). Replaced by S-CU.
  // S4: KILLED — 40% hit rate (disabled in v1). Removed.
  // S9: KILLED — 50% hit rate (disabled in v1). Removed.
  // S10: KILLED — 36% hit rate (disabled in v1). Removed.

  // ─── Derived/computed signals (server-computed in evaluateTemporalSignals()) ─

  COMPOSITE_BULL: {
    threshold: 4, weight: 8, direction: 'BULL',
    half_life_min: 720,   // 12 hours
    regime_class: 'EVENT',
    data_source: 'computed', confidence_tier: 'PROVISIONAL', enabled: true,
    description: 'S1_LAG + S2 both firing — highest-weight derived signal (67% hit rate, +3.65% avg 3d)',
  },

  STACK_BULL: {
    threshold: 3, weight: 8, direction: 'BULL',
    half_life_min: 720,
    regime_class: 'EVENT',
    data_source: 'computed', confidence_tier: 'UNTESTED', enabled: true,
    description: '3+ uncorrelated BULL signals fired within 24h',
  },

  STACK_BEAR: {
    threshold: 3, weight: 8, direction: 'BEAR',
    half_life_min: 720,
    regime_class: 'EVENT',
    data_source: 'computed', confidence_tier: 'UNTESTED', enabled: true,
    description: '3+ uncorrelated BEAR signals fired within 24h',
  },

  GAP_OPEN_BULL: {
    threshold: 3, weight: 4, direction: 'BULL',
    half_life_min: 240,   // 4 hours
    regime_class: 'EVENT',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT opens >3% above prior close — gap-up momentum',
  },

  GAP_OPEN_BEAR: {
    threshold: 3, weight: 4, direction: 'BEAR',
    half_life_min: 240,
    regime_class: 'EVENT',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT opens >3% below prior close — gap-down momentum',
  },

  'H-CORR': {
    threshold: 0.40, weight: 3, direction: 'CONTEXT',
    half_life_min: 1440,  // 1 day
    regime_class: 'STRUCTURAL',
    data_source: 'computed', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT/ETN 20d rolling Pearson correlation <0.40 for 3+ days — relationship breakdown (CRDO H6 analog, 5/5 CRDO hits; VRT threshold needs calibration)',
  },

  // ─── Tier 1: Fundamental Revenue Drivers (quarterly cadence) ─────────────

  H1: {
    threshold: 50e9, weight: 5, direction: 'BULL',
    half_life_min: 7200,  // 5 days
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Big-4 combined capex >$50B/quarter → VRT earnings beat within 90 days',
  },

  H3: {
    threshold: 20, weight: 5, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'ETN DC order growth >20% YoY → VRT beats next earnings by >5% (ETN Q4 2025: +200% YoY)',
  },

  H10: {
    threshold: 20, weight: 4, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'CRWV contracted backlog growth >20% QoQ → VRT revenue beat >7% following quarter',
  },

  H11: {
    threshold: 5, weight: 4, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'ETN EPS beat >5% → VRT beats in following earnings by >5%',
  },

  'H-INV': {
    threshold: 25, weight: 5, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'edgar_xbrl', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT InventoryNet QoQ build >25% → revenue beat next quarter (CRDO H10 analog — 5/5 CRDO hits; VRT-specific backtest required)',
  },

  // ─── Tier 2: Peer Dynamics & Relative Performance ─────────────────────────

  H8: {
    threshold: 0.70, weight: 3, direction: 'BULL',
    half_life_min: 2880,  // 2 days
    regime_class: 'MEAN_REV',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT/ETN price ratio <0.70 for 3+ days → VRT outperforms ETN by >15% over 60 days (threshold needs post-inclusion recalibration; current ratio ~0.795)',
  },

  H12: {
    threshold: 8, weight: 3, direction: 'BULL',
    half_life_min: 4320,  // 3 days
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'LME aluminum +8% in 30d → NVT underperforms VRT by >10% over 90 days (gold added to Metals-API in v2)',
  },

  // ─── Tier 3: AI Infrastructure Pull-Through ──────────────────────────────

  H5: {
    threshold: 500, weight: 4, direction: 'BULL',
    half_life_min: 10080, // 7 days
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'PJM queue >500MW in 60 days → VRT order book update within 2Q (BLOCKED: PJM DataMiner account needed)',
  },

  H15: {
    threshold: 1000, weight: 4, direction: 'BULL',
    half_life_min: 10080,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'PJM queue >1000MW in 60 days → VRT 8-K/backlog release within 90 days (BLOCKED: same as H5)',
  },

  // ─── Tier 4: VRT-Specific Catalysts ──────────────────────────────────────

  H6: {
    threshold: 5, weight: 5, direction: 'BULL',
    half_life_min: 4320,  // 3 days
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'PROVISIONAL', enabled: true,
    description: 'NVDA GTC architecture announcement → VRT +5% within 10 days (1/1 validated: GTC Mar 16 → VRT ATH Mar 25 = +9.6%)',
  },

  H13: {
    threshold: 5, weight: 4, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'NVDA GTC → VRT revenue growth exceeds prior quarter by >5pp (revenue analog to H6; window open, scores Apr 22)',
  },

  H14: {
    threshold: 5, weight: 3, direction: 'BULL',
    half_life_min: 2880,  // 2 days
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Hyperscaler earnings call connectivity keyword density >5x normal (CRDO H11 parity; same D10 transcript fetch as H1)',
  },

  'H-VRT-IR': {
    threshold: 1, weight: 4, direction: 'BULL',
    half_life_min: 1440,  // 1 day
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT product GA / partnership / 8-K announcement — IR page diff trigger (CRDO H14 parity; BMarko acquisition Apr 13 is an example)',
  },

  H22: {
    threshold: 500000, weight: 3, direction: 'BEAR',
    half_life_min: 4320,  // 3 days
    regime_class: 'STRUCTURAL',
    data_source: 'edgar_xbrl', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT insider discretionary sales >$500K in 30d (code=S, aff10b5One=0, C-suite only, not post-300%-rally profit-taking)',
  },

  H22_buy: {
    threshold: 1, weight: 8, direction: 'BULL',
    half_life_min: 7200,  // 5 days
    regime_class: 'EVENT',
    data_source: 'edgar_xbrl', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT insider OPEN-MARKET PURCHASE (Form 4 code=P ONLY — not code=A accruals, not code=M exercises). Zero fires in monitoring window. Rare and loud when it fires.',
  },

  // ─── Tier 5: Macro Regime ─────────────────────────────────────────────────

  H18: {
    threshold: 20, weight: 3, direction: 'BULL',
    half_life_min: 43200, // 30 days (slow structural signal)
    regime_class: 'STRUCTURAL',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VRT S&P 500 inclusion (Mar 23 2026) → VRT outperforms S&P by >20% over 12 months (currently +21% alpha in 22 days, tracking above threshold)',
  },

  H19: {
    threshold: 5, weight: 2, direction: 'BULL',
    half_life_min: 7200,  // 5 days
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Copper/gold ratio +5% in 30 days → VRT outperforms XLI by >8% over 90 days (gold spot added in v2 — v1 gap closed)',
  },

  H24: {
    threshold: 30, weight: 2, direction: 'BULL',
    half_life_min: 4320,  // 3 days
    regime_class: 'MEAN_REV',
    data_source: 'finnhub', confidence_tier: 'UNTESTED', enabled: true,
    description: 'VIX spike >30 then recovers <22 → VRT outperforms S&P by >12% within 30d (clock inactive — VIX peaked 27.29 Apr 3, did not cross 30)',
  },

  H26: {
    threshold: 15, weight: 3, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Definitive Section 232 tariff ruling on power equipment → VRT P/E expands >15% within 60 days (60-day window active through June 5, 2026)',
  },

  // Demoted to weight 2 — watch-only, cannot pollute composite independently
  H9: {
    threshold: 500, weight: 2, direction: 'BULL',
    half_life_min: 10080,
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'CEG/TLN PPA >500MW → VRT DC order announcement within 45 days (demoted — no trigger in 6 months, web-search detection unreliable)',
  },

  H17: {
    threshold: 90, weight: 2, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'TSMC utilization >90% AND revenue growth >15% YoY → VRT order intake +20% vs 4Q avg (demoted to weight 2)',
  },

  H20: {
    threshold: 25, weight: 2, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Modine DC cooling segment >25% revenue growth YoY → VRT EMEA segment +20% YoY (demoted to weight 2)',
  },

  H21: {
    threshold: 200, weight: 2, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Equinix new bookings >$200M AND occupancy >96% → VRT colo-related orders +15% QoQ within 2Q (demoted to weight 2)',
  },

  // ─── Tier 6: NEW — CRDO parity audit + Apr rip post-mortem ───────────────

  'H-AR': {
    threshold: 3, weight: 4, direction: 'BULL',
    half_life_min: 4320,  // 3 days
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Analyst revision cluster: 3+ upward PT revisions OR 2+ upgrades in 7 days (would have fired Apr 8, 2 days before the +19% breakout)',
  },

  'H-AR_bear': {
    threshold: 3, weight: 4, direction: 'BEAR',
    half_life_min: 4320,
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Analyst revision cluster: 3+ downgrades or PT cuts in 7 days',
  },

  'H-ETN-LEAD': {
    threshold: 5, weight: 4, direction: 'CONTEXT',
    half_life_min: 2880,  // 2 days
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'ETN earnings reaction as VRT leading indicator (CRDO H24 parity). Sub-triggers: ETN+beat+up>5%→BULL; ETN+beat+down>3%→BEAR; ETN miss→STRONG BEAR. Note: Q1 cycle inverted (VRT Apr22, ETN May5); re-enables Q2 onward.',
  },

  'H-AWS': {
    threshold: 1, weight: 3, direction: 'CONTEXT',
    half_life_min: 2880,
    regime_class: 'EVENT',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'Amazon AWS-specific catalyst (CRDO H23 parity). Sub-triggers: Trainium→BEAR; region expansion→BULL; re:Invent power/cooling mention→STRONG BULL; AWS+VRT partnership→STRONG BULL.',
  },

  'H-EFFIC': {
    threshold: 1, weight: 1, direction: 'BULL',
    half_life_min: 1440,  // 24 hours — short because Jevons reversal is quick
    regime_class: 'MEAN_REV',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: true,
    description: 'AI efficiency paper (DeepSeek-class) Jevons reversal — contrarian BULL on the dip (CRDO H22 parity). Signal fires the buy after the initial AI-infra selloff.',
  },

  // ─── Parked (weight 0, recording only) ───────────────────────────────────
  'H-OPT': {
    threshold: 3, weight: 0, direction: 'CONTEXT',
    half_life_min: 480,
    regime_class: 'TREND',
    data_source: 'external_paid', confidence_tier: 'UNTESTED', enabled: false,
    description: 'VRT options unusual call volume >3x 20d avg (PARKED — Finnhub paid tier or UnusualWhales paid required; Phase 1 free-tier stack via options_flow_phase1_vrt2.js at weight 3 UNTESTED)',
  },

  H25: {
    threshold: 55, weight: 0, direction: 'BULL',
    half_life_min: 7200,
    regime_class: 'STRUCTURAL',
    data_source: 'browser_scan', confidence_tier: 'UNTESTED', enabled: false,
    description: 'MSFT Azure capex >55% of Azure revenue for 2 consecutive quarters → VRT gross margin +100bps (PARKED — requires transcript parsing not yet built)',
  },
};

// ── SIGNAL COOLDOWNS ──────────────────────────────────────────────────────────
// Minimum ms between consecutive fires of the same signal
const SIGNAL_COOLDOWNS = {
  S1_LAG:          86400000,   // 1 day
  S2:               3600000,   // 1 hour
  S8:               3600000,
  S_RS:            86400000,
  S_ETN_LEAD:       3600000,
  'S-CU':          86400000,
  COMPOSITE_BULL:  14400000,   // 4 hours
  STACK_BULL:      14400000,
  STACK_BEAR:      14400000,
  GAP_OPEN_BULL:   86400000,
  GAP_OPEN_BEAR:   86400000,
  'H-CORR':        21600000,   // 6 hours
  H1:              86400000,
  H3:              86400000,
  H5:             604800000,   // 1 week
  H6:              86400000,
  H8:              86400000,
  H9:             604800000,
  H10:             86400000,
  H11:             86400000,
  H12:             86400000,
  H13:             86400000,
  H14:             86400000,
  H15:            604800000,
  H17:             86400000,
  H18:            86400000,
  H19:             86400000,
  H20:             86400000,
  H21:             86400000,
  H22:             86400000,
  H22_buy:          3600000,   // 1 hour — rare, log every new one
  H24:             86400000,
  H25:             86400000,
  H26:             86400000,
  'H-AR':          86400000,
  'H-AR_bear':     86400000,
  'H-ETN-LEAD':    86400000,
  'H-AWS':         21600000,
  'H-EFFIC':       86400000,
  'H-INV':         86400000,
  'H-VRT-IR':       3600000,
  'H-OPT':          3600000,
};

// ── CORRELATION DEDUP MATRIX ──────────────────────────────────────────────────
// Pairs of signals sharing underlying driver. Used by composite scoring to
// prevent double-counting when correlated signals fire together.
// Symmetric: SIGNAL_CORR[a][b] === SIGNAL_CORR[b][a]
const SIGNAL_CORR = {
  // Price signals sharing ETN driver
  S1_LAG:        { COMPOSITE_BULL: 0.85, S_RS: 0.40, S_ETN_LEAD: 0.65, 'H-CORR': 0.50 },
  S_ETN_LEAD:    { S1_LAG: 0.65, COMPOSITE_BULL: 0.50, H3: 0.40, 'H-ETN-LEAD': 0.55 },
  COMPOSITE_BULL:{ S1_LAG: 0.85, S2: 0.60, S_ETN_LEAD: 0.50 },
  S2:            { COMPOSITE_BULL: 0.60, S_RS: 0.30 },
  S_RS:          { S1_LAG: 0.40, S2: 0.30 },
  'H-CORR':      { S1_LAG: 0.50, S_ETN_LEAD: 0.40 },

  // Stack/gap meta
  GAP_OPEN_BULL: { STACK_BULL: 0.30 },
  GAP_OPEN_BEAR: { STACK_BEAR: 0.30 },

  // Fundamental signals sharing transcript data
  H1:            { H14: 0.50, H3: 0.30 },
  H14:           { H1: 0.50 },
  H3:            { H1: 0.30, 'H-ETN-LEAD': 0.55, H11: 0.60 },
  H11:           { H3: 0.60 },
  'H-ETN-LEAD':  { H3: 0.55, S_ETN_LEAD: 0.55 },

  // Insider signals (mutually exclusive transaction codes — NOT correlated)
  // H22 and H22_buy intentionally absent from matrix

  // Analyst signals (can fire together — partial correlation)
  'H-AR':        { 'H-AR_bear': 0.0 },  // mutually exclusive direction

  // Macro/regime signals
  H18:           { S_RS: 0.30 },
  H24:           { H19: 0.20 },

  // AWS/capex signals
  'H-AWS':       { H1: 0.30 },
};

// ── REGIME WEIGHT MATRIX ──────────────────────────────────────────────────────
// Per-signal multipliers applied based on current regime vector.
// regime_detector_vrt2.js computes the 4D vector daily.
// Applied BEFORE confidence_tier discount in composite math.
//
// Format: REGIME_WEIGHTS[signal_id][regime_label] = multiplier
// Unlisted signals get 1.0× in all regimes.
//
// Regime labels: 'LOW_VOL_RISK_ON', 'ELEVATED_NEUTRAL', 'STRESSED_RISK_OFF', 'ELEVATED_RISK_ON'
const REGIME_WEIGHTS = {
  S1_LAG: {
    LOW_VOL_RISK_ON:   1.00,
    ELEVATED_NEUTRAL:  1.25, // mean-reversion works better under stress
    STRESSED_RISK_OFF: 0.50, // correlations break in crashes
    ELEVATED_RISK_ON:  1.10,
  },
  S2: {
    LOW_VOL_RISK_ON:   1.25, // momentum compounds in rallies
    ELEVATED_NEUTRAL:  1.00,
    STRESSED_RISK_OFF: 0.25, // momentum fails in crashes
    ELEVATED_RISK_ON:  1.15,
  },
  H22_buy: {
    LOW_VOL_RISK_ON:   1.50, // contrarian insider buy = alpha
    ELEVATED_NEUTRAL:  1.00,
    STRESSED_RISK_OFF: 2.00, // insider buys during stress = highest conviction
    ELEVATED_RISK_ON:  1.25,
  },
  H6: {
    LOW_VOL_RISK_ON:   1.00,
    ELEVATED_NEUTRAL:  1.00,
    STRESSED_RISK_OFF: 0.50, // no one cares about product news in crashes
    ELEVATED_RISK_ON:  1.00,
  },
  'H-AR': {
    LOW_VOL_RISK_ON:   1.25, // analyst flows accelerate in rallies
    ELEVATED_NEUTRAL:  1.00,
    STRESSED_RISK_OFF: 0.75, // downgrades dominate in stress
    ELEVATED_RISK_ON:  1.15,
  },
  'H-INV': {
    // Fundamental signal — regime-neutral
    LOW_VOL_RISK_ON:   1.00,
    ELEVATED_NEUTRAL:  1.00,
    STRESSED_RISK_OFF: 1.00,
    ELEVATED_RISK_ON:  1.00,
  },
  H24: {
    // VIX recovery signal only relevant in STRESSED regime
    LOW_VOL_RISK_ON:   0.00, // window inactive
    ELEVATED_NEUTRAL:  0.00, // window inactive
    STRESSED_RISK_OFF: 2.00, // this is the entire signal's purpose
    ELEVATED_RISK_ON:  0.50,
  },
  'H-EFFIC': {
    // Contrarian — most relevant when risk is off (AI selloff)
    LOW_VOL_RISK_ON:   0.50,
    ELEVATED_NEUTRAL:  1.00,
    STRESSED_RISK_OFF: 1.50,
    ELEVATED_RISK_ON:  0.75,
  },
};

// ── CONFIDENCE TIER DISCOUNTS ─────────────────────────────────────────────────
// Applied in composite scoring: effective_weight = base_weight × tier_discount × regime_mult × half_life_decay
const CONFIDENCE_TIER_DISCOUNTS = {
  BACKTESTED:  1.00,
  PROVISIONAL: 0.75,
  UNTESTED:    0.50,
  KILLED:      0.00,
};

// ── POSITION SIZING TABLE ─────────────────────────────────────────────────────
// Composite score → position size (% of VRT_BOOK).
// Applied by position_sizer_vrt2.js after regime and Kelly adjustments.
const POSITION_SIZING = [
  { min: 0,  max: 9,  pct: 0,   label: 'FLAT',      horizon_days: 0,   rationale: 'Noise — no trade' },
  { min: 10, max: 14, pct: 10,  label: 'LOW',        horizon_days: 5,   rationale: 'Exploratory — confirm with price action' },
  { min: 15, max: 19, pct: 25,  label: 'MEDIUM',     horizon_days: 10,  rationale: 'Standard conviction — Kelly-scaled' },
  { min: 20, max: 27, pct: 50,  label: 'HIGH',       horizon_days: 20,  rationale: 'Multiple uncorrelated signals stacking' },
  { min: 28, max: 35, pct: 75,  label: 'VERY_HIGH',  horizon_days: 30,  rationale: 'STACK_BULL + 2–3 Tier 1 signals' },
  { min: 36, max: Infinity, pct: 100, label: 'EXTREME', horizon_days: 30, rationale: 'H22_buy + STACK_BULL + H-INV convergence' },
];

// Bear-side mirror: short positions capped at 50% max given asymmetric loss profile
const POSITION_SIZING_BEAR = POSITION_SIZING.map(t => ({
  ...t,
  pct: Math.min(t.pct, 50),
  label: t.label + '_SHORT',
}));

// ── STOP-LOSS PROTOCOL ────────────────────────────────────────────────────────
const STOP_LOSS = {
  10:  { type: 'HARD',              atr_mult: null, adverse_pct: 5.0  },
  25:  { type: 'ATR_ADJUSTED',      atr_mult: 2.0,  adverse_pct: null },
  50:  { type: 'ATR_TRAILING',      atr_mult: 2.5,  adverse_pct: null, tighten_pct_per_5d: 10 },
  75:  { type: 'ATR_TRAILING_HARD', atr_mult: 3.0,  adverse_pct: 15.0 },
  100: { type: 'ATR_TRAILING_HARD', atr_mult: 3.0,  adverse_pct: 15.0 },
};

// ── DRAWDOWN KILL-SWITCH ──────────────────────────────────────────────────────
const DRAWDOWN_PROTOCOL = {
  consecutive_losers_half_size: 3,
  consecutive_losers_halt:      5,
  max_drawdown_pct_kill:        20,
  monthly_loss_pct_pause:       15,
  pause_days:                   30,
};

// ── BACKTEST GATES ────────────────────────────────────────────────────────────
// Enforced nightly by signal_audit_vrt2.js
const BACKTEST_GATES = {
  n_for_pause_check:       10,
  pause_threshold:          0.50,  // <50% hit rate at n=10 → auto-PAUSE
  n_for_kill:              15,
  kill_threshold:           0.55,  // <55% hit rate at n=15 → auto-KILL
  n_for_backtested:        15,
  backtested_threshold:     0.55,  // ≥55% hit rate at n=15 → promote to BACKTESTED
  cold_streak_double_hl:    3,     // 3 consecutive misses → half-life doubled until next hit
  n_early_pause:            5,
  early_pause_threshold:    0.45,  // <45% at n=5–9 → auto-PAUSE
};

module.exports = {
  SIGNAL_CONFIG,
  SIGNAL_COOLDOWNS,
  SIGNAL_CORR,
  REGIME_WEIGHTS,
  CONFIDENCE_TIER_DISCOUNTS,
  POSITION_SIZING,
  POSITION_SIZING_BEAR,
  STOP_LOSS,
  DRAWDOWN_PROTOCOL,
  BACKTEST_GATES,
  REVIEW_CADENCE,
};
