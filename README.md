# @khorsheed/dsh-ankh-guard

> 镜像仓：与 [Khorsheed/dsh-plugins](https://github.com/Khorsheed/dsh-plugins) 的 `packages/ankh-guard` 自动同步。Issue 欢迎提在本仓；PR 请提交到 monorepo。
>
> [English](README.en.md) | 中文

让 agent 自己改代码、自己重启，还不把服务搞挂。

agent 改完代码想重启的时候，这个插件会先问一句：这次改动，构建和测试都过了吗？过了才放行，没过就拦下来——免得改坏的代码把整个服务、连同正在进行的对话一起带走。

<img src="https://raw.githubusercontent.com/Khorsheed/dsh-basic/main/docs/screenshots/ankh-guard.JPG" width="640" alt="一次受守护的重启:重启前告知验证项,重启后金丝雀自动激活会话并注入上下文继续验证">

## 工作原理

核心就一条规则：**先证明代码是好的，才允许重启。**

guard 以 `record --run -- PROGRAM ...` 亲自执行构建/测试并观察 exit 0 后，才记录一个绑定当时 git commit、有效 10 分钟（`maxAgeMinutes`）的凭证。要重启时检查四点：

1. 有没有凭证；
2. 凭证超没超过 `maxAgeMinutes`；
3. 当前 HEAD 和记录凭证时的 commit 一不一致；
4. 工作树是否完全干净——staged、unstaged、untracked 任一种输入都会让凭证失效。

这个 10 分钟窗口约束的是**尚未启动验证过的构建证据**，不是让完全相同的已部署产物每隔十分钟重新测试。一次 watchdog 重启只有在 ownership/readiness、composition preflight 与 post-restart canary 全部通过后，才把该凭证晋升为耐久的 `provenDeployment`。以后 `schedule-exit` 遇到过期凭证时，可以复用这份证明，但必须重新计算并逐项匹配 credential repo 与 harness 的干净 HEAD、完整 launch spec、profile 配置、直接安装包与 `file:` 归档、宿主安装元数据及显式绑定的 source/built preflight runner/anchor；任一字节、链接目标、启动配置或仓库状态漂移都 fail closed，退回重新 build + test。旧版 `last-good-boot.json` 不会自动获得这种资格，首次启用仍需完整门禁和一次成功 canary。

这条规则能拦住一整类事故：改坏了构建、漏注册配置、导错模块——这些全都会让构建/类型检查失败，于是没有凭证，重启在造成伤害之前就被拒绝。

但绿色构建证明不了 profile 组合能起来：坏掉的 patch YAML、缺失的构建产物、重复的 loader entry id、typert manifest 归属不匹配、apply 时抛错的插件——这些只在 boot 阶段才爆。于是第二道闸门在凭证检查之后、停任何东西之前运行：`preflight` 在子进程里对完全相同的组合做深度干跑（整个插件树走同一个引擎完整 boot 一遍，然后 dispose），组合起不来就绝不停止运行中的实例。见 [preflight：组合闸门](#preflight-the-composition-gate)。

重启本身交给 watchdog 托管：独立的监督进程，宿主死了自动拉起来，起不来就回滚到最后已知可用版本（健康启动戳——本部署里最近一次真正跑起来过的版本——兜底依次是检查点、绿色凭证的 HEAD），连续四次失败停在崩溃页等人工处理。启动失败源自仓库之外时（新装的插件是最常见的情形），回滚检出修不好它——所以 watchdog 改为回滚 **profile 组合**：每次健康启动都会快照组合输入（bundles 层与 profile 清单），仓库外故障即恢复该快照（最新插件变更被卸载，故障输入备份在 `composition-backup-*`），并通过重启报告渠道点名被卸载的内容、向用户回报这次自动恢复。每次回滚都会留下 `guard-backup-*` 恢复锚点（被丢弃的 HEAD 和未提交改动各有分支），恢复不依赖 reflog。`checkpoint` 在批次前记录干净的现有 HEAD；脏树默认拒绝，只有复核完整路径集后显式 `--include-dirty` 才提交为回滚点。`reset` 硬重置回该点（同样留锚点），`canary` 在重启后复检。检查点与凭证存在状态文件里，重启后依然存活，所以 canary 可以在新实例起来之后运行。

就绪判定理解应用语义：任何 HTTP 响应（包括裸 401）都只证明 transport-up；公开根路径 HTTP 200 才 ready。受保护根路径必须由 watchdog 从**最终进程**输出中取得同 authority 的启动 URL，并用临时 Cookie jar 证明 启动 URL → 303 → 带 Cookie 的 `/` → 200。HTTP 成功还不够：被拉起的直接 child 必须仍存活，端口的唯一 listener 必须属于该 child 的进程树，child/listener 的 PID 与启动 identity 要在稳定窗口内保持不变，且当前 retry 必须为 0。浏览器交接是独立证据面，并且只在这些证明和 canary 通过后执行：所有仍响应的已登记原标签页会在停机前进入等待；Cookie 仍有效就自动刷新，否则仅在内存中取得最终进程的一次性 URL 并执行 `location.replace()`，完成 Cookie 交换后再回到不带凭据的同源原路径。一个真实的已认证页面回执负责解除终态门禁，较慢的其他已登记标签页仍可通过同一个精确 final listener 恢复。Bearer URL 不进入耐久状态或日志。

## 安装与加载

本包是 dsh 插件：守护运行中的 dsh web 实例，防止坏掉的自我修改重启。它的唯一身份是 **`@khorsheed/dsh-ankh-guard`**，在 `dsh-plugins` monorepo 中开发并从那里发布到 npm。装宿主后把插件加为 profile bundle：

```sh
npm install @deepseek-ai/dsh                                 # the host (dsh web / dsh CLI)
dsh plugin --profile web add @khorsheed/dsh-ankh-guard       # this plugin
```

包声明了 `dsh.bundle`，add 会把它的 `cordis.patch.yml` 行（一个裸 `ankh-guard` 挂载行）自动并入 profile 的 bundles 层——不用手改 cordis.yml。一个 caveat：一个组合里 `ankh-guard` 行 id 只能挂一次。官方镜像（已发布的 npm 线和 upstream master）都不挂这行，所以上面的 add 就是安装路径；而已经用其他方式挂了该 id 的组合——2026-08-16 之前的部署 fork 的 base bundle 就挂过——不能再 add 这个包，重复的 loader entry id 会炸 boot。拿不准就先查组合树：`dsh --profile web --dump-config | grep ankh-guard` 无输出即说明可以安全 add。源码安装：clone monorepo，包在 `packages/ankh-guard`（`pnpm install && pnpm run build`）。

配置（全部可选）：`stateDir`（默认 `$DSH_HOME/state`，否则 `<cwd>/.dsh-guard-state`）、`repoDir`（默认进程 cwd）、`maxAgeMinutes`（凭证新鲜窗口，默认 10）、`reportRestartContext`（`followup` 自主报告 / `step` 骑下一次回合 / `off`，默认 `followup`）、`resumeInterrupted`（恢复被重启中断的会话并排入继续回合，默认 true）、`resumeDelayMs`（默认 5000）、`resumeMaxSnapshotAgeMs`（默认 600000）。

运行时需要：`node`、`bash`、macOS/Linux 上的 `lsof`（发现监听者；`--pid` 可绕过），以及 `pgrep`（回收后代进程：watchdog 的清理与 `restart` 的强杀升级都遍历子进程树，而不是假设进程组）。guard 会先探测 `/usr/sbin/lsof`、`/usr/bin/lsof` 等系统绝对路径，再回退到 PATH，因此 dsh 的精简 PATH 不会让监听者检查静默失效。消费者无需构建——发布的 `lib/` 就是可运行产物。

## 自我重启的前提（给驱动重启的 agent）

- **git 必需。** 凭证、检查点、回滚全部基于 git：凭证绑定干净 HEAD，checkpoint 记录一个真实 commit（干净时复用现有 HEAD，批准脏快照时创建提交），rollback 是 reset。部署目录不是 git 仓库时，先 `git init` 并做一次初始提交，再 `record`——否则门禁以 "current git HEAD unavailable" 拒绝重启。`git init` 不是仪式：有了仓库，checkpoint/rollback 的恢复锚点才真正生效。
- **需要 full-access（无沙箱）权限。** 重启链路要 spawn detached 进程、kill 进程、绑定端口；沙箱化的 tool runner（workspace-write 之类）会以 EPERM 拒绝其中操作，实例在 shell 层就起不来。**agent 自己无法切换沙箱**——这正是沙箱的意义：`/permission` 是用户输入的命令，单命令提权也要用户审批。长期部署更省事的官方做法：启动实例时设 `DSH_PERMISSION_MODE=danger-full-access`（base bundle 的部署级开关，沙箱与审批策略同时放开），所有会话默认无沙箱。或者发起自我重启前，请用户把**当前会话**切到 full-access：`/permission danger-full-access`——设置页只影响**新**会话；有打开中的持久终端（PTY）时会先被 fence 拒绝，须先关闭终端。（`verify` 和 `record` 的输出也会带这条提示。）
- **安装后的第一次重启必须用 CLI 驱动。** 正在运行的实例还没加载插件（组合变更要重启才生效），watchdog 也还不存在——此时直接退出实例，服务就躺在地上没人拉。add 之后立刻跑 `dsh-ankh-guard supervise --port N --start "CMD"`（它会接管正在运行的实例，之后任何退出都会被拉起），或用 `dsh-ankh-guard restart --port N --start "CMD" --rollback` 驱动首次重启（它在 detached 进程里完成 停→起→canary 全循环），或安装 launchd/systemd 监督器。收编接管会写一条以 `supervise` 调用会话（`$DSH_SESSION_ID`）为收件人的报告记录——首次弹换和计划重启一样自动回报，驱动会话不会无声停泊。没有存活 watchdog 时 `verify`/`record` 会警告，`schedule-exit` 则硬拒绝，避免确定性停服。

## 已知安装坑

- **从 GitHub 安装会现场构建。** `dsh plugin add github:…` 会 clone 并跑 `prepare`（完整 devDependencies 安装 + 构建）。npm 发布版（`@khorsheed/dsh-ankh-guard`）自带构建好的 `lib/`——除非刻意要跟仓库最新代码，否则优先用 npm 版。
- **pnpm 默认拦截依赖的构建脚本。** add 因构建脚本拦截失败时，把工具链条目加进 `allowBuilds` 后重试。
- **npm 缓存有 root 属主文件**（历史上用过一次 `sudo npm …`）会让 prepare 构建 EPERM：`sudo chown -R $(id -u):$(id -g) ~/.npm`。
- **`--start` 不在你的 cwd 里跑。** watchdog 启动前会 `cd` 到 dsh home（否则 `/tmp`），所以启动命令必须自包含——绝对路径，或命令里显式 `cd`。
- **启动命令里带上 `--no-open`。** 它避免宿主自己在每次拉起时弹标签。受保护的启动配置切换会先让现有标签页等待并原地恢复；只有原标签页无法在超时内确认时，watchdog 才用最终进程 URL 请求打开兜底标签页，而且系统 `open` 返回成功只表示已尝试，不代表浏览器已接管。候选进程 URL 绝不复用；preflight 干跑也不会打开浏览器。
- **首次部署原标签页交接必然走 fallback。** 由旧版插件加载的页面还没有 handoff client。要验收原页接管，必须先把本版 ankh-guard 部署到 previous 宿主并刷新原标签页，让新 client 生效，再执行宿主 cutover；bootstrap 那一次另开兜底页属于预期。
- **从沙箱会话里采用的监督会继承沙箱。** 从 workspace-write 沙箱里 spawn 的 watchdog 会把沙箱 profile 传给之后每次拉起的实例（嵌套 sandbox-exec 失败，每条命令退化成审批）。长期部署请用分层形态（launchd/systemd 安装器），让 watchdog 链从沙箱外启动。

## 命令行

主要接口是 CLI，实例宕机也能用。安装后用 `dsh-ankh-guard` bin（或 `node lib/cli.js`）。`--repo` 始终表示凭证/回滚仓库；`--harness-root` 表示 preflight 与 child 实际使用的宿主根，两者可以且通常不同。状态命令带 `--state-dir "$DSH_HOME/state"`。

```sh
dsh-ankh-guard verify      # is it safe to restart right now
dsh-ankh-guard record build+test --run -- sh -c 'pnpm run build && pnpm run test'
dsh-ankh-guard checkpoint --message "what changed"   # checkpoint before editing
dsh-ankh-guard preflight   # deep dry-run: does the profile composition boot
dsh-ankh-guard canary --port 3080   # confirm after restart
dsh-ankh-guard supervise --port 3080 --start "CMD"   # hand the port to a watchdog
dsh-ankh-guard reconfigure --start "NEW CMD" --repo "<credential repo>" \
  --harness-root "<host root>" --on-failure restore-previous
```

完整命令：`verify`、`record`、`status`、`clear`、`checkpoint`、`reset`、`canary`、`preflight`、`restart`、`schedule-exit`、`configure-launch`、`launch-status`、`reconfigure`、`abort-cutover`、`restore-previous`、`supervise`。

### preflight: the composition gate

`preflight` 对重启将要 boot 的组合做完全一致的深度干跑：走与真实 launcher 相同的路径组装 profile 的全部 patch 层（bundle 层、用户层、overlay），在子进程里用同一个引擎 boot **整棵插件树**——每个插件的 apply 都真实执行，因为 apply 即激活——同时用 overlay 把 webserver 端口钉到 0（操作系统分配，绝不与在跑实例抢端口），检查每个已注册 client bundle 产物存在，并回读 agent preset 注册表的 `broken` 诊断（preset 行挂在注册表的 standing scope 上而不是 profile 根，**boot 干净不代表 preset 可用**：坏 preset 的选择器卡片显示「加载失败」、其会话 resume 报 `never started`——3080 在 2026-09-28 撞过一次，干跑一路全绿），然后 dispose（注册即 effect，dispose 即回滚这次干跑）。退出码即契约：

- `0`——组合干净通过。
- `1`——组合结论：重启将要 boot 的树是坏的；输出会指明坏在哪一层。
- `3`——preflight 自身没能执行（缺 app 布局、基础设施崩溃）——**不是**对组合的结论。

`schedule-exit`、`restart` 和 `reconfigure` 在凭证检查之后、停止任何东西之前运行这道闸门。组合失败会带着 preflight 的诊断拒绝；基础设施失败同样拒绝——措辞不同，并附手动绕行路径（手动停实例，让 watchdog 重新拉起）——因为 guard 不会停掉一个它无法证明能回来的健康实例。CLI 在等待前立即输出 `composition preflight START`，完成后才输出 PASS 或拒绝。闸门按 `--harness-root` → 耐久选中 launch spec → `DSH_HARNESS` → 约定路径 `~/code/deepseek-harness` 的顺序定位用于干跑的 dsh app；凭证 `--repo` 永不参与宿主定位。全部都解析不到时（没有 harness 检出的纯 npm 部署）没有引擎可以 boot 这棵树，闸门警告一行后放行。参数：`--profile NAME`（默认 `$DSH_PROFILE`，否则 `web`）和 `--preflight-timeout-ms MS`（默认 120000）；`DSH_PREFLIGHT_COMMAND` 整体替换解析出的 app bin（测试钩子）。调用它的托管 shell/tool 还必须有更长的独立等待预算：默认 preflight 下使用至少 180000 ms；自定义时至少比 `--preflight-timeout-ms` 多 30000 ms。调用方超时不是 guard 拒绝，且没有 `exit scheduled` 就没有获准重启；重试前先检查耐久 marker/回执。随时可手动跑：`dsh-ankh-guard preflight --profile web --harness-root "$DSH_HARNESS"`。

### 自我重启协议

改完代码安全重启的六步。纯重启没有任何文件/依赖/profile/已安装产物/启动配置变化时跳过第 1 步；若已有新版 guard 在一次成功 canary 后写出的同指纹 `provenDeployment`，第 3–4 步也可由 `schedule-exit` 自动复用。没有证明、证明来自旧协议或指纹漂移时仍必须完整执行：

1. **checkpoint**——干净树记录现有 HEAD；脏树默认拒绝，复核且批准完整快照后才加 `--include-dirty`：`dsh-ankh-guard checkpoint --message "<批次>"`
2. **修改**——做完改动；注册它需要的每个面（聚合、paths、bundle 行、依赖）。
3. **构建 + 测试**——改动面的完整定向集；没有绿色就没有凭证。
4. **record**——让 guard 执行并观察证据命令：`dsh-ankh-guard record build+test --run -- sh -c 'pnpm run build && pnpm run test'`
5. **verify**——`dsh-ankh-guard verify` 必须 exit 0；它优先接受新鲜凭证，仅在耐久 launch spec 稳定且完整部署指纹相同时接受已验证部署。拒绝（缺证明、指纹漂移、HEAD 不匹配/工作树脏）就清理后重建重录。
6. **重启 + canary**——新实例起来后 `dsh-ankh-guard canary --port N` 确认。

### supervise：无感重启

`restart` 在单个 CLI 进程里跑完 kill → start → probe → canary（用 `--delay-ms` 让调度方回合先完成）。对于不该碰终端的部署，`supervise` 把工作交给 **watchdog**——一个 detached、比实例活得久的监督进程：

```sh
dsh-ankh-guard supervise --port 3080 --start "CMD" --state-dir "$DSH_HOME/state" \
  --repo "<credential repo>" --harness-root "<host root>"
```

`supervise` 还需要被监管实例启动时使用的 dsh home（watchdog 会把它 export 为实例的 `DSH_HOME`）：`--home DIR` 优先，否则取 `$DSH_HOME`；两者都没有时响亮拒绝——从 `--state-dir` 猜出来的 home 会让实例静默读错 profile/凭据目录。首次持久化还必须显式提供 `--harness-root` 或 `DSH_HARNESS`；它不会把 credential repo 猜成宿主根。

它以 `--wait-owner` 模式 detached 拉起随包发布的 `scripts/dsh-watchdog.sh`：watchdog 在当前实例运行期间待机，实例退出（有意重启或崩溃）后接管端口、重新拉起，有意重启时跑 guard canary（读 `restart-requested.json` 标记），通过后清除标记。连续 2 次起不来→回滚到最后已知可用版本：健康启动戳（`last-good-boot.json`，每次实例成功启动时重写，指向本部署里最近一次真正跑起来的版本）优先，其次是 guard checkpoint，最后是凭证 HEAD；但仅当启动失败的错误主体路径在仓库内。主体在仓库之外时（坏掉的 profile overlay 或已装插件），回滚检出修不好，watchdog 改为恢复上次健康的 **profile 组合**：健康启动时快照的组合输入（`last-good-composition/`）覆盖回 live 的 bundles 层与清单，最新插件变更被卸载，故障输入保留在 `composition-backup-*`，恢复报告会点名被卸载的内容。启动命令没有绑到被监督端口时同样豁免：启动窗口超时而实例正监听在别处、或以点名了本 watchdog 并不拥有的端口的 `EADDRINUSE` 失败时，watchdog 会点名实际绑定的端口并跳过两种回滚——重置文件改不了命令行参数。发生在被监督端口上的 `EADDRINUSE` 保留原本的释放并重试逃生口，现在以五次为上限。每次启动失败都会把该次 attempt 捕获的输出镜像进 watchdog 主日志——实例一行都没写时则显式记录 `attempt N produced no output`——让「boot 即死」在运维第一眼就能看到。任何路径的 reset（watchdog、CLI、service）都会先为被丢弃的 HEAD 和未提交改动创建 `guard-backup-*` 分支锚点，恢复不依赖 reflog。4 次失败→在端口上提供带重试按钮的崩溃页（SIGUSR1 通知 watchdog）。`watchdog-stop` 标记让 watchdog 彻底退出。实例可以在自我重启前自行采用监督——用户永远不需要手动启动 watchdog。

已有 watchdog 监督时，重启触发用 `schedule-exit`：它从耐久 active launch spec 取得端口、凭证仓库、宿主根与 profile，拒绝任何冲突的显式参数，并核对 supervisor 写下的完整命令后才写 restart 标记、spawn detached 退出代理（输出明确标为 `exit-agent pid`）。它优先使用 10 分钟内的新鲜 credential；credential 过期时，只允许精确匹配的 `provenDeployment` 走纯重启快速路径，并把所选证据 SHA 写入短寿命 restart marker。新 watchdog 在 canary 时再次核对同一 SHA 与现场指纹，防止检查后、停止前的证据替换。通过后才晋升或保留部署证明。从 agent 的 Bash/tool 调用时应把该调用的 `timeoutMs` 设为 180000；这不是 CLI 参数，而是保证调用方不会先于 120 秒 preflight 闸门退出的等待契约。托管 shell 的进程组回收不到退出代理，所以计划中的 kill 会在调度回合结束后真实落地。watchdog 重新拉起、跑 canary，新实例经 `last-restart.json` 回报；watchdog 生命周期日志均带时间戳。没有存活 watchdog 时 `schedule-exit` 硬拒绝，只能先建立监督或使用拥有单次完整循环的 `restart`；后者没有相同的 durable supervisor/launch ownership，因此仍要求新鲜 credential。`--boot-timeout-ms MS` 随 restart marker 记录一次性就绪预算：marker 待消费期间，重新拉起的启动窗口按它计算（向上取整到整秒），之后 watchdog 回落到自己的 `WD_BOOT_TIMEOUT`（默认 60 秒）。

### reconfigure：启动配置事务切换

`schedule-exit` 是启动配置不变时的快速路径。命令、dsh home、凭证/回滚仓库、宿主根或 profile 任一变化时必须用 `reconfigure`；在线改端口会被明确拒绝，因为那需要另起监督链再切流量。

```sh
dsh-ankh-guard reconfigure \
  --start "<完整目标命令>" \
  --repo "<目标凭证/回滚仓库>" \
  --harness-root "<目标宿主根>" \
  --preflight-surface built \
  --preflight-install-anchor "<实际 npm toolchain>/node_modules/@deepseek-ai/dsh/package.json" \
  --candidate-probe-command "<以同一 target argv 做一次性验证的命令>" \
  --transition-file "<可选的状态迁移计划.json>" \
  --on-failure restore-previous \
  --browser-handoff required \
  --boot-timeout-ms 90000 \
  --state-dir "$DSH_HOME/state"
```

`reconfigure` 与 `supervise` 接受 `--boot-timeout-ms MS`，把每次启动的就绪预算交给拉起的 watchdog（`WD_BOOT_TIMEOUT`，整秒；慢宿主上省略它，一个健康但缓慢的首次 boot 会被误判为失败）；`reconfigure` 下该值随 supervisor 驱动器的 argv 传给继任 watchdog。

恢复选择是必填项，因而会在旧宿主停止前获批：`restore-previous` 恢复上一份**完整**启动配置；`wait-for-user` 不重置任何仓库，原地停留等用户处理。完整 previous/target 对分别保存 command、home、credential repo、harness root、profile 与 port。每份新配置还固化 composition preflight 的 `source|built` 面、runner 可执行方式/路径/内容 SHA、实际 `@deepseek-ai/dsh/package.json` 安装锚点和 target command SHA；built successor 从其 npm toolchain 解析模块，绝不因 guard 自己恰由 tsx 启动就误选 checkout source。`reconfigure` 另要求调用方提供一条与 target command SHA 同时提交的一次性 `--candidate-probe-command`，先在隔离 home 执行，再跑同一执行面上的 composition preflight；Guard 只绑定并执行两个 command 摘要，不能证明任意成功的 shell command 是从 target argv 自动派生的。随包 Skill 会用相同 executable 与 launcher argv 构造 DSH `--dump-config` probe；这条调用方信任边界之外的其他集成也必须自行保证语义同源。任一失败都发生在 previous 停止之前。当前选中侧保存在 mode-0600 的 `launch-spec.json`；回执只写各摘要和 PASS 结果，不写 probe/start 命令或 bearer URL。

原子切换选中侧是配置提交点。缺少完整耐久 previous 时必须先用当前真实值运行 `configure-launch`，并显式给出它的 preflight surface/install anchor；旧 `instance-launch.json` 不足以推断，目标 `--repo` 也绝不会倒填 previous。随后替代 watchdog 会在旧宿主仍对外服务时原子取得 `watchdog.pid`。准备事务时 guard 同时固化旧 supervisor、直接 child 与 listener 的 PID/启动 identity；successor 按 identity 有界等待旧 supervisor 正常让权（默认 15 秒，可用 `--supervisor-yield-timeout-ms` 调整），等待期间持续消费 abort/restore。超时只会在先冻结并复核旧 supervisor identity 后终止其精确进程树。successor 随后只停止已证明的旧 child/listener 并确认端口释放，绝不凭端口反查后杀任意监听者。因此 PID 复用、卡死 watchdog、短命 `reconfigure` 调用者、外层 launchd/systemd 等待者或嵌套 shell 都不会模糊所有权或无限悬挂切换。

目标受保护时，watchdog 只接受最终进程输出、且 authority 与被监督 loopback 完全一致的启动 URL，不依赖任何查询参数名。它用临时 jar 证明 303 Cookie 交换和认证后根路径 200，再在默认 3 秒稳定窗口内持续证明 child 存活、唯一 listener 属于该 child 树、PID/启动 identity 不变且 retry 为 0。浏览器端改用插件同源路由上的持有式长轮询，不再永久每 500ms 请求：已证明的 previous listener 只落盘每标签页随机 capability 的哈希，并让所有仍响应的已登记标签页进入等待。只有在 ownership-stable 服务就绪和 canary 成功后，final listener 才在 Cookie 有效时通知各页刷新，或在收到 401 时把该最终进程的同源一次性 URL 返回内存，由页面执行 `location.replace()`；已认证页面回传 ACK 后，会丢弃 query/fragment 并回到原来的安全 pathname。一个真实 ACK 解除 terminal ready 门禁，其他尚未 ACK 的已登记页面在状态压缩后仍可恢复。没有原标签页登记或都未在超时内确认时，watchdog 才请求一次 system open 兜底，并继续等待新页面回传已认证 ACK；opener 的 exit 0 本身永远不算交接成功。服务端 readiness/canary 与浏览器交接分别记录，所需证据全部完成后才释放会话唤醒。裸 401、旧 listener 的 200、target 的短暂 200 或随后退出都不会成为 ready，也不会把已拒绝 target 的 URL 交给浏览器；原始 capability 和 bearer URL 均不进入状态文件、耐久日志或回执。`launch-cutover.json` 记录脱敏配置摘要、新旧 supervisor/child/listener identity、旧 supervisor 让权、认证就绪、浏览器 ACK 渠道、稳定性证明与分角色失败计数；target 的 readiness/canary 保留在 `targetValidation`，previous 的恢复 readiness 以及可用、失败或因只有 target-scoped credential 而明确跳过的恢复 canary 单独写在 `recovery.validation`，不会再出现 previous 已恢复却挂着一个无主语的 target canary fail。`launch-status` 输出该回执且不暴露两边命令。事务进行中可运行 `abort-cutover --state-dir "$DSH_HOME/state"` 执行事前批准的恢复策略；`restore-previous --state-dir "$DSH_HOME/state"` 显式授权停止已证明的 target 并恢复完整 previous spec。两个动作分别使用原子 marker，读取时 restore 永远优先，因此并发会话的晚到 abort 也不能降级 restore。

**监督链中途死亡时的 cutover 恢复。** 回执停在 `awaiting-user` 不再楔死事务。裸 `supervise`（launchd/systemd 跑的那条命令）现在以停泊形态拉起 watchdog：它取得监督所有权、什么都不启动（被拒的一侧绝不 boot），并持续消费运维控制 marker，因此 `abort-cutover --state-dir "$DSH_HOME/state"`（执行事前批准的策略）与 `restore-previous --state-dir "$DSH_HOME/state"` 立即可用，不再以「没有存活 watchdog」拒绝。停泊态会一次性说明自己的退出与恢复路径：`touch "$DSH_HOME/state/watchdog-stop"` 不做终态结算就结束停泊；`supervise --cutover-id <id> --state-dir "$DSH_HOME/state"`（id 见 `launch-status` 与回执）恢复选中侧——resume 把回执翻离 `awaiting-user`，停泊态随即释放所有权，恢复链先等到这次释放再接管。

candidate 无法读取旧宿主留下的可重建投影或缓存时，`--transition-file` 可以提交一份经过评审的 schema-v1 隔离计划。计划只接受 `home` 下互不重叠、没有符号链接且不包含 guard state 的相对路径，以及显式的 `quarantine` 操作；它不内置任何宿主版本或文件名知识。示例：`{"schemaVersion":1,"home":"/absolute/dsh-home","operations":[{"kind":"quarantine","path":"storages/<可重建缓存>","expect":"present"}]}`。每项 `expect` 必须是 `present` 或 `absent`，副本 preflight 与 live apply 都必须观察到相同状态，否则在停 previous 前或启动 target 前拒绝。计划既要覆盖 target 启动前必须移开的旧路径，也要覆盖 target 失败后 previous 启动前必须清走的新输出路径；后者即使准备时不存在也必须用 `expect: "absent"` 显式列出。权威日志、凭据或不可重建数据不得借此移出；需要内容转换的格式应使用独立、可逆且另行评审的迁移工具。

guard 先以 copy-on-write 优先方式复制 live home 的启动输入——白名单为 `profiles/`、home 级 `cordis.patch.yml`、`settings.yaml`、`.credentials.yaml`、`.anonymous-user-id`；插件数据目录（sessions、state、local-agent 子 home、tarballs、scratch 等）默认不进复制，新插件的数据目录不会悄悄扩大快照，名单只在宿主启动读取范围变化时才需要更新（漏项会以预检 FAIL 显形，而不是慢慢变大）。再把 pnpm/Cordis 链接重建为只指向 snapshot 内副本的相对链接；合法的内部依赖循环保留。外部目标进入 snapshot 自己的哈希命名去重物化区，`node_modules` 目标锚定在包自身的父 `node_modules`（保留 Node 祖先查找语义的最小范围），而不是整个 store 根。复制后逐链接 `realpath` 审计，任何可写目标都必须仍在 snapshot 根内；无可复制语义的运行时条目（socket、FIFO 及指向它们的链接）跳过并计数；悬空或不可解析链接、其余特殊文件、可写逃逸及读取/复制失败都会让 `reconfigure` 在运行 candidate、创建 cutover 或停止 previous 前 fail closed。在安全副本中执行相同隔离后才运行 target composition preflight；副本无法准备或 target 无法 boot 时，previous 继续运行且 live home 不变。successor 取得监督所有权、停止并复核 previous 进程树以后，才按照哈希绑定的耐久计划用同文件系统 rename 隔离原路径。target 被拒绝时，watchdog 必须先停止其已证明的进程，再把它在同路径产生的替代内容保留到 `launch-transitions/<cutover>/rejected-target/`，恢复 previous 原字节并写入回执，最后才允许 previous 启动；任一步无法证明完成都会停在 `awaiting-user`，不会让旧宿主读取混合状态。target 成功后，旧内容仍保存在 cutover 目录，等待 operator 后续处置，不会自动删除。

**重启报告自动到达模型——并只等它的主人。** 计划重启后（存在未确认的 `last-restart.json` 记录），插件通过 `agent.followup` 把报告排入下一回合，agent 无需任何用户消息即可回报重启结果。重启后的会话恢复是 lazy 的（只有 UI 或 RPC 碰到某个会话，它的 agent 才会被创建），所以完整报告只发给发起重启的会话（`schedule-exit` 把 `$DSH_SESSION_ID` 记为 initiator），等它何时恢复何时送达——其他会话永远不会为了报告被唤醒；记录保持未确认，直到发起会话恢复或下一次重启替换它（新 `exitAt`）。没有 initiator 的记录由首个创建的根 agent 领走。仅根 agent、仅一次（送达即确认）。配置 `reportRestartContext`：`followup`（默认，自主）、`step`（骑在下一次回合的第一步上）、或 `off`。

**被中断的会话自动恢复并继续。** SIGTERM 时插件把当时有在途回合的根会话（连同重启发起会话）快照进 `interrupted-sessions.json`；下一次重启开机时——冷启动会丢弃快照不做动作——通过 `ctx.agents.resume` 把这些会话拉起来，并给被中断的会话排入一条"继续"followup（它们的日志已被崩溃恢复修复以 `reason.kind === 'interrupted'` 关闭），自我重启不再悄悄暂停其他所有会话。一条边界：**泊在用户输入上的回合**（未回答的 `ask_user_question` 或未决审批，读修复后的日志尾部判定）不算被中断的工作——卡片还在日志里、用户随时能答——这类会话既不恢复也不续跑。配置 `resumeInterrupted`（默认 true）与 `resumeDelayMs`（默认 5000，等应用服务先起来）。

### supervise：一个端口一个拥有者

一个端口只能有一个监督拥有者，但拥有者本身也应该被监督——裸的 detached watchdog 一旦死掉（SIGKILL、宽匹配的 `pkill`、终端关闭、OOM），服务就永久停摆、零自动恢复。三种部署形态：

- **A — 纯 guard**：无外部监督者；实例在自我重启前用 `supervise` 采用 watchdog。最简单，但意外崩溃后没有东西拉回宿主。
- **B — 纯 launchd/systemd**：launcher 用 KeepAlive 拥有端口。抗崩溃，但自我修改重启不受凭证闸门约束。
- **C — 分层（推荐）**：launchd 监督 watchdog，watchdog 监督实例。每端口一个拥有者，且拥有者也被监督。macOS：`scripts/install-launchd.sh --start "CMD"` 生成 `com.dsh.watchdog.plist`（`ProgramArguments` 以前台方式跑 CLI）装进 `~/Library/LaunchAgents` 并 bootstrap；`--force` 替换正在运行的 detached watchdog；`--uninstall` 移除任务。systemd：`scripts/install-systemd.sh --start "CMD"` 生成用户单元 `~/.config/systemd/user/dsh-watchdog.service` 并 enable——`Restart=on-failure` 对应 launchd 的 `SuccessfulExit: false`，`StartLimitIntervalSec=0` 关掉启动频率限制（默认值会把反复重启的单元置为 failed 并停止重试，等于监督静默终止），`--print` 只输出单元不碰 systemctl，`--force`/`--uninstall` 同 launchd 版。用户单元在会话结束后停止；要跨登录存活需要管理员执行 `loginctl enable-linger <user>`。两个平台跑的是同一条命令：

```sh
# 安装器只初始化一次；此后每次 KeepAlive 启动都服从耐久选中配置：
dsh-ankh-guard configure-launch --if-absent --port 3093 --start "<start command>" \
  --home "$DSH_HOME" --state-dir "$DSH_HOME/state" \
  --repo "<credential repo>" --harness-root "<host root>" \
  --preflight-surface built --preflight-install-anchor "<dsh package.json>" &&
exec dsh-ankh-guard supervise --foreground --state-dir "$DSH_HOME/state"
```

`--foreground` 让 watchdog 内联运行（接管端口）并随它退出，watchdog 死掉会触发外部监督者重启。收到 TERM/INT 或任何退出时，watchdog 会回收它拉起的一切——实例子进程和放弃后的崩溃页——并删除属于自己的 pidfile，然后以非零码退出；在已装 plist 的 `KeepAlive SuccessfulExit: false` 下，被杀的 watchdog 会重启整条链，而刻意的 `watchdog-stop`（exit 0）保持停机。若已有存活的 detached watchdog 持有 pidfile，`--foreground` 会等它退出再接管；等待期间若 cutover 已失败并恢复 previous，它会重新读取 `launch-spec.json` 与回执后才启动，绝不会复活等待前缓存的 target。直接 exit 0 会被当作"正常结束"、任务转 idle，另一个看门狗静默失去监督者。detached 形态（不带 `--foreground` 的 `supervise`）是调试/一次性工具——实例在自我重启前自行采用监督，或快速手动会话——不是生产监督形态，因为没有东西监督 detached watchdog 自己。

检查点/回滚闭环：

```sh
dsh-ankh-guard checkpoint --message "before batch"
# ... modify, build, test, record, verify ...
dsh-ankh-guard canary --port 3080   # fails → roll back
dsh-ankh-guard reset <checkpoint-sha>
```

`restart` 在独立于被重启实例的进程中跑完整套重启循环。它在闸门拒绝时拒绝停实例（凭证检查在重启路径本身强制，而非仅靠流程），向 `--port` 上的监听者发 SIGTERM 并等 `--stop-timeout-ms`（默认 30000——几十万 token 日志落盘的大会话可能花数十秒）优雅退出，超时才升级 SIGKILL，然后以 detached 方式启动 `--start` 命令，轮询端口直到监听，重新校验；`--rollback` 时若新实例一直起不来则硬重置到记录的检查点。升级前会打印一行带 pid 的记录——它可与 watchdog 日志里同一 pid 的 `Killed: 9` 对齐（两者在不同日志：CLI 的 stdout vs watchdog 的日志）：

```sh
dsh-ankh-guard restart \
  --port 3080 --start "DSH_HOME=$HOME/.dsh-official pnpm dsh web" --rollback \
  --state-dir "$DSH_HOME/state" --repo "$PWD"
```

以 cordis 插件挂载（base bundle）后，同一套能力以 `selfRestartGuard` 服务的形式供应用内闸门使用。配置：`maxAgeMinutes`（默认 10）、`stateDir`、`repoDir`、`reportRestartContext`（默认 `followup`）、`fallbackGraceMs`（默认 300000）。

除 verify/record/canary 等闸门外，服务还暴露 `requestRestart({ start, profile, initiator })`——UI 级调用方（如 mode-switcher）的进程内重启触发缝：`initiator` 必填（发起会话的真实 id），端口从 launch 记录自知；无活 watchdog 走 `restart`，受监督走 `reconfigure` 事务 cutover（受监督下唯一安全的换命令通道），凭证/preflight/marker/lock 全套闸门与 CLI 同源，拒绝返回结构化 `{ accepted, stage, reason }` 且绝不停机。浏览器侧，除 cutover receipt 通道外还有 boot 代际通道：普通重启或崩溃救回后，打开的标签页经 handoff 长轮询发现进程 boot id 已变，自动全页刷新一次拿到新 bundle；刷新前会等新进程的组合挂载完成（Web-server 座位与兄弟行共用，端口刚应答时 `/api` 路由 owner 可能还没挂上；Loader 结算前一律回 `waiting` 且不下发 boot id，标签页保持陈旧 id 继续问，就绪即刷）；仅前台持续失败约 5 秒后显示带重试按钮的轻量连接提示；只有确认的 cutover 使用重启遮罩。后台或离线时间不计入失败时长；回前台或恢复联网立即清除退避并重新轮询；挂起的请求在 35 秒后超时，过期响应不能触发刷新。

## Model Experience

一个随包 skill，加两条 followup 消息，无工具 schema。`dsh-self-restart-guard` skill 在 apply 时注册：完整重启协议挂在 skill catalog 上，agent 在涉及重启实例的任务里按需发现——没有逐会话的推送通知。每次 boot 都会记录注册结果（`skill-registration.json`)，在 `check-env` 的 `skill:` 行可见；无 skill 能力的组合现在会在启动日志告警——迁移或重打包把 skill 弄丢时会在这里现形，而不是无声消失。重启后，重启报告/被中断会话的续跑只到达发起会话和被中断的会话，以插件来源的 followup 用户消息形式注入；其余会话完全无感。

#### KV Cache effect

无。

## Compatibility

- npm 发布线（`@deepseek-ai/dsh@0.1.5-rc.1`）：支持——0.1.5-rc.1 全量 boot 实证通过（42 包含 capture，2026-09-25）——带两处设计内降级。composition-preflight 门禁通过独立的 `preflight-runner` 运行（0.1.5-rc.1 仍未导出 `composeProfile`，runner 改经已发布的 `@deepseek-ai/dsh-app-boot` 原语组装，带漂移绊线测试），只要能解析到 dsh app 布局——`--harness-root`、耐久 launch spec、`DSH_HARNESS` 或默认检出路径——就完整运行。没有 harness 检出的纯 npm 部署下门禁退化为提示后放行。原标签页桥会探测可选 WebServer/connection 认证 seam，不使用 token 认证的宿主自然走现有 Cookie 路径；冷读（停靠探测与 preset 推导）走 0.1.5 的 handle 制 sessionPersistence（`open(id, 'read')` → `read` → `close`，一次性 `inspect` 已移除）。其余能力在 npm 线上完整。minHost 保持 0.1.5-rc.1，旧宿主请停留在旧发布线。
- 历史验证：npm host 的 0.1.1-rc.2 → 0.1.2-alpha.4 隔离切换已通过（transition preflight 在 home 副本上移开带旧 schema record 的 v3 whole-unit projection cache，live apply 隔离旧文件，target 以零重试完成 Token URL → 303 → Cookie 200、ownership 稳定窗口与 canary；旧文件逐字节保留在 cutover 目录。相同 home 的无 transition 对照因缺少 Alpha.4 record 字段而拒绝，证明验收覆盖了真实 schema 断裂面）。
- 源码线（deepseek-harness master，fork 或上游）：✅（verifiedHost: 0.1.7-rc.2）——门禁通过独立的 `preflight-runner` 运行（从在线 checkout 解析已发布的 `@deepseek-ai/dsh-app-boot` 等），不再需要 fork 补丁。
- 双线证据：0.1.5 的 boot 经三层兼容修复端到端通过——[preset-registry 双名探测](../../.agents/notes/implemented/bug-fix/2026-09-25-preset-registry-dual-name-probe.md)、[typert codec 双形状](../../.agents/notes/implemented/bug-fix/2026-09-25-typert-codec-dual-shape.md)、[face 自带 zod@4](../../.agents/notes/implemented/bug-fix/2026-09-25-typert-faces-carry-zod-v4.md)。

**版本线对照**：0.2.0 之后的首个发布起支持宿主 `0.1.5-rc.1` 及以后；宿主 `0.1.2-rc.1` 请停留在 `0.2.0`，宿主 `0.1.0-rc.6` ~ `0.1.1-rc.2` 请停留在 0.1.x 发布线（末版 `0.1.1`）。

## Known Limitations and Deferred Work

- **闸门在 `restart`/`supervise` 里强制，launcher 里还没有**——两者在拒绝时会拒绝停实例，但绕开 guard 的手动 `kill`/启动仍可绕过；watchdog 是让被绕过的闸门可恢复的自动安全网。
- **preflight 干跑看不到 boot 时刻的世界**——它证明的是组合能 apply 并干净 dispose，而不是重启那一瞬：preflight 子进程与真实 boot 之间的环境差异、重启瞬间被占的端口、真实持久状态（数据库、boot 会迁移的会话日志）、apply 之后的时序，都在它的视野之外。watchdog 的回滚到最后已知可用版本仍是这片区域的兜底。
- **preflight 基础设施失败按设计会拦住重启**——给不出结论的子进程按"未证明"处理，而不是"大概没事"；拒绝信息里写明了手动退出路径（手动 kill 监听者，watchdog 重新拉起）。
- **SIGKILL 崩溃写不出中断会话快照**——中断会话自动继续只覆盖优雅停止（SIGTERM：计划内退出、watchdog 接管）；崩溃中断的会话仍在打开时 lazy 恢复。
- **watchdog 需要一个比实例活得久的监督者**——`supervise` 以 detached（setsid）方式拉起它；从即将死亡的进程内派生的 watchdog 必须先被孤儿化，所以应用要在退出**之前**采用监督。
- **guard 看着检出，不管还有谁在上面工作**——并发的自修改会话共享同一棵树；回滚有锚点可恢复，但没有任何机制串行化这些会话本身。
- **脏树 checkpoint 默认拒绝**——`--include-dirty` 会提交整个 staged/unstaged/untracked 路径集，只能在逐项复核、用户明确批准且仓库策略允许时使用；纯重启直接跳过 checkpoint。
- **`restart`/`supervise` 通过 `lsof` 发现监听者**（macOS / 带 lsof 的 Linux）；guard 优先使用系统绝对路径，其他平台需用 `--pid`。
- **杀进程一律按单 pid identity + 后代回收，从不按进程组**——实例不是 setsid 的，所以 `restart`、`schedule-exit` 的退出代理和 watchdog 清理都针对已记录的 child/listener；cutover 强制路径先 `SIGSTOP`，再用 Linux boot/start-tick 或 macOS `proc_pidinfo` 微秒启动时间复核 identity，不匹配就只 `SIGCONT` 并拒绝，然后才沿 `pgrep -P` 冻结、复核亲缘并回收后代。普通非 cutover 端口恢复仍有受限的 listener 清理兜底；cutover 禁止凭端口选择或杀进程。

## 测试并发

进程集成测试默认并行运行 4 个分片，unit lane 上限为 2。资源紧张时可用 `DSH_TEST_MAX_WORKERS=1 pnpm --filter @khorsheed/dsh-ankh-guard test` 串行调度全部分片；全仓 `pnpm gate` 也可使用这个环境变量。只降低调度并发，不减少测试、延长断言期限或改变生产重启行为；无效值保留默认值。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。
