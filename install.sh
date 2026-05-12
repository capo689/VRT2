#!/bin/bash
# ════════════════════════════════════════════════════════════════════════
# install.sh · CLAW VRT2 · v3.3.0
#
# Production installer for the launchd agents. Installs into
# ~/Library/LaunchAgents and loads them.
#
# Usage:
#   ./install.sh              # install + load
#   ./install.sh --dry-run    # show what would happen
#   ./install.sh --uninstall  # unload + remove
#
# Idempotent — safe to run multiple times.
# ════════════════════════════════════════════════════════════════════════

set -u
set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VRT2_ROOT="$SCRIPT_DIR"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

if [ ! -f "$VRT2_ROOT/claw_server_vrt2.js" ]; then
    echo "ERROR: install.sh must be run from the VRT2 root directory" >&2
    echo "  current: $VRT2_ROOT" >&2
    exit 1
fi

# ── LOCATE NODE ──────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
    NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
    NODE_BIN="/usr/local/bin/node"
else
    echo "ERROR: node not found in PATH" >&2
    exit 1
fi

# ── ARG PARSING ──────────────────────────────────────────────────────────
DRY_RUN=0
UNINSTALL=0
for arg in "$@"; do
    case "$arg" in
        --dry-run)   DRY_RUN=1 ;;
        --uninstall) UNINSTALL=1 ;;
    esac
done

PLISTS=(
    "com.adamcagle.claw.vrt2.scan"
    "com.adamcagle.claw.vrt2.queue"
)

echo "CLAW VRT2 — launchd installer"
echo "  VRT2 root: $VRT2_ROOT"
echo "  Node:      $NODE_BIN"
echo "  LaunchAgents: $LAUNCH_AGENTS"
echo ""

# ── UNINSTALL ────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
    echo "Uninstalling..."
    for label in "${PLISTS[@]}"; do
        dst="$LAUNCH_AGENTS/${label}.plist"
        if [ -f "$dst" ]; then
            if [ "$DRY_RUN" -eq 0 ]; then
                launchctl unload "$dst" 2>/dev/null || true
                rm -f "$dst"
                echo "  ✓ Unloaded + removed $label"
            else
                echo "  [dry-run] Would unload + remove $label"
            fi
        else
            echo "  · $label not installed, skip"
        fi
    done
    echo "Done."
    exit 0
fi

# ── INSTALL ───────────────────────────────────────────────────────────────
mkdir -p "$LAUNCH_AGENTS"
mkdir -p "$VRT2_ROOT/logs" "$VRT2_ROOT/state"

for label in "${PLISTS[@]}"; do
    src="$VRT2_ROOT/${label}.plist"
    dst="$LAUNCH_AGENTS/${label}.plist"

    if [ ! -f "$src" ]; then
        echo "  WARNING: $src not found — skipping" >&2
        continue
    fi

    # Template-substitute the actual VRT2 root and node path
    plist_content=$(sed \
        -e "s|/Users/adamcagle/CLAW/VRT2|$VRT2_ROOT|g" \
        -e "s|/usr/local/bin/node|$NODE_BIN|g" \
        "$src")

    if [ "$DRY_RUN" -eq 1 ]; then
        echo "  [dry-run] Would install $label"
        echo "    src: $src → dst: $dst"
    else
        # Unload first if already running
        launchctl unload "$dst" 2>/dev/null || true

        echo "$plist_content" > "$dst"
        launchctl load "$dst"
        echo "  ✓ Installed + loaded $label"
    fi
done

echo ""
if [ "$DRY_RUN" -eq 0 ]; then
    echo "Installation complete."
    echo ""
    echo "Next steps:"
    echo "  1. node setup_db_vrt2.js           # create DB + backfill (if not done)"
    echo "  2. python3 migrate_vrt_from_v1.py  # import vrt.db history"
    echo "  3. node migrate_v3_1_vrt2.js       # seed signal_weights"
    echo "  4. node migrate_v3_2_vrt2.js       # verify quality columns"
    echo "  5. python3 backtest_harness_vrt2.py # H-INV backtest (PRIORITY)"
    echo "  6. node jobs/browser_runner_vrt2.js --login  # log into claude.ai"
    echo "  7. node claw_server_vrt2.js        # start server"
    echo "  8. open http://127.0.0.1:51752     # open dashboard"
    echo ""
    echo "Port: 51752 | DB: vrt2.db"
fi
