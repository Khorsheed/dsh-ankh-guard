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
# Everything is parameterized by environment (the guard CLI's `supervise` verb
# sets these); nothing here is machine-specific:
#   WD_HOME=DIR        dsh root: markers, pidfile, state (default: $DSH_HOME)
#   WD_PORT=N          port to own (default 3080)
#   WD_REPO=DIR        checkout the guard rollback operates on
#   WD_START="CMD"     shell command that starts the supervised instance
#   WD_GUARD="CMD"     how to invoke the guard CLI (default: dsh-ankh-guard)
#   WD_WAIT_OWNER=1    don't adopt the port; wait for the current owner to exit
#   WD_DELAY=N         sleep N seconds before adopting/observing the port
#   WD_SUPERVISE=1     write/check the pidfile (one watchdog only)
#   WD_TEST_FAKE=1     launch a throwaway http server instead of the instance
#   WD_TEST_BREAK=1    launch a command that always fails (give-up testing)
#
# Markers under <WD_HOME>/state (written by the app or the agent):
#   restart-requested.json  -> intentional restart: respawn + canary + clear
#   watchdog-stop           -> exit the watchdog without respawn
set -u

# CLI convenience flag: `--supervise` == WD_SUPERVISE=1.
if [ "${1:-}" = "--supervise" ]; then SUPERVISE=1; else SUPERVISE=0; fi

DSH_ROOT="${WD_HOME:-${DSH_HOME:-}}"
PORT="${WD_PORT:-3080}"
DELAY="${WD_DELAY:-0}"
REPO="${WD_REPO:-}"
GIVE_UP_MARKER="$DSH_ROOT/state/watchdog-gave-up"
RESTART_MARKER="$DSH_ROOT/state/restart-requested.json"
STOP_MARKER="$DSH_ROOT/state/watchdog-stop"
PIDFILE="$DSH_ROOT/state/watchdog.pid"
ATTEMPT_LOG="$DSH_ROOT/state/boot-attempt.log"

[ -n "$DSH_ROOT" ] || { echo "[watchdog] WD_HOME or DSH_HOME must be set" >&2; exit 1; }
export DSH_HOME="$DSH_ROOT"
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

# Free the port: the watchdog is the declared owner, so it adopts an existing
# listener (the one-time bounce that moves a running instance under supervision).
free_port() {
  local pid
  pid=$(lsof -tiTCP:$PORT -sTCP:LISTEN -P 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "[watchdog] freeing :$PORT from pid(s) $pid"
    kill $pid 2>/dev/null
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
      const boot = JSON.parse(fs.readFileSync('$DSH_ROOT/state/last-good-boot.json', 'utf8'))
      if (typeof boot.revision === 'string' && boot.revision !== '') sha = boot.revision
    } catch {}
    if (sha === '') {
      try {
        const s = require('$DSH_ROOT/state/self-restart-guard.json')
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
  printf '{"revision":"%s","at":%s}\n' "$sha" "$(date +%s)000" > "$DSH_ROOT/state/last-good-boot.json"
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
  guard_cmd verify --repo "$REPO" --state-dir "$DSH_HOME/state" >/dev/null 2>&1
}

guard_reset() {
  guard_cmd reset "$1" --repo "$REPO" --state-dir "$DSH_HOME/state"
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
}

# --supervise: one watchdog only.
if [ "$SUPERVISE" = "1" ]; then
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "[watchdog] already supervised by pid $(cat "$PIDFILE"); exiting"
    exit 0
  fi
  echo $$ > "$PIDFILE"
fi

# Graceful launch: let the scheduling turn finish before the adoption bounce.
if [ "$DELAY" -gt 0 ] 2>/dev/null; then sleep "$DELAY"; fi

rm -f "$GIVE_UP_MARKER"
failures=0
reset_done=0

trap 'retry_on_usrs' USR1

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
  # Capture this attempt's output for failure-domain classification while
  # keeping the instance's output flowing to the watchdog log as before.
  : > "$ATTEMPT_LOG"
  launch_instance > >(tee -a "$ATTEMPT_LOG") 2>&1 &
  child=$!
  # Boot window: the instance is up when the port answers 200.
  up=0
  boot_limit=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$boot_limit" ]; do
    if ! kill -0 "$child" 2>/dev/null; then break; fi
    if healthy; then up=1; break; fi
    sleep 1
  done

  if [ "$up" = "0" ]; then
    # Never came up (or died); stop a still-alive child and reap it.
    if kill -0 "$child" 2>/dev/null; then kill "$child" 2>/dev/null; fi
    wait "$child" 2>/dev/null

    if grep -q 'EADDRINUSE' "$ATTEMPT_LOG" 2>/dev/null; then
      # The port was still held (a leftover process, a slow exit) — an
      # operational race, not a code regression. The watchdog owns the port,
      # so free it and retry WITHOUT counting toward rollback or give-up.
      echo "[watchdog] boot hit EADDRINUSE on :$PORT — freeing the port and retrying (not a code failure)"
      free_port
      continue
    fi

    failures=$((failures + 1))
    echo "[watchdog] instance failed to come up (failure #$failures)"

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
  echo "[watchdog] instance up on :$PORT"
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
  fi

  failures=0
  reset_done=0
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
