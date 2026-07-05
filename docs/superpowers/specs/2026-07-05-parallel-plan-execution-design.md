---
name: parallel-plan-execution-design
description: "Plan 驱动的并行 SubAgent 执行设计 —— 批准的 Plan 由只读 ExecutionPlanner 分析步骤依赖并分波,编排协调器组内并行 / 组间串行执行 Worker,支持共享目录与 worktree 两档隔离,失败即停并交主 Agent 决策。"
metadata:
  type: project
---

# Plan 驱动的并行 SubAgent 执行设计

**日期:** 2026-07-05
**状态:** 设计(待批准)
**范围:** 在现有 `SubAgentManager` 框架上,新增"Plan 批准后并行执行其步骤"的能力。一个只读的 `ExecutionPlanner` 分析 Plan 步骤依赖并输出分波方案;编排协调器按组顺序执行,组内多个 `Worker` 并行改代码(可选 worktree 隔离);每组跑完把汇总结果交回主 Agent 决策是否推进。

---

## 动机

### 现状

CodeZ 已有 `SubAgentManager` 框架,支持 `Research`(只读)与 `Plan` 两种子智能体,通过 `Task` 工具委派。关键事实:

- `SubAgentManager.spawn` 是**阻塞式**的(调用后等到子智能体结束才返回)。
- `AgentRunner` 主循环里,**同一轮**的多个工具调用已用 `Promise.all` 并发执行(`AgentRunner/index.ts:306`)——所以底层并发能力已存在,但**没有任何编排、依赖管理、冲突避免**。
- `PlanStep` 已带 `files?: string[]` 字段(每个步骤声明涉及文件)——这是冲突分组的天然依据。
- `SubAgentDefinition.isolation?: 'none' | 'worktree'` 字段存在,但 spawn 时**从未读取**(死字段)。
- `2026-07-01-worktree-service-design.md` 设计过 `WorktreeService`,但**从未落地**(只有文档无代码)。
- `SubAgentManager.spawn` 执行工具时(`SubAgentManager.ts:516-545`)**完全绕过** `PermissionManager` —— 对只读子智能体无碍,但可写 Worker 必须补这个 gap。

### 目标

用户在 Plan 批准(`executing`)后,手动触发并行执行:先由只读 planner 分析依赖并给出"分波 + 隔离建议",用户确认(可改隔离档)后,编排协调器按波执行——组内并行、组间串行,每波跑完汇总交主 Agent 决策。

### 参考:Claude Code 的做法

来自 `ClaudeCodelogs/` 的分析,Claude Code 把多智能体并行分两层:

1. **轻量并行** —— 靠系统提示词引导模型"在同一条回复里发多个 `Agent` 工具调用",harness 并发执行。并行是**行为习惯**而非独立功能。并行写的隔离答案是 `isolation: "worktree"`。
2. **重度确定性编排** —— `Workflow` 工具(JS 脚本,`parallel` 屏障 / `pipeline` 流水线),需用户显式 opt-in。官方倾向 `pipeline` 而非屏障,因为屏障浪费快任务的等待时间。

**本设计的差异与理由:**
- Claude 无独立"分组器";本设计做独立的 `ExecutionPlanner` SubAgent —— 因为 CodeZ 是 GUI 产品,分组方案**可视化、可审查、可修改**是加分项。
- Claude 倾向 `pipeline`;本设计用 **wave(组间串行屏障)** —— 因为"每组跑完汇总给主 Agent 决策"这个失败模型**本来就需要屏障**(要等整波完成才能决策),pipeline 不适用。
- Claude 面对并行写只信 worktree;本设计提供 **shared(默认)+ worktree(可选)** 两档,安全性有梯度。

---

## 1. 总体架构与数据流

```
用户点「并行执行」(Plan 已 executing)
        │
        ▼
  先 spawn ExecutionPlanner(只读,快)
        │  读 Plan → LLM 分析依赖 → 返回 { waves, isolation 建议, rationale }
        ▼
  弹确认框(带 planner 建议,隔离档用户可改)
        │  用户确认最终 isolation
        ▼
┌─────────────────────────────────────────────────────┐
│  编排协调器 parallelOrchestrator                       │
│                                                       │
│  1. 冲突校验兜底:同波 steps 的 files 交集必须为空      │
│       shared 档 → 交集非空则硬拒绝                      │
│       worktree 档 → 交集非空仅警告(物理隔离已兜底)     │
│                                                       │
│  2. 按 wave 顺序循环(组间串行):                       │
│       for wave in waves:                              │
│         [worktree档] 为每个 step 建 worktree            │
│         await Promise.all(                            │
│           wave.stepIds.map(spawn Worker)              │  ← 组内并行(并发闸)
│         )                                             │
│         [worktree档] 波末统一 merge 成功 step 回主区    │
│         写回 PlanStore 步骤状态 + 广播前端              │
│         if 有失败 → status=halted, break               │  ← 失败即停
│                                                       │
│  3. 返回 ParallelExecutionReport 给主 Agent           │
└─────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
  ExecutionPlanner(只读)     Worker × N(可写)
  = 新 SubAgent 定义          = 新 SubAgent 定义
                             读写工具 + submit_result
                             可选跑在 worktree 里
```

