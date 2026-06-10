#!/bin/bash
set -euo pipefail

# install-schedule.sh — macOS LaunchAgent for the daily living-profile refresh.
#
#   ./scripts/install-schedule.sh install [--project <dir>]
#   ./scripts/install-schedule.sh uninstall
#   ./scripts/install-schedule.sh status
#
# Scheduling semantics:
#   - StartCalendarInterval 00:15 LOCAL time (the user's midnight).
#   - launchd coalesces firings missed while ASLEEP and runs once on wake.
#   - RunAtLoad fires at login/boot, which covers machines POWERED OFF at
#     midnight; viber-refresh's date stamp makes those catch-ups
#     at-most-once-per-day no-ops when today already ran.
#
# Linux equivalent (not installed here): a systemd user timer with
# OnCalendar=*-*-* 00:15 and Persistent=true.

LABEL="ai.minutework.viber.refresh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$REPO_DIR/bin/viber-refresh"
VIBER_HOME="${VIBER_HOME:-$HOME/.viber}"
CONFIG_FILE="$VIBER_HOME/refresh/config"
LOG_DIR="$VIBER_HOME/logs"

cmd="${1:-install}"
shift || true

ensure_config() {
  mkdir -p "$(dirname "$CONFIG_FILE")" "$LOG_DIR"
  chmod 700 "$VIBER_HOME" "$(dirname "$CONFIG_FILE")" 2>/dev/null || true
  if [ ! -f "$CONFIG_FILE" ]; then
    cat >"$CONFIG_FILE" <<EOF
# viber daily-refresh config (sourced by bin/viber-refresh; shell syntax).
VIBER_REFRESH_PROJECT_PATH="${PROJECT_PATH:-$PWD}"
# Endpoints (defaults target the hosted service; self-hosted setups override):
#VIBER_PUBLIC_DJ_BASE_URL="http://127.0.0.1:8002"
#VIBER_PLATFORM_BASE_URL="http://127.0.0.1:8000"
# Use the local repo's skill instead of fetching it over the network:
VIBER_SKILL_URL="file://$REPO_DIR/skill/SKILL.md"
# Pin the analysis agent (claude|codex|cursor); otherwise auto-detected:
#VIBER_AGENT="claude"
# Non-interactive submission token source. Without it, nightly runs are
# PREPARE-ONLY (full analysis + cache warm + validated payload, nothing sent).
# Self-hosted operators can point this at a platform management command, e.g.:
#VIBER_TOKEN_COMMAND="cd /path/to/mwv3-platform-dj && poetry run python manage.py mint_builder_submission_token <handle>"
# Temporary off-switch:
#VIBER_REFRESH_DISABLED=1
EOF
    chmod 600 "$CONFIG_FILE"
    echo "wrote config template: $CONFIG_FILE"
  fi
}

case "$cmd" in
  install)
    PROJECT_PATH=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --project) PROJECT_PATH="$2"; shift 2 ;;
        *) echo "unknown flag $1" >&2; exit 2 ;;
      esac
    done
    [ -x "$RUNNER" ] || chmod +x "$RUNNER"
    ensure_config
    mkdir -p "$HOME/Library/LaunchAgents"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>0</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/launchd.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed: $LABEL (daily at 00:15 local + catch-up at login/wake)"
    echo "config:    $CONFIG_FILE"
    echo "logs:      $LOG_DIR/refresh.log"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "uninstalled: $LABEL (config and logs kept under $VIBER_HOME)"
    ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      echo "loaded: $LABEL"
      launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|last exit|run interval" | head -5 || true
    else
      echo "not loaded: $LABEL"
    fi
    "$RUNNER" --status
    ;;
  *)
    echo "usage: $0 install [--project <dir>] | uninstall | status" >&2
    exit 2
    ;;
esac
