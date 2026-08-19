#!/bin/bash
# dsh watchdog — launcher-layer babysitter for one dsh web instance.
#
# Owns a TCP port, respawns the host when it dies (including intentional
# self-restarts), runs the self-restart-guard canary on intentional restarts,
# rolls the repository back to the last known-good revision (the healthy-boot
# stamp — deployment-proven — else the guard checkpoint, else the green
# credential's HEAD) when the instance repeatedly fails to come up — leaving
# guard-backup-* branches on the discarded HEAD and uncommitted work — and
# serves a crash page with a retry button when it gives up. A boot failure
# whose error subject is a path outside the repository skips the rollback:
# reverting the checkout cannot fix a broken profile overlay or installed
# plugin. The enforcement point of the restart-safety mechanism lives here,
# outside the protected process — spawned detached (setsid) by the guard CLI's
# `supervise` verb or by a launcher, never by hand in normal operation.
#
# Process model: the watchdog reaps the instance it spawned, and on the way
# out (EXIT/TERM/INT) anything it still owns (the instance child, the give-up
# crash page) — supervision never leaves orphans. It does NOT assume a process
# group: the instance is not setsid'd, so reaping walks the descendant tree
# (pgrep -P) instead of killing a group. The supervised instance is expected to
# manage its own children on graceful shutdown; the tree walk is the
# best-effort net for the forced paths (SIGKILL cannot be trapped, and the next
# start's free_port covers that case).
#
# Everything is parameterized by environment (the guard CLI's `supervise` verb
# sets these); nothing here is machine-specific:
#   WD_HOME=DIR        dsh root (default: $DSH_HOME)
#   WD_STATE_DIR=DIR   state dir: markers, pidfile, logs (default: <WD_HOME>/state)
#   WD_PORT=N          port to own (default 3080)
#   WD_REPO=DIR        checkout the guard rollback operates on
#   WD_START="CMD"     shell command that starts the supervised instance
#   WD_GUARD="CMD"     how to invoke the guard CLI (default: dsh-ankh-guard)
#   WD_WAIT_OWNER=1    don't adopt the port; wait for the current owner to exit
#   WD_DELAY=N         sleep N seconds before adopting/observing the port
#   WD_SUPERVISE=1     write/check the pidfile (one watchdog only)
#   WD_BOOT_TIMEOUT=N  seconds to wait for the port to answer 200 (default 60)
#   WD_TEST_FAKE=1     launch a throwaway http server instead of the instance
#   WD_TEST_BREAK=1    launch a command that always fails (give-up testing)
#
# Markers under the state directory (written by the app or the agent):
#   restart-requested.json  -> intentional restart: respawn + canary + clear
#   watchdog-stop           -> exit the watchdog without respawn
set -u

# CLI convenience flag: `--supervise` == WD_SUPERVISE=1.
if [ "${1:-}" = "--supervise" ]; then SUPERVISE=1; else SUPERVISE=0; fi

DSH_ROOT="${WD_HOME:-${DSH_HOME:-}}"
PORT="${WD_PORT:-3080}"
DELAY="${WD_DELAY:-0}"
BOOT_TIMEOUT="${WD_BOOT_TIMEOUT:-60}"
REPO="${WD_REPO:-}"
# Every marker, the pidfile, and the attempt log live in ONE state directory:
# WD_STATE_DIR when the guard CLI names it (its --state-dir), else the
# conventional <home>/state. Deriving it here as <home>/state while the guard
# plugin reads its own configured stateDir breaks whenever the two differ (an
# explicit --state-dir, or the '<cwd>/.dsh-guard-state' fallback) — the marker
# the CLI wrote and the snapshot the plugin reads would land in two places.
STATE_DIR="${WD_STATE_DIR:-$DSH_ROOT/state}"
GIVE_UP_MARKER="$STATE_DIR/watchdog-gave-up"
RESTART_MARKER="$STATE_DIR/restart-requested.json"
STOP_MARKER="$STATE_DIR/watchdog-stop"
PIDFILE="$STATE_DIR/watchdog.pid"
ATTEMPT_LOG="$STATE_DIR/boot-attempt.log"

[ -n "$DSH_ROOT" ] || { echo "[watchdog] WD_HOME or DSH_HOME must be set" >&2; exit 1; }
export DSH_HOME="$DSH_ROOT"
mkdir -p "$STATE_DIR"
cd "$DSH_ROOT/home" 2>/dev/null || cd /tmp || exit 1

