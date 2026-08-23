---
name: dsh-self-restart-guard
description: Use before ANY self-modification batch that may end in restarting the running dsh web instance (product code, client plugins, tsconfig/bundle registrations, dependencies). Enforces the green-build credential gate, the pre-batch checkpoint, and the post-restart canary so a broken self-change rolls back instead of taking the instance down. Also consult it to query the guard state or the recorded pitfalls before deployment.
---

# Self-Restart Guard: atomic self-modification protocol

Self-modification ends in a restart of the running instance — the process that hosts the conversation. A broken change therefore kills the session. This protocol makes every restart conditional on proof and recoverable on failure. The guard is the `@khorsheed/dsh-ankh-guard` package installed into the active profile (CLI + `selfRestartGuard` service, state file at `$DSH_HOME/state/self-restart-guard.json`).

Invoke the CLI through the installed package (resolve once, then reuse):

```sh
GUARD="node $(ls "$DSH_HOME"/profiles/*/node_modules/@khorsheed/dsh-ankh-guard/lib/cli.js 2>/dev/null | head -1)"
```

If a profile `.bin` directory is on PATH, `dsh-ankh-guard <verb>` works too.

## Resolve your own environment first (do NOT assume defaults)

Never restart "the instance" from a recipe — restart the one you are actually in. Resolve these three from your own context, in this order:

1. **State dir**: `$DSH_HOME/state` (already in your environment). If `DSH_HOME` is unset, the deployment is custom — ask the user rather than guessing.
2. **Start command and repo**: read `$DSH_HOME/state/instance-launch.json` once the plugin has booted there — the plugin records the instance's exact launch command (cwd, env, full argv incl. `--import` chains) at every boot. `restart`/`supervise` consume it automatically, so `--start` is usually unnecessary. Only construct a start command yourself when the record does not exist (plugin not loaded yet).
3. **Port**: the GUI address in your context (e.g. the system prompt's URL), else `lsof -a -p <instance-pid> -iTCP -sTCP:LISTEN -P`. The `restart` verb also defaults `--port` from the launch record.

Run `$GUARD check-env --state-dir "$DSH_HOME/state" --repo <repo>` for a one-shot readout of all of the above plus sandbox status and watchdog presence.

## The protocol (every batch)

1. **Checkpoint** — before touching anything, snapshot the working tree of the repo you are about to change:

```sh
$GUARD checkpoint --message "before <batch-name>" --repo <repo> --state-dir "$DSH_HOME/state"
```

2. **Modify** — make the change; register every surface the change needs (package `files`, `dsh.bundle.patch`, identity triangle, dependencies). Missing registrations are the single most common failure class — an unregistered package is invisible to every gate.

3. **Prove green** — run the build and tests that cover the change, then record the green-build credential bound to the repo's HEAD (freshness window 10 minutes):

```sh
$GUARD record build --command "<the command that went green>" --repo <repo> --state-dir "$DSH_HOME/state"
$GUARD verify --repo <repo> --state-dir "$DSH_HOME/state"
```

4. **Preflight** — the composition dry-run gate; a FAIL blocks the restart and must never be bypassed:

```sh
$GUARD preflight --profile web
```

5. **Restart** — the path depends on supervision:
   - **No watchdog yet** (e.g. right after installing the plugin): drive it with the `restart` verb — it owns stop → start → canary in a detached driver and self-detaches from the dying instance. `--start` defaults to the launch record when one exists.
   - **Watchdog-supervised** (a `watchdog.pid` is live in the state dir): `schedule-exit --port <port> --delay-ms 5000 --repo <repo> --initiator <your-agent-id>`. It re-verifies the credential against the repo's CURRENT HEAD, runs the composition preflight, exits the instance after the delay (so the current turn finishes), and the watchdog respawns + canaries automatically. Do NOT use bare `restart` against a supervised instance — it fights the supervisor.
   - Never hand-roll `sleep; kill; nohup start` scripts — they die with the instance (teardown reaps managed processes).

6. **Verify after** — the port must listen again and the canary must PASS (`$DSH_HOME/state/restart.log` for the verb path, `watchdog.log` for the supervised path). On repeated boot failure the watchdog rolls the checkout back to the last known-good revision, leaving `guard-backup-*` branches on the discarded HEAD.

## Querying state

```sh
$GUARD status --state-dir "$DSH_HOME/state"   # credentials, checkpoints, restart records
$GUARD canary --port <port> --state-dir "$DSH_HOME/state" --repo <repo>
```

## Pitfalls this protocol exists for

- **Credential/HEAD mismatch**: `schedule-exit`/`restart` refuse when the credential's revision ≠ current HEAD — rebuild and re-record after every commit. Record with `--state-dir` pointing at the SAME state the restart reads (`$DSH_HOME/state`); a record without it lands in a stray `<cwd>/.dsh-guard-state` and the gate will not see it.
- **Sandboxed sessions**: restart verbs refuse in a sandboxed turn (a detached driver would be reaped). Escalate through your host's per-command approval, or the user runs `/permission danger-full-access` in the session — settings pages only affect NEW sessions.
- **Preflight FAIL is information, not friction**: it has caught unbootable profile patches and duplicate loader entry ids before they could take prod down. Fix the composition; never bypass.
- **Profile `link:`/`file:` deps**: after rebuilding a plugin, refresh the profile install (`dsh plugin --profile web add <path-or-tarball>`) before restarting — a restart serves whatever the profile's `node_modules` currently contains.
