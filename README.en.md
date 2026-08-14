# @deepseek-ai/dsh-ankh-guard

English | [中文](README.md)

Hard gate for self-modification restarts. A self-modifying agent changes this repository and then restarts the running instance — if the change is broken, the restart takes the instance (and the conversation) down. This plugin makes the restart conditional on proof: a **green-build credential** recorded only after the full build and targeted tests pass, bound to the git HEAD it was produced on and to a freshness window.

The credential is the gate's source of truth: `verify()` is denied when there is no credential, when it is older than `maxAgeMinutes`, or — the load-bearing part — when the current HEAD differs from the revision the credential was recorded on. Any tree change after recording invalidates it, so a post-hoc or stale credential can never authorize a restart of unverified code. That single rule catches the whole failure class seen in the 2026-08-14 file-preview incident (wrong import style, missing tsconfig registrations, missing `./typert` export): every one of those errors fails the build/typecheck, so no credential is recorded and the restart is refused before it can hurt.

Beyond the gate it provides the P2 safety net: `checkpoint` commits the whole working tree as a rollback point before a batch, `reset` hard-resets to it, and `canary` re-verifies after a restart (credential freshness + optional TCP port liveness). Checkpoints and credentials persist in a state file that survives restarts, so the canary runs after the new instance is up.

## Installation and loading

This package is a **dsh plugin**: it guards the running dsh web instance against broken self-modification restarts. It does not ship a host — install the host yourself and load this plugin into it:

```sh
npm install @deepseek-ai/dsh            # the host (dsh web / dsh CLI)
npm install @deepseek-ai/dsh-ankh-guard # this plugin
```

Then start the host: `npx @deepseek-ai/dsh web`.