launch_instance() {
  if [ "${WD_TEST_BREAK:-0}" = "1" ]; then sleep 1; exit 1; fi
  if [ "${WD_TEST_FAKE:-0}" = "1" ]; then
    node -e "require('http').createServer((q,s)=>s.end('ok')).listen($PORT,'127.0.0.1')"
    exit
  fi
  if [ -z "${WD_START:-}" ]; then echo "[watchdog] WD_START unset — nothing to supervise" >&2; exit 1; fi
  sh -c "$WD_START"
}

healthy() {
  code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/")
  [ "$code" = "200" ]
}

# Reap a pid AND its descendants, deepest first (best effort). The watchdog
# guarantees the direct child; the sweep keeps grandchildren from outliving
# the instance — a single-pid kill is what orphaned listeners and left the
# EADDRINUSE race behind.
kill_tree() {
  local pid=$1 sig=${2:-TERM} child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child" "$sig"
  done
  kill -s "$sig" "$pid" 2>/dev/null || true
}

# Echo a pid and all its descendants, one per line.
pid_tree() {
  local pid=$1 child
  echo "$pid"
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    pid_tree "$child"
  done
}

# Every TCP port the instance tree is listening on, one per line. Used only to
# explain a boot-window timeout: a `--start` command that omits the port flag
# binds the application default instead of the supervised port, so the instance
# is healthy on a port nobody is watching while this watchdog polls an empty
# one. `lsof` takes the whole tree because the started command usually execs
# into the server through a shell.
instance_listen_ports() {
  local pids
  pids=$(pid_tree "$1" | paste -sd, -)
  [ -n "$pids" ] || return 0
  lsof -nP -a -p "$pids" -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk 'NR > 1 { n = split($9, a, ":"); print a[n] }' | sort -u
}

# Free the port: the watchdog is the declared owner, so it adopts an existing
# listener (the one-time bounce that moves a running instance under supervision).
free_port() {
  local pid p
  pid=$(lsof -tiTCP:$PORT -sTCP:LISTEN -P 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "[watchdog] freeing :$PORT from pid(s) $pid"
    for p in $pid; do kill_tree "$p" TERM; done
    sleep 2
  fi
}

# The rollback target: the last DEPLOYMENT-PROVEN revision (stamped by this
# watchdog on every healthy boot — a green credential proves build+test
# passed, never that the deployment composes and the instance comes up),
# falling back to the guard checkpoint, then the credential's HEAD.
# The reset itself (guard CLI) leaves guard-backup-* recovery anchors for the
# discarded HEAD and any uncommitted work, so recovery never needs the reflog.
rollback_sha() {
  node -e "
    const fs = require('fs')
    let sha = ''
    try {
      const boot = JSON.parse(fs.readFileSync('$STATE_DIR/last-good-boot.json', 'utf8'))
      if (typeof boot.revision === 'string' && boot.revision !== '') sha = boot.revision
    } catch {}
    if (sha === '') {
      try {
        const s = require('$STATE_DIR/self-restart-guard.json')
        sha = s.checkpoint?.revision ?? s.credential?.revision ?? ''
      } catch {}
    }
    process.stdout.write(sha)
  " 2>/dev/null
}

# A healthy boot proves the current HEAD runs in this deployment: stamp it as
# the preferred rollback target.
stamp_last_good_boot() {
  [ -n "$REPO" ] || return 0
  local sha
  sha=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) || return 0
  [ -n "$sha" ] || return 0
  printf '{"revision":"%s","at":%s}\n' "$sha" "$(date +%s)000" > "$STATE_DIR/last-good-boot.json"
}

# Roll back to a known-good revision — unless that revision already IS HEAD:
# the reset would be a commit no-op whose only effect is wiping uncommitted
# work (a real hazard with concurrent sessions on a shared checkout), so skip
# it. Returns 1 when the reset was skipped, so the boot-failure path keeps
# counting toward give-up instead of retrying a boot that cannot change.
rollback_to() {
  local sha="$1" head
  head=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
  if [ -n "$head" ] && [ "$sha" = "$head" ]; then
    echo "[watchdog] rollback target $sha is the current HEAD — skipping reset (nothing to roll back; a reset would only wipe uncommitted work)"
    return 1
  fi
  echo "[watchdog] rolling repo back to last known-good $sha"
  guard_reset "$sha"
}

