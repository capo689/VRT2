#!/bin/bash
# ════════════════════════════════════════════════════════════════════════
# scheduler_dispatch.sh · CLAW VRT2 · v3.3.0
#
# Called by launchd on schedule. Decides what to run based on current
# ET time. Uses lock files to prevent double-firing within a window.
#
# VRT2 Schedule (all times ET):
#   Every 5 min:                  process_browser_results_vrt2.js
#   Every 30 min (xx:00, xx:30):  scan_watchdog_vrt2.js
#   02:00–02:09 ET:               signal_audit_vrt2.js (nightly auto-kill)
#   05:00–05:09 ET:               analyst_revisions_vrt2.js (H-AR feed)
#   06:00–06:09 ET:               queue_daily_review_vrt2.js [THE BIG ONE]
#   06:30–06:34 ET:               aws_news_vrt2.js (H-AWS daily)
#   09:31–09:39 ET:               regime_detector_vrt2.js + risk_monitor_vrt2.js
#   10:00–10:04 ET:               options_flow_phase1_vrt2.js (H-OPT scan 1)
#   09/13/17/21 ET:               queue_scan_tasks_vrt2.js
#   Every 6h (06/12/18 ET):       queue_news_tasks_vrt2.js
#   14:00–14:04 ET:               options_flow_phase1_vrt2.js (H-OPT scan 2)
#   16:05–16:14 ET:               fill_outcomes_vrt2.js + recalibrate_weights_vrt2.js
# ════════════════════════════════════════════════════════════════════════

set -u
set -o pipefail

# ── RESOLVE PATHS ────────────────────────────────────────────────────────
SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_PATH" ]; do
    SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
JOBS_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
ROOT="$(cd "$JOBS_DIR/.." && pwd)"

LOG_DIR="$ROOT/logs"
STATE_DIR="$ROOT/state"
LOG="$LOG_DIR/dispatch.log"

mkdir -p "$LOG_DIR" "$STATE_DIR"

# ── LOCATE NODE ──────────────────────────────────────────────────────────
if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
    NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
    NODE="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
    NODE="/usr/local/bin/node"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: node not found" >> "$LOG"
    exit 1
fi

