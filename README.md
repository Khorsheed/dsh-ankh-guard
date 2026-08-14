# @khorsheed/dsh-ankh-guard

[English](README.en.md) | 中文

自我修改重启的硬闸门。自我修改的 agent 改动本仓库后要重启运行中的实例——如果改动是坏的，重启会把实例（连同会话）一起带走。这个插件让重启以证据为条件：**绿色构建凭证**，只有在完整构建与定向测试通过后才记录，绑定到产出它的 git HEAD，并有新鲜度窗口。

凭证是闸门的唯一事实来源：没有凭证、超过 `maxAgeMinutes`、或——最关键的一环——当前 HEAD 与记录凭证时的 revision 不一致，`verify()` 一律拒绝。记录之后的任何树改动都会令凭证失效，所以事后补记或过期的凭证永远无法为未验证代码的重启背书。这一条规则就能拦住 2026-08-14 file-preview 事故的整类失败（错误导入风格、漏注册 tsconfig、缺 `./typert` 导出）：这些错误全部过不了构建/类型检查，于是不会有凭证，重启在造成伤害之前就被拒绝。

闸门之外还提供 P2 安全网：`checkpoint` 在批次前把整个工作树提交为回滚点，`reset` 硬重置回该点，`canary` 在重启后复检（凭证新鲜度 + 可选 TCP 端口存活）。检查点与凭证持久化在重启后依然存活的状态文件中，因此 canary 可以在新实例起来之后运行。

## 安装与加载

本包是 **dsh 插件**：它守护运行中的 dsh web 实例，防止坏掉的自我修改重启。它不自带宿主——请自行安装宿主，再把本插件加载进去：

```sh
npm install @deepseek-ai/dsh            # the host (dsh web / dsh CLI)
npm install @khorsheed/dsh-ankh-guard # this plugin
```

然后启动宿主：`npx @deepseek-ai/dsh web`。

包内自带 CLI（`dsh-ankh-guard` bin）、插件（`@khorsheed/dsh-ankh-guard`）、watchdog 脚本与自己的 README——外部部署需要的一切都在发布物里，不在 harness 仓库里。从 npm 安装插件（peer 依赖——`@deepseek-ai/cordis`、`@deepseek-ai/dsh-invariants`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-session-persistence`——自动安装）：

```sh
npm install @khorsheed/dsh-ankh-guard
```

或从源码安装——clone 本仓库、构建并测试：

```sh
git clone https://github.com/Khorsheed/dsh-ankh-guard.git
cd dsh-ankh-guard && pnpm install && pnpm run build && pnpm test
```

然后在你自己的包里以依赖引用（`"@khorsheed/dsh-ankh-guard": "file:../dsh-ankh-guard"`），或直接从检出里跑 CLI：`node lib/cli.js <命令>`。

在 `cordis.yml` 里以 cordis 插件方式加载（这就是加载步骤——没被加载的重启 guard 保护不了任何东西）：

```yaml
plugins:
  - id: ankh-guard
    name: '@khorsheed/dsh-ankh-guard'
