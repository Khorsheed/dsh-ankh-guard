#!/bin/bash
# install-systemd.sh — the systemd half of deployment shape C (see
# install-launchd.sh for the macOS half; the two generate different artifacts
# for the same supervision chain: service manager → guard CLI → watchdog →
# instance).
#
# The watchdog alone is a single point of failure: a bare detached watchdog
# (`supervise` without `--foreground`) that dies — SIGKILL, a wide pkill, a
# closed terminal, OOM — leaves the service down with zero automatic recovery.
# This script installs a user unit whose ExecStart runs the guard CLI's
# `supervise --foreground`: the CLI process IS the watchdog's parent and exits
# with it, so systemd restarts the whole chain.
#
# `Restart=on-failure` is the equivalent of launchd's `KeepAlive
# SuccessfulExit: false`: a watchdog that exits 0 is an INTENTIONAL stop (the
# `watchdog-stop` marker path) and stays down; anything else (SIGKILL, TERM →
# 143 via the watchdog's cleanup trap) is restarted. To stop supervision for
# good, `--uninstall`; the `watchdog-stop` marker alone will not stop a
# systemd unit.
#
# `StartLimitIntervalSec=0` disables the start rate limit ON PURPOSE. The
# default (5 starts / 10 s) puts a rapidly restarting unit into `failed` and
# stops trying — supervision would end silently, which is the exact failure
# this deployment shape exists to remove. The watchdog carries its own backoff
# and gives up into a crash page, so the retry budget belongs to it, not here.
#
# This script only ever installs a USER unit (`systemctl --user`), never a
# system one: no root, nothing under /etc. A user unit stops when the user's
# session ends unless lingering is enabled — that needs an administrator, so
# the script prints the command instead of running it.
#
# Usage:
#   install-systemd.sh --start "CMD" [--port N] [--home DIR] [--repo DIR]
#                      [--cli "CMD"] [--label NAME] [--force] [--print]
#   install-systemd.sh --uninstall [--label NAME]
#
#   --start "CMD"   REQUIRED: the shell command that starts the dsh instance
#                   (the same command you would pass to `supervise --start`).
#   --port N        port the watchdog owns (default 3080).
#   --home DIR      dsh root: state/, logs, DSH_HOME for the unit (default
#                   $DSH_HOME, else $HOME/.dsh-official).
#   --repo DIR      checkout the guard credential/rollback binds to (default
#                   DSH_HARNESS, else $HOME/code/deepseek-harness).
#   --cli "CMD"     guard CLI invocation prefix (default: this package's built
#                   lib/cli.js run via an absolute node path).
#   --label NAME    unit name without .service (default dsh-watchdog).
#   --force         first stop the running detached watchdog (TERM to the pid
#                   in <home>/state/watchdog.pid) so the unit becomes the one
#                   true owner; without it the install fails when a live
#                   detached watchdog holds the pidfile.
#   --print         write the unit to stdout and exit without touching
#                   systemctl. The only way to review the generated artifact
#                   on a machine without systemd (this package is developed on
#                   macOS), so it is also what the repo's checks exercise.
#
# The generated unit is machine-specific (absolute paths) and lives under
# ~/.config/systemd/user — nothing machine-specific is committed to the repo.
set -u

LABEL="${DSH_WD_LABEL:-dsh-watchdog}"
PORT="${DSH_WD_PORT:-3080}"
HOME_DIR="${DSH_WD_HOME:-${DSH_HOME:-$HOME/.dsh-official}}"
REPO="${DSH_WD_REPO:-${DSH_HARNESS:-$HOME/code/deepseek-harness}}"
START=""
CLI=""
FORCE=0
UNINSTALL=0
PRINT=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(dirname "$SCRIPT_DIR")"
BUILT_CLI="$PKG_ROOT/lib/cli.js"
# A systemd unit starts with an almost empty environment, so a bare `node`
# would fail the same way it did under launchd. Resolve node absolutely for the
# default CLI and snapshot this shell's PATH into the unit below.
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
    --print) PRINT=1; shift ;;
    *) echo "install-systemd.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$LABEL.service"

if [ "$UNINSTALL" = "1" ]; then
  systemctl --user disable --now "$LABEL.service" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "[install-systemd] removed $UNIT"
  exit 0
fi

if [ -z "$START" ]; then
  echo "install-systemd.sh: --start \"CMD\" is required (the command that starts the instance)" >&2
  exit 2