# Where did the boot failure originate? The error's subject is the first
# absolute path on the `Error:` message line of the attempt log. Node's
# uncaught-exception printout leads with the THROW SITE (a repo-internal path
# naming the parser, not the cause) and follows with `    at ` stack frames,
# so the message line is the only reliable carrier of the offending path; the
# non-frame scan is the fallback for output without an `Error:` line. A
# subject outside the repository means a rollback — which only reverts the
# checkout — cannot fix this failure.
failure_subject_outside_repo() {
  [ -n "$REPO" ] || return 1
  local subject
  subject=$(grep -m1 -E '^[A-Za-z]*Error: ' "$ATTEMPT_LOG" 2>/dev/null | grep -oE '/[^ )]+' | head -1)
  if [ -z "$subject" ]; then
    subject=$(grep -v '^ *at ' "$ATTEMPT_LOG" 2>/dev/null | grep -oE '/[^ )]+' | head -1)
  fi
  [ -n "$subject" ] || return 1
  case "$subject" in
    "$REPO"|"$REPO"/*) return 1 ;;
    *) return 0 ;;
  esac
}

guard_cmd() {
  local bin="${WD_GUARD:-dsh-ankh-guard}"
  $bin "$@"
}

guard_verify() {
  guard_cmd verify --repo "$REPO" --state-dir "$STATE_DIR" >/dev/null 2>&1
}

guard_reset() {
  guard_cmd reset "$1" --repo "$REPO" --state-dir "$STATE_DIR"
}

# Give-up crash page: a tiny HTTP server served by the watchdog itself, with a
# retry button that signals the watchdog (SIGUSR1) — no terminal needed.
page_script() {
  cat <<'EOF'
const http = require('http');
const port = Number(process.env.WD_PORT || 3080);
const wd = Number(process.env.WD_PID);
http.createServer((req, res) => {
  if (req.url === '/restart') {
    try { process.kill(wd, 'SIGUSR1'); res.end('retrying...'); }
    catch (e) { res.statusCode = 500; res.end('signal failed: ' + e.message); }
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // 503, never 200: a probe that treats any 200 as "service healthy" must not
  // read the give-up page as the instance it replaced.
  res.statusCode = 503;
  res.end('<!doctype html><meta charset="utf-8"><title>dsh 未能启动</title>'
    + '<body style="font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center">'
    + '<div style="text-align:center"><h2>dsh 服务未能启动</h2>'
    + '<p>看门狗多次尝试仍未拉起服务。点击重试，或查看看门狗日志。</p>'
    + '<form action="/restart"><button style="font-size:18px;padding:10px 28px">重试</button></form></div></body>');
}).listen(port, '127.0.0.1');
EOF
}

retry_on_usrs() {
  echo "[watchdog] USR1 received — clearing give-up marker and retrying"
  rm -f "$GIVE_UP_MARKER"
  if [ -n "${page_pid:-}" ]; then kill "$page_pid" 2>/dev/null; fi
  failures=0
  reset_done=0
  port_races=0
}

# --supervise: one watchdog only. The claim must be atomic — a check-then-write
# (`[ -f ]` + `kill -0`, then `>`) is a TOCTOU window in which two watchdogs
# starting together both find no live owner, both write, and both supervise the
# same port. `set -C` (noclobber) makes the redirect itself fail when the file
# exists, so exactly one racer creates it and the others take the exit path.
# Note this runs BEFORE the cleanup trap is installed: a loser must not remove
# the winner's pidfile on its way out.
if [ "$SUPERVISE" = "1" ]; then
  mkdir -p "$(dirname "$PIDFILE")" 2>/dev/null || true
  claimed=0
  attempt=0
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    if (set -C; echo $$ > "$PIDFILE") 2>/dev/null; then claimed=1; break; fi
    owner=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      echo "[watchdog] already supervised by pid $owner; exiting"
      exit 0
    fi
    # Stale (owner gone) or empty pidfile: drop it and race for the claim
    # again. Losing that race is correct — the next pass sees a live owner and
    # exits through the branch above.
    rm -f "$PIDFILE"
  done
  if [ "$claimed" != "1" ]; then
    echo "[watchdog] could not claim $PIDFILE after $attempt attempts" >&2
    exit 1
  fi
fi

# Graceful launch: let the scheduling turn finish before the adoption bounce.
if [ "$DELAY" -gt 0 ] 2>/dev/null; then sleep "$DELAY"; fi

rm -f "$GIVE_UP_MARKER"
failures=0
reset_done=0
port_races=0

trap 'retry_on_usrs' USR1

# Reap what we spawned on the way out — the instance child and the give-up
# crash page. Without this, TERM/INT (or a plain exit) orphans them to PPID 1:
# the leak that left three crash pages on 8/16, and the held port the
# EADDRINUSE branch then had to free. SIGKILL cannot be trapped; the next
# start's free_port covers that case. (`set -u` — guard every var.)
cleanup() {
  if [ -n "${page_pid:-}" ]; then kill "$page_pid" 2>/dev/null; fi
  if [ -n "${child:-}" ]; then kill_tree "$child" TERM; fi
  # Drop the pidfile ONLY while it names us: a successor watchdog may have
  # already claimed it in the restart window, and deleting theirs would let a
  # second supervisor in.
  if [ -f "$PIDFILE" ] && [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ]; then
    rm -f "$PIDFILE"
  fi
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT

if [ "${WD_WAIT_OWNER:-0}" = "1" ]; then
  # Adoption ahead of a self-restart: the current owner exits on its own.
  echo "[watchdog] waiting for the current owner of :$PORT to exit"
  while lsof -tiTCP:$PORT -sTCP:LISTEN -P >/dev/null 2>&1; do sleep 1; done
  echo "[watchdog] port free — taking over"
else
  free_port
fi

while true; do
  echo "[watchdog] starting instance on :$PORT (failures=$failures)"
  # Capture this attempt's output for failure-domain classification. Plain
  # redirection only — never > >(tee …) process substitution: a sandboxed or
  # detached spawner can EPERM on the /dev/fd/N that >() opens (workspace-write
  # sandboxes do), killing the instance before it runs. On failure the attempt
  # log is mirrored into this log below; a healthy run's boot message names
  # the file its output lives in.
  : > "$ATTEMPT_LOG"
  launch_instance > "$ATTEMPT_LOG" 2>&1 &
  child=$!
  # Boot window: the instance is up when the port answers 200.
  up=0
  boot_limit=$(( $(date +%s) + BOOT_TIMEOUT ))
  while [ "$(date +%s)" -lt "$boot_limit" ]; do
    if ! kill -0 "$child" 2>/dev/null; then break; fi
    if healthy; then up=1; break; fi
    sleep 1
  done

  if [ "$up" = "0" ]; then
    # Read the bound ports BEFORE reaping — once the child is gone there is no
    # way left to tell "never started" from "started on the wrong port".
    bound=""
    if kill -0 "$child" 2>/dev/null; then bound=$(instance_listen_ports "$child"); fi
    # Never came up (or died); stop a still-alive child and reap it.
    if kill -0 "$child" 2>/dev/null; then kill "$child" 2>/dev/null; fi
    wait "$child" 2>/dev/null
    # Mirror the captured output into the watchdog log: with plain redirection
    # (see the launch site) the attempt log is the only place the failure was
    # written, and the watchdog log is where an operator looks first.
    sed 's/^/[instance] /' "$ATTEMPT_LOG" 2>/dev/null

    if grep -q 'EADDRINUSE' "$ATTEMPT_LOG" 2>/dev/null; then
      if grep 'EADDRINUSE' "$ATTEMPT_LOG" | grep -qE "[:.]$PORT([^0-9]|$)"; then
        # The supervised port was still held (a leftover process, a slow exit)
        # — an operational race, not a code regression. The watchdog owns this
        # port, so free it and retry WITHOUT counting toward rollback or
        # give-up. Bounded: once freeing stops winning the port back, the owner
        # is outside this watchdog's reach and retrying is a hot spin.
        port_races=$((port_races + 1))
        if [ "$port_races" -le 5 ]; then
          echo "[watchdog] boot hit EADDRINUSE on :$PORT — freeing the port and retrying (not a code failure, attempt $port_races/5)"
          free_port
          continue
        fi
        echo "[watchdog] :$PORT is still held after 5 free attempts — counting this as a boot failure"
      else
        # EADDRINUSE on a port this watchdog does not own: the start command
        # targets somewhere else, and freeing :$PORT cannot release it. The
        # unconditional retry this replaces never counted the attempt, so a
        # start command aimed at an occupied foreign port respawned the
        # instance in a tight loop with no backoff and no give-up.
        echo "[watchdog] boot hit EADDRINUSE on a port other than the supervised :$PORT — the --start command targets a port this watchdog does not own; freeing :$PORT cannot fix that"
        reset_done=1
      fi
    fi

    failures=$((failures + 1))
    echo "[watchdog] instance failed to come up (failure #$failures)"

    # The instance came up on a port this watchdog does not own: a start-command
    # argument, not a code regression. Resetting the checkout cannot change a
    # command line, so mark the rollback spent (same escape hatch as a failure
    # whose subject lives outside the repository) and keep counting toward the
    # crash page, which is what makes the misconfiguration visible.
    if [ -n "$bound" ] && ! printf '%s\n' "$bound" | grep -qx "$PORT"; then
      echo "[watchdog] instance bound :$(printf '%s' "$bound" | paste -sd, -) but supervision owns :$PORT — the --start command does not bind the supervised port; a repository rollback cannot fix that"
      reset_done=1
    fi

    if [ "$failures" -ge 2 ] && [ "$reset_done" -eq 0 ]; then
      sha=$(rollback_sha)
      if [ -z "$sha" ]; then
        echo "[watchdog] no guard credential/checkpoint recorded; cannot roll back"
      elif failure_subject_outside_repo; then
        # The failure lives outside the checkout (profile overlay, installed
        # plugin, environment) — reverting the repository cannot fix it.
        echo "[watchdog] boot failure originates outside $REPO — repository rollback cannot fix it; leaving the checkout untouched"
        reset_done=1
      else
        if rollback_to "$sha"; then
          reset_done=1
          failures=0
          continue
        fi
        # The target already is HEAD: the reset was skipped, so keep counting
        # toward give-up — retrying a boot that cannot change is pointless.
        reset_done=1
      fi
    fi

    if [ "$failures" -ge 4 ]; then
      echo "[watchdog] giving up after $failures consecutive failures"
      printf '%s giving up after %s failures\n' "$(date '+%F %T')" "$failures" > "$GIVE_UP_MARKER"
      echo "[watchdog] serving crash page on :$PORT — click 重试 or send SIGUSR1 to $$"
      WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
      page_pid=$!
      wait "$page_pid"
      continue
    fi

    sleep $((failures * 5))
    continue
  fi

  # Instance is up.
  echo "[watchdog] instance up on :$PORT — instance output: $ATTEMPT_LOG"
  stamp_last_good_boot

  # Intentional restart: run the guard canary (credential fresh + HEAD match).
  if [ -f "$RESTART_MARKER" ]; then
    if guard_verify; then
      echo "[watchdog] canary PASS — clearing restart marker"
      rm -f "$RESTART_MARKER"
    else
      echo "[watchdog] canary FAIL — rolling back to last known-good"
      sha=$(rollback_sha)
      if [ -n "$sha" ]; then rollback_to "$sha" || true; fi
      rm -f "$RESTART_MARKER"
      failures=0
      reset_done=0
      continue
    fi
  else
    # Unplanned exit (crash, or a stop outside the guard): the instance is
    # back, but nobody knows — the report machinery only hears from the
    # scheduled path. Leave a record the plugin reports on this boot, unless
    # one still awaits its report (never overwrite a pending record).
    node -e "
      const fs = require('fs')
      const file = '$STATE_DIR/last-restart.json'
      try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (r.reportedAt === undefined) process.exit(0)
      } catch {}
      fs.writeFileSync(file, JSON.stringify({ exitAt: Date.now(), unexpected: true }) + '\n')
    " && echo "[watchdog] unplanned exit recovered — left a report record for the next session"
  fi

  failures=0
  reset_done=0
  port_races=0
  wait "$child"
  exit_code=$?

  # Explicit stop: exit the watchdog without respawn.
  if [ -f "$STOP_MARKER" ]; then
    echo "[watchdog] stop marker present — exiting"
    rm -f "$STOP_MARKER" "$PIDFILE"
    exit 0
  fi

  sleep 3
  if healthy; then
    free_port
  fi
done
