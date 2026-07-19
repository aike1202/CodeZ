# 层级多智能体编排：人工测试与人工介入记录

> 创建日期：2026-07-19
> 对应设计：`2026-07-18-hierarchical-multi-agent-orchestration-feasibility-report.md`
> 用途：只记录无法通过确定性自动测试充分证明的真实场景，以及重复尝试后仍需人工介入的问题。

## 记录规则

- 能用 Fake Provider、虚拟时钟、临时 Git 仓库或故障注入稳定验证的行为，写自动测试，不放入本清单。
- 依赖真实 Provider 账户、真实限流、操作系统窗口交互、视觉流畅度或跨进程崩溃时机的场景，放入人工测试。
- 同一问题连续多次尝试仍无法解决时，在“人工介入问题”中记录尝试、证据、当前影响和建议恢复入口。
- 每项人工测试保留明确前置条件、操作、预期、证据和结果，不能只写“看起来正常”。

## 人工测试清单

当前暂无已到执行阶段的人工测试项。实现过程中持续补充。

## 人工介入问题

当前无。

## 自动验证边界

以下能力必须优先由自动测试证明，不得因并发场景复杂而降级为人工测试：

- spawn 幂等、状态 CAS、终态竞争和事件 revision 单调性。
- 调度并发上限、公平性、等待释放 Provider permit 和 missed wakeup 防线。
- 邮箱持久化、cursor 重放、ack 幂等、ACL 和大消息 artifact 投影。
- scope/permission 交集、最大深度、fan-out、root 总量和预算预留。
- stale writer 冲突、worktree fail-closed、固定基线和 merge 冲突不污染主工作区。
- 崩溃恢复状态判定、危险外部 effect 不盲目重放和残留进程归属。
- UI 事件按 `agent_id + attempt_id + sequence` 路由、去重以及旧 revision 丢弃。
