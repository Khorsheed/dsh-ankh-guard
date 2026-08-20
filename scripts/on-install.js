/**
 * Post-install bootstrap guidance, printed at the end of install (prepare for
 * git installs, postinstall for registry installs where the runner allows
 * build scripts). This is the ONE channel that reaches the driving agent on
 * first install, before the plugin is loaded — every other hint (README,
 * boot notice, CLI hints) fires only after the first boot or first CLI call,
 * and fresh-machine agents kept hand-rolling restart scripts in exactly that
 * vacuum. Consumer installs only: a monorepo/workspace developer building
 * the package is not the audience, so the message stays silent unless the
 * package directory sits inside a node_modules.
 */
import { sep } from 'node:path'

if (process.cwd().includes(`${sep}node_modules${sep}`)) {
  console.log(`[ankh-guard] installed. The FIRST restart after install must go through the guard CLI —
the running instance has not loaded the plugin and no watchdog exists yet, so a bare
exit leaves the service DOWN:
  node_modules/@khorsheed/dsh-ankh-guard/lib/cli.js check-env
  node_modules/@khorsheed/dsh-ankh-guard/lib/cli.js record build+test --state-dir "$DSH_HOME/state" --repo "$PWD"
  node_modules/@khorsheed/dsh-ankh-guard/lib/cli.js restart --port <port> --start "<start command>"
or establish the watchdog first with \`supervise\`. NEVER hand-roll sleep/kill/nohup restart
scripts — they die with the instance (its teardown reaps managed processes).
首次安装后的第一次重启必须走守护 CLI（见上）；禁止手写 sleep/kill/nohup 重启脚本。
`)
}
