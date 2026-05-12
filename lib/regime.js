// CLAW VRT2 — lib/regime.js
//
// Regime detection helper. Reads the most recent regime_log row and
// returns the current regime vector + label for use in composite scoring.
//
// Regime is computed daily by jobs/regime_detector_vrt2.js.
// This module is import-only — it reads, never writes.
//
// Regime label mapping (for REGIME_WEIGHTS lookup in signal_config.js):
//   VIX LOW + HYG RISK_ON         → 'LOW_VOL_RISK_ON'
//   VIX ELEVATED + HYG NEUTRAL    → 'ELEVATED_NEUTRAL'
//   VIX ELEVATED + HYG RISK_ON    → 'ELEVATED_RISK_ON'
//   VIX STRESSED + HYG RISK_OFF   → 'STRESSED_RISK_OFF'
//   (all others)                  → 'ELEVATED_NEUTRAL' (default)

'use strict';

const { REGIME_WEIGHTS } = require('./signal_config');

// ── Regime label derivation ───────────────────────────────────────────────────
function deriveRegimeLabel(vixRegime, riskRegime) {
  // Four canonical regime labels used in REGIME_WEIGHTS:
  //   LOW_VOL_RISK_ON, ELEVATED_NEUTRAL, ELEVATED_RISK_ON, STRESSED_RISK_OFF
  if (vixRegime === 'STRESSED' && riskRegime === 'RISK_OFF') return 'STRESSED_RISK_OFF';
  if (vixRegime === 'LOW'      && riskRegime === 'RISK_ON')  return 'LOW_VOL_RISK_ON';
  // ELEVATED or NORMAL vix + RISK_ON = cautious bull (ELEVATED_RISK_ON)
  if ((vixRegime === 'ELEVATED' || vixRegime === 'NORMAL') && riskRegime === 'RISK_ON') return 'ELEVATED_RISK_ON';
  // Everything else defaults to cautious neutral
  return 'ELEVATED_NEUTRAL';
}

// ── Get current regime from DB ────────────────────────────────────────────────
function getCurrentRegime(db) {
  try {
    const row = db.prepare(
      'SELECT vix_regime, pmi_regime, rates_regime, risk_regime, full_vector ' +
      'FROM regime_log ORDER BY ts DESC LIMIT 1'
    ).get();

    if (!row) {
      // No regime data yet — return safe defaults
      return {
        vix:    'NORMAL',
        pmi:    'EXPANSION',
        rates:  'FLAT',
        risk:   'NEUTRAL',
        label:  'ELEVATED_NEUTRAL',
        vector: 'UNKNOWN',
      };
    }

    return {
      vix:    row.vix_regime   || 'NORMAL',
      pmi:    row.pmi_regime   || 'EXPANSION',
      rates:  row.rates_regime || 'FLAT',
      risk:   row.risk_regime  || 'NEUTRAL',
      label:  deriveRegimeLabel(row.vix_regime, row.risk_regime),
      vector: row.full_vector  || 'UNKNOWN',
    };
  } catch (e) {
    // regime_log table may not exist yet (first run before migration)
    return {
      vix: 'NORMAL', pmi: 'EXPANSION', rates: 'FLAT', risk: 'NEUTRAL',
      label: 'ELEVATED_NEUTRAL', vector: 'UNKNOWN',
    };
  }
}

// ── Apply regime multiplier to a signal weight ────────────────────────────────
function applyRegimeMultiplier(signalId, baseWeight, regimeLabel) {
  const regimeMap = REGIME_WEIGHTS[signalId];
  if (!regimeMap) return baseWeight; // unlisted signals get 1.0×
  const mult = regimeMap[regimeLabel];
  if (mult === undefined) return baseWeight;
  return baseWeight * mult;
}

// ── VIX binning helper (used by regime_detector_vrt2.js) ─────────────────────
function binVix(vixClose) {
  if (vixClose < 16) return 'LOW';
  if (vixClose < 22) return 'NORMAL';
  if (vixClose < 30) return 'ELEVATED';
  return 'STRESSED';
}

// ── HYG 30d return binning ────────────────────────────────────────────────────
function binHyg(hyg30dReturn) {
  if (hyg30dReturn < -3) return 'RISK_OFF';
  if (hyg30dReturn > 3)  return 'RISK_ON';
  return 'NEUTRAL';
}

// ── ISM PMI binning ───────────────────────────────────────────────────────────
function binPmi(pmi) {
  return pmi >= 50 ? 'EXPANSION' : 'CONTRACTION';
}

// ── 10Y yield 30d delta binning ───────────────────────────────────────────────
function binRates(delta30dBps) {
  if (delta30dBps < -25) return 'FALLING';
  if (delta30dBps > 25)  return 'RISING';
  return 'FLAT';
}

module.exports = {
  getCurrentRegime,
  applyRegimeMultiplier,
  deriveRegimeLabel,
  binVix,
  binHyg,
  binPmi,
  binRates,
};
