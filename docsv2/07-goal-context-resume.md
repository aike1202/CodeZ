# 07 目标保持、上下文压缩与关键信息防丢失

## 1. 用户需求

用户明确担心：随着上下文压缩、长任务、多轮开发、文档拆分和后续代码优化推进，Agent 会丢失最初目标、关键需求和阶段性决策。

因此 CodeZ v2 必须具备一套“防遗忘机制”：

- 长任务中不丢目标。
- 上下文压缩后不丢关键决策。
- 多轮“继续”后能恢复当前阶段。
- 子 Agent / Swarm 不丢任务边界。
- 验证失败、阻塞、用户确认项能保留下来。
- 编码前能重新加载需求与验收标准。

## 2. 分析资料中的关键观察

来自 `分析/Codex.txt`、`分析/Claude.txt`、`分析/CodeZ02.txt` 的可吸收要点：

### 2.1 Codex 部分

Codex 强调：

- 非简单任务必须有 `update_plan`。
- 计划必须随进度更新，只能有一个 `in_progress`。
- 完成步骤要及时标记，避免上下文长了以后状态失真。
- 子 Agent 必须有明确任务边界和文件所有权。
- 不要重复做已委派的工作。
- 多 Agent 结果需要主 Agent 汇总。
- shell / PowerShell 的平台差异会导致验证失败，例如 Windows PowerShell 执行 `npm.ps1` 被策略阻止。

这说明 CodeZ 需要把“计划”和“当前阶段”持久化，而不是只依赖模型上下文。

### 2.2 Claude 部分

Claude 工具体系强调：

- `TaskCreate` / `TaskUpdate` 可用于长期任务状态追踪。
- `EnterPlanMode` / `ExitPlanMode` 用于非平凡实现前的方案确认。
- `ScheduleWakeup` / loop 需要携带原始 prompt，避免恢复时不知道继续什么。
- Workflow 支持 resume，但要求脚本和参数稳定。
- 子 Agent 的结果不可盲信，主 Agent 需要核验和整合。
- Context compaction / memory / task list 是不同层级的持久化。

这说明 CodeZ 需要区分：

```text
当前上下文 ≠ 长期目标
模型记忆 ≠ 项目状态
压缩摘要 ≠ 可执行计划
```

### 2.3 CodeZ 当前暴露工具部分

`CodeZ02.txt` 显示当前项目已经有：

- `get_project_snapshot`
- `read_files`
- `search_code`
- `get_symbol_map`
- `rollback_last_edit`
- `write_to_file`
- `replace_file_content`
- `run_command`
- `fast_context`

但这些工具主要解决“读取/修改/运行”，还没有解决：

- 当前目标是什么。
- 当前阶段是什么。
- 哪些需求已经确认。
- 哪些决策不能丢。
- 压缩后如何恢复。
- 后续优化项目时从哪里继续。

## 3. 最终目的

建立“目标保持层”：

```text
User Goal
→ Goal Snapshot
→ Requirement Ledger
→ Decision Log
→ Task Plan
→ Verification Ledger
→ Context Summary
→ Resume Prompt
```

即使对话被压缩、Agent 中断、重启、进入下一天，也能通过这些结构恢复：

- 用户最初要什么。
- 当前已经决定了什么。
- 当前做到哪一步。
- 下一步应该做什么。
- 哪些验证必须跑。
- 哪些不能做。

## 4. 核心数据模型

### 4.1 GoalSnapshot

保存任务总目标。

```ts
type GoalSnapshot = {
  id: string
  title: string
  originalUserRequest: string
  normalizedGoal: string
  nonGoals: string[]
  successCriteria: string[]
  createdAt: string
  updatedAt: string
}
```

必须包含：

- 原始用户需求。
- 归一化后的目标。
- 明确不做什么。
- 成功标准。

### 4.2 RequirementLedger

保存已确认需求。

```ts
type RequirementLedger = {
  functional: RequirementItem[]
  nonFunctional: RequirementItem[]
  constraints: RequirementItem[]
}

type RequirementItem = {
  id: string
  text: string
  source: 'user' | 'docs' | 'analysis' | 'code' | 'decision'
  status: 'proposed' | 'confirmed' | 'implemented' | 'verified' | 'deferred'
  verification?: string
}
```

### 4.3 DecisionLog

保存关键决策。

```ts
type DecisionLogEntry = {
  id: string
  decision: string
  why: string
  alternatives?: string[]
  appliesTo: string[]
  status: 'active' | 'superseded'
  createdAt: string
}
```

示例：

```text
决策：第一轮不做 Swarm。
原因：单 Agent 工具、权限、验证闭环未稳定前，多 Agent 会放大错误。
适用：阶段 1-7。
```

### 4.4 TaskPlan

保存当前阶段计划。

```ts
type TaskPlan = {
  steps: Array<{
    id: string
    title: string
    status: 'pending' | 'in_progress' | 'completed' | 'blocked'
    dependsOn?: string[]
    validation?: string[]
  }>
  currentStepId?: string
}
```

规则：

- 同一时间只能一个 `in_progress`。
- 进入下一步前必须标记上一项完成或阻塞。
- 阻塞必须写明原因。

### 4.5 VerificationLedger

保存验证义务和结果。

```ts
type VerificationLedger = {
  required: Array<{
    id: string
    command: string
    reason: string
    status: 'pending' | 'passed' | 'failed' | 'skipped'
    lastOutputSummary?: string
  }>
}
```