# ── TIME VARIABLES ───────────────────────────────────────────────────────
HOUR=$(TZ=America/New_York date +%H)
MIN=$(TZ=America/New_York date +%M)
DOW=$(TZ=America/New_York date +%u)   # 1=Mon ... 7=Sun
ET_DATE=$(TZ=America/New_York date +%Y-%m-%d)
NOW_ISO=$(date '+%Y-%m-%d %H:%M:%S')
HOUR_N=$((10#$HOUR))
MIN_N=$((10#$MIN))

# ── HELPERS ──────────────────────────────────────────────────────────────
log() { echo "[$NOW_ISO] $*" >> "$LOG"; }

run_job() {
    local job="$1"
    local lock_name="${2:-}"

    if [ -n "$lock_name" ]; then
        local lock_file="$STATE_DIR/${lock_name}.${ET_DATE}.ran"
        if [ -f "$lock_file" ]; then
            log "  ∙ $job — already ran today ($lock_name)"
            return 0
        fi
        find "$STATE_DIR" -maxdepth 1 -name "${lock_name}.*.ran" \
            ! -name "${lock_name}.${ET_DATE}.ran" -delete 2>/dev/null || true
    fi

    log "  → $job"
    local start_ts
    start_ts=$(date +%s)
    (cd "$ROOT" && "$NODE" "jobs/$job" 2>&1) >> "$LOG"
    local exit_code=$?
    local duration=$(( $(date +%s) - start_ts ))
    log "  ← $job exit=$exit_code (${duration}s)"

    if [ -n "$lock_name" ] && [ "$exit_code" -eq 0 ]; then
        touch "$STATE_DIR/${lock_name}.${ET_DATE}.ran"
    fi
    return $exit_code
}

in_window() {
    local h_start=$1 h_end=$2 m_start=$3 m_end=$4
    if [ "$HOUR_N" -eq "$h_start" ] && [ "$HOUR_N" -eq "$h_end" ]; then
        [ "$MIN_N" -ge "$m_start" ] && [ "$MIN_N" -le "$m_end" ] && return 0
    elif [ "$HOUR_N" -gt "$h_start" ] && [ "$HOUR_N" -lt "$h_end" ]; then
        return 0
    elif [ "$HOUR_N" -eq "$h_start" ] && [ "$MIN_N" -ge "$m_start" ]; then
        return 0
    elif [ "$HOUR_N" -eq "$h_end" ] && [ "$MIN_N" -le "$m_end" ]; then
        return 0
    fi
    return 1
}

# ── DISPATCH ─────────────────────────────────────────────────────────────
log "dispatch tick — ET ${HOUR}:${MIN} dow=${DOW} node=${NODE}"

# ── Every 5 min: drain browser results ──────────────────────────────────
run_job "process_browser_results_vrt2.js"

# ── Every 30 min: watchdog ───────────────────────────────────────────────
if { [ "$MIN_N" -ge 0 ] && [ "$MIN_N" -le 4 ]; } || \
   { [ "$MIN_N" -ge 30 ] && [ "$MIN_N" -le 34 ]; }; then
    if [ "$MIN_N" -lt 30 ]; then
        run_job "scan_watchdog_vrt2.js" "watchdog_${HOUR}_00"
    else
        run_job "scan_watchdog_vrt2.js" "watchdog_${HOUR}_30"
    fi
fi

# ── 02:00 ET: nightly signal audit (auto-kill gate) ──────────────────────
if in_window 2 2 0 9; then
    run_job "signal_audit_vrt2.js" "signal_audit"
fi

# ── 05:00 ET: analyst revisions (H-AR data feed) ────────────────────────
if in_window 5 5 0 9; then
    run_job "analyst_revisions_vrt2.js" "analyst_revisions"
fi

# ── 06:00 ET: THE BIG ONE — daily review ────────────────────────────────
if in_window 6 6 0 9; then
    log "  *** DAILY REVIEW WINDOW ***"
    run_job "queue_daily_review_vrt2.js" "daily_review"
fi

# ── 06:30 ET: AWS news (H-AWS daily scan) ───────────────────────────────
if in_window 6 6 30 39; then
    run_job "aws_news_vrt2.js" "aws_news"
fi

# ── 09:31 ET weekdays: regime detector + risk monitor at open ────────────
if in_window 9 9 31 39 && [ "$DOW" -le 5 ]; then
    run_job "regime_detector_vrt2.js" "regime_open"
    run_job "risk_monitor_vrt2.js"    "risk_open"
fi

# ── 10:00 ET weekdays: options flow Phase 1 (scan 1) ─────────────────────
if in_window 10 10 0 9 && [ "$DOW" -le 5 ]; then
    run_job "options_flow_phase1_vrt2.js" "options_1000"
fi

# ── 14:00 ET weekdays: options flow Phase 1 (scan 2) ─────────────────────
if in_window 14 14 0 9 && [ "$DOW" -le 5 ]; then
    run_job "options_flow_phase1_vrt2.js" "options_1400"
fi

# ── Scan queues: 09:00, 13:00, 17:00 ET weekdays + 21:00 daily ──────────
if in_window 9 9 0 9 || in_window 13 13 0 9 || in_window 17 17 0 9; then
    if [ "$DOW" -le 5 ]; then
        run_job "queue_scan_tasks_vrt2.js" "scan_${HOUR}"
    fi
fi
if in_window 21 21 0 9; then
    run_job "queue_scan_tasks_vrt2.js" "scan_21"
fi

# ── Every 6h: news monitoring (06/12/18 ET) ──────────────────────────────
for news_hour in 6 12 18; do
    if in_window "$news_hour" "$news_hour" 0 9; then
        run_job "queue_news_tasks_vrt2.js" "news_${news_hour}"
    fi
done

# ── 16:05 ET weekdays: fill outcomes + recalibrate weights ───────────────
if in_window 16 16 5 19 && [ "$DOW" -le 5 ]; then
    run_job "fill_outcomes_vrt2.js"         "fill_outcomes"
    run_job "recalibrate_weights_vrt2.js"   "recalibrate"
fi

# ── 16:30 ET weekdays: correlation job (VRT/ETN history for H-CORR) ──────
# Runs after fill_outcomes so today's price data is in DB.
if in_window 16 16 30 44 && [ "$DOW" -le 5 ]; then
    run_job "correlation_vrt2.js"           "correlation"
fi

# ── 18:00 ET weekdays: insider transactions (Form 4, code=P only) ─────────
# EDGAR Form 4s due by 6pm next business day — check at 6pm same day for
# same-day filings, and again at 9pm to catch late filers.
if in_window 18 18 0 9 && [ "$DOW" -le 5 ]; then
    run_job "insider_vrt2.js"               "insider_1800"
fi
if in_window 21 21 15 29 && [ "$DOW" -le 5 ]; then
    run_job "insider_vrt2.js"               "insider_2115"
fi

# ── Mon+Thu 07:00 ET: EDGAR filings check (10-Q, 8-K, DEF 14A) ───────────
# Filings post async — Mon/Thu coverage catches most material events within 2 business days.
if in_window 7 7 0 9 && { [ "$DOW" -eq 1 ] || [ "$DOW" -eq 4 ]; }; then
    run_job "edgar_vrt2.js"                 "edgar"
fi

log "dispatch tick complete"
exit 0