### 决策映射

| 决策 | 落到哪个组件 |
|------|-------------|
| LLM 分析依赖分组 | `ExecutionPlanner` SubAgent(只读,独立上下文,不占主 Agent) |
| LLM 给出组序列(组内并行/组间串行) | `waves[].index` 字段 + 编排协调器 for 循环 |
| 并行写 | `Worker` SubAgent(读写工具) |
| 共享目录 + 校验兜底 | 编排协调器冲突校验(shared 档硬拒绝) |
| worktree 可选隔离档 | `isolation` 字段生效 + 新建 `WorktreeService` |
| 每组跑完汇总给主 Agent 决策 | for 循环每波结束的"汇总 + 失败停止" |
| Plan 批准后手动触发 | 前端「并行执行」按钮 → 主 Agent 调 `ExecutePlanParallel` |
| planner 建议 + 用户可改隔离档 | planner 提前到确认框弹出前,建议展示在确认框,用户可改 |

---

## 2. 编排协调器 & 数据结构

### 2.1 数据结构

ExecutionPlanner 的结构化输出:

```typescript
interface ExecutionGroupingResult {
  /** 波次数组,按执行顺序排列 */
  waves: ExecutionWave[]
  /** 隔离建议:planner 根据步骤是否触碰共享文件给出 */
  isolation: 'shared' | 'worktree'
  /** 分组理由,一句话,展示给用户 */
  rationale: string
}

interface ExecutionWave {
  /** 波次序号,从 0 递增 */
  index: number
  /** 本波并行执行的步骤 ID(引用 PlanStep.id,如 ['p1','p2']) */
  stepIds: string[]
}
```

编排协调器聚合后返回主 Agent 的报告:

```typescript
interface ParallelExecutionReport {
  planSlug: string
  status: 'completed' | 'halted'   // halted = 某波有失败,已停在该波
  waves: WaveReport[]
  /** halted 时:哪一波、哪些步骤失败 */
  haltedAt?: { waveIndex: number; failedStepIds: string[] }
}

interface WaveReport {
  waveIndex: number
  results: StepResult[]
}

interface StepResult {
  stepId: string
  status: 'completed' | 'failed'
  summary: string                          // Worker 的 submit_result 摘要
  filesModified: string[]
  qualitySummary?: SubAgentQualitySummary
  error?: string
}
```

**单一数据源:** `ExecutionWave` 只引用 `stepId`,不复制步骤内容。Worker 执行时从 PlanStore 读完整步骤(title/description/files)。

### 2.2 编排流程

```
orchestrate(planSlug, groupingResult, isolation, permissionScope):
  1. 冲突校验(兜底守卫)
     for each wave:
       收集 wave 内所有 step 的 PlanStep.files
       if 任意两 step 的 files 交集非空:
         shared 档   → 抛错返回主 Agent(拒绝该分组)
         worktree 档 → 记录警告,继续

  2. 按 wave.index 顺序循环(组间串行):
     for wave in waves:
       - 标记本波 steps 为 in_progress(写回 PlanStore + 广播 PARALLEL_WAVE_UPDATE)
       - [worktree] 为每个 step 建 worktree,Worker 的 workspaceRoot 指向各自 worktree
       - const results = await runWithConcurrencyLimit(
           wave.stepIds.map(stepId => () => spawnWorker(stepId, ...)),
           limit = min(6, cpuCount - 1)
         )                                          ← 组内并行 + 并发闸
       - [worktree] 波末统一 merge 成功 step 回主区(见 §4.2)
       - 写回步骤 completed/failed 状态
       - if results 有 failed:
           status = 'halted'; haltedAt = { waveIndex, failedStepIds }; break
       else 继续下一波

  3. 返回 ParallelExecutionReport 给主 Agent
```

