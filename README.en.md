# dsh-ankh-guard

English | [中文](README.md)

Let an agent change its own code and restart its own service — without taking the whole thing down.

When the agent wants to restart after editing code, this plugin asks one question first: did the build and tests pass? Yes, go ahead. No, blocked — so broken code can't take the service, and the conversation running inside it, down with it.

![The restart loop in action](assets/restart-loop-demo.png)

A real self-restart, end to end: the agent announces its verification plan before restarting (1); the host exits and the in-flight tool call is safely interrupted and recorded (2); the watchdog brings the instance back within seconds and ankh-guard injects the restart context into the original session (3) — the agent wakes up and runs the exact checks it promised, while the user notices nothing.

## How it works

One rule at the core: **prove the code is good before you allow a restart.**

After a green build and tests, the plugin records a credential bound to the current git commit, valid for 10 minutes (`maxAgeMinutes`). On a restart request it checks three things:

1. does a credential exist;
2. is it younger than `maxAgeMinutes`;
3. does the current HEAD match the commit the credential was recorded on — any change after recording invalidates it.

That one rule catches a whole class of incidents: broken builds, missed config registration, wrong imports — all of these fail the build/typecheck, so no credential exists and the restart is refused before it can hurt.

The restart itself is handed to a watchdog: a detached supervisor that brings the host back if it dies, rolls back to the checkpoint if it can't come up, and stops at a crash page after four consecutive failures. `checkpoint` commits the whole working tree as a rollback point before a batch, `reset` hard-resets to it, and `canary` re-verifies after a restart. Checkpoints and credentials persist in a state file that survives restarts, so the canary runs after the new instance is up.

## Install and load

This package is a dsh plugin: it guards a running dsh web instance against broken self-modification restarts. It ships no host — you need a dsh host first (`npx @deepseek-ai/dsh web`). Host compatibility: dsh `0.0.1-rc.5+` or `0.1.0-rc.5+` (any current npm release works).

One command installs the plugin into a profile and activates it as a patch layer (the package declares `dsh.bundle`, so `add` both writes the dependency and mounts the plugin — re-running is safe, deduped by package name):

```sh
dsh plugin --profile web add @khorsheed/dsh-ankh-guard
```

Or install from GitHub (builds itself on install via `prepare`):

```sh
dsh plugin --profile web add github:Khorsheed/dsh-ankh-guard
```

Restart the host afterwards. Note: if your profile already composes `ankh-guard` through another bundle, do NOT also `plugin add` it — mounting the same entry id twice fails loud at boot (`duplicate loader entry id`).

For custom profiles, compose it by hand in your own patch layer instead:

```yaml
- insert:
    - id: ankh-guard
      name: '@khorsheed/dsh-ankh-guard'
```

From source — clone, build, test:

```sh
git clone https://github.com/Khorsheed/dsh-ankh-guard.git
cd dsh-ankh-guard && pnpm install && pnpm run build && pnpm test
```

Config (all optional): `stateDir` (default `$DSH_HOME/state`, else `<cwd>/.dsh-guard-state`), `repoDir` (default the process cwd), `maxAgeMinutes` (credential freshness, default 10), `reportRestartContext` (`followup` autonomous report / `step` ride the next turn / `off`, default `followup`), `fallbackGraceMs` (how long to wait for the initiating session before another agent takes the report, default 60000).

Runtime needs: `node`, `bash`, `lsof` on macOS/Linux for listener discovery (`--pid` bypasses it). No build step for consumers — the published `lib/` is the runnable artifact.

## CLI

The primary interface is the CLI, usable even when the instance is down. Use the `dsh-ankh-guard` bin (or `node lib/cli.js`). Every command takes `--state-dir "$DSH_HOME/state" --repo "$PWD"`.

```sh
dsh-ankh-guard verify      # is it safe to restart right now
dsh-ankh-guard record build+test   # green build & tests → record the credential
dsh-ankh-guard checkpoint --message "what changed"   # checkpoint before editing
dsh-ankh-guard canary --port 3080   # confirm after restart
dsh-ankh-guard supervise --port 3080 --start "CMD"   # hand the port to a watchdog
```

Full commands: `verify`, `record`, `status`, `clear`, `checkpoint`, `reset`, `canary`, `restart`, `schedule-exit`, `supervise`.

### The self-restart protocol

Six steps for a safe restart after editing code:

1. **checkpoint** — snapshot the working tree as the rollback point: `dsh-ankh-guard checkpoint --message "<batch>"`
2. **modify** — make the change; register every surface it needs (aggregates, paths, bundle rows, dependencies).
3. **build + test** — the narrow full set for the changed surface; no green, no credential.
4. **record** — `dsh-ankh-guard record build+test --command "<what went green>"`
5. **verify** — `dsh-ankh-guard verify` must exit 0; a denial (missing/stale/HEAD-mismatched credential) means rebuild and re-record.
6. **restart + canary** — after the new instance is up, `dsh-ankh-guard canary --port N` confirms it.

### supervise: seamless restart

`restart` runs the whole kill → start → probe → canary loop in one CLI process (use `--delay-ms` so the scheduling turn finishes first). For deployments where nobody should touch a terminal, `supervise` hands the job to a **watchdog** — a detached supervisor process that survives the instance:

