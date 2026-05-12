#!/usr/bin/env python3
"""
CLAW VRT2 — Migrate from VRT v1 database
Imports price history, signals, and composite scores from vrt.db → vrt2.db.
Signals from v1 are preserved as historical record (is_backtest=1 for killed signals).

Run after setup_db_vrt2.js:
  cd ~/CLAW/VRT2
  python3 migrate_vrt_from_v1.py [path/to/vrt.db]

Default source path: ~/CLAW/VRT/vrt.db
"""

import sqlite3
import sys
import os
from datetime import datetime, timezone
from pathlib import Path

SRC_DEFAULT = Path.home() / 'CLAW' / 'VRT' / 'vrt.db'
DST_PATH    = Path(__file__).parent / 'vrt2.db'

# Signals killed in v2 — preserved as is_backtest=1 for historical reference
KILLED_SIGNALS = {'S1_LEAD', 'S3', 'S4', 'S9', 'S10'}

# Old tickers to exclude from live polling (data kept in DB for backtest purposes)
OLD_TICKERS_KEEP = {
    'AA', 'AMAT', 'CORZ', 'DELL', 'EQT', 'GNRC', 'HPE', 'HUT', 'LIN', 'NDSN'
}

def ts_to_date(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')

def migrate(src_path):
    if not src_path.exists():
        print(f"ERROR: Source DB not found at {src_path}")
        print("Usage: python3 migrate_vrt_from_v1.py [/path/to/vrt.db]")
        sys.exit(1)

    if not DST_PATH.exists():
        print(f"ERROR: Destination DB not found at {DST_PATH}")
        print("Run node setup_db_vrt2.js first.")
        sys.exit(1)

    print(f"Source:      {src_path}")
    print(f"Destination: {DST_PATH}")
    print()

    src = sqlite3.connect(src_path)
    dst = sqlite3.connect(DST_PATH)

    src.row_factory = sqlite3.Row
    dst.execute("PRAGMA journal_mode = WAL")
    dst.execute("PRAGMA foreign_keys = ON")

    # ── Prices ──────────────────────────────────────────────────────────────
    print("Migrating prices...")

    src_count = src.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
    print(f"  Source rows: {src_count:,}")

    insert_price = dst.execute  # will use executemany below
    rows = src.execute(
        "SELECT ts, ticker, price, open, high, low, volume, pct, source FROM prices"
    ).fetchall()

    # Migrate all price rows — old ticker data is kept for historical backtest
    dst.executemany(
        """INSERT OR IGNORE INTO prices
           (ts, ticker, price, open, high, low, volume, pct, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [(r['ts'], r['ticker'], r['price'], r['open'], r['high'],
          r['low'], r['volume'], r['pct'], r['source']) for r in rows]
    )
    dst.commit()

    dst_count = dst.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
    print(f"  Destination rows after migration: {dst_count:,}")

    # Ticker breakdown
    tickers = dst.execute(
        "SELECT ticker, COUNT(*) n FROM prices GROUP BY ticker ORDER BY ticker"
    ).fetchall()
    print(f"  Tickers: {len(tickers)}")
    for t in tickers:
        flag = ' ← old cohort (kept for backtest)' if t[0] in OLD_TICKERS_KEEP else ''
        print(f"    {t[0]:<8} {t[1]:>6} rows{flag}")

    # ── Signals ──────────────────────────────────────────────────────────────
    print("\nMigrating signals...")

    src_sigs = src.execute(
        "SELECT id, ts, hyp_id, trigger_val, trigger_desc, vrt_price, active FROM signals"
    ).fetchall()
    print(f"  Source signals: {len(src_sigs)}")

    now_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    migrated_sigs = 0
    skipped_sigs  = 0

    for sig in src_sigs:
        hyp_id = sig['hyp_id']
        # Rename old signal IDs to v2 equivalents
        if hyp_id == 'S1':
            hyp_id = 'S1_LAG'
        is_killed = 1 if hyp_id in KILLED_SIGNALS else 0
        phase_note = 'KILLED_V2' if is_killed else 'HISTORICAL'

        try:
            dst.execute(
                """INSERT OR IGNORE INTO signals
                   (ts, hyp_id, trigger_val, trigger_desc, vrt_price, active,
                    is_backtest, source, reason)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'v1_migrated', ?)""",
                (sig['ts'], hyp_id, sig['trigger_val'], sig['trigger_desc'],
                 sig['vrt_price'], sig['active'], is_killed, phase_note)
            )
            migrated_sigs += 1
        except Exception as e:
            skipped_sigs += 1
            print(f"  WARNING: signal {sig['id']} skip: {e}")

    dst.commit()

    print(f"  Migrated: {migrated_sigs} | Skipped: {skipped_sigs}")
    print(f"  Killed signals preserved as is_backtest=1: {KILLED_SIGNALS}")

    # ── Composite scores ──────────────────────────────────────────────────────
    print("\nMigrating composite scores...")

    src_comp = src.execute(
        """SELECT ts, score, direction, signals_active, earnings_weight,
                  position_pct, stop_price, target_price, note
           FROM composite_scores"""
    ).fetchall()
    print(f"  Source rows: {len(src_comp)}")

    dst.executemany(
        """INSERT OR IGNORE INTO composite_scores
           (ts, score, direction, signals_active, earnings_weight,
            position_pct, stop_price, target_price, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [(r['ts'], r['score'], r['direction'], r['signals_active'],
          r['earnings_weight'], r['position_pct'], r['stop_price'],
          r['target_price'], r['note']) for r in src_comp]
    )
    dst.commit()

    comp_count = dst.execute("SELECT COUNT(*) FROM composite_scores").fetchone()[0]
    print(f"  Destination composite_scores: {comp_count}")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Migration complete")
    print("=" * 60)

    tables = ['prices', 'signals', 'composite_scores', 'signal_weights']
    for t in tables:
        try:
            n = dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            print(f"  {t:<25} {n:>8,} rows")
        except Exception:
            print(f"  {t:<25} (table not found)")

    src.close()
    dst.close()
    print("\nDone. Run python3 backtest_harness_vrt2.py next.")

if __name__ == '__main__':
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC_DEFAULT
    migrate(src_path)