### 2.3 关键决策

**两级冲突校验:**

| 隔离档 | files 交集非空时 |
|--------|-----------------|
| `shared`(默认) | **硬拒绝** —— 共享目录下真会改坏,返回错误让主 Agent 重新分组或改 worktree |
| `worktree` | **仅警告** —— 物理隔离已兜底,交集只提示"合并时可能需解冲突" |

**失败即停:**
- 组内某 Worker 失败,**仍等本波全部跑完**(不打断已在并行的兄弟 Worker)。
- 本波聚合后若有失败,**停在这一波**,报告交回主 Agent。主 Agent 决定:修复后重跑、跳过、或中止。
- 续跑机制见 §6.4 —— planner 读 `PlanStep.status`,已 `completed` 的步骤不再入波。

**位置:** `src/main/agent/AgentRunner/parallelOrchestrator.ts`(与 `planRunnerHelper.ts`/`taskRunnerHelper.ts` 同目录同风格)。它不是 SubAgent,是被 `ExecutePlanParallel` 工具调用的纯编排函数。

---

## 3. 两个 SubAgent 定义

### 3.1 ExecutionPlanner(只读分组规划器)

**职责:** 读 Plan 全部步骤 → 分析依赖(文件依赖 + 逻辑依赖)→ 输出 `waves` + `isolation` 建议 + `rationale`。

```typescript
export const ExecutionPlannerSubAgent: SubAgentDefinition = {
  type: 'ExecutionPlanner',
  description: 'Analyzes an approved plan and groups its steps into parallel execution waves based on file and logical dependencies.',
  maxLoops: 8,
  whenToUse: [
    'A plan is approved and the user wants to execute its steps in parallel.',
    'You need to determine which plan steps can safely run concurrently.',
  ].join('\n'),
  whenNotToUse: [
    'The plan has only 1-2 steps (parallel overhead not worth it).',
    'Steps are strictly sequential (each depends on the previous).',
  ].join('\n'),
  costHint: 'Up to 8 read-only tool calls. Reads the plan and spot-checks files to confirm independence.',
  getTools: (tm) => tm.getReadOnlyTools(),
  outputSpec: {
    description: 'Submit the execution grouping: waves of parallelizable step IDs plus an isolation recommendation.',
    fields: [
      { name: 'waves', type: 'string[]', description: 'Ordered waves. Each entry is a JSON string like {"index":0,"stepIds":["p1","p2"]}. Steps in the same wave run in parallel; waves run in order.', required: true },
      { name: 'isolation', type: 'string', description: '"shared" if steps touch disjoint files, "worktree" if any risk of write collision', required: true },
      { name: 'rationale', type: 'string', description: 'One sentence explaining the grouping decision', required: true },
    ]
  },
  systemPromptBuilder: (ctx) => [ /* 见下述规则 */ ].join('\n'),
}
```

**分组规则(注入 systemPromptBuilder):**
1. 两步骤同波,当且仅当独立:`files` 不重叠 **且** 无逻辑依赖(如 B 用了 A 创建的接口 → B 须在更晚的波)。
2. 若 B 需要 A 的产出,A 放更早的波。
3. 优先"更少波、更多并行",但绝不以正确性为代价。
4. 读实际步骤描述并 spot-check 文件(Grep/Read)确认独立 —— **不盲信 `files` 字段**。
5. 隔离建议:不确定文件是否真独立、或步骤触碰共享 config/index 文件 → 建议 `worktree`;确信各波写完全独立文件 → 建议 `shared`。
6. **续跑:** 读 `PlanStep.status`,已 `completed` 的步骤不纳入任何波。

> `waves` 用 `string[]`(每项 JSON 字符串)以适配现有 `SubAgentOutputSpec` 只支持 `string/string[]/number/boolean` 的限制,避免改动 outputSpec 框架。协调器接收后 `JSON.parse` 每项。

### 3.2 Worker(可写执行器)

**职责:** 领取**单个** PlanStep → 用完整读写工具实现 → `submit_result` 汇报改动。

