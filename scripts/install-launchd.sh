#!/bin/bash
# install-launchd.sh — give the dsh watchdog a supervisor (deployment shape C).
#
# The watchdog alone is a single point of failure: a bare detached watchdog
# (`supervise` without `--foreground`) that dies — SIGKILL, a wide pkill, a
# closed terminal, OOM — leaves the service down with zero automatic recovery
# (the 2026-08-18 outage). This script installs a launchd KeepAlive job whose
# ProgramArguments run the guard CLI's `supervise --foreground`: the CLI
# process IS the watchdog's parent and exits with it, so launchd restarts the
# whole chain — "the watchdog restarts the instance" stops being an empty
# promise exactly when the watchdog itself dies.
#
# KeepAlive is `SuccessfulExit: false`: a watchdog that exits 0 is an
# INTENTIONAL stop (the `watchdog-stop` marker path) and stays down; anything
# else (SIGKILL → 137, TERM → 143 via the watchdog's cleanup trap) is
# restarted. To stop supervision for good, `--uninstall` (bootout + remove
# the plist); the `watchdog-stop` marker alone will not stop a launchd job.
#
# Usage:
#   install-launchd.sh --start "CMD" [--port N] [--home DIR] [--repo DIR]
#                      [--cli "CMD"] [--label NAME] [--force]
#   install-launchd.sh --uninstall [--label NAME]
#
#   --start "CMD"   REQUIRED: the shell command that starts the dsh instance
#                   (the same command you would pass to `supervise --start`).
#   --port N        port the watchdog owns (default 3080).
#   --home DIR      dsh root: state/, logs, DSH_HOME for the job (default
#                   $DSH_HOME, else $HOME/.dsh-official).
#   --repo DIR      checkout the guard credential/rollback binds to (default
#                   DSH_HARNESS, else $HOME/code/deepseek-harness).
#   --cli "CMD"     guard CLI invocation prefix, e.g. "node lib/cli.js" or
#                   "node --import <tsx> src/cli.ts" (default: this package's
#                   built lib/cli.js run via node).
#   --label NAME    launchd label (default com.dsh.watchdog).
#   --force         first stop the running detached watchdog (TERM to the pid
#                   in <home>/state/watchdog.pid) so the launchd job becomes
#                   the one true owner; without it the install fails when a
#                   live detached watchdog holds the pidfile.
#
# The generated plist is machine-specific (absolute paths) and lives in
# ~/Library/LaunchAgents — nothing machine-specific is committed to the repo.
set -u

LABEL="${DSH_WD_LABEL:-com.dsh.watchdog}"
PORT="${DSH_WD_PORT:-3080}"
HOME_DIR="${DSH_WD_HOME:-${DSH_HOME:-$HOME/.dsh-official}}"
REPO="${DSH_WD_REPO:-${DSH_HARNESS:-$HOME/code/deepseek-harness}}"
START=""
CLI=""
FORCE=0
UNINSTALL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(dirname "$SCRIPT_DIR")"
BUILT_CLI="$PKG_ROOT/lib/cli.js"
# launchd jobs run with a minimal PATH (/usr/bin:/bin:...), so bare `node`
# would fail with exit 127 ("node: not found") both for the CLI invocation and
# for the instance's WD_START. Resolve node absolutely for the default CLI and
# snapshot this shell's PATH into the plist's EnvironmentVariables below.
NODE_BIN="$(command -v node || echo /usr/bin/node)"
if [ -f "$BUILT_CLI" ]; then
  DEFAULT_CLI="$NODE_BIN $BUILT_CLI"
else
  DEFAULT_CLI=""
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --start) START="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --home) HOME_DIR="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --cli) CLI="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "install-launchd.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[install-launchd] removed $PLIST"
  exit 0
fi

if [ -z "$START" ]; then
  echo "install-launchd.sh: --start \"CMD\" is required (the command that starts the instance)" >&2
  exit 2
fi
if [ -z "$CLI" ]; then
  CLI="$DEFAULT_CLI"
  if [ -z "$CLI" ]; then
    echo "install-launchd.sh: no built lib/cli.js here and no --cli given; pass --cli \"node --import <tsx> <src/cli.ts>\" to run from source" >&2
    exit 2
  fi
fi

PIDFILE="$HOME_DIR/state/watchdog.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  OLD_PID="$(cat "$PIDFILE")"
  if [ "$FORCE" = "1" ]; then
    echo "[install-launchd] stopping the running detached watchdog $OLD_PID (TERM; its cleanup trap reaps the instance; the launchd job will adopt the port)"
    kill "$OLD_PID" 2>/dev/null
    # Wait for the old watchdog to actually die so it cannot win a pidfile race
    # with the job we are about to start.
    i=0
    while [ $i -lt 30 ] && kill -0 "$OLD_PID" 2>/dev/null; do sleep 1; i=$((i + 1)); done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "install-launchd.sh: watchdog $OLD_PID did not die within 30 s — refusing to install" >&2
      exit 1
    fi
    echo "[install-launchd] old watchdog gone"
  else
    echo "install-launchd.sh: a live watchdog ($OLD_PID) already owns the port; re-run with --force to replace it with the launchd job" >&2
    exit 1
  fi
fi

STATE_DIR="$HOME_DIR/state"
LOG_OUT="$STATE_DIR/watchdog.log"
LOG_ERR="$STATE_DIR/watchdog.stderr.log"
mkdir -p "$STATE_DIR"

# XML-escape a value for the plist body.
xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

# One bash -c line: `exec <cli> supervise --foreground ...` so launchd restarts
# the CLI (which exits with the watchdog) — never the watchdog script directly.
PROGRAM="exec $CLI supervise --foreground --port $PORT --start $(printf '%q' "$START") --state-dir $(printf '%q' "$STATE_DIR") --repo $(printf '%q' "$REPO") --log $(printf '%q' "$LOG_OUT")"

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$(dirname "$PLIST")"
if ! cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>$(xml_escape "$PROGRAM")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key>
    <string>$(xml_escape "$HOME_DIR")</string>
    <key>PATH</key>
    <string>$(xml_escape "$PATH")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_OUT")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_ERR")</string>
</dict>
</plist>
EOF
then
  echo "install-launchd.sh: failed to write $PLIST" >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
  || launchctl load "$PLIST" 2>/dev/null \
  || { echo "install-launchd.sh: failed to load $PLIST — run 'launchctl bootstrap gui/\$(id -u) $PLIST' to see the error" >&2; exit 1; }

echo "[install-launchd] installed $LABEL → supervises :$PORT via $PLIST"
echo "[install-launchd] log: $LOG_OUT (stderr: $LOG_ERR); uninstall with: $0 --uninstall --label $LABEL"