The package ships the CLI (`dsh-ankh-guard` bin), the plugin (`@deepseek-ai/dsh-ankh-guard`), the watchdog script, and its own README — everything an external deployment needs lives in the artifact, not in the harness repository. Install the plugin from npm (peer dependencies — `@deepseek-ai/cordis`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-session-persistence` — install automatically):

```sh
npm install @deepseek-ai/dsh-ankh-guard
```

Or install from source — clone this repository, build, and test it:

```sh
git clone https://github.com/Khorsheed/dsh-ankh-guard.git
cd dsh-ankh-guard && pnpm install && pnpm run build && pnpm test
```

Then reference it as a dependency (`"@deepseek-ai/dsh-ankh-guard": "file:../dsh-ankh-guard"`) in your own package, or run the CLI directly from the checkout with `node lib/cli.js <command>`.

Load it as a cordis plugin in your `cordis.yml` (this is the loading step — a restart guard that is not loaded cannot protect anything):

```yaml
plugins:
  - id: ankh-guard
    name: '@deepseek-ai/dsh-ankh-guard'
```

Config (all optional): `stateDir` (default `$DSH_HOME/state`, else `<cwd>/.dsh-guard-state`), `repoDir` (default the process cwd), `maxAgeMinutes` (credential freshness, default 10), `reportRestartContext` (`followup` autonomous report / `step` ride the next turn / `off`, default `followup`), `fallbackGraceMs` (how long a non-initiator root agent waits before claiming a record whose initiator session has not resumed, default 60000).

Runtime needs: `node` (the CLI, the watchdog's crash page, and the detached exit agent), `bash` (the watchdog script), and `lsof` on macOS/Linux for listener discovery (`--pid` bypasses it). No build step for consumers — the published `lib/` is the runnable artifact.

## The gate

The state file lives at `$DSH_HOME/state/self-restart-guard.json` (override with `stateDir`; falls back to `<cwd>/.dsh-guard-state`). It records the credential, the latest checkpoint, and a capped audit trail. `verify()` checks, in order:

1. a credential exists;
2. the current git HEAD equals the credential's revision;
3. the credential is younger than `maxAgeMinutes`.

Anything else is a denial with a reason that says exactly what to do (record, rebuild, or re-record).

## Usage

The primary interface is the CLI, which works even while the instance is down (no app boot needed). Installed consumers use the `dsh-ankh-guard` bin (or `node lib/cli.js`); inside this repository the source form `node --import tsx/esm src/cli.ts` also works. The state file lives at `$DSH_HOME/state` — pass `--state-dir "$DSH_HOME/state" --repo "$PWD"` on every command.

### The self-restart protocol (self-contained)

The safe way to restart an instance after changing its code:

1. **checkpoint** — snapshot the working tree as the rollback point: `dsh-ankh-guard checkpoint --message "<batch>"`
2. **modify** — make the change; register every surface it needs (aggregates, paths, bundle rows, dependencies).
3. **build + test** — the narrow full set for the changed surface; no credential without green.
4. **record** — `dsh-ankh-guard record build+test --command "<what went green>"`
5. **verify** — `dsh-ankh-guard verify` must exit 0; a denial (missing/stale/HEAD-mismatched credential) means rebuild and re-record.
6. **restart + canary** — see below. After the new instance is up, `dsh-ankh-guard canary --port N` confirms it.

### supervise: seamless restart for non-technical users

`restart` runs the whole kill → start → probe → canary loop in one CLI process (use `--delay-ms` so the scheduling turn finishes first). For deployments where nobody should touch a terminal, `supervise` hands the job to a **watchdog** — a detached supervisor process that survives the instance:

```sh
dsh-ankh-guard supervise --port 3080 --start "CMD" --state-dir "$DSH_HOME/state" --repo "$PWD"
```

It spawns `scripts/dsh-watchdog.sh` (ships with the package) detached with `--wait-owner`: the watchdog idles while the current instance runs, takes over the port when the instance exits (intentional restart or crash), respawns it, runs the guard canary on intentional restarts (a `restart-requested.json` marker), and clears the marker on pass. Two consecutive boot failures roll the checkout back to the guard checkpoint; four failures serve a crash page on the port with a retry button (SIGUSR1 to the watchdog). A `watchdog-stop` marker exits the watchdog for good. The instance itself can adopt supervision before a self-restart — the user never starts the watchdog by hand.

When a watchdog is already supervising, the restart trigger is `schedule-exit` — the reliable way to end the host: it writes the restart marker and spawns a **detached exit agent** (setsid via node `spawn`), which cannot be reaped by a managed shell's process group, so the scheduled kill actually lands after the scheduling turn ends (the fix for `(sleep N; kill) &` silently never firing). The watchdog respawns, runs the canary, and the new instance reports via `last-restart.json`. Prefer `restart` (single-shot loop) only when no watchdog is present.

**The restart report reaches the model by itself.** On agent creation after a scheduled restart (a pending `last-restart.json` record), the plugin queues the report as the next turn via `agent.followup` — the official wake-the-agent seam the schedule system uses for reminders — so the agent reports the restart result **without any user message**. The report returns to the session that scheduled the exit: `schedule-exit` records `$DSH_SESSION_ID` as the initiator, and while that session's root agent is live only it may claim the record (a non-initiator session resuming first does not steal it); Session restore is asynchronous, so when the initiator is not live yet its session is checked against persistence: if it still exists (slow resume), a grace timer (Config `fallbackGraceMs`, default 60000 ms) waits for it before any root agent falls back; if it is gone (deleted, or a subagent that never resumes), the first live root agent claims the record so the report is never lost. The timer validates the record identity on fire (same `exitAt`, still unreported) so a second restart or an earlier claim cannot be acked by a stale timer. Only root agents, once (the record is acknowledged). Config `reportRestartContext`: `followup` (default, autonomous), `step` (ride the first step of whatever turn comes next), or `off`.

### The local feedback board

This plugin is a local loop inside one deployment, not an upstream feedback channel. When the gate misbehaves — a false deny or allow, a canary misjudgment, a supervise anomaly, or documentation that does not match behavior — agents running this plugin leave a structured note on the local board:

```sh
dsh-ankh-guard feedback "<reproducible problem description>" --state-dir "$DSH_HOME/state"
dsh-ankh-guard feedback list              # read the newest entries
```

Entries are appended to `$DSH_HOME/feedback/dsh-self-restart-guard.jsonl` (the DSH_HOME runtime area — never the plugin install directory or the source tree), append-only and capped at 200 with the newest kept. Write only reproducible, actionable problems; never secrets or private data. Upstream issues belong on the project's issue tracker, not here.

### supervise: one port, one owner

A port must have exactly one supervision owner, but the owner itself should be supervised. Three deployment shapes:

- **A — pure guard**: no external supervisor; the instance adopts the watchdog via `supervise` before a self-restart. Simplest, but nothing pulls the host back after an unexpected crash.
- **B — pure launchd/systemd**: the launcher owns the port with KeepAlive. Solid for crashes, but self-modification restarts are not guarded by the credential gate.
- **C — layered (recommended)**: launchd supervises the watchdog, the watchdog supervises the instance. One owner per port, and the owner is supervised. Run the watchdog in the foreground so the external supervisor acts on it:

```sh
# launchd/systemd job (KeepAlive) runs this; the CLI process IS the watchdog:
dsh-ankh-guard supervise --foreground --port 3093 --start "<start command>" \
  --state-dir "$DSH_HOME/state" --repo "<checkout>"
```

`--foreground` runs the watchdog inline (adopting the port) and exits with it, so a dead watchdog triggers the external supervisor's restart. The detached form (`supervise` without `--foreground`) is for the instance adopting supervision ahead of a self-restart.

Commands: `verify` (exit 0/1), `record <scope>`, `status`, `clear`, `checkpoint [--message]`, `reset <sha>`, `canary [--port N]`, `restart --port N --start "CMD" [--delay-ms MS] [--rollback]`, `schedule-exit --port N --delay-ms MS`, `supervise --port N --start "CMD" [--log FILE]`. The checkpoint/reset round trip:

```sh
dsh-ankh-guard checkpoint --message "before batch"
# ... modify, build, test, record, verify ...
dsh-ankh-guard canary --port 3080   # fails → roll back
dsh-ankh-guard reset <checkpoint-sha>
```

`restart` owns the whole restart loop in a **detached process that outlives the restarted instance** — the compatibility fix for "the restart kills the session that used to own the canary". It refuses to stop the instance when the gate denies (the credential check is enforced in the restart path itself, not just by procedure), stops the listener on `--port`, starts the `--start` command detached, polls until the port listens, re-verifies, and with `--rollback` hard-resets to the recorded checkpoint when the new instance never comes up:

```sh
dsh-ankh-guard restart \
  --port 3080 --start "DSH_HOME=$HOME/.dsh-official pnpm dsh web" --rollback \
  --state-dir "$DSH_HOME/state" --repo "$PWD"
```

`--delay-ms MS` turns this into a graceful agent-driven self-restart: the detached CLI waits out the delay before stopping, so the scheduling agent's turn completes and its final message is delivered first — the disruption becomes a reconnect, not a mid-turn kill (true in-place node hot-swap is unavailable by design: the web bundle disables cordis module-reload HMR; client-plugin bundles, by contrast, hot-swap without any process restart via the `dsh-client-hmr` stat-poll/SSE chain).

Mounted as a cordis plugin (base bundle), the same surface is available as the `selfRestartGuard` service for in-app gates. Config: `maxAgeMinutes` (default 10), `stateDir`, `repoDir`, `reportRestartContext` (`followup` default), `fallbackGraceMs` (default 60000).

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