```typescript
export const WorkerSubAgent: SubAgentDefinition = {
  type: 'Worker',
  description: 'Executes a single plan step end-to-end: reads context, writes/edits code, and reports what changed. Runs in parallel with sibling workers in the same wave.',
  maxLoops: 20,
  canRunInBackground: true,
  isolation: 'none',   // 运行时由编排协调器按需覆盖为 worktree
  whenToUse: ['Executing one independent step of an approved plan.'].join('\n'),
  costHint: 'Up to 20 tool calls including file edits. One worker per plan step.',
  getTools: (tm) => { /* 只读 + Edit + Write + Bash/PowerShell(受权限层约束) */ },
  outputSpec: {
    description: 'Report the outcome of executing this plan step.',
    fields: [
      { name: 'status', type: 'string', description: '"completed" or "failed"', required: true },
      { name: 'summary', type: 'string', description: 'One-paragraph summary of what you changed and why', required: true },
      { name: 'filesModified', type: 'string[]', description: 'Paths of files you created or edited', required: true },
      { name: 'blockers', type: 'string[]', description: 'If failed: what blocked you', required: false },
    ]
  },
  systemPromptBuilder: (ctx) => [ /* 见下述约束 */ ].join('\n'),
}
```

**Worker 提示词关键约束:**
- 只负责分配给你的**一个**步骤,不碰其它步骤。
- **越界即停:** 若必须触碰分配文件集之外的文件 → **停止并报 blocker**(兄弟 Worker 可能正在并行改它),不要擅自编辑。
- 工作流:读步骤描述与涉及文件 → Edit/Write 实现 → 有验证则跑 Bash/PowerShell → `submit_result`。

### 3.3 注册

```typescript
// definitions/index.ts
export const allSubAgentDefinitions = [
  PlanSubAgent,
  ResearchSubAgent,
  ExecutionPlannerSubAgent,  // ← 新增
  WorkerSubAgent,            // ← 新增
]
```

### 3.4 两道防线(shared 档核心安全机制)

1. **协调器:** 校验同波 files 不相交(硬校验)。
2. **Worker:** 提示词强制"只碰分配文件,越界报 blocker"。

两道叠加,即使 planner 分组有小疏漏,Worker 也不会擅自改别人的文件。worktree 档再加物理隔离作为第三道兜底。

---

## 4. worktree 隔离、合并回主工作区、权限 gap

### 4.1 WorktreeService(从零实现)

沿用 `2026-07-01-worktree-service-design.md` 接口,改路径约定对齐 CodeZ:

```typescript
class WorktreeService {
  static create(workspaceRoot: string, name: string): { path: string; branch: string }
  static remove(workspaceRoot: string, name: string, force?: boolean): void
  static list(workspaceRoot: string): Array<{ path: string; branch: string; head: string }>
  static exists(workspaceRoot: string, name: string): boolean
}
```

- 路径:`<workspaceRoot>/.codez/worktrees/<name>/`(旧文档写 `.claude/`,CodeZ 用 `.codez/`)
- 分支:`codez/wt/<name>`
- name sanitize:仅 `[a-zA-Z0-9_-]`,防路径穿越;所有 git 命令 30s 超时;非 git 仓库抛错。

### 4.2 worktree 档生命周期

```
一波执行,isolation='worktree':
  1. 建 worktree(每 step 一个):wtInfo = WorktreeService.create(root, `plan-${slug}-${stepId}`)
     → 每个 Worker 的 workspaceRoot 指向自己的 worktree
  2. Promise.all 并行 spawn Worker(各自在独立 worktree 改文件,物理隔离)
  3. 波末统一合并成功 step 回主工作区:
     for each completed step:
       在 step 的 worktree 里 git add + commit
       回主工作区:git merge codez/wt/plan-<slug>-<stepId>
       → 同波 files 不相交(planner 保证),merge 应无冲突
       → 万一冲突(planner 失误):记录该 step failed,保留 worktree 供排查,不污染主区
  4. 清理:merge 成功的 worktree → remove(force);失败/冲突的 → 保留并报告路径
```

**合并放"每波末"而非"每 Worker 末":** 同波并行,各自 merge 会产生 git index 竞争;波是天然屏障,波末统一 merge 最简单安全。合并用 **git merge**(而非 cherry-pick 或拷文件)。

### 4.3 shared 档(默认,无 worktree)

```
一波执行,isolation='shared':
  1. 所有 Worker 的 workspaceRoot = 主工作区(同一目录)
  2. Promise.all 并行 spawn Worker
     → 靠两道防线(协调器硬校验 + Worker 越界即停)
  3. 无合并步骤(本就写在主工作区)
  4. 本波聚合结果
```

### 4.4 权限 gap(方案 B:前置一次性授权)

**现状问题:** `SubAgentManager.spawn` 执行工具时绕过 `PermissionManager`(`SubAgentManager.ts:516-545`)。可写 Worker 必须补。