fi
if [ -z "$CLI" ]; then
  CLI="$DEFAULT_CLI"
  if [ -z "$CLI" ]; then
    echo "install-systemd.sh: no built lib/cli.js here and no --cli given; pass --cli \"node --import <tsx> <src/cli.ts>\" to run from source" >&2
    exit 2
  fi
fi

STATE_DIR="$HOME_DIR/state"
LOG_OUT="$STATE_DIR/watchdog.log"
LOG_ERR="$STATE_DIR/watchdog.stderr.log"

# One bash -c line: `exec <cli> supervise --foreground ...` so systemd restarts
# the CLI (which exits with the watchdog) — never the watchdog script directly.
PROGRAM="exec $CLI supervise --foreground --port $PORT --start $(printf '%q' "$START") --state-dir $(printf '%q' "$STATE_DIR") --repo $(printf '%q' "$REPO") --log $(printf '%q' "$LOG_OUT")"

# Quote one value as a single systemd argument. systemd does NOT parse shell
# quoting: it splits on whitespace and understands double quotes with backslash
# escapes. A `printf '%q'` string therefore arrives as many arguments instead of
# one, which silently truncates ExecStart at the first space.
systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# `StandardOutput=append:` takes a bare path with no quoting of its own, so a
# whitespace-bearing state directory cannot be expressed here. Refuse rather
# than emit a unit that would fail at start with an unhelpful parse error.
case "$HOME_DIR" in
  *[[:space:]]*)
    echo "install-systemd.sh: --home must not contain whitespace ($HOME_DIR) — systemd's StandardOutput=append: takes an unquoted path" >&2
    exit 2 ;;
esac

emit_unit() {
  cat <<UNIT
[Unit]
Description=dsh watchdog supervising :$PORT
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/bin/bash -c $(systemd_quote "$PROGRAM")
Environment=$(systemd_quote "DSH_HOME=$HOME_DIR")
Environment=$(systemd_quote "PATH=$PATH")
Restart=on-failure
RestartSec=2
StandardOutput=append:$LOG_OUT
StandardError=append:$LOG_ERR

[Install]
WantedBy=default.target
UNIT
}

if [ "$PRINT" = "1" ]; then
  emit_unit
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "install-systemd.sh: systemctl not found — this installer targets systemd. On macOS use install-launchd.sh; to review the unit anywhere, re-run with --print" >&2
  exit 2
fi

PIDFILE="$STATE_DIR/watchdog.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  OLD_PID="$(cat "$PIDFILE")"
  if [ "$FORCE" = "1" ]; then
    echo "[install-systemd] stopping the running detached watchdog $OLD_PID (TERM; its cleanup trap reaps the instance; the unit will adopt the port)"
    kill "$OLD_PID" 2>/dev/null
    # Wait for the old watchdog to actually die so it cannot win a pidfile race
    # with the unit we are about to start.
    i=0
    while [ $i -lt 30 ] && kill -0 "$OLD_PID" 2>/dev/null; do sleep 1; i=$((i + 1)); done
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "install-systemd.sh: watchdog $OLD_PID did not die within 30 s — refusing to install" >&2
      exit 1
    fi
    echo "[install-systemd] old watchdog gone"
  else
    echo "install-systemd.sh: a live watchdog ($OLD_PID) already owns the port; re-run with --force to replace it with the systemd unit" >&2
    exit 1
  fi
fi

mkdir -p "$STATE_DIR" "$UNIT_DIR"
if ! emit_unit > "$UNIT"; then
  echo "install-systemd.sh: failed to write $UNIT" >&2
  exit 1
fi

systemctl --user daemon-reload || { echo "install-systemd.sh: daemon-reload failed" >&2; exit 1; }
systemctl --user enable --now "$LABEL.service" \
  || { echo "install-systemd.sh: failed to enable $LABEL.service — run 'systemctl --user status $LABEL.service' to see the error" >&2; exit 1; }

echo "[install-systemd] installed $LABEL.service → supervises :$PORT via $UNIT"
echo "[install-systemd] log: $LOG_OUT (stderr: $LOG_ERR); uninstall with: $0 --uninstall --label $LABEL"
echo "[install-systemd] a user unit stops when your session ends; to keep it running after logout an administrator must run: loginctl enable-linger $(id -un)"
