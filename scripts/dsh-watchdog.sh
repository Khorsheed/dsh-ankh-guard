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
#   WD_REPO=DIR        credential/rollback repository (not the host checkout)
#   WD_HARNESS_ROOT=DIR host checkout exported to the child as DSH_HARNESS
#   WD_START="CMD"     shell command that starts the supervised instance
#   WD_PROFILE=NAME    the profile the instance boots (default web) — its
#                      composition inputs are snapshotted at healthy boots and
#                      restored when boot failures originate outside the repo
#   WD_GUARD="CMD"     how to invoke the guard CLI (default: dsh-ankh-guard)
#   WD_WAIT_OWNER=1    don't adopt the port; wait for the current owner to exit
#   WD_DELAY=N         sleep N seconds before adopting/observing the port
#   WD_INITIATOR=ID    session that established supervision; the adoption
#                      takeover's report record is addressed to it
#   WD_ADOPTION=1      the CLI saw a live owner at supervise time — the first
#                      boot is a takeover (report it), not a first-ever boot
#   WD_SUPERVISE=1     write/check the pidfile (one watchdog only)
#   WD_BOOT_TIMEOUT=N  seconds to prove application readiness (default 60)
#   WD_TAKEOVER_FROM=P replace this live watchdog's pidfile claim before the
#                      old instance is interrupted (launch cutover only)
#   WD_CUTOVER_ID=ID   durable launch-cutover receipt transaction
#   WD_CUTOVER_POLICY= restore-previous or wait-for-user (approved pre-stop)
#   WD_CUTOVER_DELAY_SECONDS=N grace after supervisor claim before old-child stop
#   WD_PREVIOUS_CHILD_*=PID/start token authoritative old supervisor child root
#   WD_PREVIOUS_LISTENER_*=PID/start token listener inside that old child tree
#   WD_READY_STABILITY_SECONDS=N unchanged child/listener proof window (default 3)
#   WD_BROWSER_HANDOFF=required|off after an authenticated launch-URL exchange
#   WD_TRANSITION_PLAN_SHA256=SHA-256 signals a prepared filesystem transition
#                      bound to the active cutover; the guard CLI reads the
#                      durable plan and journal rather than trusting this value
#   WD_BROWSER_HANDOFF_TIMEOUT_SECONDS=N wait for original-tab acknowledgement,
#                      then (after fallback open) for fallback acknowledgement
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
HARNESS_ROOT="${WD_HARNESS_ROOT:-${DSH_HARNESS:-}}"
PROFILE="${WD_PROFILE:-web}"
START_CMD="${WD_START:-}"
CUTOVER_ID="${WD_CUTOVER_ID:-}"
CUTOVER_POLICY="${WD_CUTOVER_POLICY:-}"
CUTOVER_ROLE="${WD_CUTOVER_ROLE:-target}"
PREVIOUS_START="${WD_PREVIOUS_START:-}"
PREVIOUS_HOME="${WD_PREVIOUS_HOME:-}"
PREVIOUS_REPO="${WD_PREVIOUS_REPO:-}"
PREVIOUS_HARNESS_ROOT="${WD_PREVIOUS_HARNESS_ROOT:-}"
PREVIOUS_PROFILE="${WD_PREVIOUS_PROFILE:-}"
PREVIOUS_CHILD_PID="${WD_PREVIOUS_CHILD_PID:-}"
PREVIOUS_CHILD_START="${WD_PREVIOUS_CHILD_START:-}"
PREVIOUS_LISTENER_PID="${WD_PREVIOUS_LISTENER_PID:-}"
PREVIOUS_LISTENER_START="${WD_PREVIOUS_LISTENER_START:-}"
BROWSER_HANDOFF="${WD_BROWSER_HANDOFF:-off}"
TARGET_FAILURE_LIMIT="${WD_TARGET_FAILURE_LIMIT:-2}"
READY_STABILITY_SECONDS="${WD_READY_STABILITY_SECONDS:-3}"
BROWSER_HANDOFF_TIMEOUT_SECONDS="${WD_BROWSER_HANDOFF_TIMEOUT_SECONDS:-8}"
TRANSITION_PLAN_SHA256="${WD_TRANSITION_PLAN_SHA256:-}"
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
CONTROL_FILE="$STATE_DIR/launch-cutover-control.json"
CONTROL_ABORT_FILE="$STATE_DIR/launch-cutover-abort.json"
CONTROL_RESTORE_FILE="$STATE_DIR/launch-cutover-restore-previous.json"
BROWSER_HANDOFF_REQUEST_FILE="$STATE_DIR/browser-handoff-request.json"
BROWSER_HANDOFF_ACK_FILE="$STATE_DIR/browser-handoff-ack.json"

# Timestamp every lifecycle line so a durable receipt can be correlated with
# supervisor/child PIDs across launchd, systemd, and detached CLI restarts.
wd_log() {
  printf '%s [watchdog] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

resolve_tool() {
  local name=$1 candidate
  shift
  for candidate in "$@"; do [ -x "$candidate" ] && { printf '%s' "$candidate"; return 0; }; done
  command -v "$name" 2>/dev/null || return 1
}

# macOS tool sessions commonly omit /usr/sbin from PATH. Listener identity is
# a safety proof, not optional telemetry, so resolve canonical absolute paths
# and fail loud when the proof machinery truly is unavailable.
LSOF_BIN=$(resolve_tool lsof /usr/sbin/lsof /usr/bin/lsof) || { wd_log "lsof is required to prove listener ownership" >&2; exit 1; }
PS_BIN=$(resolve_tool ps /bin/ps /usr/bin/ps) || { wd_log "ps is required to prove process identity" >&2; exit 1; }
PGREP_BIN=$(resolve_tool pgrep /usr/bin/pgrep /bin/pgrep) || { wd_log "pgrep is required to manage the supervised child tree" >&2; exit 1; }
SYSCTL_BIN=$(resolve_tool sysctl /usr/sbin/sysctl /sbin/sysctl 2>/dev/null || true)
PYTHON_BIN=$(resolve_tool python3 /usr/bin/python3 /opt/homebrew/bin/python3 2>/dev/null || true)

[ -n "$DSH_ROOT" ] || { wd_log "WD_HOME or DSH_HOME must be set" >&2; exit 1; }
export DSH_HOME="$DSH_ROOT"
mkdir -p "$STATE_DIR"

# Production sleeps retain their exact durations. A test run may scale only
# internal polling/backoff after presenting the private run coordinates used
# by the ownership ledger; the scale is never persisted in a launch spec.
wd_sleep() {
  local duration=$1 scale=${ANKH_GUARD_TEST_SLEEP_SCALE:-1}
  if [ -n "${ANKH_GUARD_TEST_RUN_DIR:-}" ] && [ -n "${ANKH_GUARD_TEST_RUN_TOKEN:-}" ] \
    && printf '%s' "$scale" | grep -Eq '^0\.[0-9]+$|^1(\.0+)?$'; then
    duration=$(/usr/bin/awk -v duration="$duration" -v scale="$scale" \
      'BEGIN { value=duration*scale; if (value < 0.01) value=0.01; printf "%.3f", value }')
  fi
  sleep "$duration"
}

launch_instance() {
  test_register_self instance-wrapper
  test_event_self instance-wrapper process-started
  if [ "${WD_TEST_BREAK:-0}" = "1" ]; then wd_sleep 1; exit 1; fi
  if [ "${WD_TEST_FAKE:-0}" = "1" ]; then
    node -e "require('http').createServer((q,s)=>s.end('ok')).listen($PORT,'127.0.0.1')"
    exit
  fi
  if [ -z "$START_CMD" ]; then wd_log "launch command unset — nothing to supervise" >&2; exit 1; fi
  # The instance inherits this process's environment: scrub EVERY WD_* so no
  # supervision variable can leak into the shells the instance hosts. A leaked
  # WD_STATE_DIR retargets any watchdog script those shells spawn (observed
  # 2026-08-29: an agent session inside the supervised deployment ran the test
  # suite straight into the PROD state dir — racers yielded to the live
  # pidfile owner, and the reclaim case never saw its temp pidfile). The scrub
  # is prefix-based, not a name list: the CLI adds WD_* variables over time
  # (WD_GUARD, WD_WAIT_OWNER, WD_ADOPTION, …) and a list silently goes stale.
  # WD_START is captured first: the unset would otherwise eat the command
  # itself. The guard CLI's bare-restart spawn applies the same scrub.
  local start_cmd=$START_CMD launch_home=$DSH_ROOT launch_harness_root=$HARNESS_ROOT
  (
    export DSH_HOME="$launch_home"
    if [ -n "$launch_harness_root" ]; then export DSH_HARNESS="$launch_harness_root"; fi
    cd "$launch_home/home" 2>/dev/null || cd /tmp || exit 1
    for v in $(env | sed -n 's/^\(WD_[^=]*\)=.*/\1/p'); do unset "$v"; done
    sh -c "$start_cmd"
  )
}

http_status() {
  curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || true
}

cutover_event() {
  [ -n "$CUTOVER_ID" ] || return 0
  guard_cmd cutover-event "$CUTOVER_ID" "$@" --state-dir "$STATE_DIR" >/dev/null 2>&1
}

# Receipt updates are part of the transaction, not telemetry. Keep the proven
# child (or the still-running old child during supervisor handoff) available
# while retrying a transient state/CLI failure; never advance in memory past a
# durable event that crash recovery depends on.
cutover_event_required() {
  [ -n "$CUTOVER_ID" ] || return 0
  while ! cutover_event "$@"; do
    wd_log "could not persist cutover event $1 — retrying; service state is unchanged" >&2
    wd_sleep 1
  done
}

cutover_control_action() {
  [ -n "$CUTOVER_ID" ] || return 0
  node -e '
    const fs = require("fs")
    const [restoreFile, abortFile, legacyFile, id] = process.argv.slice(1)
    const read = (file) => {
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"))
        return value?.version === 1 && value.cutoverId === id
          && (value.action === "abort" || value.action === "restore-previous") ? value.action : ""
      } catch { return "" }
    }
    const restore = read(restoreFile)
    const legacy = read(legacyFile)
    process.stdout.write(restore === "restore-previous" || legacy === "restore-previous"
      ? "restore-previous" : read(abortFile) || legacy)
  ' "$CONTROL_RESTORE_FILE" "$CONTROL_ABORT_FILE" "$CONTROL_FILE" "$CUTOVER_ID" 2>/dev/null
}