**方案 B(采纳):**
- `SubAgentManager.spawn` 增加 `permissionScope` 参数(允许写的文件范围 + 是否允许 Bash 验证命令)。
- Worker 执行工具前,用 `PermissionManager` 做**非交互式**检查:命中 scope → 放行;越界/危险(删除/网络/越界路径)→ 直接拒绝(返回 error 给 Worker,不弹窗)。
- 触发并行执行时,用户在确认框**一次性授权**本次写权限范围(限定 Plan 声明的 files 内)。
- worktree 档因物理隔离,scope 可放宽到该 worktree 内任意文件。

被否决的方案:A(每写操作弹窗 —— N 个 Worker 并行淹没用户且阻塞并行);C(完全放行 —— 危险,不可接受)。

### 4.5 并发上限

借鉴 Claude Code 的 `min(16, cpu-2)`,桌面端保守取 **`min(6, cpuCount - 1)`**(避免 API 限流 + 本地 CPU 打满)。超出的 step 在波内排队。

---

## 5. 前端 UI

### 5.1 触发入口(两步)

Plan 处于 `executing` 时,Plan 卡片上出现「⚡ 并行执行」按钮(与"顺序执行"并列)。

```
点「并行执行」
   │
   ▼ 先 spawn ExecutionPlanner(只读,快)→ 拿到 waves + isolation 建议 + rationale
   ▼
弹确认框(带 planner 建议):
   分组理由:p0 须先行,p1/p2/p3 文件独立可并行
   隔离方式:● worktree(planner 建议)  ○ 共享目录   ← 用户可改
   ⚠ 本次授权 Worker 在计划声明文件范围内自主读写,不再逐步弹窗;危险操作仍拦截。
   [取消]  [开始并行执行]
   │
   ▼ 用户确认(可能改了隔离档)→ 主 Agent 调 ExecutePlanParallel(带最终 grouping + isolation)
```

若 planner 建议 worktree 而用户改成 shared → 确认框给"⚠ planner 认为有冲突风险"提示。

### 5.2 波次进度展示

复用 `SubAgentCard`(每个 Worker 一张卡),外套「波次分组容器」`ParallelWaveGroup`:

```
┌─ ⚡ 并行执行:重构工具系统 ────────────────────┐
│  分组理由:p0 建接口须先行,p1/p2/p3 文件独立可并行│
│  隔离:worktree                                  │
│  ▼ Wave 0  [✓ 完成]                             │
│     └ p0 搭建 apply_patch 接口   ✓ 3 文件        │
│  ▼ Wave 1  [⟳ 执行中 2/3]                        │
│     ├ p1 实现 search 工具        ⟳ 运行中…       │
│     ├ p2 实现 read_files 工具    ✓ 2 文件        │
│     └ p3 实现 shell 工具         ⟳ 运行中…       │
│  ▷ Wave 2  [等待中]                              │
└──────────────────────────────────────────────────┘
```

- 每波可折叠,徽章:等待中 / 执行中 N/M / 完成 / 失败(停止)。
- 波内 Worker 复用 `SubAgentCard`(点开看工具日志、submit_result 摘要、改动文件)。
- 某波失败 → 该波标红"已停止",后续波"已取消",顶部提示"主 Agent 正在决策"。

### 5.3 状态流与事件(单向数据流)

主进程是唯一数据源,前端只渲染 + 发事件。新增 IPC 事件(复用 `PLAN_SUBAGENT_PROGRESS` 风格):

```typescript
PARALLEL_EXEC_STARTED    { planSlug, waves, isolation, rationale }
PARALLEL_WAVE_UPDATE     { waveIndex, status, stepResults }
PARALLEL_EXEC_DONE       { report: ParallelExecutionReport }
```

- 渲染进程用 zustand(现有 `chatStore` 模式)持有 `parallelExecState`,监听事件更新。
- Worker 的 chunk/tool 事件继续走现有 `onSubAgentStart/Chunk/ToolStart/End`,按 `subAgentId` 路由到对应波内卡片。

### 5.4 复用 vs 新建

| 部分 | 复用 / 新建 |
|------|-----------|
| Worker 卡片 | 复用 `SubAgentCard` |
| 波次容器 | 新建 `ParallelWaveGroup` |
| 触发按钮 + 确认框 | 新建(挂现有 Plan 卡片) |
| 状态管理 | 复用 zustand,新增 `parallelExecState` slice |
| IPC 通道 | 新增 3 个事件通道 |

---

## 6. 实现分期、文件清单、风险

