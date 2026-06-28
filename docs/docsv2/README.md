# docsv2：CodeZ AI Coding Agent 优化总纲

> 目的：把 `docs` 下现有能力路线、工具设计、Swarm 蓝图重新整理成一个有顺序、可执行、可验证的 v2 文档集。  
> 原则：先把当前项目已有单 Agent Coding 闭环做稳，再逐步扩展到 Rules、Skills、MCP、Swarm。  
> 使用方式：后续优化项目时，按本文档编号顺序推进；每个阶段都必须满足对应验证标准后再进入下一阶段。

## 1. 文档来源

- `docs/ai-coding-agent-evolution.md`：完整 AI Coding Agent 能力路线。
- `docs/ai-coding-agent-tools-design.md`：工具系统、搜索、读取、Patch、权限、Diff 设计。
- `docs/SWARM_ARCHITECTURE_PLAN.md`：多 Agent / Swarm 远期架构。
- 当前项目源码：`src/main/agent`、`src/main/tools`、`src/main/services/chat`、`src/main/ipc`、`src/renderer/src/stores`。

## 2. 当前项目真实基础

当前 CodeZ 已经不是“从零开始”的项目，已有基础包括：

- Agent 循环：`src/main/agent/AgentRunner.ts`
- 上下文裁剪：`src/main/agent/ContextManager.ts`
- 工具注册：`src/main/tools/ToolManager.ts`
- 工具契约：`src/main/tools/Tool.ts`
- 内置工具：`src/main/tools/builtin/*.ts`
- 多模型 Provider：`src/main/services/chat/*Provider.ts`
- Chat IPC：`src/main/ipc/chat.handlers.ts`
- 编辑事务与回滚：`src/main/services/EditTransactionService.ts`
- Renderer 会话与工具状态：`src/renderer/src/stores/chatStore.ts`
- 测试命令：`npm test`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`

因此 v2 优化不是重写，而是**在现有基础上收敛、补强、验证**。

## 3. 总体优化顺序

```text
00 当前状态确认与范围冻结
01 工具系统收敛：search / read_files / apply_patch / shell
02 编辑事务、Patch、Diff、回滚
03 AgentLoop 与 ProviderAdapter 稳定化
04 权限、安全边界、Shell 风险控制
05 验证闭环：测试、构建、诊断、自修复
06 上下文、Rules、Skills 基础能力
07 目标保持、上下文压缩、防丢失
08 UI 交互、可观测性、用户确认体验
09 MCP、插件、外部系统接入
10 Swarm 多 Agent 并发架构
11 从 Claude 运行日志学习，完善 CodeZ Agent 工具
```

## 4. 阶段推进原则

1. 每个阶段必须有明确用户需求。
2. 每个阶段必须有最终目的。
3. 每个阶段必须能验证。
4. 不跳阶段做高级能力。
5. 不因为远期 Swarm 设计影响当前单 Agent 闭环。
6. 不用 Prompt 代替 Runtime 安全控制。
7. 不引入无法验证的“看起来智能”的功能。

## 5. 第一轮建议只做哪些

第一轮建议只做：

- `01-tool-system.md`
- `02-edit-diff-rollback.md`
- `03-agent-loop-provider.md`
- `04-permission-safety.md` 的最小子集
- `05-verification-loop.md` 的最小验证闭环

暂时不做：

- 完整 MCP 管理。
- 插件市场。
- 长期向量记忆。
- Swarm 多 Agent 并发。
- 大规模 UI 重构。

## 6. 目录说明

| 文档 | 作用 |
| --- | --- |
| `00-current-state-and-scope.md` | 当前项目状态、用户需求范围、冻结项。 |
| `01-tool-system.md` | 搜索、读取、Patch、Shell 工具收敛。 |
| `02-edit-diff-rollback.md` | 编辑事务、Diff、Patch、回滚、用户已有改动保护。 |
| `03-agent-loop-provider.md` | AgentRunner、ProviderAdapter、tool loop、stop reason。 |
| `04-permission-safety.md` | 权限、审批、危险命令、安全边界。 |
| `05-verification-loop.md` | 测试、构建、typecheck、失败诊断。 |
| `06-context-rules-skills.md` | 上下文管理、Rules、Skills。 |
| `07-goal-context-resume.md` | 目标保持、上下文压缩、恢复状态、防止关键需求丢失。 |
| `08-ui-observability.md` | UI 展示、工具轨迹、日志、可观测性。 |
| `09-mcp-plugins.md` | MCP、插件、外部系统接入。 |
| `10-swarm-roadmap.md` | Swarm 多 Agent 远期架构。 |
| `11-project-analysis-and-run-audit.md` | 从 Claude 运行日志学习工具选择、上下文治理、失败恢复和审计能力，用于完善 CodeZ Agent 工具系统。 |

## 7. 全局成功标准

当 v2 阶段 1-5 完成后，CodeZ 应能稳定完成以下任务闭环：

```text
用户提出一个小功能或 bug
→ Agent 通过 search 找到相关代码
→ Agent 用 read_files 读取必要上下文
→ Agent 制定简短计划
→ Agent 用 Patch 修改代码
→ UI 展示 Diff / 文件变更
→ Agent 运行相关验证命令
→ 失败则诊断并修复
→ 成功后给出已验证总结
```

只有这个闭环稳定后，才进入 MCP、插件和 Swarm。
