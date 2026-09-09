---
name: dsh-self-restart-guard
description: Use before a self-modification batch, an agent-driven restart, or a launch-configuration cutover of the running dsh web instance. Enforces execution-backed green evidence, clean-tree/HEAD binding, authoritative supervisor/child/listener ownership, the checkpoint policy for real edits, durable abort/full-spec recovery, and the post-restart canary. Also consult it to query guard state or recorded deployment pitfalls.
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
3. **Port**: use the GUI address in your context (e.g. the system prompt's URL); otherwise run `/usr/sbin/lsof -a -p <instance-pid> -iTCP -sTCP:LISTEN -P` on macOS (or the platform's absolute `lsof` path). The `restart` verb also defaults `--port` from the launch record.

Run `$GUARD check-env --state-dir "$DSH_HOME/state" --repo <repo>` for a one-shot readout of all of the above plus sandbox status and watchdog presence.

## Classify the operation first

- **Pure same-launch restart**: no source, dependency, profile, generated output, installed artifact, or launch-spec input changed. Skip the Git checkpoint because there is no pre-edit state to preserve. Run `verify` first: a fresh credential passes, and a `proven deployment valid` result may reuse the build/test evidence that a previous successful watchdog canary promoted for this exact deployment fingerprint. Missing legacy proof or any fingerprint drift requires build/test + record again. Preflight, watchdog ownership, readiness, and canary are never skipped.
- **Modification followed by restart**: take the checkpoint before editing, then commit the logical change and prove the resulting clean HEAD.
- **Launch configuration changes**: use the modification protocol as applicable, then `reconfigure`; never smuggle a new command/repo/host root/profile through `schedule-exit`.

## The protocol

1. **Checkpoint real edits only** — before touching anything, record the rollback point of the repo you are about to change. A clean tree records the existing HEAD without creating an empty commit. A dirty tree is refused by default; inspect every path and, only with explicit approval and where repository policy permits committing the complete snapshot, rerun with `--include-dirty`:

```sh
$GUARD checkpoint --message "before <batch-name>" --repo <repo> --state-dir "$DSH_HOME/state"
# reviewed dirty snapshot only:
$GUARD checkpoint --message "before <batch-name>" --include-dirty --repo <repo> --state-dir "$DSH_HOME/state"
```

2. **Modify** — make the change; register every surface the change needs (package `files`, `dsh.bundle.patch`, identity triangle, dependencies). Missing registrations are the single most common failure class — an unregistered package is invisible to every gate.

3. **Prove green on the final clean commit** — after any modification, use `record --run --` to make the guard execute the exact argv and observe exit 0. The guard clears any old credential and proven-deployment reuse before the command, and records only if HEAD is unchanged and staged, unstaged, and untracked inputs are all absent afterward. For multiple shell steps, invoke the shell explicitly as the evidence program:

```sh
$GUARD record build+test --repo <repo> --state-dir "$DSH_HOME/state" --run -- sh -c 'pnpm run build && pnpm run test'
$GUARD verify --repo <repo> --state-dir "$DSH_HOME/state"
```

For a classified pure same-launch restart, run only the `verify` line first. If it reports either a fresh green credential or `proven deployment valid`, continue without rerunning the expensive command. The reusable proof exists only after this guard version has observed a complete watchdog restart and canary; `last-good-boot.json` by itself, an older guard state, or a matching HEAD without the runtime fingerprint does not qualify. `schedule-exit` recomputes the fingerprint and pins the selected evidence SHA into the short-lived restart marker, and the successor watchdog revalidates it before accepting canary. A refusal is not bypassable: run the full evidence command above.

`--trust-command --command "..."` is reserved for an external orchestrator that already observed the command's real exit status (for example, the repository's deployment driver). It is not an agent shortcut.

4. **Composition preflight** — `restart`, `schedule-exit`, and `reconfigure` each run this gate internally exactly once and refuse before stopping the healthy host. For an ordinary same-launch restart, call the stop-capable verb directly; use the standalone verb only to diagnose an already-observed failure, never as a speculative duplicate immediately before that verb:

```sh
$GUARD preflight --profile web
```

   The caller deadline is a separate safety budget from the guard's `--preflight-timeout-ms` (default 120000 ms). A managed Bash/tool call MUST wait longer than the internal gate: with the default, set the call's execution option to `timeoutMs: 180000`; with a custom preflight timeout, keep at least 30000 ms of caller margin. `timeoutMs` is tool metadata, not a guard CLI flag. Never wrap the command in a shorter shell timeout. The CLI prints `composition preflight START` before the wait and a PASS/refusal only after the runner settles. If the caller nevertheless kills the CLI, absence of `exit scheduled` means no restart was authorized; inspect the restart marker and receipt before deciding whether a retry is safe.