```

配置（全部可选）：`stateDir`（默认 `$DSH_HOME/state`，否则 `<cwd>/.dsh-guard-state`）、`repoDir`（默认进程 cwd）、`maxAgeMinutes`（凭证新鲜窗口，默认 10）、`reportRestartContext`（`followup` 自主报告 / `step` 骑下一次回合 / `off`，默认 `followup`）、`fallbackGraceMs`（非发起根 agent 在发起会话尚未恢复时等待多久才认领记录，默认 60000）。

运行时需要：`node`（CLI、watchdog 崩溃页与 detached 退出代理）、`bash`（watchdog 脚本）、macOS/Linux 上的 `lsof`（发现监听者；`--pid` 可绕过）。消费者无需构建——发布的 `lib/` 就是可运行产物。

## 闸门

状态文件位于 `$DSH_HOME/state/self-restart-guard.json`（可用 `stateDir` 覆盖；否则回退到 `<cwd>/.dsh-guard-state`）。它记录凭证、最新检查点和有上限的审计轨迹。`verify()` 依次检查：

1. 存在凭证；
2. 当前 git HEAD 等于凭证的 revision；
3. 凭证未超过 `maxAgeMinutes`。

其余情况一律拒绝，并给出明确该做什么的理由（record / 重建 / 重录）。

## 用法

主要接口是 CLI，即使实例宕机也能用（无需启动应用）。安装后的使用者用 `dsh-ankh-guard` bin（或 `node lib/cli.js`）；在本仓库内源码形态 `node --import tsx/esm src/cli.ts` 也可用。状态文件位于 `$DSH_HOME/state`——所有命令都带 `--state-dir "$DSH_HOME/state" --repo "$PWD"`。

### 自我重启协议（自包含）

改完代码后安全重启实例的六步：

1. **checkpoint**——把工作树快照为回滚点：`dsh-ankh-guard checkpoint --message "<批次>"`
2. **修改**——做完改动；注册它需要的每个面（聚合、paths、bundle 行、依赖）。
3. **构建 + 测试**——改动面的完整定向集；没有绿色就没有凭证。
4. **record**——`dsh-ankh-guard record build+test --command "<什么过了>"`
5. **verify**——`dsh-ankh-guard verify` 必须 exit 0；拒绝（缺凭证/过期/HEAD 不匹配）就重建重录。
6. **重启 + canary**——见下。新实例起来后 `dsh-ankh-guard canary --port N` 确认。

### supervise：不懂技术的用户也能无感重启

`restart` 在单个 CLI 进程里跑完 kill → start → probe → canary（用 `--delay-ms` 让调度方回合先完成）。对于不该碰终端的部署，`supervise` 把工作交给 **watchdog**——一个 detached、比实例活得久的监督进程：

```sh
dsh-ankh-guard supervise --port 3080 --start "CMD" --state-dir "$DSH_HOME/state" --repo "$PWD"
```

它以 `--wait-owner` 模式 detached 拉起随包发布的 `scripts/dsh-watchdog.sh`：watchdog 在当前实例运行期间待机，实例退出（有意重启或崩溃）后接管端口、重新拉起，有意重启时跑 guard canary（读 `restart-requested.json` 标记），通过后清除标记。连续 2 次起不来→回滚到 guard checkpoint；4 次失败→在端口上提供带重试按钮的崩溃页（SIGUSR1 通知 watchdog）。`watchdog-stop` 标记让 watchdog 彻底退出。实例可以在自我重启前自行采用监督——用户永远不需要手动启动 watchdog。

已有 watchdog 监督时，重启触发用 `schedule-exit`——可靠的结束宿主方式：它写入 restart 标记并 spawn 一个 **detached 退出代理**（node `spawn` 的 setsid），托管 shell 的进程组回收不到它，所以计划中的 kill 会在调度回合结束后真实落地（修复 `(sleep N; kill) &` 静默不触发的坑）。watchdog 重新拉起、跑 canary，新实例经 `last-restart.json` 回报。只有无 watchdog 时才用 `restart`（单次循环）。

**重启报告自动到达模型。** 计划重启后，插件在 agent 创建时（存在未确认的 `last-restart.json` 记录）通过 `agent.followup` 把报告排入下一回合——这是 schedule 系统用于提醒的官方唤醒 agent 接缝——agent **无需任何用户消息**即可回报重启结果。报告返回给发起重启的会话：`schedule-exit` 把 `$DSH_SESSION_ID` 记为 initiator，只要该会话的根 agent 还活着，就只有它能领走记录（先恢复的非发起会话抢不走）；会话恢复是异步的，因此发起会话尚未 live 时先查持久化：会话还在（慢恢复）则用宽限定时器（配置 `fallbackGraceMs`，默认 60000 ms）等它，宽限期后才允许任意根 agent 回退；会话确实没了（已删除、或是不再恢复的子 agent）则由首个 live 根 agent 领走，报告不会丢失。定时器触发时会校验记录身份（`exitAt` 相同且未确认），二次重启或已有人认领时旧定时器不会误 ack。仅根 agent、仅一次（记录被确认）。配置 `reportRestartContext`：`followup`（默认，自主）、`step`（骑在下一次回合的第一步上）、或 `off`。

### 本地留言板

本插件是单部署内的本地闭环，不是上游反馈渠道。当闸门行为异常——误拒/误放、canary 误判、supervise 行为异常、文档与行为不符——使用本插件的 agent 在本地留言板留一条结构化记录：

```sh
dsh-ankh-guard feedback "<reproducible problem description>" --state-dir "$DSH_HOME/state"
dsh-ankh-guard feedback list              # read the newest entries
```

条目追加到 `$DSH_HOME/feedback/dsh-self-restart-guard.jsonl`（DSH_HOME 运行时区——绝不写入插件安装目录或源码树），append-only、单文件封顶 200 条（保留最新）。只写可复现、可行动的问题；绝不写密钥/隐私。上游问题请走项目 issue 渠道，不是这里。

### supervise：一个端口一个拥有者

一个端口只能有一个监督拥有者，但拥有者本身也应该被监督。三种部署形态：

- **A — 纯 guard**：无外部监督者；实例在自我重启前用 `supervise` 采用 watchdog。最简单，但意外崩溃后没有东西拉回宿主。
- **B — 纯 launchd/systemd**：launcher 用 KeepAlive 拥有端口。抗崩溃，但自我修改重启不受凭证闸门约束。
- **C — 分层（推荐）**：launchd 监督 watchdog，watchdog 监督实例。每端口一个拥有者，且拥有者也被监督。watchdog 以前台方式运行，外部监督者作用于它：

```sh
# launchd/systemd job (KeepAlive) runs this; the CLI process IS the watchdog:
dsh-ankh-guard supervise --foreground --port 3093 --start "<start command>" \
  --state-dir "$DSH_HOME/state" --repo "<checkout>"