### 4.6 ResumeState

用于上下文压缩后恢复。

```ts
type ResumeState = {
  currentGoalId: string
  currentPhase: string
  currentStep: string
  lastCompletedStep?: string
  nextAction: string
  openQuestions: string[]
  blockedBy: string[]
  filesTouched: string[]
  filesToInspectNext: string[]
  validationPending: string[]
}
```

## 5. 存储位置建议

### 5.1 当前项目开发状态

建议保存在：

```text
.continue/index.md
.continue/current/<task>-requirements.md
.continue/current/<task>-plan.md
.continue/current/<task>-state.json
```

原因：项目里已经出现 `.continue/current` 和 `.continue/archive` 工作流痕迹，适合承载“继续开发”状态。

### 5.2 Agent 内部运行状态

可保存在：

```text
.codez-cache/runs/<runId>/goal.json
.codez-cache/runs/<runId>/plan.json
.codez-cache/runs/<runId>/decisions.json
.codez-cache/runs/<runId>/verification.json
```

注意：缓存目录不一定提交 Git，只用于运行恢复。

### 5.3 文档化长期路线

保存在：

```text
docsv2/
```

即当前目录，用于用户确认和后续实现依据。

## 6. 上下文压缩策略

### 6.1 压缩前必须提取

当上下文接近裁剪/压缩阈值时，必须先生成结构化摘要：

```text
1. 当前总目标
2. 当前阶段
3. 已确认需求
4. 已完成步骤
5. 当前 in_progress 步骤
6. 尚未完成步骤
7. 关键决策
8. 修改过的文件
9. 待验证命令
10. 阻塞项 / 用户待确认项
```

### 6.2 压缩摘要不得只写自然语言

不要只生成：

```text
我们正在优化 Agent，已做了一些文档。
```

必须结构化：

```json
{
  "goal": "整理 docsv2 并作为后续 CodeZ 优化依据",
  "phase": "需求整理",
  "currentStep": "补充上下文压缩防丢失机制",
  "decisions": ["第一轮不做 Swarm", "先做单 Agent 闭环"],
  "pendingValidation": ["检查 docsv2 完整性", "用户确认后再改源码"]
}
```

### 6.3 恢复时必须先读 ResumeState

长任务恢复流程：

```text
用户说“继续”
→ 读取 .continue/index.md
→ 读取 current task state
→ 读取 docsv2 对应阶段
→ 恢复 plan
→ 明确下一步
→ 再开始工具调用或代码修改
```

## 7. 与现有阶段的关系

本阶段应插入到 `06-context-rules-skills.md` 之后、`07-ui-observability.md` 之前。

原因：

- 它依赖 ContextManager。
- 它影响 UI 展示当前目标和任务状态。
- 它是 Swarm 的前置条件。

更新后的顺序：

```text
00 当前状态确认与范围冻结
01 工具系统收敛
02 编辑事务、Patch、Diff、回滚
03 AgentLoop 与 ProviderAdapter
04 权限与安全
05 验证闭环
06 上下文、Rules、Skills
07 目标保持、上下文压缩、防丢失
08 UI 交互与可观测性
09 MCP、插件
10 Swarm 多 Agent
```

## 8. 实施顺序

1. 新增 `GoalSnapshot`、`RequirementLedger`、`DecisionLog`、`TaskPlan`、`VerificationLedger` 类型。
2. 在任务开始时生成 GoalSnapshot。
3. 在用户确认需求后写 RequirementLedger。
4. 每次关键选择写 DecisionLog。
5. 每次计划变化写 TaskPlan。
6. 每次运行验证写 VerificationLedger。
7. ContextManager 裁剪前生成 ResumeState。
8. 用户说“继续”时优先恢复 ResumeState。
9. UI 显示当前目标、当前阶段、下一步、待验证项。
10. Swarm 阶段复用这些结构给 Manager / Coder / QA。

## 9. 验证方式

### 9.1 单元验证

- 创建任务时生成 GoalSnapshot。
- 更新计划时最多一个 `in_progress`。
- 阻塞步骤必须带 reason。
- 关键决策能追加到 DecisionLog。
- 验证命令结果能写入 VerificationLedger。
- ContextManager 触发裁剪前能输出 ResumeState。

### 9.2 行为验证

场景：

```text
用户要求整理 docsv2，做一半后上下文被压缩，然后用户说“继续”。
```

期望：

1. Agent 读取 ResumeState。
2. Agent 知道当前目标是整理 docsv2，不是开始改源码。
3. Agent 知道第一轮不做 Swarm。
4. Agent 知道当前阶段是需求整理。
5. Agent 知道下一步是补缺或等待用户确认。

### 9.3 回归验证

- 修改源码后压缩上下文，再恢复，不能忘记待运行 `npm test` / `npm run typecheck`。
- 用户拒绝某个范围后压缩上下文，再恢复，不能重新提出该范围。
- 子 Agent 完成后压缩上下文，再恢复，主 Agent 仍知道哪些结果已合并、哪些未核验。

### 9.4 命令验证

- `npm test`
- `npm run typecheck`

## 10. 完成标准

- 上下文压缩不再只依赖自然语言摘要。
- 用户说“继续”时能恢复目标、阶段、计划和验证状态。
- 后续优化项目不会因为长对话丢失最初目标。
- Swarm 多 Agent 可以复用同一套任务状态和决策日志。
