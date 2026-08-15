# dsh-ankh-guard

[English](README.en.md) | 中文

让 agent 自己改代码、自己重启，还不把服务搞挂。

agent 改完代码想重启的时候，这个插件会先问一句：这次改动，构建和测试都过了吗？过了才放行，没过就拦下来——免得改坏的代码把整个服务、连同正在进行的对话一起带走。

![重启闭环演示](assets/restart-loop-demo.png)

一次真实的自我重启：agent 重启前先告知验证计划（1)；宿主退出，进行中的 tool call 被安全中断并落盘（2);watchdog 在 10 秒内拉回实例，ankh-guard 把重启上下文注入原会话（3)——agent 醒来后继续执行重启前宣布的验证，用户全程无感知。

## 工作原理

核心就一条规则：**先证明代码是好的，才允许重启。**

构建和测试全绿后，插件记录一个凭证，绑定当时的 git commit，并带 10 分钟有效期（`maxAgeMinutes`）。要重启时检查三点：

1. 有没有凭证；
2. 凭证超没超过 `maxAgeMinutes`；
3. 当前 HEAD 和记录凭证时的 commit 一不一致——记录之后任何改动都会让凭证失效。

这条规则能拦住一整类事故：改坏了构建、漏注册配置、导错模块——这些全都会让构建/类型检查失败，于是没有凭证，重启在造成伤害之前就被拒绝。

重启本身交给 watchdog 托管：独立的监督进程，宿主死了自动拉起来，起不来就回滚到检查点，连续四次失败停在崩溃页等人工处理。`checkpoint` 在批次前把整个工作树提交为回滚点，`reset` 硬重置回该点，`canary` 在重启后复检。检查点与凭证存在状态文件里，重启后依然存活，所以 canary 可以在新实例起来之后运行。

## 安装与加载

