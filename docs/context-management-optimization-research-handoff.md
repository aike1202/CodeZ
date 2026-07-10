# CodeZ 上下文管理优化研究交接

> 更新时间：2026-07-10  
> 状态：对标研究进行中，尚未进入代码改造阶段。

## 目标

为 CodeZ 的上下文管理功能制定优化方案，并对标 Claude Code、OpenAI Codex、Xiaomi MiMo Code、OpenCode、Aider 等项目。

## 已完成分析

已核对以下实现链路：

- 前端会话重建：`src/renderer/src/components/chat/hooks/useSendMessage.ts`
- 系统 Prompt 组装：`src/main/ipc/chat.handlers.ts`
- 主 Agent 裁剪入口：`src/main/agent/AgentRunner/index.ts`
- 核心裁剪算法：`src/main/agent/ContextManager.ts`
- UI 容量显示：`src/renderer/src/components/ContextTracker.tsx`
- ResumeState：`src/main/tools/builtin/UpdateResumeStateTool.ts`
- 子 Agent 上下文：`src/main/agent/SubAgentManager.ts`

当前方案本质是：

```text
分层 System Prompt
+ 工具输出截断
+ 按 Token/消息数删除历史
+ ResumeState 快照
```

它还不是真正的“历史摘要/上下文压缩”。

## 主要问题

1. 最近三轮被绝对保护，大消息可能完全无法裁剪。
2. 工具结果至少允许 45,000 字符，不适配 8K 等小窗口模型。
3. 一次 Agent 运行内的多轮 `assistant → tool → assistant` 被 UI 扁平化，下一轮回放顺序失真。
4. ResumeState 不保证在删除历史前保存。
5. 循环上限自动快照可能覆盖已有的高质量 ResumeState。
6. UI 与后端 Token 估算公式不同。
7. 后端预算没有计算 Tool Schema、协议开销和输出预留。
8. 固定 40 条消息兜底无法充分利用大上下文模型。
9. 子 Agent 固定按照 32K 窗口管理。
10. Renderer 和主进程存在重复 System Prompt。
11. 历史只删除，没有自动生成结构化摘要。

## 测试情况

现有两组上下文测试共 7 项均通过，但主要只覆盖工具输出截断和 ResumeState key，尚未覆盖核心轮次裁剪、近期消息超限、跨轮历史重建、小窗口、UI/后端估算一致性和 Compaction 恢复。

## 对标研究进度

三个仓库已经浅克隆到临时目录，没有改动 CodeZ 工作区：

```text
C:\Users\asus\AppData\Local\Temp\codez-context-research-20260710\codex
C:\Users\asus\AppData\Local\Temp\codez-context-research-20260710\claude-code
C:\Users\asus\AppData\Local\Temp\codez-context-research-20260710\mimo-code
```

### OpenAI Codex

- 仓库包含完整 Rust 源码和明确的 context、compaction、thread history 逻辑。
- 官方 App Server 提供 `thread/compact/start`。
- Compaction 被建模为正式的 `contextCompaction` 线程事件，而不是请求前临时删除消息。
- 根级 `AGENTS.md` 明确要求上下文增量构建，避免任意重写历史。
- 下一步阅读 compact、rollout persistence、Token 预算和事件生命周期源码。

### Claude Code

- 仓库已经克隆，但尚未确认核心运行源码的公开范围。
- 如果核心实现未开源，只引用官方文档和可验证行为，不把行为推断当成源码事实。
- 后续重点分析 `/compact`、自动压缩、`CLAUDE.md`、SubAgent 隔离和工具结果清理。

### Xiaomi MiMo Code

- 仓库包含 `packages/opencode`，很可能基于或深度复用了 OpenCode 架构。
- 后续重点分析 Session、Compaction、Token accounting、Tool output pruning、Summary generation，以及与上游 OpenCode 的差异。

Codex 手册抓取脚本因服务端缺少 `x-content-sha256` 校验头失败，后续已切换到官方 OpenAI Docs MCP。

## 当前计划状态

```text
✓ 核对当前实现与约束
→ 确认对标项目资料边界
□ 研究各项目上下文策略
□ 比较方案并给出推荐
□ 提交架构设计供确认
□ 写入并自审设计文档
□ 生成详细实施计划
```

## 下一会话任务

1. 深入阅读 Codex 的 compaction、history、rollout 和 Token budget 源码。
2. 阅读 MiMo Code `packages/opencode` 中的 Session 与 Compaction 实现。
3. 核实 Claude Code 公开源码范围并阅读官方压缩文档。
4. 补充 `anomalyco/opencode` 和 `Aider-AI/aider` 作为对标。
5. 输出五个项目的上下文管理对比表。
6. 提出 2～3 种 CodeZ 目标架构并给出推荐。
7. 方案确认后生成详细实施计划。

## 初步优化方向

### 1. 规范化消息账本

- 模型消息与 UI 聚合消息分离。
- 持久化真实的 `assistant → tool → assistant` 顺序。
- 保留完整展示历史，同时为模型构建压缩视图。

### 2. 统一 Token 预算

- 前端、主 Agent、子 Agent 使用同一估算服务。
- 预算包含 System Prompt、Tool Schema、消息、协议开销和输出预留。
- 工具负责分页和局部截断，ContextManager 负责全局安全边界。
- 取消固定 40 条消息限制。

### 3. 正式 Compaction 机制

- 将 Compaction 建模为可持久化事件。
- 压缩前生成结构化摘要，而不是先删除再通知模型。
- 摘要保存目标、计划、事实、决策、文件、证据、阻塞和验证状态。
- ResumeState 采用版本化合并，防止低质量自动快照覆盖高质量状态。
- 压缩后重新读取活跃文件，不依赖被删除的文件内容记忆。

## 工作区说明

- 本阶段尚未修改上下文管理源码。
- 仓库已有未提交改动属于其他工作，后续实现必须保留并避开。
- 本文档是当前研究进度和新会话的交接入口。
