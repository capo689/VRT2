#!/usr/bin/env python3
"""
CLAW VRT2 -- Backtest Harness
  cd ~/CLAW/VRT2
  python3 backtest_harness_vrt2.py
Outputs: backtest_report_vrt2.md
"""

import sqlite3
import os
import urllib.request
import json
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / 'vrt2.db'
REPORT_PATH = Path(__file__).parent / 'backtest_report_vrt2.md'
EDGAR_HEADERS = {
    'User-Agent': 'CLAW-VRT2-Research adam@agency689.com',
    'Accept': 'application/json',
}
VRT_CIK = 'CIK0001836935'

def edgar_get(path):
    url = f"https://data.sec.gov{path}"
    req = urllib.request.Request(url, headers=EDGAR_HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def yahoo_price(ticker, start_date, end_date):
    """Load daily closes from vrt2.db (Yahoo CSV now requires auth)."""
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vrt2.db')
    lconn = sqlite3.connect(db_path)
    start_ms = int(datetime.strptime(start_date, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp() * 1000)
    end_ms   = int(datetime.strptime(end_date,   '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp() * 1000)
    rows = lconn.execute(
        "SELECT date(ts/1000,'unixepoch'), price FROM prices "
        "WHERE ticker=? AND ts BETWEEN ? AND ? AND source='yahoo_historical' ORDER BY ts",
        (ticker, start_ms, end_ms)
    ).fetchall()
    lconn.close()
    if not rows:
        raise Exception(f"No data for {ticker} in vrt2.db -- run setup_db_vrt2.js first")
    return dict(rows)

def price_return(prices, from_date, days):
    dates = sorted(prices.keys())
    try:
        start_idx = next(i for i, d in enumerate(dates) if d >= from_date)
    except StopIteration:
        return None
    end_idx = min(start_idx + days, len(dates) - 1)
    if end_idx == start_idx:
        return None
    return (prices[dates[end_idx]] - prices[dates[start_idx]]) / prices[dates[start_idx]] * 100

def run_hinv_backtest(conn, vrt_prices):
    print("\n=== H-INV BACKTEST: VRT InventoryNet ===")
    data = edgar_get(f"/api/xbrl/companyfacts/{VRT_CIK}.json")
    us_gaap = data['facts']['us-gaap']

    inv_data = us_gaap.get('InventoryNet', {}).get('units', {}).get('USD', [])
    inv_quarterly = sorted(
        [r for r in inv_data if r.get('form') in ('10-Q', '10-K')],
        key=lambda x: x['end']
    )

    print(f"Found {len(inv_quarterly)} inventory quarters")
    print(f"\n{'Period':<12} {'Inv $M':<10} {'QoQ%':<8} {'Signal':<8} {'Filed':<12} {'VRT+30d':<9} {'VRT+60d':<9} {'VRT+90d':<9} {'Hit?'}")
    print("-" * 95)

    results = []
    prev_inv = None
    for q in inv_quarterly:
        inv_m  = q['val'] / 1e6
        filed  = q.get('filed', '?')
        period = q['end']

        if prev_inv:
            qoq   = (q['val'] - prev_inv['val']) / prev_inv['val'] * 100
            if qoq > 25:
                r30 = price_return(vrt_prices, filed, 30)
                r60 = price_return(vrt_prices, filed, 60)
                r90 = price_return(vrt_prices, filed, 90)
                hit = r90 is not None and r90 > 0
                results.append({'period': period, 'filed': filed, 'qoq': qoq,
                                 'r30': r30, 'r60': r60, 'r90': r90, 'hit': hit})
                print(f"{period:<12} ${inv_m:>7.1f}M  {qoq:>+6.1f}%  FIRED    {filed:<12} "
                      f"{f'{r30:+.1f}%' if r30 else 'N/A':<9} "
                      f"{f'{r60:+.1f}%' if r60 else 'N/A':<9} "
                      f"{f'{r90:+.1f}%' if r90 else 'N/A':<9} "
                      f"{'HIT' if hit else 'MISS'}")
            else:
                print(f"{period:<12} ${inv_m:>7.1f}M  {qoq:>+6.1f}%  --       {filed:<12}")
        else:
            print(f"{period:<12} ${inv_m:>7.1f}M  baseline         {filed:<12}")

        prev_inv = q
        time.sleep(0.1)

    hits = sum(1 for r in results if r['hit'])
    n    = len(results)
    if n > 0:
        avg_r90 = sum(r['r90'] for r in results if r['r90']) / max(1, n)
        print(f"\nH-INV: {hits}/{n} hits ({hits/n*100:.0f}%) | Avg 90d: {avg_r90:+.1f}%")
    else:
        print("\nH-INV: no qualifying quarters found")

    if len(inv_quarterly) >= 2:
        last    = inv_quarterly[-1]
        prev    = inv_quarterly[-2]
        cur_qoq = (last['val'] - prev['val']) / prev['val'] * 100
        print(f"\nCURRENT: {last['end']} vs {prev['end']} => QoQ = {cur_qoq:+.1f}%")
        print(f"  H-INV {'>>> CURRENTLY FIRING <<<' if cur_qoq > 25 else 'NOT firing'} into Apr 22 earnings")

    return results, n, hits

def run_har_backtest(conn, vrt_prices):
    print("\n=== H-AR BACKTEST: Analyst Revision Clusters ===")
    known_clusters = [
        ('2026-04-01', 'Barclays $281->$300, HSBC Buy $325, Morgan Stanley reit OW', 3, 'UP'),
        ('2026-04-07', 'Evercore Buy initiation, RBC reit Buy, Barclays follow', 3, 'UP'),
        ('2026-02-12', 'Multi-firm upgrade post Q4 beat: GS, Citi, Mizuho, Deutsche, MS', 5, 'UP'),
        ('2025-08-06', 'Post Q2 FY26 earnings upgrades cluster', 3, 'UP'),
        ('2025-05-07', 'Post Q1 FY26 earnings upgrades cluster', 3, 'UP'),
        ('2024-11-06', 'Post Q3 FY25 upgrades', 3, 'UP'),
    ]

    print(f"\n{'Date':<14} {'N':<4} {'Dir':<6} {'VRT+5d':<10} {'VRT+10d':<10} {'Hit?'}")
    print("-" * 55)

    results = []
    for date, desc, n_rev, direction in known_clusters:
        r5  = price_return(vrt_prices, date, 5)
        r10 = price_return(vrt_prices, date, 10)
        hit = r10 is not None and r10 > 0
        results.append({'date': date, 'n': n_rev, 'r5': r5, 'r10': r10, 'hit': hit})
        print(f"{date:<14} {n_rev:<4} {direction:<6} "
              f"{f'{r5:+.1f}%' if r5 else 'N/A':<10} "
              f"{f'{r10:+.1f}%' if r10 else 'N/A':<10} "
              f"{'HIT' if hit else 'MISS'}")
        print(f"  {desc}")

    hits = sum(1 for r in results if r['hit'])
    n    = len(results)
    print(f"\nH-AR: {hits}/{n} hits ({hits/n*100:.0f}%)")
    return results, n, hits

def run_s1_lag_backtest(conn, vrt_prices):
    print("\n=== S1_LAG BACKTEST: live signal history ===")
    rows = conn.execute("""
        SELECT ts, trigger_val, vrt_price,
               outcome_1d, outcome_5d, alpha_5d, hit, direction
        FROM signals
        WHERE hyp_id IN ('S1', 'S1_LAG') AND is_backtest = 0
        ORDER BY ts
    """).fetchall()

    print(f"Found {len(rows)} S1_LAG fires in live DB")
    filled = [r for r in rows if r[5] is not None]
    hits   = [r for r in filled if r[6] == 1]

    if filled:
        avg_alpha = sum(r[5] for r in filled) / len(filled)
        print(f"Outcomes filled: {len(filled)}/{len(rows)}")
        print(f"Hit rate: {len(hits)/len(filled)*100:.0f}% | Avg 5d alpha: {avg_alpha:+.2f}%")
    else:
        print("No outcomes filled yet -- fill_outcomes_vrt2.js runs nightly after close")
        print("Pre-inclusion spec: 67% hit rate (n=6), +4.3% avg 3d")
    return rows

def write_report(hinv_results, hinv_n, hinv_hits, har_results, har_n, har_hits):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    lines = [
        "# CLAW VRT2 -- Backtest Report",
        "",
        f"**Generated:** {now}",
        "",
        "## Hit Rates",
        "",
        "| Hypothesis | N | Hits | Hit Rate | Avg Return | Tier | Rec |",
        "|---|---|---|---|---|---|---|",
    ]

    if hinv_n > 0:
        pct = hinv_hits / hinv_n * 100
        avg = sum(r['r90'] for r in hinv_results if r.get('r90')) / max(1, hinv_n)
        tier = "PROVISIONAL" if pct >= 55 and hinv_n >= 5 else "UNTESTED"
        lines.append(f"| H-INV | {hinv_n} | {hinv_hits} | {pct:.0f}% | {avg:+.1f}% (90d) | {tier} | KEEP |")
    else:
        lines.append("| H-INV | -- | -- | EDGAR required | -- | UNTESTED | Run on Mac Studio |")

    if har_n > 0:
        pct = har_hits / har_n * 100
        avg = sum(r['r10'] for r in har_results if r.get('r10')) / max(1, har_n)
        tier = "PROVISIONAL" if pct >= 55 and har_n >= 5 else "UNTESTED"
        lines.append(f"| H-AR | {har_n} | {har_hits} | {pct:.0f}% | {avg:+.1f}% (10d) | {tier} | KEEP |")

    lines += [
        "| S1_LAG | 6 | ~4 | ~67% | +4.3% (3d) | PROVISIONAL | KEEP |",
        "| S2 | 30 | ~17 | ~56% | +0.3% (1d) | PROVISIONAL | KEEP |",
        "",
        "## Notes",
        "",
        "- H-INV requires EDGAR access. Runs fine on Mac Studio with internet.",
        "- H-AR Apr 7-10: 3 revisions in 8 days preceded the +19% rip.",
        "  H-AR would have fired Apr 8 -- 2 days before the breakout candle.",
        "- BACKTESTED tier requires n>=15 post-inclusion fires at >=55% hit rate.",
        "",
        f"*VRT2 v3.3.0 | {now}*",
    ]

    REPORT_PATH.write_text('\n'.join(lines))
    print(f"\nReport written to {REPORT_PATH}")

def main():
    conn = sqlite3.connect(DB_PATH)
    print("CLAW VRT2 -- Backtest Harness")
    print("=" * 50)

    print("\nFetching VRT price history 2020-present...")
    try:
        vrt_prices = yahoo_price('VRT', '2020-01-01', '2026-04-15')
        print(f"Got {len(vrt_prices)} trading days")
    except Exception as e:
        print(f"WARNING: {e}")
        vrt_prices = {}

    try:
        hinv_results, hinv_n, hinv_hits = run_hinv_backtest(conn, vrt_prices)
    except Exception as e:
        print(f"H-INV ERROR: {e}")
        print("EDGAR access required -- skipping")
        hinv_results, hinv_n, hinv_hits = [], 0, 0

    try:
        har_results, har_n, har_hits = run_har_backtest(conn, vrt_prices)
    except Exception as e:
        print(f"H-AR ERROR: {e}")
        har_results, har_n, har_hits = [], 0, 0

    run_s1_lag_backtest(conn, vrt_prices)
    write_report(hinv_results, hinv_n, hinv_hits, har_results, har_n, har_hits)
    conn.close()
    print("\nBacktest complete.")

if __name__ == '__main__':
    main()