5. **Restart or launch cutover** — the path depends on supervision and whether the complete launch specification changes:
   - **No watchdog yet** (e.g. right after installing the plugin): `schedule-exit` hard-refuses because killing the host would guarantee an outage. Establish supervision, or drive the first bounce with the `restart` verb — it owns stop → start → canary in a detached driver and self-detaches from the dying instance. `--start` defaults to the launch record when one exists.
   - **Watchdog-supervised, same command, home, credential repo, harness root, and profile**: run `schedule-exit --delay-ms 5000 --state-dir "$DSH_HOME/state"` (`--port` may confirm the durable port on legacy state), with `timeoutMs: 180000` on the managed Bash/tool call. It reloads the durable active spec, rejects explicit repo/host-root/profile/port conflicts, verifies that the live supervisor record owns the same command, accepts either the active repo's fresh credential or an exact canary-promoted deployment proof, runs one composition preflight against the active host root, then exits the child. Proof reuse never skips preflight or canary. The watchdog respawns + canaries automatically. Do NOT use bare `restart` against a supervised instance — it fights the supervisor and lacks the durable ownership needed for proof reuse. **Never pass `--initiator` by hand**: it defaults to `$DSH_SESSION_ID`, which the shell environment already sets to THIS session's id — that is what routes the post-restart wake-up report back to you. An invented value sends the report to a session that does not exist and you are never woken (a branch name is not a session id).
   - **Watchdog-supervised, command, home, credential repo, harness root, profile, or execution surface changes**: first ensure `launch-status` shows a complete durable previous spec. If it does not, initialize the real current values with `configure-launch`; never infer previous from the target repo or legacy command record. Explicitly classify the command actually used by the successor: `built` for an npm toolchain `.../@deepseek-ai/dsh/lib/bin.js`, `source` for checkout TypeScript. Pass `--preflight-surface <source|built>` and `--preflight-install-anchor <the exact successor @deepseek-ai/dsh/package.json>`; pass `--preflight-runner` only when the matching installed guard runner cannot be auto-resolved. Do not infer the surface from `process.execArgv`, `DSH_HARNESS`, or the guard's own launch mode. Treat `--candidate-probe-command` as a caller-supplied trust boundary: the guard hash-binds it beside `--start` but cannot prove that arbitrary shell text is semantically derived from the target argv. Construct it from the same target executable and launcher argv (for the official dsh CLI, preserve the same launcher flags/order and replace the long-running action with one-shot `--dump-config`); never use an unrelated success command, because it will not catch misplaced or unknown final argv. Then use `reconfigure --start "<complete target command>" --repo <target-credential-repo> --harness-root <target-host-root> --preflight-surface ... --preflight-install-anchor ... --candidate-probe-command "..." --on-failure <policy> --browser-handoff required`. Before running it, obtain the user's explicit recovery choice: `restore-previous` restores the entire previous launch specification; `wait-for-user` parks without resetting a repository. `reconfigure` rebuilds internal pnpm/Cordis links against copied nodes, keeps contained dependency cycles, maps external targets into a deduplicated snapshot-owned area, and rejects dangling/unresolvable links, special files, or any writable target outside the snapshot before it can run candidate or stop previous. Candidate and composition checks then run there, after which the pidfile transfers atomically. It persists start identities for the old supervisor/direct child/listener plus the new driver/watchdog. The successor consumes abort/restore while waiting, bounds old-supervisor yield (default 15 seconds), and may stop only a frozen then revalidated identity; it never treats a process found by port as the target. Online port changes are refused; deploy a separately supervised authority and cut traffic over instead.
   - **Candidate rejects reconstructible old state**: derive the incompatible path from source/schema evidence, classify it as reconstructible rather than authoritative, and show the user the exact plan before approval. Pass a schema-v1 JSON file through `reconfigure --transition-file <plan>`; do not put `mv`, deletion, or migration logic in `--start`. The only supported operation is `{"kind":"quarantine","path":"<home-relative path>","expect":"present|absent"}`. Build the recovery closure: list both old paths target must not see and target output paths previous must not see after a failed attempt, including paths absent before cutover. `expect` binds that observation across isolated preflight and live apply; drift refuses rather than silently changing rollback meaning. The guard also rejects traversal, symlinks, overlapping paths, guard-state overlap, cross-filesystem moves, or a plan whose bytes change after preparation. It preflights the target against an isolated transitioned copy while previous remains live, applies the hash-bound plan only after previous is proven stopped, and on recovery retains target replacements before restoring exact previous bytes. A rollback failure parks without starting previous. Never quarantine session logs, credentials, or other authority; content conversion requires a separate reviewed migration mechanism.
   - Never hand-roll `sleep; kill; nohup start` scripts — they die with the instance (teardown reaps managed processes).

