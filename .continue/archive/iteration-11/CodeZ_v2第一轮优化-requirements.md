# 📋 需求文档 - CodeZ_v2第一轮优化

> 迭代：iteration-4
> 创建时间：2026-06-28 14:45
> 最后更新：2026-06-28 14:45
> 存放位置：.continue/current/CodeZ_v2第一轮优化-requirements.md

## 需求概述

**一句话描述**：基于 `docsv2` 规划，完成 CodeZ 的单 Agent 闭环（工具收敛、编辑事务、循环稳定、权限控制、验证闭环、目标防丢机制等）重构与优化。

**业务背景**：随着项目不断迭代，当前的工具系统心智不够收敛、缺少结构化 Diff 主路径、权限边界模糊、验证机制脱节，导致模型表现不稳定、上下文容易丢失。因此需要将原先零散的工具、状态机和上下文管理统一升级，夯实单 Agent 核心能力，为后续接入多 Agent (Swarm) 和 MCP 打下坚实基础。

**预期价值**：使 Agent 可以通过统一的 Patch/Diff 进行精准修改并支持用户审查；提供结构化结果与明确的审批流控制；保障任务过程不丢失目标和关键决策；整体提高编码执行稳定性和代码安全。

## 功能需求

### 核心功能（必须实现）

- [ ] **F1**: 工具系统收敛与重构
  - 核心：提供最小稳定工具集 `search`, `read_files`, `apply_patch`, `shell`，替代原有的零散文件访问与终端命令拼凑方式，规范化输入输出结构。
- [ ] **F2**: 编辑事务、Patch 与回滚防线
  - 核心：推行 Patch 主路径修改代码，生成文件级结构化 Diff，支持 stale hash 校验，并提供用户 UI 界面的 `Accept/Reject` 审批入口。
- [ ] **F3**: AgentLoop 与 ProviderAdapter 稳定化
  - 核心：统一个 Provider 事件/停止原因，对工具的执行失败、截断等提供标准化 observation，实现错误重试与长轮次保护。
- [ ] **F4**: 权限与安全边界控制
  - 核心：增加 `PermissionManager`，区分高低风险命令（allow/ask/deny），确保无法越权向工作空间外写入文件或执行危险 Shell。
- [ ] **F5**: 验证闭环与自我修复
  - 核心：执行修改后自动结合变更文件推荐并运行验证命令（如 test / typecheck），诊断报错并支持自我修复。
- [ ] **F6**: 上下文与目标防丢失机制
  - 核心：维护 `GoalSnapshot`、`RequirementLedger`、`DecisionLog`、`TaskPlan` 与 `ResumeState`，确保压缩或中断后能恢复当前任务进度。
- [ ] **F7**: UI 可观测性增强
  - 核心：通过 IPC 为前端提供 AgentRunState 以及包含工具日志、审批、Diff 的详细时间线与 Audit Log。

### 扩展功能（可选实现）

- [ ] **E1**: 基于上下文规则拦截 Prompt Injection 内容

## 非功能需求

### 兼容性要求
- 保留现有的 API 设计并允许老插件向下兼容（如无直接冲突）。
- Shell 执行要兼顾 Windows PowerShell 与 `npm.cmd` 等跨平台执行差异。

### 安全要求
- 任何越界写操作与破坏性命令需强制申请用户审批，杜绝静默破坏。

## 约束条件

### 技术栈限制
- 遵循原有的 Node.js + Electron (主进程与渲染进程) 架构，保留 IPC 通信模式。

### 其他约束
- **阶段限制**：本轮**绝对不包含** Swarm（多 Agent 调度）或插件生态的实现，它们需推迟到单 Agent 闭环稳定之后。
- **保护现有改动**：不能破坏用户尚未提交的已有源码文件状态。

## 验收标准

### 功能验收
- [ ] **AC1**: 工具心智收敛，模型优先选择 `apply_patch` 和 `search`/`read_files` 组合，而非 Bash 调用。
- [ ] **AC2**: 当系统进行文件修改时，用户界面可以直观看到 Diff 面板并具有 Reject 拦截能力。
- [ ] **AC3**: 调用 `npm install` 或其他危险系统指令时，会被拦截且请求 UI 卡片审批。
- [ ] **AC4**: 更改源码且测试失败时，Agent 能获取报错信息并自我反思修复，不再谎称完成。
- [ ] **AC5**: 长任务中断恢复后（上下文缩减），Agent 仍能明确自己当前的 Goal 与处于何种开发阶段。

## 相关资源

### 参考文档
- [00-current-state-and-scope.md](file:///f:/MyProjectF/CodeZ/docsv2/00-current-state-and-scope.md)
- [01-tool-system.md](file:///f:/MyProjectF/CodeZ/docsv2/01-tool-system.md)
- [02-edit-diff-rollback.md](file:///f:/MyProjectF/CodeZ/docsv2/02-edit-diff-rollback.md)
- [03-agent-loop-provider.md](file:///f:/MyProjectF/CodeZ/docsv2/03-agent-loop-provider.md)
- [04-permission-safety.md](file:///f:/MyProjectF/CodeZ/docsv2/04-permission-safety.md)
- [05-verification-loop.md](file:///f:/MyProjectF/CodeZ/docsv2/05-verification-loop.md)
- [06-context-rules-skills.md](file:///f:/MyProjectF/CodeZ/docsv2/06-context-rules-skills.md)
- [07-goal-context-resume.md](file:///f:/MyProjectF/CodeZ/docsv2/07-goal-context-resume.md)
- [08-ui-observability.md](file:///f:/MyProjectF/CodeZ/docsv2/08-ui-observability.md)

## 需求澄清记录

| 问题 | 回答 | 确认时间 |
|------|------|----------|
| 是否需要拆分为多个迭代？ | docsv2 是作为一个整包需求，当前作为一个整体 iteration 处理，若过程中过于庞大再在计划中进一步分片。 | 2026-06-28 |
