# dsh-ankh-guard

English | [中文](README.md)

Let an agent change its own code and restart its own service — without taking the whole thing down.

When the agent wants to restart after editing code, this plugin asks one question first: did the build and tests pass? Yes, go ahead. No, blocked — so broken code can't take the service, and the conversation running inside it, down with it.

## How it works

One rule at the core: **prove the code is good before you allow a restart.**

After a green build and tests, the plugin records a credential bound to the current git commit, valid for 10 minutes (`maxAgeMinutes`). On a restart request it checks three things:

1. does a credential exist;
2. is it younger than `maxAgeMinutes`;
3. does the current HEAD match the commit the credential was recorded on — any change after recording invalidates it.

That one rule catches a whole class of incidents: broken builds, missed config registration, wrong imports — all of these fail the build/typecheck, so no credential exists and the restart is refused before it can hurt.

A green build still says nothing about the profile composition: bad patch YAML, a missing built file, a duplicate loader entry id, a typert manifest ownership mismatch, a plugin whose apply throws — all of these fail only at boot. So a second gate runs after the credential check, before anything is stopped: `preflight` deep-dry-runs the exact composition in a subprocess (full plugin tree booted through the same engine, then disposed), and a composition that does not boot means the running instance is never stopped. See [preflight: the composition gate](#preflight-the-composition-gate).

The restart itself is handed to a watchdog: a detached supervisor that brings the host back if it dies, rolls back to the last known-good revision (the healthy-boot stamp — the last revision that actually came up in this deployment — else the checkpoint, else the green credential's HEAD) if it can't come up — skipping the rollback when the boot failure originates outside the repository — and stops at a crash page after four consecutive failures. Every rollback leaves `guard-backup-*` recovery anchors for the discarded HEAD and any uncommitted work. `checkpoint` commits the whole working tree as a rollback point before a batch, `reset` hard-resets to it (anchored the same way), and `canary` re-verifies after a restart. Checkpoints and credentials persist in a state file that survives restarts, so the canary runs after the new instance is up.

## Install and load

This package is a dsh plugin: it guards a running dsh web instance against broken self-modification restarts. Its single identity is **`@khorsheed/dsh-ankh-guard`**, developed in the `dsh-plugins` monorepo and published to npm from there. Install the host and add the plugin as a profile bundle:

```sh
npm install @deepseek-ai/dsh                                 # the host (dsh web / dsh CLI)
dsh plugin --profile web add @khorsheed/dsh-ankh-guard       # this plugin
```

Or install straight from this GitHub mirror — the `prepare` script builds it on install:

```sh
dsh plugin --profile web add github:Khorsheed/dsh-ankh-guard
```

The package declares `dsh.bundle`, so the add reconciles its `cordis.patch.yml` row (a bare `ankh-guard` mount) into the profile's bundles layer — no hand-edited cordis.yml. One caveat: a composition may mount the `ankh-guard` row id only once. Official images (the published npm line and upstream master) mount no such row, so the add above is the install path; a composition that already mounts the id by other means — the pre-2026-08-16 deploy fork's base bundle did — must not also add the package, because a duplicate loader entry id fails boot. When in doubt, check the composed tree first: `dsh --profile web --dump-config | grep ankh-guard` printing nothing means the add is safe. From source: clone the monorepo; the package lives at `packages/ankh-guard` (`pnpm install && pnpm run build`).

Config (all optional): `stateDir` (default `$DSH_HOME/state`, else `<cwd>/.dsh-guard-state`), `repoDir` (default the process cwd), `maxAgeMinutes` (credential freshness, default 10), `reportRestartContext` (`followup` autonomous report / `step` ride the next turn / `off`, default `followup`), `resumeInterrupted` (resume restart-interrupted sessions and queue a continue turn, default true), `resumeDelayMs` (default 5000), `resumeMaxSnapshotAgeMs` (default 600000).

Runtime needs: `node`, `bash`, `lsof` on macOS/Linux for listener discovery (`--pid` bypasses it), and `pgrep` for descendant reaping (the watchdog's `free_port`/cleanup and `restart`'s forced-kill escalation walk the child tree instead of assuming a process group). No build step for consumers — the published `lib/` is the runnable artifact.

## Prerequisites for a self-restart (for the agent driving it)

- **git is required.** The credential, checkpoints, and rollback are all git-based: the credential binds HEAD, a checkpoint is a real commit, rollback is a reset. If the deployment directory is not a git repository, `git init` it and make an initial commit before `record` — otherwise the gate refuses with "current git HEAD unavailable". The `git init` is not ceremony: with a repository in place, the checkpoint/rollback recovery anchors actually work.
- **Full-access (unsandboxed) permissions.** The restart loop spawns detached processes, kills processes, and binds ports; sandboxed tool runners (workspace-write and the like) deny those operations with EPERM and the instance dies at the shell layer (a real incident: the `/dev/fd` open of `> >(tee …)` was refused, four "boot failures" straight to the crash page). The agent CANNOT switch its own sandbox — that is the point of the sandbox; `/permission` is a user-typed command, and per-command escalation prompts the user for approval. For a permanent deployment the easier official path is starting the instance with `DSH_PERMISSION_MODE=danger-full-access` (the base bundle's deployment-level switch — sandbox and approval policy both open), so every session starts unsandboxed. Otherwise, before initiating a self-restart, ask the user to switch THIS session: `/permission danger-full-access` — the settings page only affects NEW sessions, and an open persistent terminal (PTY) fences the switch until closed. (`verify` and `record` print this hint too.) (`verify` and `record` print this hint too.)
- **The first restart after install must be driven by the CLI.** The running instance has not loaded the plugin yet — composition changes need a boot — and no watchdog exists yet, so a bare exit leaves the service DOWN with nothing to bring it back. Right after the add, run `dsh-ankh-guard supervise --port N --start "CMD"` (it adopts the running instance and respawns ANY exit from then on), or drive the first restart with `dsh-ankh-guard restart --port N --start "CMD" --rollback` (it owns the whole stop→start→canary loop in a detached process), or install the launchd/systemd supervisor. `verify`/`record`/`schedule-exit` all warn while no live watchdog exists.

## Known install pitfalls

- **A GitHub install builds from source.** `dsh plugin add github:…` clones and runs `prepare` (a full devDependency install + build). The npm release (`@khorsheed/dsh-ankh-guard`) ships the built `lib/` — prefer it unless you specifically need the repo edge.
- **pnpm blocks dependency build scripts by default.** If the add fails on a build-script interception, allow the toolchain entries via `allowBuilds` and retry.
- **A root-owned npm cache** (one `sudo npm …` in the past) fails the prepare build with EPERM: `sudo chown -R $(id -u):$(id -g) ~/.npm`.
- **`--start` does not run from your cwd.** The watchdog `cd`s into the dsh home (else `/tmp`) before launching, so the start command must be self-contained — absolute paths, or an explicit `cd` inside it.
- **Supervision adopted from a sandboxed session stays sandboxed.** A watchdog spawned from inside a workspace-write sandbox passes that profile to every respawned instance (nested sandbox-exec then fails, and every command degrades to approvals). For a permanent deployment, use the layered shape (the launchd/systemd installer) so the watchdog chain starts outside any sandbox.

## CLI

The primary interface is the CLI, usable even when the instance is down. Use the `dsh-ankh-guard` bin (or `node lib/cli.js`). Every command takes `--state-dir "$DSH_HOME/state" --repo "$PWD"`.

```sh
dsh-ankh-guard verify      # is it safe to restart right now
dsh-ankh-guard record build+test   # green build & tests → record the credential
dsh-ankh-guard checkpoint --message "what changed"   # checkpoint before editing
dsh-ankh-guard preflight   # deep dry-run: does the profile composition boot
dsh-ankh-guard canary --port 3080   # confirm after restart
dsh-ankh-guard supervise --port 3080 --start "CMD"   # hand the port to a watchdog
```

Full commands: `verify`, `record`, `status`, `clear`, `checkpoint`, `reset`, `canary`, `preflight`, `restart`, `schedule-exit`, `supervise`.

### preflight: the composition gate

`preflight` deep-dry-runs the exact composition a restart would boot: it composes the profile's full patch stack through the same path as the real launcher (bundle layers, user layers, overlays), boots the **whole plugin tree** in a subprocess through the same engine — every plugin's apply runs, because apply is activation — with an overlay pinning the webserver port to 0 (OS-assigned, so it never collides with the live instance), checks every registered client bundle artifact exists, and disposes (registrations are effects, so dispose rolls the dry-run back). Exit codes are the contract:

- `0` — the composition boots clean.
- `1` — a composition verdict: the tree a restart would boot is broken; the output names the failing layer.
- `3` — preflight itself could not execute (missing app layout, infrastructure crash) — **not** a verdict on the composition.

`schedule-exit` and `restart` run this gate after the credential check, before anything is stopped. A composition failure refuses with the preflight's diagnostics; an infrastructure failure also refuses — worded differently and with the manual override (stop the instance by hand, let the watchdog respawn it) — because the guard will not stop a healthy instance it cannot prove will come back. Outside the dsh app layout (a standalone published install) there is no profile to check: the gate warns once and proceeds. Flags: `--profile NAME` (default `$DSH_PROFILE`, else `web`) and `--preflight-timeout-ms MS` (default 120000); `DSH_PREFLIGHT_COMMAND` replaces the resolved app bin wholesale (test hook). Run it by hand any time with `dsh-ankh-guard preflight --profile web`.

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

`supervise` also needs the dsh home the supervised instance boots with (the watchdog exports it as the instance's `DSH_HOME`): `--home DIR` wins, else `$DSH_HOME`; with neither set it refuses loudly — a home guessed from `--state-dir` would silently boot the instance on the wrong profiles/credentials.

It spawns `scripts/dsh-watchdog.sh` (ships with the package) detached with `--wait-owner`: the watchdog idles while the current instance runs, takes over the port when the instance exits (intentional restart or crash), respawns it, runs the guard canary on intentional restarts (a `restart-requested.json` marker), and clears the marker on pass. Two consecutive boot failures roll the checkout back to the last known-good revision — the healthy-boot stamp (`last-good-boot.json`, written every time the instance comes up, so it names the last revision that genuinely ran in this deployment), else the guard checkpoint, else the credential's HEAD — but only when the boot failure's error subject is a path inside the repository: a broken profile overlay or installed plugin cannot be fixed by reverting the checkout, so that failure class skips the rollback entirely. The same exemption covers a start command that does not bind the supervised port: when the boot window times out while the instance is listening elsewhere — or fails with `EADDRINUSE` naming a port this watchdog does not own — the watchdog names the bound port and skips the rollback, because resetting the checkout cannot change a command-line argument. `EADDRINUSE` on the supervised port keeps its free-and-retry escape hatch, now bounded at five attempts. Every reset (watchdog, CLI, or service) first creates `guard-backup-*` branch anchors for the discarded HEAD and for uncommitted tracked changes, so recovery never depends on the reflog. Four failures serve a crash page on the port with a retry button (SIGUSR1 to the watchdog). A `watchdog-stop` marker exits the watchdog for good. The instance itself can adopt supervision before a self-restart — the user never starts the watchdog by hand.

When a watchdog is already supervising, the restart trigger is `schedule-exit`: it writes the restart marker and spawns a detached exit agent (setsid via node `spawn`), which cannot be reaped by a managed shell's process group, so the scheduled kill actually lands after the scheduling turn ends (the fix for `(sleep N; kill) &` silently never firing). The watchdog respawns, runs the canary, and the new instance reports via `last-restart.json`. Prefer `restart` (single-shot loop) only when no watchdog is present.

**The restart report reaches the model by itself — and waits for its owner.** After a scheduled restart (a pending `last-restart.json` record), the plugin queues the report as the next turn via `agent.followup` — the official wake-the-agent seam the schedule system uses for reminders — so the agent reports the restart result without any user message. Session restore after a restart is lazy (an agent is created only when the UI or an RPC touches the session), so the report goes ONLY to the session that scheduled the exit (`schedule-exit` records `$DSH_SESSION_ID` as the initiator), whenever it resumes — no other session is ever woken for reporting, and the record stays pending until its owner resumes or the next restart replaces it (new `exitAt`). A record without an initiator is claimed by the first root agent created. Only root agents, once (acknowledged on delivery). Config `reportRestartContext`: `followup` (default, autonomous), `step` (ride the first step of whatever turn comes next), or `off`.

**Interrupted sessions resume and continue by themselves.** At SIGTERM the plugin snapshots which root sessions had a live turn (plus the restart's initiator) into `interrupted-sessions.json`; on the next restart boot — a cold start drops the snapshot — it resumes those sessions via `ctx.agents.resume` and queues a "continue" followup for the interrupted ones (their logs were closed with `reason.kind === 'interrupted'` by crash-recovery repair), so a self-restart no longer silently pauses every other session. Config `resumeInterrupted` (default true) and `resumeDelayMs` (default 5000, lets the app's services come up first).

### supervise: one port, one owner

A port must have exactly one supervision owner, but the owner itself should be supervised — a bare detached watchdog that dies (SIGKILL, a wide `pkill`, a closed terminal, OOM) leaves the service down with zero automatic recovery. Three deployment shapes:

- **A — pure guard**: no external supervisor; the instance adopts the watchdog via `supervise` before a self-restart. Simplest, but nothing pulls the host back after an unexpected crash.
- **B — pure launchd/systemd**: the launcher owns the port with KeepAlive. Solid for crashes, but self-modification restarts are not guarded by the credential gate.
- **C — layered (recommended)**: launchd supervises the watchdog, the watchdog supervises the instance. One owner per port, and the owner is supervised. macOS: `scripts/install-launchd.sh --start "CMD"` generates a `com.dsh.watchdog.plist` (whose `ProgramArguments` run the CLI in the foreground) into `~/Library/LaunchAgents` and bootstraps it; `--force` replaces a running detached watchdog; `--uninstall` removes the job. systemd: `scripts/install-systemd.sh --start "CMD"` generates and enables the user unit `~/.config/systemd/user/dsh-watchdog.service` — `Restart=on-failure` is the counterpart of launchd's `SuccessfulExit: false`, `StartLimitIntervalSec=0` disables the start rate limit (the default puts a repeatedly restarting unit into `failed` and stops trying, which ends supervision silently), `--print` writes the unit to stdout without touching systemctl, and `--force`/`--uninstall` match the launchd installer. A user unit stops when the session ends; surviving logout needs an administrator to run `loginctl enable-linger <user>`. Both platforms run the same command:

```sh
# launchd/systemd job (KeepAlive) runs this; the CLI process IS the watchdog:
dsh-ankh-guard supervise --foreground --port 3093 --start "<start command>" \
  --state-dir "$DSH_HOME/state" --repo "<checkout>"
```

`--foreground` runs the watchdog inline (adopting the port) and exits with it, so a dead watchdog triggers the external supervisor's restart. On TERM/INT or any exit the watchdog reaps what it spawned — the instance child and the give-up crash page — and removes its own pidfile, then exits non-zero; under the installed plist's `KeepAlive SuccessfulExit: false` a killed watchdog restarts the whole chain, while a deliberate `watchdog-stop` (exit 0) stays down. If a live detached watchdog already holds the pidfile, `--foreground` waits for it to exit and then takes over — exiting 0 instead would read as an intentional stop, idle the launchd job, and silently leave the other watchdog unsupervised. The detached form (`supervise` without `--foreground`) is a debug / one-shot tool — the instance adopting supervision ahead of a self-restart, or a quick manual session — not a production supervision shape, because nothing supervises the detached watchdog itself.

The checkpoint/rollback round trip:

```sh
dsh-ankh-guard checkpoint --message "before batch"
# ... modify, build, test, record, verify ...
dsh-ankh-guard canary --port 3080   # fails → roll back
dsh-ankh-guard reset <checkpoint-sha>
```

`restart` owns the whole restart loop in a detached process that outlives the restarted instance. It refuses to stop the instance when the gate denies (the credential check is enforced in the restart path itself, not just by procedure), SIGTERMs the listener on `--port` and waits `--stop-timeout-ms` (default 30000 — large sessions flushing out tens of thousands of log tokens can take tens of seconds) for a graceful exit before escalating to SIGKILL, starts the `--start` command detached, polls until the port listens, re-verifies, and with `--rollback` hard-resets to the recorded checkpoint when the new instance never comes up. The escalation prints a line naming the pid — it correlates with the watchdog log's `Killed: 9` for the same pid, which lives in a different log than the CLI's stdout:

```sh
dsh-ankh-guard restart \
  --port 3080 --start "DSH_HOME=$HOME/.dsh-official pnpm dsh web" --rollback \
  --state-dir "$DSH_HOME/state" --repo "$PWD"
```

Mounted as a cordis plugin (base bundle), the same surface is available as the `selfRestartGuard` service for in-app gates. Config: `maxAgeMinutes` (default 10), `stateDir`, `repoDir`, `reportRestartContext` (default `followup`), `fallbackGraceMs` (default 300000).

## Model Experience

None. The guard is host-side infrastructure; it adds no tool schema, prompt, or result to any model request.

#### KV Cache effect

None.

## Compatibility

- npm release line (`@deepseek-ai/dsh@0.1.0-rc.7`): ⚠️ degraded — the composition-preflight gate needs a harness checkout to resolve the official packages from; on a standalone npm install without one the guard proceeds with a notice, and every other capability (restart/supervise gating, watchdog, rollback-to-known-good) stays fully intact.
- source line (deepseek-harness master, fork or upstream): ✅ — the gate runs through the standalone `preflight-runner` (resolves the published `@deepseek-ai/dsh-app-boot` etc. from the live checkout), so no fork patch is required.

## Known Limitations and Deferred Work

- **The gate is enforced in `restart`/`supervise`, not the launcher** — both refuse to stop the instance on a denial, but a manual `kill`/start outside the guard still bypasses it; the watchdog is the automatic safety net that makes a bypassed gate recoverable.
- **The preflight dry-run cannot see the boot-time world** — it proves the composition applies and disposes cleanly, not the restart instant: environment divergence between the preflight subprocess and the real boot, a port taken at the restart moment, real persistent state (databases, session logs a boot migrates), and post-apply timing all remain outside its view. The watchdog's rollback-to-known-good stays the net for that territory.
- **A preflight infrastructure failure blocks restarts by design** — a subprocess that cannot produce a verdict is treated as "unproven", not "probably fine"; the refusal message names the manual exit path (kill the listener by hand; the watchdog respawns).
- **A SIGKILL crash writes no interrupted-session snapshot** — interrupted-session auto-continue covers graceful stops (SIGTERM: scheduled exits, watchdog takeovers); crash-interrupted sessions still resume lazily on open.
- **The watchdog needs a supervisor to outlive the instance** — `supervise` spawns it detached (setsid); a watchdog spawned from inside a process that is about to die must be orphaned first, so the app adopts supervision *before* exiting.
- **The guard watches the checkout, not who else works on it** — concurrent self-modifying sessions share the tree; rollbacks are anchored and recoverable, but nothing serializes the sessions themselves.
- **Checkpoint commits sweep the whole working tree** — intended (a checkpoint is a full rollback point), but note it also captures unrelated uncommitted work.
- **`restart`/`supervise` discover the listener via `lsof`** (macOS/Linux with lsof); other platforms need `--pid`.
- **Kills are per-pid with a descendant sweep, never per process group** — the instance is not setsid'd, so `restart`, `schedule-exit`'s exit agent, and the watchdog's `free_port` target the listener pid and (on the forced paths: the `restart` SIGKILL escalation, the watchdog's port adoption and exit cleanup) walk `pgrep -P` descendants instead of killing a group. The supervised instance is expected to manage its own children on graceful shutdown; the sweep is the best-effort net for the forced paths.