6. **Verify after** — the port must listen again and the canary must PASS (`$DSH_HOME/state/restart.log` for the verb path, timestamped `watchdog.log` for the supervised path). For `reconfigure`, wait for `launch-status` to show a terminal receipt, read `$DSH_HOME/state/launch-cutover.json`, and report its supervisor/child/listener identities, redacted launch summaries, `preflight` surface/runner/install-anchor/target-command bindings and both PASS outcomes, server authentication readiness, stable-window/retry-zero proof, the later page-authored `browserHandoff` acknowledgement, per-role failure counts, transition digest/count/terminal phase when present, and recovery outcome. Read target readiness/canary from `targetValidation`; after restore, read previous readiness and its pass/fail/explicitly-skipped recovery canary from `recovery.validation`. Never describe a retained target canary failure as the restored previous host's health. A port response is never sufficient: the receipt must prove that the selected child remained alive, uniquely owned the listener through the stability window, completed at retry zero, passed or explicitly classified its role-specific canary before any browser URL was issued, and—when browser handoff is required—received an authenticated ACK from the original or fallback page. On repeated ordinary boot failure the watchdog rolls the checkout back to the last known-good revision; a cutover follows only its pre-approved full-spec recovery policy.

## Querying state

```sh
$GUARD status --state-dir "$DSH_HOME/state"   # credentials, checkpoints, restart records
$GUARD launch-status --state-dir "$DSH_HOME/state"   # redacted selected spec + durable cutover receipt
$GUARD canary --port <port> --state-dir "$DSH_HOME/state" --repo <repo>
# In-flight cutover controls:
$GUARD abort-cutover --state-dir "$DSH_HOME/state"      # execute its pre-approved policy
$GUARD restore-previous --state-dir "$DSH_HOME/state"   # explicit full-previous restore authorization
```

## Pitfalls this protocol exists for

- **Credential/deployment mismatch**: `verify` and `schedule-exit` prefer the fresh credential; after it expires they accept only a proof written by a successful canary for the exact clean credential/harness HEADs, launch spec, profile/install artifacts, and bound preflight execution surface. `restart` still requires the fresh credential. Any changed HEAD, staged/unstaged/untracked input, profile package, linked target, archive, runner, or anchor refuses. Commit/remove the input, then rerun the execution-backed evidence. Record with `--state-dir` pointing at the SAME state the restart reads (`$DSH_HOME/state`); a record without it lands in a stray `<cwd>/.dsh-guard-state` and the gate will not see it.
- **Sandboxed sessions**: restart verbs refuse in a sandboxed turn (a detached driver would be reaped). Escalate through your host's per-command approval, or the user runs `/permission danger-full-access` in the session — settings pages only affect NEW sessions.
- **Preflight FAIL is information, not friction**: it has caught unbootable profile patches and duplicate loader entry ids before they could take prod down. Fix the composition; never bypass.
- **Caller timeout is not a guard verdict**: the default internal preflight budget is 120 seconds, while managed shell tools may default to 60 seconds. Set `timeoutMs: 180000` (or at least the configured preflight timeout plus 30000 ms). `composition preflight START` without PASS/refusal or `exit scheduled` means the caller interrupted the gate before any restart was authorized; check durable markers before retrying.
- **Profile `link:`/`file:` deps**: after rebuilding a plugin, refresh the profile install (`dsh plugin --profile web add <path-or-tarball>`) before restarting — a restart serves whatever the profile's `node_modules` currently contains.
- **401 is transport, not readiness**: require a protected final process to announce a same-authority launch URL; the watchdog proves URL → 303 → cookie-authenticated `/` → 200 with a temporary jar, holds one child/listener identity stable at retry zero, and passes canary before browser handoff. With `--browser-handoff required`, every responsive tab uses a held same-origin poll to register a per-tab capability before shutdown and waits. The final listener asks each tab to reload when its cookie is valid, or returns its own one-time same-origin URL in memory for `location.replace()` after 401; after ACK, the page returns to the original credential-free pathname. One real ACK gates terminal readiness, while slower registered tabs remain recoverable. Only if no original tab registers or none acknowledges before timeout does the watchdog request a system-open fallback, and opener success never substitutes for an authenticated page ACK. Never copy a candidate instance's URL into the final restart, and never persist or print bearer URLs or raw capabilities in state, logs, receipts, or reports.
- **First handoff rollout uses fallback**: a page loaded by an older ankh-guard has no handoff client. To test original-tab recovery, first deploy this plugin to the previous host and refresh that page, then run the host cutover. A fallback tab during the bootstrap deployment is expected.
- **An arbitrary 200 is not target identity**: the spawned direct child must still be alive; the port must have exactly one listener in that child tree; child/listener PID and start identity must remain unchanged through the stability window at retry zero. `EADDRINUSE`, a stale old listener, or a child that exits after provisional readiness fails the attempt and invokes the approved recovery path.
- **Restricted PATH is expected**: the guard resolves `/usr/sbin/lsof`, `/usr/bin/lsof`, and corresponding system `ps`/`pgrep` paths before PATH. Do not replace ownership proof with a bare `lsof` shell check or a port-only kill.
- **Intervene durably, never by signal alone**: use `abort-cutover` to execute the policy approved before the stop, or `restore-previous` to explicitly authorize a complete previous-spec restore. Each writes its own atomic marker before waking the watchdog; restore is monotonically stronger even when sessions race. Do not manually kill supervisor or child PIDs.
