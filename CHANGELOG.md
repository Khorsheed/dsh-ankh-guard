# 变更记录

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