本包是 dsh 插件：守护运行中的 dsh web 实例，防止坏掉的自我修改重启。不自带宿主——先准备 dsh 宿主（`npx @deepseek-ai/dsh web`)。宿主兼容性：dsh `0.0.1-rc.5+` 或 `0.1.0-rc.5+`(npm 上任何当前版本均可）。

一条命令安装到 profile 并作为补丁层激活（本包声明了 `dsh.bundle`,add 会同时写入依赖并挂载插件；重复执行安全，按包名去重）:

```sh
dsh plugin --profile web add @khorsheed/dsh-ankh-guard
```

或从 GitHub 安装（安装时经 `prepare` 自动构建）:

```sh
dsh plugin --profile web add github:Khorsheed/dsh-ankh-guard
```

装完重启宿主。注意：如果你的 profile 已经通过其他 bundle 组合了 ankh-guard，请不要再 add——同一条目 id 挂载两次会在启动时 fail loud(`duplicate loader entry id`)。

自定义 profile 也可以在自己的补丁层里手工组合：

```yaml
- insert:
    - id: ankh-guard
      name: '@khorsheed/dsh-ankh-guard'
```

源码安装——clone、构建、测试：

```sh
git clone https://github.com/Khorsheed/dsh-ankh-guard.git
cd dsh-ankh-guard && pnpm install && pnpm run build && pnpm test
```

配置（全部可选）：`stateDir`（默认 `$DSH_HOME/state`，否则 `<cwd>/.dsh-guard-state`）、`repoDir`（默认进程 cwd）、`maxAgeMinutes`（凭证新鲜窗口，默认 10）、`reportRestartContext`（`followup` 自主报告 / `step` 骑下一次回合 / `off`，默认 `followup`）、`fallbackGraceMs`（发起会话尚未恢复时等其他 agent 接管报告前等多久，默认 60000）。

运行时需要：`node`、`bash`、macOS/Linux 上的 `lsof`（发现监听者；`--pid` 可绕过）。消费者无需构建——发布的 `lib/` 就是可运行产物。

## 命令行

主要接口是 CLI，实例宕机也能用。安装后用 `dsh-ankh-guard` bin（或 `node lib/cli.js`）。所有命令带 `--state-dir "$DSH_HOME/state" --repo "$PWD"`。

```sh
dsh-ankh-guard verify      # is it safe to restart right now
dsh-ankh-guard record build+test   # green build & tests → record the credential
dsh-ankh-guard checkpoint --message "what changed"   # checkpoint before editing
dsh-ankh-guard canary --port 3080   # confirm after restart
dsh-ankh-guard supervise --port 3080 --start "CMD"   # hand the port to a watchdog
```

完整命令：`verify`、`record`、`status`、`clear`、`checkpoint`、`reset`、`canary`、`restart`、`schedule-exit`、`supervise`。

### 自我重启协议

改完代码安全重启的六步：

1. **checkpoint**——快照工作树为回滚点：`dsh-ankh-guard checkpoint --message "<批次>"`
2. **修改**——做完改动；注册它需要的每个面（聚合、paths、bundle 行、依赖）。
3. **构建 + 测试**——改动面的完整定向集；没有绿色就没有凭证。
4. **record**——`dsh-ankh-guard record build+test --command "<什么过了>"`
5. **verify**——`dsh-ankh-guard verify` 必须 exit 0；拒绝（缺凭证/过期/HEAD 不匹配）就重建重录。
6. **重启 + canary**——新实例起来后 `dsh-ankh-guard canary --port N` 确认。

### supervise：无感重启

`restart` 在单个 CLI 进程里跑完 kill → start → probe → canary（用 `--delay-ms` 让调度方回合先完成）。对于不该碰终端的部署，`supervise` 把工作交给 **watchdog**——一个 detached、比实例活得久的监督进程：

```sh
dsh-ankh-guard supervise --port 3080 --start "CMD" --state-dir "$DSH_HOME/state" --repo "$PWD"
```

它以 `--wait-owner` 模式 detached 拉起随包发布的 `scripts/dsh-watchdog.sh`：watchdog 在当前实例运行期间待机，实例退出（有意重启或崩溃）后接管端口、重新拉起，有意重启时跑 guard canary（读 `restart-requested.json` 标记），通过后清除标记。连续 2 次起不来→回滚到 checkpoint；4 次失败→在端口上提供带重试按钮的崩溃页（SIGUSR1 通知 watchdog）。`watchdog-stop` 标记让 watchdog 彻底退出。实例可以在自我重启前自行采用监督——用户永远不需要手动启动 watchdog。

已有 watchdog 监督时，重启触发用 `schedule-exit`：写入 restart 标记并 spawn 一个 detached 退出代理（node `spawn` 的 setsid），托管 shell 的进程组回收不到它，所以计划中的 kill 会在调度回合结束后真实落地（修复 `(sleep N; kill) &` 静默不触发的坑）。watchdog 重新拉起、跑 canary，新实例经 `last-restart.json` 回报。只有无 watchdog 时才用 `restart`（单次循环）。

**重启报告自动到达模型。** 计划重启后，插件在 agent 创建时（存在未确认的 `last-restart.json` 记录）通过 `agent.followup` 把报告排入下一回合，agent 无需任何用户消息即可回报重启结果。报告返回给发起重启的会话：`schedule-exit` 把 `$DSH_SESSION_ID` 记为 initiator，只要该会话的根 agent 还活着，就只有它能领走记录。会话恢复是异步的，发起会话尚未 live 时先查持久化：会话还在（慢恢复）用宽限定时器（`fallbackGraceMs`，默认 60000 ms）等它，宽限期后才允许任意根 agent 回退；会话确实没了则由首个 live 根 agent 领走，报告不会丢失。定时器触发时校验记录身份（`exitAt` 相同且未确认），二次重启或已有人认领时旧定时器不会误 ack。仅根 agent、仅一次（记录被确认）。配置 `reportRestartContext`：`followup`（默认，自主）、`step`（骑在下一次回合的第一步上）、或 `off`。

### supervise：一个端口一个拥有者

一个端口只能有一个监督拥有者，但拥有者本身也应该被监督。三种部署形态：

- **A — 纯 guard**：无外部监督者；实例在自我重启前用 `supervise` 采用 watchdog。最简单，但意外崩溃后没有东西拉回宿主。
- **B — 纯 launchd/systemd**：launcher 用 KeepAlive 拥有端口。抗崩溃，但自我修改重启不受凭证闸门约束。
- **C — 分层（推荐）**：launchd 监督 watchdog，watchdog 监督实例。每端口一个拥有者，且拥有者也被监督。watchdog 以前台方式运行：

```sh
# launchd/systemd job (KeepAlive) runs this; the CLI process IS the watchdog:
dsh-ankh-guard supervise --foreground --port 3093 --start "<start command>" \
  --state-dir "$DSH_HOME/state" --repo "<checkout>"
```

`--foreground` 让 watchdog 内联运行（接管端口）并随它退出，watchdog 死掉会触发外部监督者重启。detached 形态（不带 `--foreground` 的 `supervise`）用于实例在自我重启前自行采用监督。

检查点/回滚闭环：

```sh
dsh-ankh-guard checkpoint --message "before batch"
# ... modify, build, test, record, verify ...
dsh-ankh-guard canary --port 3080   # fails → roll back
dsh-ankh-guard reset <checkpoint-sha>
```

`restart` 在独立于被重启实例的进程中跑完整套重启循环。它在闸门拒绝时拒绝停实例（凭证检查在重启路径本身强制，而非仅靠流程），停止 `--port` 上的监听者，以 detached 方式启动 `--start` 命令，轮询端口直到监听，重新校验；`--rollback` 时若新实例一直起不来则硬重置到记录的检查点：

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

## 友情链接

- [dshfind](https://dshfind.com/)