```

`--foreground` 让 watchdog 内联运行（接管端口）并随它退出，watchdog 死掉会触发外部监督者重启。detached 形态（不带 `--foreground` 的 `supervise`）用于实例在自我重启前自行采用监督。

命令：`verify`（退出码 0/1）、`record <scope>`、`status`、`clear`、`checkpoint [--message]`、`reset <sha>`、`canary [--port N]`、`restart --port N --start "CMD" [--delay-ms MS] [--rollback]`、`schedule-exit --port N --delay-ms MS`、`supervise --port N --start "CMD" [--log FILE]`。检查点/回滚闭环：

```sh
dsh-ankh-guard checkpoint --message "before batch"
# ... modify, build, test, record, verify ...
dsh-ankh-guard canary --port 3080   # fails → roll back
dsh-ankh-guard reset <checkpoint-sha>
```

`restart` 在**独立于被重启实例的进程中**跑完整套重启循环——这正是"重启会杀死原来持有 canary 的会话"的兼容性修复。它在闸门拒绝时拒绝停实例（凭证检查在重启路径本身强制，而非仅靠流程），停止 `--port` 上的监听者，以 detached 方式启动 `--start` 命令，轮询端口直到监听，重新校验；`--rollback` 时若新实例一直起不来则硬重置到记录的检查点：

```sh
dsh-ankh-guard restart \
  --port 3080 --start "DSH_HOME=$HOME/.dsh-official pnpm dsh web" --rollback \
  --state-dir "$DSH_HOME/state" --repo "$PWD"
```

以 cordis 插件挂载（base bundle）后，同一套能力以 `selfRestartGuard` 服务的形式供应用内闸门使用。配置：`maxAgeMinutes`（默认 10）、`stateDir`、`repoDir`、`reportRestartContext`（默认 `followup`）、`fallbackGraceMs`（默认 60000）。

## Model Experience

无。guard 是宿主侧基础设施；不给任何模型请求增加工具 schema、提示词或结果。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **闸门在 `restart`/`supervise` 里强制，launcher 里还没有**——两者在拒绝时会拒绝停实例，但绕开 guard 的手动 `kill`/启动仍可绕过；watchdog（P2）是让被绕过的闸门可恢复的自动安全网。
- **watchdog 需要一个比实例活得久的监督者**——`supervise` 以 detached（setsid）方式拉起它；从即将死亡的进程内派生的 watchdog 必须先被孤儿化，所以应用要在退出**之前**采用监督。
- **A/B 分区（P1）不在本包范围**——生产的槽位切换机制在别处；基于 worktree、永不触碰运行中检出的开发流是独立的后续项。
- **checkpoint 提交会扫入整个工作树**——有意为之（检查点就是完整回滚点），但也会带上无关的未提交改动。
- **`restart`/`supervise` 通过 `lsof` 发现监听者**（macOS / 带 lsof 的 Linux）；其他平台需用 `--pid`。
