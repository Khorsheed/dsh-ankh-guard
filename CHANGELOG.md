# 变更记录

## 0.2.0（2026-09-10）

- **BREAKING**：minHost 前移至 `0.1.2-rc.1`；宿主 `0.1.0-rc.6` ~ `0.1.1-rc.2` 的用户请停留在 0.1.x 线（末版 `0.1.1`）
- 新增进程内 `requestRestart` 触发缝与 boot 代际浏览器刷新通道：应用内服务可直接驱动受门禁约束的重启，重启后按 boot 代际刷新已登记标签页
- preflight 快照跳过运行时条目：socket/FIFO（含指向它们的符号链接）不再导致 `reconfigure` 拒绝；顶层 `scratch/` 目录从 home 复制中排除；复制耗时超过凭证窗口一半时提前警告
- 适配宿主 0.1.2 线：dev/peer 依赖面迁移到 0.1.2 API（`@deepseek-ai/dsh-skill` 归位 0.1.2 范围），`dsh.compat` 地板同步前移
- preflight 执行面成为 launch spec 的显式契约：持久化 source/built、runner 可执行方式/路径/内容 SHA、实际 dsh 安装锚点与 target command SHA；`reconfigure` 在隔离 home 先运行与该 SHA 绑定的一等 candidate command probe，再用同一 source/npm-built 模块面做 composition preflight，不再从 `process.execArgv` 猜测或误读 checkout source
- candidate probe 是调用方提供并与 target command 摘要共同绑定的信任边界；Guard 不声称能从任意 shell command 自动证明 argv 同源，随包 Skill 负责按同一 DSH executable/launcher argv 生成 `--dump-config` probe
- preflight snapshot 复制物理节点并把 pnpm/Cordis 链接图重建到副本内，保留合法依赖循环；外部 target 在哈希命名区域按 canonical path 去重物化，链接逐条审计确保可写解析结果不逃出 snapshot。经内部/外部链接写入不会触达原字节，悬空/不可解析链接、特殊文件、可写逃逸或复制失败均在运行 candidate、创建 cutover、停止 previous 前 fail closed
- cutover 回执把 target 的 readiness/canary 保留在 `targetValidation`，previous 恢复验证单列在 `recovery.validation`；只有 target-scoped credential 时明确记录 recovery canary skipped 并继续要求稳定 ownership，不再把 target canary fail 与 restored/previous readiness 混成一个字段
- `reconfigure --transition-file` 新增版本无关的可逆状态隔离：在 copy-on-write 优先的 live-home 副本上完成 target preflight，previous 停止后才按哈希绑定计划原子 quarantine；target 失败时先保留其替代内容、恢复 previous 原字节再启动旧宿主，任何无法证明的回滚都会停机等待用户
- 重启凭证改为执行证据：CLI `record` 默认拒绝自我声明，`--run -- PROGRAM ...` 以原样 argv 执行并只在 exit 0、HEAD 不变且工作树全净时记录；任何 staged/unstaged/untracked 输入都会让 verify/restart/canary 拒绝
- checkpoint 在干净树上直接记录现有 HEAD，不再造空提交；脏树默认拒绝，复核后显式 `--include-dirty` 才用临时 index 提交完整快照，hook/commit 失败不污染调用者 staging area
- `schedule-exit` 无存活 watchdog 时从警告升级为硬拒绝；稳定态从耐久 active launch spec 取 repo/harness/profile/port，并拒绝冲突参数或过期 supervisor command，防止复活已拒绝的启动配置
- detached `supervise` 等到 watchdog 已持久化 pidfile claim 才返回成功，关闭“刚 supervise 就 schedule-exit”竞态；输出区分 `exit-agent pid`，watchdog 生命周期日志带时间戳
- 新增通用启动配置事务切换：`configure-launch`/`reconfigure` 持久化并原子选择 previous/target 完整 launch spec，分别记录 credential/rollback repo 与宿主 `harnessRoot`；资料不足时拒绝从旧 command record 或目标 repo 伪造 previous
- launchd/systemd 前台等待者在 successor 退出后重新读取耐久 launch state 与回执；target 失败恢复 previous 后，外层 supervisor 不会复活等待前缓存的 target
- watchdog 就绪探针区分 transport-up 与 ready：裸 401 不再健康；最终进程输出的同 authority 启动 URL 必须完成临时 Cookie jar 的 303 交换和认证后 `/` 200；通过 ownership 稳定窗口和 canary 后才开始浏览器交接。客户端改用 Cordis Context + 空 inject 兼容 rc.2/Alpha.4，并以持有式长轮询登记和恢复所有仍响应的标签页；现有 Cookie 刷新或 `location.replace()` 一次性 URL 交换后恢复不带 query/fragment 的原 pathname，仅在原页缺失/超时时 system-open 兜底。一个真实页面 ACK 解除终态门禁，其他慢标签页在状态压缩后仍可恢复；opener 成功不等同接管成功，Bearer URL 与原始 capability 不进入耐久状态、日志或回执
- 新增脱敏耐久回执 `launch-cutover.json`，记录 supervisor/child PID、配置摘要、认证、重试、canary 与恢复结果；会话仅在回执终态后唤醒
- 修复嵌套 watchdog 接管的进程所有权漏洞：`reconfigure` 在旧宿主仍存活时固化 supervisor、直接 child 与 listener 的 PID/start identity；successor 对旧 supervisor 做可消费控制请求的有界等待，超时只终止先冻结再复核的精确 identity，并冻结/复核后代亲缘后回收，拒绝按端口误杀或把旧 listener 的 HTTP 200 当成 target ready
- cutover 就绪现在同时要求目标 child 存活、唯一 listener 属于该 child 树、child/listener identity 在稳定窗口内不变且 retry 为 0；目标在 provisional ready 后退出、`EADDRINUSE` 或旧 listener 持续 200 都会计入失败并执行完整 spec 恢复策略
- 进程发现优先使用 `/usr/sbin/lsof`、`/usr/bin/lsof` 等绝对路径，不依赖 dsh 工具环境的 PATH；Linux identity 使用 boot/start tick，macOS 优先使用 `proc_pidinfo` 微秒启动时间；新增耐久 `abort-cutover` 与显式 `restore-previous` 控制命令，独立原子 marker 保证并发时 restore 单调优先，回执记录 ownership、稳定性证明、分角色失败计数与控制结果

## 0.1.1（2026-08-23）

- 修复：schedule-exit 与 restart 的竞态——schedule-exit 现在全程持 restart.lock（读→写→拉起），不再误杀并发重启刚拉起的新实例
- 修复：随包 skill 在目录里可见、调用即炸——宿主在 load 时才校验注册的 `source` 字段，之前没传；已补 `source: 'runtime'`，并加了真实 SkillRegistry 往返测试（list + load）防回归

## 0.1.0（2026-08-22）

首个公开发布。

- 重启凭证闸门：构建与测试全绿后记录凭证，绑定当时的 git HEAD 并带有效期，重启前逐条校验，改坏的代码在造成伤害之前被拦下
- preflight 组合闸门：重启前在子进程里对完整 profile 组合做深度干跑，组合起不来就绝不停止运行中的实例
- watchdog 托管重启：实例退出自动拉起，连续启动失败回滚到最后已知可用版本，每次回滚留下恢复锚点
- checkpoint/reset：批次前把整个工作树提交为回滚点，可硬重置恢复
- 重启后金丝雀自动复检，被重启中断的会话自动恢复续跑
- 完整 CLI（verify / record / preflight / restart / supervise 等），实例宕机时也可用