```sh
dsh-ankh-guard supervise --port 3080 --start "CMD" --state-dir "$DSH_HOME/state" --repo "$PWD"
```

It spawns `scripts/dsh-watchdog.sh` (ships with the package) detached with `--wait-owner`: the watchdog idles while the current instance runs, takes over the port when the instance exits (intentional restart or crash), respawns it, runs the guard canary on intentional restarts (a `restart-requested.json` marker), and clears the marker on pass. Two consecutive boot failures roll the checkout back to the guard checkpoint; four failures serve a crash page on the port with a retry button (SIGUSR1 to the watchdog). A `watchdog-stop` marker exits the watchdog for good. The instance itself can adopt supervision before a self-restart — the user never starts the watchdog by hand.

When a watchdog is already supervising, the restart trigger is `schedule-exit`: it writes the restart marker and spawns a detached exit agent (setsid via node `spawn`), which cannot be reaped by a managed shell's process group, so the scheduled kill actually lands after the scheduling turn ends (the fix for `(sleep N; kill) &` silently never firing). The watchdog respawns, runs the canary, and the new instance reports via `last-restart.json`. Prefer `restart` (single-shot loop) only when no watchdog is present.

**The restart report reaches the model by itself.** On agent creation after a scheduled restart (a pending `last-restart.json` record), the plugin queues the report as the next turn via `agent.followup` — the official wake-the-agent seam the schedule system uses for reminders — so the agent reports the restart result without any user message. The report returns to the session that scheduled the exit: `schedule-exit` records `$DSH_SESSION_ID` as the initiator, and while that session's root agent is live only it may claim the record. Session restore is asynchronous, so a non-live initiator is checked against persistence: still present (slow resume) → a grace timer (`fallbackGraceMs`, default 60000 ms) waits for it before any root agent falls back; gone → the first live root agent claims it, so the report is never lost. The timer validates the record identity on fire (same `exitAt`, still unreported) so a second restart or an earlier claim cannot be acked by a stale timer. Only root agents, once (the record is acknowledged). Config `reportRestartContext`: `followup` (default, autonomous), `step` (ride the first step of whatever turn comes next), or `off`.

### supervise: one port, one owner

A port must have exactly one supervision owner, but the owner itself should be supervised. Three deployment shapes:

- **A — pure guard**: no external supervisor; the instance adopts the watchdog via `supervise` before a self-restart. Simplest, but nothing pulls the host back after an unexpected crash.
- **B — pure launchd/systemd**: the launcher owns the port with KeepAlive. Solid for crashes, but self-modification restarts are not guarded by the credential gate.
- **C — layered (recommended)**: launchd supervises the watchdog, the watchdog supervises the instance. One owner per port, and the owner is supervised. Run the watchdog in the foreground:

```sh
# launchd/systemd job (KeepAlive) runs this; the CLI process IS the watchdog:
dsh-ankh-guard supervise --foreground --port 3093 --start "<start command>" \
  --state-dir "$DSH_HOME/state" --repo "<checkout>"
```

`--foreground` runs the watchdog inline (adopting the port) and exits with it, so a dead watchdog triggers the external supervisor's restart. The detached form (`supervise` without `--foreground`) is for the instance adopting supervision ahead of a self-restart.

The checkpoint/rollback round trip:

```sh
dsh-ankh-guard checkpoint --message "before batch"
# ... modify, build, test, record, verify ...
dsh-ankh-guard canary --port 3080   # fails → roll back
dsh-ankh-guard reset <checkpoint-sha>
```

`restart` owns the whole restart loop in a detached process that outlives the restarted instance. It refuses to stop the instance when the gate denies (the credential check is enforced in the restart path itself, not just by procedure), stops the listener on `--port`, starts the `--start` command detached, polls until the port listens, re-verifies, and with `--rollback` hard-resets to the recorded checkpoint when the new instance never comes up:

```sh
dsh-ankh-guard restart \
  --port 3080 --start "DSH_HOME=$HOME/.dsh-official pnpm dsh web" --rollback \
  --state-dir "$DSH_HOME/state" --repo "$PWD"
```

Mounted as a cordis plugin (base bundle), the same surface is available as the `selfRestartGuard` service for in-app gates. Config: `maxAgeMinutes` (default 10), `stateDir`, `repoDir`, `reportRestartContext` (default `followup`), `fallbackGraceMs` (default 60000).

## Model Experience

None. The guard is host-side infrastructure; it adds no tool schema, prompt, or result to any model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **The gate is enforced in `restart`/`supervise`, not the launcher** — both refuse to stop the instance on a denial, but a manual `kill`/start outside the guard still bypasses it; the watchdog (P2) is the automatic safety net that makes a bypassed gate recoverable.
- **The watchdog needs a supervisor to outlive the instance** — `supervise` spawns it detached (setsid); a watchdog spawned from inside a process that is about to die must be orphaned first, so the app adopts supervision *before* exiting.
- **A/B partition (P1) is out of scope here** — the slot-switch mechanism for production exists elsewhere; a worktree-based dev flow that never touches the running checkout is a separate follow-up.
- **Checkpoint commits sweep the whole working tree** — intended (a checkpoint is a full rollback point), but note it also captures unrelated uncommitted work.
- **`restart`/`supervise` discover the listener via `lsof`** (macOS/Linux with lsof); other platforms need `--pid`.

## Links

- [dshfind](https://dshfind.com/)