# The host owns the shape of its per-process launch URL. Discovery is generic:
# the first HTTP URL printed by THIS attempt whose authority is exactly the
# supervised loopback authority and whose query is non-empty. No parameter
# name ("token" or otherwise) is part of the watchdog protocol.
launch_url_from_output() {
  node -e '
    const fs = require("fs")
    const [file, port] = process.argv.slice(1)
    let text = ""
    try { text = fs.readFileSync(file, "utf8") } catch {}
    for (const match of text.matchAll(/https?:\/\/[^\s)]+/g)) {
      try {
        const url = new URL(match[0])
        if (url.protocol === "http:" && url.hostname === "127.0.0.1"
          && url.port === port && url.pathname === "/" && url.search !== ""
          && url.username === "" && url.password === "" && url.hash === "") {
          process.stdout.write(url.href)
          break
        }
      } catch {}
    }
  ' "$ATTEMPT_LOG" "$PORT" 2>/dev/null
}

# The process output is durable operational evidence, but a launch URL is a
# bearer credential. Once captured in memory, overwrite every matching URL in
# place with an equal-length marker. Equal length preserves the active child's
# append offset; an atomic rename here would strand later output on an unlinked
# inode. The failure path calls this too, so a process that prints then exits
# cannot have its credential mirrored into the watchdog log.
redact_launch_urls_in_output() {
  node -e '
    const fs = require("fs")
    const [file, port] = process.argv.slice(1)
    let text
    try { text = fs.readFileSync(file, "utf8") } catch { process.exit(0) }
    const edits = []
    for (const match of text.matchAll(/https?:\/\/[^\s)]+/g)) {
      try {
        const url = new URL(match[0])
        if (url.protocol === "http:" && url.hostname === "127.0.0.1"
          && url.port === port && url.pathname === "/" && url.search !== ""
          && url.username === "" && url.password === "" && url.hash === "") {
          const start = Buffer.byteLength(text.slice(0, match.index))
          const length = Buffer.byteLength(match[0])
          edits.push({ start, length })
        }
      } catch {}
    }
    if (edits.length === 0) process.exit(0)
    const fd = fs.openSync(file, "r+")
    try {
      for (const { start, length } of edits) {
        const label = Buffer.from("[launch-url-redacted]")
        const replacement = Buffer.alloc(length, 0x20)
        label.copy(replacement, 0, 0, Math.min(label.length, replacement.length))
        fs.writeSync(fd, replacement, 0, replacement.length, start)
      }
    } finally { fs.closeSync(fd) }
  ' "$ATTEMPT_LOG" "$PORT" 2>/dev/null || true
}

open_launch_url() {
  local url=$1
  if [ -n "${WD_BROWSER_OPEN_COMMAND:-}" ]; then
    "${WD_BROWSER_OPEN_COMMAND}" "$url" >/dev/null 2>&1
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1
  elif command -v gio >/dev/null 2>&1; then
    gio open "$url" >/dev/null 2>&1
  else
    return 1
  fi
}

last_transport_status=''
launch_url_reported=0
launch_url_value=''
browser_handoff_done=0
browser_handoff_reported=0
handoff_cookie_jar=''
readiness_detail=''
protected_ready=0

# Readiness has two layers. Any HTTP response proves transport-up; only a bare
# 200, or a same-authority launch-URL exchange (303 + cookie-authenticated 200)
# proves application readiness. A naked 401 therefore never counts as ready.
ready_probe() {
  local status url jar exchange authenticated
  current_owned_listener || return 1
  # The test fixture records the proven runtime identity as soon as ownership
  # is established. This is not production discovery or port-based cleanup:
  # teardown later signals only this immutable PID/start-token lease.
  test_register_pid "$current_listener_pid" instance-listener
  status=$(http_status)
  current_ownership_matches || return 1
  if [ -n "$status" ] && [ "$status" != "000" ] && [ "$status" != "$last_transport_status" ]; then
    last_transport_status=$status
    cutover_event_required transport "$status"
    if [ "$status" != "200" ]; then
      wd_log "transport up on :$PORT (HTTP $status); application readiness still pending"
    fi
  fi
  if [ "$status" = "200" ]; then
    protected_ready=0
    readiness_detail="plain HTTP 200"
    return 0
  fi

  if [ -z "$launch_url_value" ]; then
    launch_url_value=$(launch_url_from_output)
    [ -n "$launch_url_value" ] && redact_launch_urls_in_output
  fi
  url=$launch_url_value
  [ -n "$url" ] || return 1
  if [ "$launch_url_reported" = "0" ]; then
    wd_log "observed same-authority launch URL (credential redacted)"
    cutover_event_required launch-url
    launch_url_reported=1
  fi
  jar=$(mktemp "${TMPDIR:-/tmp}/ankh-guard-handoff.XXXXXX") || return 1
  handoff_cookie_jar=$jar
  chmod 600 "$jar" 2>/dev/null || true
  exchange=$(curl -sS --noproxy '*' -c "$jar" -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
  cutover_event_required auth-exchange "${exchange:-0}"
  if [ "$exchange" != "303" ]; then rm -f "$jar"; handoff_cookie_jar=''; return 1; fi
  authenticated=$(curl -sS --noproxy '*' -b "$jar" -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || true)
  rm -f "$jar"
  handoff_cookie_jar=''
  cutover_event_required authenticated "${authenticated:-0}"
  [ "$authenticated" = "200" ] || return 1
  current_ownership_matches || return 1
  protected_ready=1
  readiness_detail="authenticated launch URL: 303 exchange, cookie / = 200"
  return 0
}

# Whether the previous, proven listener armed an original tab for this
# transaction. All registered tabs are eligible to recover; the file contains
# only capability digests, never raw capabilities or bearer launch URLs.
browser_original_registered() {
  node -e '
    const fs = require("fs")
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      if (value.version !== 2 || value.cutoverId !== process.argv[2]
        || !Array.isArray(value.registrations) || value.registrations.length < 1
        || value.registrations.length > 64) process.exit(1)
      let expectedPort = false
      for (const registration of value.registrations) {
        const authority = new URL(`http://${registration.authority ?? ""}`)
        if (typeof registration.authority !== "string" || registration.authority === ""
          || authority.host !== registration.authority
          || authority.username !== "" || authority.password !== ""
          || !/^[a-f0-9]{64}$/.test(registration.capabilitySha256)
          || !Number.isFinite(registration.armedAt)) process.exit(1)
        if (authority.port === process.argv[3]) expectedPort = true
      }
      if (!expectedPort) process.exit(1)
    } catch { process.exit(1) }
  ' "$BROWSER_HANDOFF_REQUEST_FILE" "$CUTOVER_ID" "$PORT" >/dev/null 2>&1
}

# Print non-secret acknowledgement evidence only when it names this exact
# stable listener identity and cutover role.
browser_ack_evidence() {
  node -e '
    const fs = require("fs")
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      const authority = new URL(`http://${value.authority ?? ""}`)
      if (value.version !== 1 || value.cutoverId !== process.argv[2]
        || value.role !== process.argv[3] || String(value.listenerPid) !== process.argv[4]
        || value.listenerStartToken !== process.argv[5]
        || !["original-tab", "fallback-tab"].includes(value.channel)
        || !["existing-cookie", "launch-url"].includes(value.authentication)
        || typeof value.authority !== "string" || value.authority === ""
        || authority.host !== value.authority || authority.port !== process.argv[6]
        || authority.username !== "" || authority.password !== ""
        || !Number.isFinite(value.acknowledgedAt) || value.acknowledgedAt <= 0
        || value.authority.includes("|")) process.exit(1)
      process.stdout.write(`${value.channel}|${value.authentication}|${value.authority}`)
    } catch { process.exit(1) }
  ' "$BROWSER_HANDOFF_ACK_FILE" "$CUTOVER_ID" "$CUTOVER_ROLE" \
    "$current_listener_pid" "$current_listener_start" "$PORT" 2>/dev/null
}