### 6.1 实现分期

**Phase 1 — 底层能力(无行为变更)**
1. 新建 `WorktreeService.ts` + 测试
2. `SubAgentManager.spawn` 增加 `permissionScope` 参数 + 非交互式权限校验
3. `SubAgentManager.spawn` 真正读取 `isolation` 字段

**Phase 2 — 两个 SubAgent + 编排协调器**
4. 新建 `ExecutionPlannerSubAgent`、`WorkerSubAgent` 并注册
5. 新建 `parallelOrchestrator.ts`(冲突校验 + 波循环 + worktree 合并 + 结果聚合 + 并发闸)
6. 新建 `ExecutePlanParallel` 工具(编排入口)

**Phase 3 — 前端**
7. Plan 卡片「并行执行」按钮 + 两步确认框(先跑 planner 再弹框)
8. `ParallelWaveGroup` 组件 + `parallelExecState` zustand slice
9. 3 个 IPC 事件通道接线

**Phase 4 — 系统提示词 + 收尾**
10. 委派指引加入 `ExecutePlanParallel` 使用时机
11. 端到端回归:简单 Plan 跑 shared;多文件 Plan 跑 worktree;故意制造失败测"失败即停 + 续跑"

### 6.2 文件清单

**新建:**
```
src/main/services/WorktreeService.ts
src/main/agent/definitions/ExecutionPlannerSubAgent.ts
src/main/agent/definitions/WorkerSubAgent.ts
src/main/agent/AgentRunner/parallelOrchestrator.ts
src/main/tools/builtin/ExecutePlanParallelTool.ts
src/renderer/src/components/chat/ParallelWaveGroup.tsx (+ .css)
src/tests/worktree-service.test.ts
src/tests/parallel-orchestrator.test.ts
```

**修改:**
```
src/main/agent/SubAgentManager.ts          (permissionScope + isolation 生效)
src/main/agent/definitions/index.ts        (注册 2 个新 SubAgent)
src/main/agent/AgentRunner/index.ts        (加 ExecutePlanParallel 分发)
src/shared/ipc/channels.ts                 (3 个新事件通道)
src/main/tools/ToolManager.ts              (注册新工具)
src/renderer/.../ (Plan 卡片组件)           (并行执行按钮 + 确认框)
src/renderer/src/stores/ (zustand)          (parallelExecState slice)
src/main/services/prompts/sections/...      (委派指引补充)
```

### 6.3 风险与缓解

| 风险 | 缓解 |
|------|------|
| ExecutionPlanner 分组误判(冲突步骤分到同波) | 双防线:协调器 files 硬校验 + Worker 越界即停;worktree 档物理兜底 |
| worktree merge 冲突 | 波末统一 merge;冲突则该 step 标失败、保留 worktree 供排查,不污染主区 |
| 并行 Worker 淹没 API(限流) | 并发闸 `min(6, cpu-1)`,波内排队 |
| Windows 上 worktree + node_modules 成本 | worktree 是可选档,默认 shared;文档提示 worktree 适合改动集中在源码的场景 |
| 权限一次性授权被滥用 | scope 限定 Plan 声明 files 内,危险操作非交互式拦截 |
| PlanStep.files 声明不准 | ExecutionPlanner spot-check 文件,不盲信;shared 档下不准会被硬校验挡下 |

### 6.4 开放问题(实现时定,不阻塞设计)

1. **从失败波续跑** —— **采纳:** planner 读 `PlanStep.status`,已 `completed` 步骤不再入波。主 Agent 修复失败步骤后重新触发 `ExecutePlanParallel`,planner 自动跳过已完成步骤,重新分波剩余步骤。无需 `fromWaveIndex` 参数。
2. **worktree 档下 Bash 验证命令的工作目录** —— 倾向合并后在主区统一验证(避免 worktree 里缺 node_modules)。
3. **planner 建议 worktree 但用户强改 shared** —— 尊重用户,确认框给冲突风险提示;反之(建议 shared 改 worktree)直接尊重。

---

## 7. 向后兼容

- 不改现有 `Task` 工具、`Research`/`Plan` SubAgent 行为。
- `SubAgentManager.spawn` 新增 `permissionScope` 为可选参数;不传时保持现有行为(只读子智能体无 gap)。
- `isolation` 字段从"死字段"变为"spawn 读取";现有定义 `isolation: 'none'` 或未设,行为不变。
- 新增能力完全通过新工具 `ExecutePlanParallel` 入口,不触碰现有顺序执行路径。
