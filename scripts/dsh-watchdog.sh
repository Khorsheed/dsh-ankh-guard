#!/bin/bash
# dsh watchdog — launcher-layer babysitter for one dsh web instance.
#
# Owns a TCP port, respawns the host when it dies (including intentional
# self-restarts), runs the self-restart-guard canary on intentional restarts,
# rolls back to the guard checkpoint when the instance repeatedly fails to
# come up, and serves a crash page with a retry button when it gives up. The
# enforcement point of the restart-safety mechanism lives here, outside the
# protected process — spawned detached (setsid) by the guard CLI's `supervise`
# verb or by a launcher, never by hand in normal operation.
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

checkpoint_sha() {
  node -e "try{const s=require('$DSH_ROOT/state/self-restart-guard.json');process.stdout.write(s.checkpoint?.revision??'')}catch{}" 2>/dev/null
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
  launch_instance &
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
    failures=$((failures + 1))
    echo "[watchdog] instance failed to come up (failure #$failures)"

    if [ "$failures" -ge 2 ] && [ "$reset_done" -eq 0 ]; then
      sha=$(checkpoint_sha)
      if [ -n "$sha" ]; then
        echo "[watchdog] rolling repo back to guard checkpoint $sha"
        guard_reset "$sha"
        reset_done=1
        failures=0
        continue
      fi
      echo "[watchdog] no guard checkpoint recorded; cannot roll back"
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

  # Intentional restart: run the guard canary (credential fresh + HEAD match).
  if [ -f "$RESTART_MARKER" ]; then
    if guard_verify; then
      echo "[watchdog] canary PASS — clearing restart marker"
      rm -f "$RESTART_MARKER"
    else
      echo "[watchdog] canary FAIL — rolling back to checkpoint"
      sha=$(checkpoint_sha)
      if [ -n "$sha" ]; then guard_reset "$sha"; fi
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