wait_for_browser_ack() {
  local deadline evidence rest
  case "$BROWSER_HANDOFF_TIMEOUT_SECONDS" in ''|*[!0-9]*) return 1 ;; esac
  [ "$BROWSER_HANDOFF_TIMEOUT_SECONDS" -gt 0 ] || return 1
  deadline=$(( $(now_ms) + BROWSER_HANDOFF_TIMEOUT_SECONDS * 1000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    [ -z "$(cutover_control_action)" ] || return 1
    current_ownership_matches || return 1
    evidence=$(browser_ack_evidence) || evidence=''
    if [ -n "$evidence" ]; then
      browser_ack_channel=${evidence%%|*}
      rest=${evidence#*|}
      browser_ack_authentication=${rest%%|*}
      browser_ack_authority=${rest#*|}
      return 0
    fi
    wd_sleep 0.25
  done
  return 1
}

# Browser handoff is deliberately after the ownership stability window and
# canary. An opener's exit status proves only that a fallback was attempted;
# readiness requires a page-authored acknowledgement naming the stable listener.
complete_browser_handoff() {
  local fallback_url
  current_ownership_matches || return 1
  [ "$protected_ready" = "1" ] || return 0
  if [ "$BROWSER_HANDOFF" = "required" ] && [ "$browser_handoff_done" = "0" ]; then
    [ -n "$launch_url_value" ] || return 1
    if browser_original_registered; then
      wd_log "waiting for an armed original browser tab to acknowledge the final process"
      if wait_for_browser_ack; then
        browser_handoff_done=1
        browser_handoff_reported=1
        cutover_event_required browser-handoff acknowledged "$browser_ack_channel" \
          "$browser_ack_authentication" "$browser_ack_authority"
        wd_log "original browser tab acknowledged handoff ($browser_ack_authentication; authority $browser_ack_authority); all registered responsive tabs remain eligible to recover"
      else
        wd_log "original browser tab did not acknowledge within ${BROWSER_HANDOFF_TIMEOUT_SECONDS}s; falling back to system open"
      fi
    else
      wd_log "no original browser tab registered before shutdown; falling back to system open"
    fi
    if [ "$browser_handoff_done" = "0" ]; then
      fallback_url="${launch_url_value}#ankh-guard-handoff=${CUTOVER_ID}"
      if open_launch_url "$fallback_url"; then
        cutover_event_required browser-fallback-opened
        wd_log "browser fallback open requested; waiting for page acknowledgement"
        if wait_for_browser_ack; then
          browser_handoff_done=1
          browser_handoff_reported=1
          cutover_event_required browser-handoff acknowledged "$browser_ack_channel" \
            "$browser_ack_authentication" "$browser_ack_authority"
          wd_log "browser acknowledged fallback handoff ($browser_ack_channel; authority $browser_ack_authority)"
        fi
      fi
    fi
    if [ "$browser_handoff_done" = "0" ]; then
      if [ "$browser_handoff_reported" = "0" ]; then
        wd_log "browser handoff failed: no page acknowledgement — not ready"
        cutover_event_required browser-handoff failed
        browser_handoff_reported=1
      fi
      return 1
    fi
  elif [ "$BROWSER_HANDOFF" = "off" ] && [ "$browser_handoff_reported" = "0" ]; then
    cutover_event_required browser-handoff off
    browser_handoff_reported=1
  fi
  current_ownership_matches || return 1
  if [ "$browser_handoff_done" = "1" ]; then
    readiness_detail="authenticated launch URL: 303 exchange, cookie / = 200, browser page acknowledged"
  fi
  return 0
}

# Initial HTTP/auth readiness is provisional. Hold the exact child PID/start
# identity and exact listener PID/start identity unchanged for a stability
# window, with no retry tolerated inside that window, before canary/terminal
# receipt. A child that exits after first returning 200 therefore fails the
# cutover instead of borrowing another process's response.
prove_stable_readiness() {
  local expected_child=$child expected_child_start=$child_start_token
  local expected_listener=$current_listener_pid expected_listener_start=$current_listener_start
  local deadline
  case "$READY_STABILITY_SECONDS" in ''|*[!0-9]*) return 1 ;; esac
  [ "$READY_STABILITY_SECONDS" -gt 0 ] || return 1
  deadline=$(( $(now_ms) + READY_STABILITY_SECONDS * 1000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    [ -z "$(cutover_control_action)" ] || return 1
    [ "$child" = "$expected_child" ] && [ "$child_start_token" = "$expected_child_start" ] || return 1
    current_listener_pid=$expected_listener
    current_listener_start=$expected_listener_start
    current_ownership_matches || return 1
    ready_probe || return 1
    [ "$current_listener_pid" = "$expected_listener" ] \
      && [ "$current_listener_start" = "$expected_listener_start" ] || return 1
    wd_sleep 0.25
  done
  current_listener_pid=$expected_listener
  current_listener_start=$expected_listener_start
  current_ownership_matches || return 1
  readiness_detail="$readiness_detail; ownership stable ${READY_STABILITY_SECONDS}s (child $child, listener $current_listener_pid, retry 0)"
  cutover_event_required ownership-stable "$CUTOVER_ROLE" "$child" "$child_start_token" \
    "$current_listener_pid" "$current_listener_start" "$((READY_STABILITY_SECONDS * 1000))" 0
  return 0
}

transport_up() {
  local status
  status=$(http_status)
  [ -n "$status" ] && [ "$status" != "000" ]
}

process_start_token() {
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && [ -n "$PYTHON_BIN" ]; then
    "$PYTHON_BIN" -c 'import ctypes,struct,sys;p=int(sys.argv[1]);b=ctypes.create_string_buffer(136);n=ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo(p,3,0,b,136);n == 136 or sys.exit(1);s,u=struct.unpack_from("QQ",b.raw,120);print(f"darwin:{s}:{u}",end="")' "$1" 2>/dev/null && return 0
  fi
  PROCESS_PS="$PS_BIN" PROCESS_SYSCTL="$SYSCTL_BIN" node -e '
    const { createHash } = require("crypto")
    const { existsSync, readFileSync } = require("fs")
    const { execFileSync } = require("child_process")
    const pid = Number(process.argv[1])
    try {
      const run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: "pipe" }).trim()
      const status = run(process.env.PROCESS_PS, ["-o", "stat=", "-p", String(pid)])
      if (!status || status.startsWith("Z")) process.exit(1)
      const procStat = `/proc/${pid}/stat`
      if (existsSync(procStat)) {
        const stat = readFileSync(procStat, "utf8")
        const end = stat.lastIndexOf(")")
        const fields = end < 0 ? [] : stat.slice(end + 1).trim().split(/\s+/)
        const ticks = fields[19]
        if (!ticks) process.exit(1)
        let boot = "unknown-boot"
        try { boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || boot } catch {}
        process.stdout.write(`linux:${boot}:${ticks}`)
        process.exit(0)
      }
      const base = run(process.env.PROCESS_PS, ["-o", "sess=", "-o", "uid=", "-o", "lstart=", "-o", "command=", "-p", String(pid)])
      if (!base) process.exit(1)
      let boot = "unknown-boot"
      try { if (process.env.PROCESS_SYSCTL) boot = run(process.env.PROCESS_SYSCTL, ["-n", "kern.boottime"]) || boot } catch {}
      process.stdout.write("posix:" + createHash("sha256").update(boot).update("\0").update(base).digest("hex"))
    } catch { process.exit(1) }
  ' "$1" 2>/dev/null
}

# Test-only birth registration and event sink. The shipped watchdog is inert
# unless a fixture provides an explicit private run directory, token, and the
# built registrar path. Each shell/Node child initiates its own record so the
# outer Vitest process never has to discover a replacement through a mutable
# pidfile. Registration failure is diagnostic-only and cannot alter production
# supervision behavior.
test_register_pid() {
  [ -n "${ANKH_GUARD_TEST_RUN_DIR:-}" ] || return 0
  [ -n "${ANKH_GUARD_TEST_RUN_TOKEN:-}" ] || return 0
  [ -f "${ANKH_GUARD_TEST_REGISTER_BIN:-}" ] || return 0
  ANKH_GUARD_TEST_PROCESS_ROLE="$2" node "$ANKH_GUARD_TEST_REGISTER_BIN" register-pid "$1" "$2" >/dev/null 2>&1 || true
}

test_register_self() {
  [ -n "${ANKH_GUARD_TEST_RUN_DIR:-}" ] || return 0
  [ -n "${ANKH_GUARD_TEST_RUN_TOKEN:-}" ] || return 0
  [ -f "${ANKH_GUARD_TEST_REGISTER_BIN:-}" ] || return 0
  ANKH_GUARD_TEST_PROCESS_ROLE="$1" node "$ANKH_GUARD_TEST_REGISTER_BIN" register-parent "$1" >/dev/null 2>&1 || true
}

test_event_pid() {
  [ -n "${ANKH_GUARD_TEST_RUN_DIR:-}" ] || return 0
  [ -n "${ANKH_GUARD_TEST_RUN_TOKEN:-}" ] || return 0
  [ -f "${ANKH_GUARD_TEST_REGISTER_BIN:-}" ] || return 0
  ANKH_GUARD_TEST_PROCESS_ROLE="$2" node "$ANKH_GUARD_TEST_REGISTER_BIN" event-pid "$1" "$2" "$3" >/dev/null 2>&1 || true
}

test_event_self() {
  [ -n "${ANKH_GUARD_TEST_RUN_DIR:-}" ] || return 0
  [ -n "${ANKH_GUARD_TEST_RUN_TOKEN:-}" ] || return 0
  [ -f "${ANKH_GUARD_TEST_REGISTER_BIN:-}" ] || return 0
  ANKH_GUARD_TEST_PROCESS_ROLE="$1" node "$ANKH_GUARD_TEST_REGISTER_BIN" event-parent "$1" "$2" >/dev/null 2>&1 || true
}

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

identity_matches() {
  local pid=$1 expected=$2 actual
  [ -n "$pid" ] && [ -n "$expected" ] || return 1
  actual=$(process_start_token "$pid")
  [ -n "$actual" ] && [ "$actual" = "$expected" ]
}

listener_pids() {
  "$LSOF_BIN" -tiTCP:"$PORT" -sTCP:LISTEN -P 2>/dev/null | sort -u
}

pid_is_listener() {
  local expected=$1 candidate
  for candidate in $(listener_pids); do [ "$candidate" = "$expected" ] && return 0; done
  return 1
}

pid_belongs_to_tree() {
  local root=$1 cursor=$2 parent hops=0
  while [ "$cursor" -gt 0 ] 2>/dev/null && [ "$hops" -lt 256 ]; do
    [ "$cursor" = "$root" ] && return 0
    parent=$("$PS_BIN" -o ppid= -p "$cursor" 2>/dev/null | tr -d ' ')
    [ -n "$parent" ] || return 1
    cursor=$parent
    hops=$((hops + 1))
  done
  return 1
}

# Prove one unchanged listener inside the launched child tree. The response
# probe is accepted only while this identity remains true before and after
# the HTTP exchange, preventing a stale/foreign server on the same port from
# being mistaken for the target.
current_owned_listener() {
  local pids count listener token
  identity_matches "$child" "$child_start_token" || return 1
  pids=$(listener_pids)
  count=$(printf '%s\n' "$pids" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" = "1" ] || return 1
  listener=$(printf '%s\n' "$pids" | head -1)
  pid_belongs_to_tree "$child" "$listener" || return 1
  token=$(process_start_token "$listener")
  [ -n "$token" ] || return 1
  current_listener_pid=$listener
  current_listener_start=$token
  return 0
}

current_ownership_matches() {
  local pids count token
  identity_matches "$child" "$child_start_token" || return 1
  pids=$(listener_pids)
  count=$(printf '%s\n' "$pids" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$count" = "1" ] || return 1
  [ "$(printf '%s\n' "$pids" | head -1)" = "$current_listener_pid" ] || return 1
  token=$(process_start_token "$current_listener_pid")
  [ -n "$token" ] && [ "$token" = "$current_listener_start" ] \
    && pid_belongs_to_tree "$child" "$current_listener_pid"
}

# Reap a pid AND its descendants, deepest first (best effort). The watchdog
# guarantees the direct child; the sweep keeps grandchildren from outliving
# the instance — a single-pid kill is what orphaned listeners and left the
# EADDRINUSE race behind.
kill_frozen_tree() {
  local pid=$1 sig=${2:-TERM} child parent unsafe=0
  for child in $("$PGREP_BIN" -P "$pid" 2>/dev/null); do
    kill -STOP "$child" 2>/dev/null || continue
    parent=$("$PS_BIN" -o ppid= -p "$child" 2>/dev/null | tr -d ' ')
    if [ "$parent" != "$pid" ]; then
      kill -CONT "$child" 2>/dev/null || true
      unsafe=1
      continue
    fi
    kill_frozen_tree "$child" "$sig" || unsafe=1
  done
  kill -s "$sig" "$pid" 2>/dev/null || true
  if [ "$sig" != "KILL" ]; then kill -CONT "$pid" 2>/dev/null || true; fi
  [ "$unsafe" = "0" ]
}

kill_tree() {
  local pid=$1 sig=${2:-TERM}
  # Freeze before enumeration so a wrapper cannot exit and orphan its
  # listener to PID 1 between pgrep and signal delivery.
  kill -STOP "$pid" 2>/dev/null || return 0
  kill_frozen_tree "$pid" "$sig"
}

stop_matching_identity() {
  local pid=$1 token=$2 sig=${3:-TERM} actual
  [ -n "$pid" ] && [ -n "$token" ] || return 2
  # Authorization is checked while the PID is frozen. A pre-STOP check leaves
  # a reuse window in which the signal can hit a new, unrelated process.
  kill -STOP "$pid" 2>/dev/null || return 0
  actual=$(process_start_token "$pid")
  if [ -z "$actual" ] || [ "$actual" != "$token" ]; then
    kill -CONT "$pid" 2>/dev/null || true
    wd_log "refused signal $sig to pid $pid: frozen start identity did not match" >&2
    return 2
  fi
  kill_frozen_tree "$pid" "$sig"
}

# Stop only the process identities captured while the old supervisor still
# owned them. The listener is also retained because a shell wrapper can exit
# and orphan its server between tree enumeration and signal delivery. Never
# replace this with "kill whatever owns the port" during a cutover.
stop_previous_owned_tree() {
  local deadline pids foreign=0 identity_error=0
  [ -n "$PREVIOUS_CHILD_PID" ] && [ -n "$PREVIOUS_CHILD_START" ] \
    && [ -n "$PREVIOUS_LISTENER_PID" ] && [ -n "$PREVIOUS_LISTENER_START" ] || {
      wd_log "cutover ownership proof is incomplete; refusing to stop by port" >&2
      return 1
    }
  stop_matching_identity "$PREVIOUS_CHILD_PID" "$PREVIOUS_CHILD_START" TERM || identity_error=1
  # The frozen root sweep normally signals the listener too. Give its exit
  # teardown time to drop the socket before separately touching the captured
  # listener PID; a dying process can retain a ps row after its executable
  # identity is already gone.
  wd_sleep 0.5
  if pid_is_listener "$PREVIOUS_LISTENER_PID"; then
    stop_matching_identity "$PREVIOUS_LISTENER_PID" "$PREVIOUS_LISTENER_START" TERM || identity_error=1
  fi
  deadline=$(( $(date +%s) + 15 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! identity_matches "$PREVIOUS_CHILD_PID" "$PREVIOUS_CHILD_START" \
      && ! pid_is_listener "$PREVIOUS_LISTENER_PID"; then
      break
    fi
    wd_sleep 0.2
  done
  if identity_matches "$PREVIOUS_CHILD_PID" "$PREVIOUS_CHILD_START"; then
    stop_matching_identity "$PREVIOUS_CHILD_PID" "$PREVIOUS_CHILD_START" KILL || identity_error=1
  fi
  if pid_is_listener "$PREVIOUS_LISTENER_PID"; then
    stop_matching_identity "$PREVIOUS_LISTENER_PID" "$PREVIOUS_LISTENER_START" KILL || identity_error=1
  fi
  wd_sleep 0.2
  if identity_matches "$PREVIOUS_CHILD_PID" "$PREVIOUS_CHILD_START" \
    || pid_is_listener "$PREVIOUS_LISTENER_PID"; then
    wd_log "captured previous child/listener identity did not exit" >&2
    return 1
  fi
  pids=$(listener_pids)
  if [ -n "$pids" ]; then
    wd_log "port :$PORT is owned by unapproved pid(s) $(printf '%s' "$pids" | paste -sd, -); refusing arbitrary cleanup" >&2
    foreign=1
  fi
  [ "$foreign" = "0" ] && [ "$identity_error" = "0" ]
}

kill_current_owned_attempt() {
  local identity_error=0
  if [ -n "${child:-}" ] && [ -n "${child_start_token:-}" ]; then
    stop_matching_identity "$child" "$child_start_token" TERM || identity_error=1
  fi
  wd_sleep 0.2
  if [ -n "${current_listener_pid:-}" ] && [ -n "${current_listener_start:-}" ] \
    && pid_is_listener "$current_listener_pid"; then
    stop_matching_identity "$current_listener_pid" "$current_listener_start" TERM || identity_error=1
  fi
  wd_sleep 0.2
  if [ -n "${child:-}" ] && [ -n "${child_start_token:-}" ] \
    && identity_matches "$child" "$child_start_token"; then
    stop_matching_identity "$child" "$child_start_token" KILL || identity_error=1
  fi
  if [ -n "${current_listener_pid:-}" ] && [ -n "${current_listener_start:-}" ] \
    && pid_is_listener "$current_listener_pid"; then
    stop_matching_identity "$current_listener_pid" "$current_listener_start" KILL || identity_error=1
  fi
  [ "$identity_error" = "0" ]
}

select_previous_spec() {
  local reason=$1
  [ -n "$PREVIOUS_START" ] && [ -n "$PREVIOUS_HOME" ] && [ -n "$PREVIOUS_REPO" ] \
    && [ -n "$PREVIOUS_HARNESS_ROOT" ] || return 1
  if [ -n "$TRANSITION_PLAN_SHA256" ]; then
    if ! guard_cmd transition-rollback "$CUTOVER_ID" --state-dir "$STATE_DIR"; then
      wd_log "filesystem transition rollback failed — refusing to start previous over target state" >&2
      return 1
    fi
    transition_rolled_back=1
    wd_log "filesystem transition rolled back; rejected target output retained in cutover quarantine"
  fi
  cutover_event_required restoring "$reason"
  START_CMD="$PREVIOUS_START"
  DSH_ROOT="$PREVIOUS_HOME"
  REPO="$PREVIOUS_REPO"
  HARNESS_ROOT="$PREVIOUS_HARNESS_ROOT"
  PROFILE="${PREVIOUS_PROFILE:-web}"
  export DSH_HOME="$DSH_ROOT"
  CUTOVER_ROLE="previous"
  browser_handoff_done=0
  browser_handoff_reported=0
  rm -f "$BROWSER_HANDOFF_ACK_FILE"
  failures=0
  reset_done=1
  port_races=0
  rm -f "$CONTROL_FILE" "$CONTROL_ABORT_FILE" "$CONTROL_RESTORE_FILE"
  return 0
}

# Return 0 when a durable operator request was consumed; control_result tells
# the caller whether to launch previous or park according to wait-for-user.
handle_cutover_control() {
  local action effective
  control_result=''
  action=$(cutover_control_action)
  [ -n "$action" ] || return 1
  cutover_event_required control-requested "$action"
  effective=$action
  if [ "$action" = "abort" ]; then effective=$CUTOVER_POLICY; fi
  if [ "$effective" = "restore-previous" ]; then
    if ! kill_current_owned_attempt; then
      rm -f "$CONTROL_FILE" "$CONTROL_ABORT_FILE" "$CONTROL_RESTORE_FILE"
      cutover_event_required awaiting-user "operator requested $action, but the frozen current identity no longer matched; refusing to signal an unapproved process"
      control_result='wait'
      return 0
    fi
    if [ -n "${child:-}" ]; then wait "$child" 2>/dev/null || true; fi
    if select_previous_spec "operator requested $action; restoring previous complete launch specification"; then
      control_result='restore'
      return 0
    fi
    effective='wait-for-user'
  fi
  rm -f "$CONTROL_FILE" "$CONTROL_ABORT_FILE" "$CONTROL_RESTORE_FILE"
  cutover_event_required awaiting-user "operator requested $action; recovery is waiting for user"
  control_result='wait'
  return 0
}

# Keep a recovered/otherwise healthy child available while a non-terminal
# cutover waits for explicit operator action. This path intentionally skips
# last-good stamping and continues to consume abort/restore requests.
wait_cutover_with_live_child() {
  while identity_matches "$child" "$child_start_token"; do
    if handle_cutover_control && [ "$control_result" = "restore" ]; then return 0; fi
    wd_sleep 2
  done
  wait "$child" 2>/dev/null || true
}

# Echo a pid and all its descendants, one per line.
pid_tree() {
  local pid=$1 child
  echo "$pid"
  for child in $("$PGREP_BIN" -P "$pid" 2>/dev/null); do
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
  "$LSOF_BIN" -nP -a -p "$pids" -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk 'NR > 1 { n = split($9, a, ":"); print a[n] }' | sort -u
}

# Free the port: the watchdog is the declared owner, so it adopts an existing
# listener (the one-time bounce that moves a running instance under supervision).
free_port() {
  local pid p
  pid=$(listener_pids)
  if [ -n "$pid" ]; then
    wd_log "freeing :$PORT from pid(s) $pid"
    for p in $pid; do kill_tree "$p" TERM; done
    wd_sleep 2
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

# A healthy boot also proves the current PROFILE COMPOSITION runs: snapshot
# its inputs (the bundles patch layer + the profile manifest). This is the
# rollback target for failures a checkout reset cannot fix — a freshly
# installed plugin whose row breaks the real boot lives in the profile, not
# the repository.
snapshot_composition() {
  local dir="$DSH_ROOT/profiles/$PROFILE"
  [ -f "$dir/cordis.patch.yml" ] || return 0
  mkdir -p "$STATE_DIR/last-good-composition"
  cp "$dir/cordis.patch.yml" "$STATE_DIR/last-good-composition/"
  if [ -f "$dir/package.json" ]; then cp "$dir/package.json" "$STATE_DIR/last-good-composition/"; fi
}

# Restore the snapshotted composition over the live one, backing the current
# (failing) inputs up first and computing the delta for the recovery report.
# Returns 1 when there is nothing to restore to (no snapshot, or the snapshot
# already IS the live composition — retrying a boot with unchanged inputs is
# pointless).
restore_composition() {
  local snap="$STATE_DIR/last-good-composition"
  local dir="$DSH_ROOT/profiles/$PROFILE"
  [ -f "$snap/cordis.patch.yml" ] || return 1
  local same=1
  diff -q "$snap/cordis.patch.yml" "$dir/cordis.patch.yml" >/dev/null 2>&1 || same=0
  if [ -f "$snap/package.json" ] || [ -f "$dir/package.json" ]; then
    diff -q "$snap/package.json" "$dir/package.json" >/dev/null 2>&1 || same=0
  fi
  [ "$same" = "0" ] || return 1
  # What the rollback unmounts — names for the recovery report.
  comp_restore_detail=$(node -e '
    const fs = require("fs")
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { return {} } }
    const live = read(process.argv[1]), snap = read(process.argv[2])
    const added = (a, b) => a.filter((x) => !b.includes(x))
    const parts = []
    const rows = added(live.dsh?.profile?.bundles ?? [], snap.dsh?.profile?.bundles ?? [])
    if (rows.length > 0) parts.push(`卸载挂载行: ${rows.join(", ")}`)
    const deps = added(Object.keys(live.dependencies ?? {}), Object.keys(snap.dependencies ?? {}))
    if (deps.length > 0) parts.push(`移除依赖: ${deps.join(", ")}`)
    process.stdout.write(parts.join(";"))
  ' "$dir/package.json" "$snap/package.json" 2>/dev/null)
  if ! diff -q "$snap/cordis.patch.yml" "$dir/cordis.patch.yml" >/dev/null 2>&1; then
    comp_restore_detail="${comp_restore_detail:+$comp_restore_detail;}回滚 profile patch 层变更"
  fi
  local backup="$STATE_DIR/composition-backup-$(date +%s)"
  mkdir -p "$backup"
  cp "$dir/cordis.patch.yml" "$backup/" 2>/dev/null || true
  if [ -f "$dir/package.json" ]; then cp "$dir/package.json" "$backup/"; fi
  cp "$snap/cordis.patch.yml" "$dir/cordis.patch.yml"
  if [ -f "$snap/package.json" ]; then cp "$snap/package.json" "$dir/package.json"; fi
  wd_log "restored the last healthy profile composition over $dir (failing inputs backed up to $backup)"
  return 0
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
    wd_log "rollback target $sha is the current HEAD — skipping reset (nothing to roll back; a reset would only wipe uncommitted work)"
    return 1
  fi
  wd_log "rolling repo back to last known-good $sha"
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
  # Revalidate the exact short-lived authorization selected before the stop.
  # A same-launch proof may outlive the original build credential's freshness,
  # but only while every fingerprinted deployment input remains identical.
  guard_cmd verify-restart --repo "$REPO" --state-dir "$STATE_DIR" >/dev/null 2>&1
}

guard_reset() {
  guard_cmd reset "$1" --repo "$REPO" --state-dir "$STATE_DIR"
}

# Give-up crash page: a tiny HTTP server served by the watchdog itself, with a
# retry button that signals the watchdog (SIGUSR1) — no terminal needed.
page_script() {
  cat <<'EOF'
if (process.env.ANKH_GUARD_TEST_RUN_DIR && process.env.ANKH_GUARD_TEST_RUN_TOKEN
  && process.env.ANKH_GUARD_TEST_REGISTER_BIN) {
  require('child_process').spawnSync(process.execPath, [process.env.ANKH_GUARD_TEST_REGISTER_BIN,
    'register-pid', String(process.pid), 'crash-page'], { stdio: 'ignore', env: process.env });
}
const http = require('http');
const port = Number(process.env.WD_PORT || 3080);
const wd = Number(process.env.WD_PID);
const handler = (req, res) => {
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
};
// An occupied port is the COMMON case at give-up (the boot failures were
// often EADDRINUSE themselves). Dying on the bind error — an unhandled
// 'error' event — would return the watchdog's `wait` and drop it back into
// the boot loop, fighting the healthy occupant it just gave up against
// (observed 2026-08-30 in an e2e rig: four give-up cycles, the occupant
// killed over and over). Park instead: retry the bind every 5s; SIGUSR1
// still re-arms the boot loop.
let noted = false;
function bind() {
  const server = http.createServer(handler);
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      if (!noted) {
        noted = true;
        process.stderr.write(new Date().toISOString() + ' [watchdog] crash page cannot bind :' + port + ' (occupied) — retrying every 5s; SIGUSR1 to ' + wd + ' re-arms the boot loop\n');
      }
      setTimeout(bind, 5000);
      return;
    }
    throw e;
  });
  server.listen(port, '127.0.0.1');
}

bind();
EOF
}

park_cutover() {
  local reason=$1
  printf '%s launch cutover waiting: %s\n' "$(date '+%F %T')" "$reason" > "$GIVE_UP_MARKER"
  WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
  page_pid=$!
  wait "$page_pid" 2>/dev/null || true
  page_pid=''
}

retry_on_usrs() {
  wd_log "USR1 received — clearing give-up marker and retrying"
  rm -f "$GIVE_UP_MARKER"
  if [ -n "${page_pid:-}" ]; then kill "$page_pid" 2>/dev/null; fi
  failures=0
  reset_done=0
  port_races=0
}

# Register before the first ownership branch can exit or detach more children.
test_register_self "${ANKH_GUARD_TEST_PROCESS_ROLE:-watchdog}"
test_event_self "${ANKH_GUARD_TEST_PROCESS_ROLE:-watchdog}" process-started

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
  empty_reads=0
  if [ -n "${WD_TAKEOVER_FROM:-}" ]; then
    owner=$(cat "$PIDFILE" 2>/dev/null)
    if [ -z "${WD_TAKEOVER_FROM_START:-}" ] || [ "$owner" != "$WD_TAKEOVER_FROM" ] \
      || ! identity_matches "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START"; then
      wd_log "takeover refused: expected matching pidfile owner identity $WD_TAKEOVER_FROM, found ${owner:-none}" >&2
      exit 1
    fi
    takeover_tmp="$PIDFILE.takeover.$$"
    echo $$ > "$takeover_tmp"
    # Atomic rename is the ownership handoff commit point. The previous
    # watchdog already knows how to yield to a different live pidfile owner
    # without reaping its child, so this works even when that watchdog is the
    # older package version that had no reconfigure verb.
    mv -f "$takeover_tmp" "$PIDFILE"
    claimed=1
    wd_log "claimed supervision from watchdog $owner; old child remains running until the scheduled exit"
    supervisor_start_token=$(process_start_token "$$")
    [ -n "$supervisor_start_token" ] || { wd_log "could not capture replacement watchdog start identity" >&2; exit 1; }
    cutover_event_required supervisor-ready "$$" "$supervisor_start_token"
  else
    while [ "$attempt" -lt 5 ]; do
      attempt=$((attempt + 1))
      if (set -C; echo $$ > "$PIDFILE") 2>/dev/null; then claimed=1; break; fi
      owner=$(cat "$PIDFILE" 2>/dev/null)
      if [ -n "$owner" ]; then
        if kill -0 "$owner" 2>/dev/null; then
          wd_log "already supervised by pid $owner; exiting"
          exit 0
        fi
        # A real but dead claim: safe to drop below.
        empty_reads=0
      else
        # An EMPTY pidfile is a rival's claim mid-write: the noclobber create
        # and the echo are two disk operations, and a preempted winner sits
        # between them. Deleting the file here re-opens the race and can
        # cascade until every racer exhausts its attempts (observed under
        # deploy-gate load: 8 concurrent racers, zero survivors). Give the
        # writer a beat to land its pid; only treat the file as abandoned
        # after several consecutive empty reads.
        empty_reads=$((empty_reads + 1))
        if [ "$empty_reads" -le 3 ]; then
          attempt=$((attempt - 1))
          wd_sleep 0.2
          continue
        fi
      fi
      # Stale (owner gone, or abandoned mid-write): drop it and race for the
      # claim again. Losing that race is correct — the next pass sees a live
      # owner and exits through the branch above.
      rm -f "$PIDFILE"
    done
  fi
  if [ "$claimed" != "1" ]; then
    wd_log "could not claim $PIDFILE after $attempt attempts" >&2
    exit 1
  fi
fi

if [ "$SUPERVISE" = "1" ] && [ "$claimed" = "1" ]; then
  test_event_self "${ANKH_GUARD_TEST_PROCESS_ROLE:-watchdog}" pidfile-published
fi

# Graceful launch: let the scheduling turn finish before the adoption bounce.
if [ "$DELAY" -gt 0 ] 2>/dev/null; then sleep "$DELAY"; fi

rm -f "$GIVE_UP_MARKER"
failures=0
reset_done=0
port_races=0
target_attempt=0
previous_attempt=0
yielded=0
comp_restore_done=0
comp_restored=0
comp_restore_detail=''
transition_applied=0
transition_rolled_back=0

trap 'retry_on_usrs' USR1

# Reap what we spawned on the way out — the instance child and the give-up
# crash page. Without this, TERM/INT (or a plain exit) orphans them to PPID 1:
# the leak that left three crash pages on 8/16, and the held port the
# EADDRINUSE branch then had to free. SIGKILL cannot be trapped; the next
# start's free_port covers that case. (`set -u` — guard every var.)
cleanup() {
  if [ -n "${handoff_cookie_jar:-}" ]; then rm -f "$handoff_cookie_jar"; fi
  if [ -n "${page_pid:-}" ]; then kill "$page_pid" 2>/dev/null; fi
  # A YIELDING watchdog leaves its instance running for the new owner (the
  # port is healthy; killing it would just make the successor respawn).
  if [ -n "${child:-}" ] && [ "${yielded:-0}" != "1" ]; then
    if [ -n "${CUTOVER_ID:-}" ] && [ -n "${child_start_token:-}" ]; then
      stop_matching_identity "$child" "$child_start_token" TERM || true
    else
      kill_tree "$child" TERM
    fi
  fi
  # Drop the pidfile ONLY while it names us: a successor watchdog may have
  # already claimed it in the restart window, and deleting theirs would let a
  # second supervisor in.
  if [ -f "$PIDFILE" ] && [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ]; then
    if [ -n "${WD_TAKEOVER_FROM:-}" ] && [ -n "${WD_TAKEOVER_FROM_START:-}" ] \
      && identity_matches "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START"; then
      takeover_restore="$PIDFILE.restore.$$"
      echo "$WD_TAKEOVER_FROM" > "$takeover_restore"
      mv -f "$takeover_restore" "$PIDFILE"
      wd_log "takeover aborted while old watchdog $WD_TAKEOVER_FROM is alive — restored its pidfile claim"
    else
      rm -f "$PIDFILE"
    fi
  fi
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM INT

cutover_control_signal() {
  # The durable marker is the signal. Let the main loop freeze and reap the
  # authoritative tree; killing only the wrapper here recreates the orphan
  # listener race.
  if [ -n "${page_pid:-}" ]; then kill "$page_pid" 2>/dev/null || true; fi
}
trap 'cutover_control_signal' USR2

# Test readiness is stronger than pidfile publication: the control handler is
# installed and the shell has yielded through one scheduler tick. Production
# readiness remains unchanged; only explicit test event consumers observe it.
test_event_self "${ANKH_GUARD_TEST_PROCESS_ROLE:-watchdog}" handler-installed
if [ -n "${ANKH_GUARD_TEST_RUN_DIR:-}" ]; then wd_sleep 0.01; fi
test_event_self "${ANKH_GUARD_TEST_PROCESS_ROLE:-watchdog}" keepalive-first-tick
test_event_self "${ANKH_GUARD_TEST_PROCESS_ROLE:-watchdog}" ready

write_cutover_restart_marker() {
  node -e '
    const fs = require("fs")
    const [file, id, initiator] = process.argv.slice(1)
    fs.writeFileSync(file, JSON.stringify({
      reason: "launch configuration cutover",
      cutoverId: id,
      requestedAt: Date.now(),
      ...(initiator === "" ? {} : { initiator }),
    }) + "\n")
  ' "$RESTART_MARKER" "$CUTOVER_ID" "${WD_INITIATOR:-}"
}

consume_takeover_control() {
  if handle_cutover_control; then
    if [ "$control_result" = "wait" ]; then
      wd_log "operator control parked cutover before the irreversible boundary; previous host remains available"
      park_cutover "operator abort follows wait-for-user policy"
      rm -f "$GIVE_UP_MARKER"
    else
      wd_log "operator control selected previous launch configuration before takeover"
    fi
  fi
}

if [ -n "${WD_TAKEOVER_FROM:-}" ]; then
  # The atomic pidfile claim above is the cutover commit point. From here the
  # replacement watchdog — not the short-lived reconfigure caller — owns the
  # delayed old-child stop, so a caller/session death cannot strand the
  # transaction between "supervisor-ready" and "host stopped".
  cutover_delay="${WD_CUTOVER_DELAY_SECONDS:-5}"
  wd_log "supervision claimed; leaving the old host uninterrupted for ${cutover_delay}s"
  cutover_delay_deadline=$(node -e '
    const delay = Number(process.argv[1])
    if (!Number.isFinite(delay) || delay < 0) process.exit(1)
    process.stdout.write(String(Date.now() + delay * 1000))
  ' "$cutover_delay") || { wd_log "invalid WD_CUTOVER_DELAY_SECONDS" >&2; exit 1; }
  while [ "$(now_ms)" -lt "$cutover_delay_deadline" ]; do
    consume_takeover_control
    wd_sleep 0.2
  done
  # Do not publish the restart marker while the previous watchdog is still
  # alive. Older watchdogs consume that marker themselves; if one wins that
  # race, the replacement child can become healthy while the cutover receipt
  # remains permanently nonterminal. The previous child stays up throughout
  # this wait. A healthy old watchdog notices our pidfile claim on its next
  # supervision pass and yields without reaping the child.
  supervisor_yield_timeout_ms="${WD_SUPERVISOR_YIELD_TIMEOUT_MS:-15000}"
  case "$supervisor_yield_timeout_ms" in ''|*[!0-9]*) wd_log "invalid WD_SUPERVISOR_YIELD_TIMEOUT_MS" >&2; exit 1 ;; esac
  [ "$supervisor_yield_timeout_ms" -ge 100 ] || { wd_log "WD_SUPERVISOR_YIELD_TIMEOUT_MS must be at least 100" >&2; exit 1; }
  supervisor_yield_deadline=$(( $(now_ms) + supervisor_yield_timeout_ms ))
  supervisor_was_live=0
  supervisor_timed_out=0
  supervisor_retirement='identity-gone'
  if identity_matches "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START"; then
    supervisor_was_live=1
    wd_log "waiting up to ${supervisor_yield_timeout_ms}ms for old watchdog $WD_TAKEOVER_FROM to yield; old host remains available"
  fi
  while identity_matches "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START"; do
    consume_takeover_control
    if [ "$(now_ms)" -ge "$supervisor_yield_deadline" ]; then
      supervisor_timed_out=1
      wd_log "old watchdog $WD_TAKEOVER_FROM did not yield in ${supervisor_yield_timeout_ms}ms; retiring its frozen, revalidated identity"
      if stop_matching_identity "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START" TERM; then
        supervisor_retirement='forced'
        retirement_deadline=$(( $(date +%s) + 3 ))
        while identity_matches "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START" \
          && [ "$(date +%s)" -lt "$retirement_deadline" ]; do wd_sleep 0.2; done
        stop_matching_identity "$WD_TAKEOVER_FROM" "$WD_TAKEOVER_FROM_START" KILL || true
      else
        # The PID changed between the loop predicate and SIGSTOP. The helper
        # resumed it without delivering TERM; the authorized old identity is
        # gone, so proceed using only the separately captured child identities.
        supervisor_retirement='identity-gone'
      fi
      break
    fi
    wd_sleep 0.2
  done
  if [ "$supervisor_was_live" = "1" ] && [ "$supervisor_timed_out" = "0" ]; then
    supervisor_retirement='yielded'
  fi
  cutover_event_required previous-supervisor-retired "$supervisor_retirement"
  # Publish the intentional-restart marker only at the irreversible boundary.
  # Writing it in the reconfigure caller lets the OLD watchdog consume and
  # clear it before yielding, leaving the final child ready but the receipt
  # permanently nonterminal. The old instance still sees the marker during
  # SIGTERM and can snapshot interrupted sessions with the correct initiator.
  write_cutover_restart_marker
  if ! stop_previous_owned_tree; then
    WD_TAKEOVER_FROM=""
    cutover_event_required awaiting-user "could not stop the captured previous child/listener identity without touching an unapproved port owner"
    printf '%s launch cutover waiting: previous ownership could not be retired\n' "$(date '+%F %T')" > "$GIVE_UP_MARKER"
    WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
    page_pid=$!
    wait "$page_pid"
    exit 1
  fi
  wd_log "captured previous child $PREVIOUS_CHILD_PID and listener $PREVIOUS_LISTENER_PID exited — taking over :$PORT"
  # This is the irreversible boundary. Never restore a possibly recycled old
  # supervisor pid during a much later cleanup.
  WD_TAKEOVER_FROM=""
elif [ -n "$CUTOVER_ID" ]; then
  # OS-level crash recovery: this watchdog claimed a stale/empty pidfile and
  # resumes the atomically selected side of an existing transaction. Replace
  # any orphan listener from the failed supervisor, then prove a fresh final
  # child; never compact the transaction merely because its driver died.
  wd_log "resuming launch cutover $CUTOVER_ID on selected side $CUTOVER_ROLE"
  supervisor_start_token=$(process_start_token "$$")
  [ -n "$supervisor_start_token" ] || { wd_log "could not capture resumed watchdog start identity" >&2; exit 1; }
  cutover_event_required supervisor-ready "$$" "$supervisor_start_token"
  write_cutover_restart_marker
  if ! stop_previous_owned_tree; then
    cutover_event_required awaiting-user "resume could not prove the shared port free from the captured previous identity"
    printf '%s launch cutover waiting: port ownership is ambiguous\n' "$(date '+%F %T')" > "$GIVE_UP_MARKER"
    WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
    page_pid=$!
    wait "$page_pid"
    exit 1
  fi
elif [ "${WD_WAIT_OWNER:-0}" = "1" ]; then
  # Adoption ahead of a self-restart: the current owner exits on its own.
  wd_log "waiting for the current owner of :$PORT to exit"
  while "$LSOF_BIN" -tiTCP:"$PORT" -sTCP:LISTEN -P >/dev/null 2>&1; do wd_sleep 1; done
  wd_log "port free — taking over"
else
  free_port
fi

while true; do
  # Self-heal the ownership claim before processing control or changing live
  # state. If another supervisor owns the pidfile, this process has no
  # authority to apply or roll back a filesystem transition.
  if [ "$SUPERVISE" = "1" ]; then
    if [ ! -f "$PIDFILE" ]; then (set -C; echo $$ > "$PIDFILE") 2>/dev/null || true; fi
    pidowner=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$pidowner" ] && [ "$pidowner" != "$$" ] && kill -0 "$pidowner" 2>/dev/null; then
      wd_log "pidfile now owned by live pid $pidowner — yielding"
      yielded=1
      # Non-zero keeps launchd/systemd's stable launcher alive: it restarts,
      # reads the newly selected durable spec, then waits behind the successor.
      # A detached parent simply observes the code and is unaffected.
      exit 75
    fi
  fi
  if [ -n "$CUTOVER_ID" ] && handle_cutover_control; then
    if [ "$control_result" = "wait" ]; then
      park_cutover "operator abort follows wait-for-user policy"
      continue
    fi
    wd_log "operator control selected the previous complete launch specification"
  fi
  if [ -n "$TRANSITION_PLAN_SHA256" ]; then
    if [ "$CUTOVER_ROLE" = "target" ] && [ "$transition_applied" = "0" ]; then
      if guard_cmd transition-apply "$CUTOVER_ID" --state-dir "$STATE_DIR"; then
        transition_applied=1
        wd_log "filesystem transition applied after previous stopped and before target start"
      else
        wd_log "filesystem transition apply failed — target will not start" >&2
        if [ "$CUTOVER_POLICY" = "restore-previous" ] \
          && select_previous_spec "filesystem transition failed before target start; restoring previous spec"; then
          continue
        fi
        cutover_event_required awaiting-user "filesystem transition failed; target was not started and previous was not restored"
        park_cutover "filesystem transition failed; inspect the cutover transition journal"
        continue
      fi
    elif [ "$CUTOVER_ROLE" = "previous" ] && [ "$transition_rolled_back" = "0" ]; then
      if guard_cmd transition-rollback "$CUTOVER_ID" --state-dir "$STATE_DIR"; then
        transition_rolled_back=1
        wd_log "filesystem transition rollback verified before previous start"
      else
        cutover_event_required awaiting-user "filesystem transition rollback failed; previous was not started"
        park_cutover "filesystem transition rollback failed; previous remains stopped"
        continue
      fi
    fi
  fi
  # Snapshot BEFORE this boot rewrites it: the stamp exists iff this
  # deployment has ever come up healthy — the discriminator between
  # "recovered an unplanned exit" and "first boot ever" (a first boot must
  # not file a crash report). Durable (not a process flag) so a restarted
  # watchdog still judges correctly.
  had_boot_stamp=0
  [ -f "$STATE_DIR/last-good-boot.json" ] && had_boot_stamp=1
  if [ "$CUTOVER_ROLE" = "target" ]; then
    target_attempt=$((target_attempt + 1))
    current_attempt=$target_attempt
  else
    previous_attempt=$((previous_attempt + 1))
    current_attempt=$previous_attempt
  fi
  # Keep the long-standing "starting instance" prefix stable for operators and
  # log consumers; the role is additive cutover metadata.
  wd_log "starting instance on :$PORT (role=$CUTOVER_ROLE, failures=$failures, attempt=$current_attempt)"
  # Capture this attempt's output for failure-domain classification. Plain
  # redirection only — never > >(tee …) process substitution: a sandboxed or
  # detached spawner can EPERM on the /dev/fd/N that >() opens (workspace-write
  # sandboxes do), killing the instance before it runs. On failure the attempt
  # log is mirrored into this log below; a healthy run's boot message names
  # the file its output lives in.
  : > "$ATTEMPT_LOG"
  chmod 600 "$ATTEMPT_LOG" 2>/dev/null || true
  launch_instance > "$ATTEMPT_LOG" 2>&1 &
  child=$!
  child_start_token=$(process_start_token "$child")
  [ -n "$child_start_token" ] || child_start_token="unavailable-$child"
  cutover_event_required child-started "$CUTOVER_ROLE" "$current_attempt" "$child" "$child_start_token"
  last_transport_status=''
  launch_url_reported=0
  launch_url_value=''
  readiness_detail=''
  protected_ready=0
  # Launch URLs and browser cookies are process-bound. Every retry must prove
  # and hand off its own URL; an accepted URL from a rejected child is stale.
  browser_handoff_done=0
  browser_handoff_reported=0
  current_listener_pid=''
  current_listener_start=''
  # Boot window: transport-up is not enough. A protected root can answer 401;
  # ready_probe completes the process's announced launch-URL cookie exchange.
  up=0
  readiness_failure_detail="readiness not proven within ${BOOT_TIMEOUT}s"
  boot_limit=$(( $(date +%s) + BOOT_TIMEOUT ))
  while [ "$(date +%s)" -lt "$boot_limit" ]; do
    if [ -n "$(cutover_control_action)" ]; then
      readiness_failure_detail="operator control interrupted readiness"
      kill_current_owned_attempt
      break
    fi
    if ! kill -0 "$child" 2>/dev/null; then
      readiness_failure_detail="child exited before ownership-stable readiness"
      break
    fi
    if ready_probe; then
      if prove_stable_readiness; then
        up=1
      else
        readiness_failure_detail="provisional readiness did not retain one child/listener identity through the stability window"
      fi
      # Readiness that cannot hold the same child/listener identity for the
      # stability window is an attempt failure, not an invitation to attach
      # to whichever process next answers on the shared port.
      break
    fi
    wd_sleep 1
  done

  if [ "$up" = "0" ]; then
    # Read the bound ports BEFORE reaping — once the child is gone there is no
    # way left to tell "never started" from "started on the wrong port".
    bound=""
    if identity_matches "$child" "$child_start_token"; then bound=$(instance_listen_ports "$child"); fi
    # Never came up (or died); stop a still-alive child and reap it.
    kill_current_owned_attempt
    wait "$child" 2>/dev/null
    # Strip bearer launch URLs before any durable failure output is mirrored.
    redact_launch_urls_in_output
    # Mirror the captured output into the watchdog log: with plain redirection
    # (see the launch site) the attempt log is the only place the failure was
    # written, and the watchdog log is where an operator looks first.
    sed 's/^/[instance] /' "$ATTEMPT_LOG" 2>/dev/null

    if [ -n "$CUTOVER_ID" ] && [ -n "$(cutover_control_action)" ]; then
      failures=$((failures + 1))
      cutover_event_required attempt-failed "$CUTOVER_ROLE" "$current_attempt" "operator control interrupted readiness"
      if handle_cutover_control; then
        if [ "$control_result" = "restore" ]; then
          wd_log "operator control interrupted target readiness — restoring previous"
          continue
        fi
        park_cutover "operator abort follows wait-for-user policy"
        continue
      fi
    fi

    if grep -q 'EADDRINUSE' "$ATTEMPT_LOG" 2>/dev/null; then
      if grep 'EADDRINUSE' "$ATTEMPT_LOG" | grep -qE "[:.]$PORT([^0-9]|$)"; then
        if [ -n "$CUTOVER_ID" ]; then
          # The target never inherits authority to kill an arbitrary owner of
          # the shared port. Count the attempt so the approved full-spec
          # recovery policy runs; any listener previously proven inside this
          # attempt was already retired by kill_current_owned_attempt.
          wd_log "cutover $CUTOVER_ROLE hit EADDRINUSE on :$PORT — refusing port-based cleanup; counting a $CUTOVER_ROLE failure"
          readiness_failure_detail="EADDRINUSE on supervised :$PORT; cutover refused port-based cleanup"
          port_races=5
        else
        # The supervised port was still held (a leftover process, a slow exit)
        # — an operational race, not a code regression. The watchdog owns this
        # port, so free it and retry WITHOUT counting toward rollback or
        # give-up. Bounded: once freeing stops winning the port back, the owner
        # is outside this watchdog's reach and retrying is a hot spin.
        port_races=$((port_races + 1))
        if [ "$port_races" -le 5 ]; then
          wd_log "boot hit EADDRINUSE on :$PORT — freeing the port and retrying (not a code failure, attempt $port_races/5)"
          free_port
          continue
        fi
        wd_log ":$PORT is still held after 5 free attempts — counting this as a boot failure"
        fi
      else
        # EADDRINUSE on a port this watchdog does not own: the start command
        # targets somewhere else, and freeing :$PORT cannot release it. The
        # unconditional retry this replaces never counted the attempt, so a
        # start command aimed at an occupied foreign port respawned the
        # instance in a tight loop with no backoff and no give-up.
        wd_log "boot hit EADDRINUSE on a port other than the supervised :$PORT — the --start command targets a port this watchdog does not own; freeing :$PORT cannot fix that"
        reset_done=1
      fi
    fi

    failures=$((failures + 1))
    wd_log "instance failed to come up (failure #$failures: $readiness_failure_detail)"
    cutover_event_required attempt-failed "$CUTOVER_ROLE" "$current_attempt" "$readiness_failure_detail"

    # The instance came up on a port this watchdog does not own: a start-command
    # argument, not a code regression. Resetting the checkout cannot change a
    # command line, so mark the rollback spent (same escape hatch as a failure
    # whose subject lives outside the repository) and keep counting toward the
    # crash page, which is what makes the misconfiguration visible.
    if [ -n "$bound" ] && ! printf '%s\n' "$bound" | grep -qx "$PORT"; then
      wd_log "instance bound :$(printf '%s' "$bound" | paste -sd, -) but supervision owns :$PORT — the --start command does not bind the supervised port; a repository rollback cannot fix that"
      reset_done=1
    fi

    # A launch cutover recovers the complete previous spec or waits, exactly as
    # approved before the stop. It never falls through to the ordinary
    # repository/composition reset machinery: neither can repair a command,
    # home, credential repo, host root, or profile change as one unit.
    if [ -n "$CUTOVER_ID" ] && [ "$failures" -ge "$TARGET_FAILURE_LIMIT" ]; then
      if [ "$CUTOVER_ROLE" = "target" ] && [ "$CUTOVER_POLICY" = "restore-previous" ] \
        && [ -n "$PREVIOUS_START" ] && [ -n "$PREVIOUS_HOME" ] && [ -n "$PREVIOUS_REPO" ] \
        && [ -n "$PREVIOUS_HARNESS_ROOT" ]; then
        wd_log "target launch failed after $failures attempt(s) — restoring the approved previous launch specification"
        if select_previous_spec "target failed after $failures attempt(s); restoring previous spec"; then
          continue
        fi
        cutover_event_required awaiting-user "target failed and filesystem transition rollback did not complete; previous was not started"
        park_cutover "target failed; previous restore is blocked by filesystem transition rollback"
        continue
      fi
      wd_log "launch cutover cannot become ready — approved policy is ${CUTOVER_POLICY:-wait-for-user}; parking for user action"
      cutover_event_required awaiting-user "$CUTOVER_ROLE launch failed after $failures attempt(s)"
      printf '%s launch cutover waiting after %s failures\n' "$(date '+%F %T')" "$failures" > "$GIVE_UP_MARKER"
      WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
      page_pid=$!
      wait "$page_pid"
      page_pid=''
      continue
    fi

    if [ -z "$CUTOVER_ID" ] && [ "$failures" -ge 2 ] && [ "$reset_done" -eq 0 ]; then
      sha=$(rollback_sha)
      if [ -z "$sha" ]; then
        wd_log "no guard credential/checkpoint recorded; cannot roll back"
      elif failure_subject_outside_repo; then
        # The failure lives outside the checkout (profile overlay, installed
        # plugin, environment) — reverting the repository cannot fix it. But
        # the COMPOSITION can be rolled back: if a healthy-boot snapshot of
        # the profile inputs exists and differs from the live one, restore it
        # (unmounting the newest plugin change) and retry with a clean count.
        if [ "$comp_restore_done" -eq 0 ] && restore_composition; then
          comp_restore_done=1
          comp_restored=1
          failures=0
          continue
        fi
        wd_log "boot failure originates outside $REPO — repository rollback cannot fix it; leaving the checkout untouched"
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
      wd_log "giving up after $failures consecutive failures"
      printf '%s giving up after %s failures\n' "$(date '+%F %T')" "$failures" > "$GIVE_UP_MARKER"
      wd_log "serving crash page on :$PORT — click 重试 or send SIGUSR1 to $$"
      WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
      page_pid=$!
      wait "$page_pid"
      page_pid=''
      continue
    fi

    wd_sleep $((failures * 5))
    continue
  fi

  # Instance is up.
  wd_log "instance ready on :$PORT ($readiness_detail) — instance output: $ATTEMPT_LOG"
  if [ "$comp_restored" = "1" ]; then
    # The boot only succeeded because the composition was rolled back — the
    # recovery (newest plugin change unmounted) must be reported, not silent.
    guard_cmd record-composition-recovery --state-dir "$STATE_DIR" --detail "$comp_restore_detail"
    comp_restored=0
  fi

  # Intentional restart: run the guard canary (credential fresh + HEAD match).
  if [ -f "$RESTART_MARKER" ]; then
    canary_proven=0
    if guard_verify && current_ownership_matches; then
      cutover_event_required canary "$CUTOVER_ROLE" pass
      # Persisting canary evidence can take long enough for a short-lived child
      # to exit. Recheck after the event and before the terminal ready event.
      if current_ownership_matches; then canary_proven=1; fi
    fi
    if [ "$canary_proven" = "1" ]; then
      if [ -n "$CUTOVER_ID" ] && ! complete_browser_handoff; then
        failures=$((failures + 1))
        cutover_event_required attempt-failed "$CUTOVER_ROLE" "$current_attempt" \
          "browser handoff failed after canary and stable ownership"
        if [ "$CUTOVER_ROLE" = "target" ] && [ "$CUTOVER_POLICY" = "restore-previous" ] \
          && [ -n "$PREVIOUS_START" ] && [ -n "$PREVIOUS_HOME" ] && [ -n "$PREVIOUS_REPO" ] \
          && [ -n "$PREVIOUS_HARNESS_ROOT" ]; then
          kill_current_owned_attempt
          wait "$child" 2>/dev/null || true
          if select_previous_spec "target canary passed but browser handoff failed; restoring previous spec"; then
            continue
          fi
          cutover_event_required awaiting-user "browser handoff failed and filesystem transition rollback did not complete; previous was not started"
          park_cutover "browser handoff failed; previous restore is blocked by filesystem transition rollback"
          continue
        fi
        if [ "$CUTOVER_ROLE" = "previous" ]; then
          rm -f "$RESTART_MARKER"
          cutover_event_required awaiting-user "restored previous host is ready, but browser handoff was not acknowledged"
          wait_cutover_with_live_child
          continue
        fi
        kill_current_owned_attempt
        wait "$child" 2>/dev/null || true
        rm -f "$RESTART_MARKER"
        cutover_event_required awaiting-user "target browser handoff failed after canary"
        printf '%s launch cutover waiting after browser handoff failure\n' "$(date '+%F %T')" > "$GIVE_UP_MARKER"
        WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
        page_pid=$!
        wait "$page_pid"
        page_pid=''
        continue
      fi
      wd_log "canary PASS — browser handoff settled; recording deployment proof"
      if [ -n "$CUTOVER_ID" ]; then
        cutover_event_required ready "$CUTOVER_ROLE"
        CUTOVER_ID=''
      fi
      if ! guard_cmd record-proven-deployment --repo "$REPO" --state-dir "$STATE_DIR"; then
        # Proof persistence is an optimization for a later pure restart. This
        # boot already passed readiness, ownership, and canary; keep it up but
        # force the next restart back through fresh build/test evidence.
        wd_log "deployment proof unavailable — the next restart requires fresh build/test evidence" >&2
      fi
      rm -f "$RESTART_MARKER"
    else
      if [ -n "$CUTOVER_ID" ]; then
        wd_log "canary/ownership FAIL during launch cutover"
        if [ "$CUTOVER_ROLE" = "target" ]; then
          cutover_event_required canary target fail "credential/head verification or child/listener identity failed after readiness"
        elif current_ownership_matches; then
          # The singleton restart credential normally belongs to the rejected
          # target repo. Do not relabel that target credential failure as a
          # previous-host canary failure: stable process/listener ownership is
          # the explicit recovery proof when no previous-scoped credential is
          # available.
          cutover_event_required canary previous skipped \
            "target-scoped credential is not previous recovery evidence; stable ownership remained proven"
        else
          cutover_event_required canary previous fail \
            "restored child/listener identity failed after readiness"
        fi
        if [ "$CUTOVER_ROLE" = "target" ] && [ "$CUTOVER_POLICY" = "restore-previous" ] \
          && [ -n "$PREVIOUS_START" ] && [ -n "$PREVIOUS_HOME" ] && [ -n "$PREVIOUS_REPO" ] \
          && [ -n "$PREVIOUS_HARNESS_ROOT" ]; then
          kill_current_owned_attempt
          wait "$child" 2>/dev/null || true
          if select_previous_spec "target became ready but canary failed; restoring previous spec"; then
            continue
          fi
          cutover_event_required awaiting-user "target canary failed and filesystem transition rollback did not complete; previous was not started"
          park_cutover "target canary failed; previous restore is blocked by filesystem transition rollback"
          continue
        fi
        if [ "$CUTOVER_ROLE" = "previous" ]; then
          if ! current_ownership_matches; then
            failures=$((failures + 1))
            cutover_event_required attempt-failed previous "$current_attempt" \
              "restored previous ownership changed after readiness"
            cutover_event_required awaiting-user "restored previous host lost child/listener ownership"
            wait_cutover_with_live_child
            continue
          fi
          # The previous service is restored and ready; a credential tied to a
          # different target repo may legitimately fail. Browser acknowledgement
          # is still required before this recovery becomes terminal.
          rm -f "$RESTART_MARKER"
          if complete_browser_handoff; then
            cutover_event_required ready previous
            CUTOVER_ID=''
          else
            failures=$((failures + 1))
            cutover_event_required attempt-failed previous "$current_attempt" \
              "browser handoff failed after restored-previous canary settled"
            cutover_event_required awaiting-user "restored previous host is ready, but browser handoff was not acknowledged"
            wait_cutover_with_live_child
            continue
          fi
        else
          kill_current_owned_attempt
          wait "$child" 2>/dev/null || true
          cutover_event_required awaiting-user "target canary failed"
          printf '%s launch cutover waiting after canary failure\n' "$(date '+%F %T')" > "$GIVE_UP_MARKER"
          WD_PORT="$PORT" WD_PID="$$" node -e "$(page_script)" &
          page_pid=$!
          wait "$page_pid"
          page_pid=''
          continue
        fi
      else
      wd_log "canary FAIL — rolling back to last known-good"
      sha=$(rollback_sha)
      if [ -n "$sha" ]; then rollback_to "$sha" || true; fi
      rm -f "$RESTART_MARKER"
      failures=0
      reset_done=0
      continue
      fi
    fi
  else
    # Unplanned exit (crash, or a stop outside the guard): leave a record the
    # plugin reports on this boot — crash recovery must not be silent. Only
    # when the deployment has come up before (stamp snapshotted at the loop
    # top); the record semantics (pending protection, atomic write) live in
    # the guard CLI, where they typecheck and unit-test.
    if [ "$had_boot_stamp" = "1" ]; then
      guard_cmd record-unexpected-exit --state-dir "$STATE_DIR"
    elif [ "${WD_ADOPTION:-0}" = "1" ]; then
      # Adoption takeover — the first restart this deployment ever saw (the
      # CLI detected the previous owner at supervise time; probing here would
      # race the owner's exit). The session that established supervision
      # promised a verification report; this record wakes it after the bounce.
      # A first-EVER boot (WD_ADOPTION=0) reports nothing.
      guard_cmd record-adoption --state-dir "$STATE_DIR" --initiator "${WD_INITIATOR:-}"
    fi
  fi

  # Only a fully ready + canary-settled boot becomes the deployment rollback
  # target. Stamping before the cutover canary once made a rejected target the
  # very revision ordinary rollback preferred.
  stamp_last_good_boot
  snapshot_composition

  failures=0
  reset_done=0
  port_races=0
  # Watch the instance with a poll loop rather than a bare wait: the ownership
  # claim needs the same self-heal while the instance is healthy (the state
  # dir can be cleaned underneath a live watchdog at any time — that is how a
  # second supervisor once got spawned and both fought over the port).
  while kill -0 "$child" 2>/dev/null; do
    if [ "$SUPERVISE" = "1" ]; then
      if [ ! -f "$PIDFILE" ]; then (set -C; echo $$ > "$PIDFILE") 2>/dev/null || true; fi
      pidowner=$(cat "$PIDFILE" 2>/dev/null)
      if [ -n "$pidowner" ] && [ "$pidowner" != "$$" ] && kill -0 "$pidowner" 2>/dev/null; then
        wd_log "pidfile now owned by live pid $pidowner — yielding (instance left running for the new owner)"
        yielded=1
        exit 75
      fi
    fi
    wd_sleep 2
  done
  wait "$child"

  # Explicit stop: exit the watchdog without respawn.
  if [ -f "$STOP_MARKER" ]; then
    wd_log "stop marker present — exiting"
    rm -f "$STOP_MARKER" "$PIDFILE"
    exit 0
  fi

  wd_sleep 3
  if transport_up; then
    free_port
  fi
done
