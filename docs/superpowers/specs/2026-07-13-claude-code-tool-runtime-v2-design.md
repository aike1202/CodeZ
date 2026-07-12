# 基于 Claude Code 的 CodeZ 工具调用平台 V2 设计

- 日期：2026-07-13
- 状态：Draft
- 目标项目：CodeZ
- 参考实现：`F:\MyProjectF\Claude-Code`，提交 `b78dd22`
- 参考性质：该仓库由 Claude Code npm source map 还原，并非官方原始源码；本设计只借鉴当前快照中可验证的架构思想
- 文档范围：工具目录、工具暴露、Provider 协议归一化、参数校验、权限、Hooks、并发执行、结果管理、上下文预算、可观测性和渐进迁移
- 本次交付：仅设计文档，不修改生产代码、测试、依赖或配置

---

## 1. 摘要

CodeZ 已经完成核心工具名称和单工具能力对齐，但当前工具调用仍然是“固定工具列表 + AgentRunner 中央分发 + 字符串结果”的第一代架构。随着任务管理、子代理、并行 Executor、上下文压缩和多 Provider 支持加入，工具系统已经承担了远超最初契约的职责：

- 24 个内建工具始终全部发送给模型；
- system prompt 又重复注入一次工具摘要；
- 工具参数只在每个工具内部手工 `JSON.parse` 和校验；
- 所有同轮工具调用默认通过 `Promise.all` 并行，缺少统一的并发安全声明；
- `SubAgentRunner`、`DelegateTasks`、`ExecutionControl` 等特殊工具在 `AgentRunner` 里硬编码分支；
- 权限系统通过工具名集合判断能力，工具新增或改名容易造成策略漂移；
- 工具成功或失败依赖字符串特征识别，再被二次 JSON 包装；
- 大结果进入 ledger 后才由上下文裁剪处理，无法阻止单轮结果批次瞬间撑大上下文；
- 三家 Provider 分别解析工具调用流，但没有统一、可测试的 ToolCall assembler 契约；
- 暂无 MCP/插件工具的稳定接入点。

本设计将工具系统重构为一个独立的 Tool Runtime。核心变化如下：

1. 用 `ToolRegistry` 代替固定 `ToolManager` 列表，工具声明能力、风险、并发、可见性和中断语义。
2. 每一轮生成不可变 `ToolCatalogSnapshot`，确保 schema、执行对象和权限判断来自同一版本。
3. 引入 `ToolExposurePlanner`，按核心工具、角色、权限、Provider 能力和上下文预算选择本轮工具。
4. 引入跨 Provider 的 `ToolCallAssembler`，将 OpenAI、Anthropic 和 Gemini 的流式差异归一为 `NormalizedToolCall`。
5. 使用统一 JSON Schema validator 在执行前校验参数，工具实现接收已解析、已校验对象。
6. 引入 `ToolExecutionPipeline`：解析、查找、暴露校验、权限、Hooks、调度、执行、结果规范化、持久化、ledger 记录。
7. 用声明式 effect plan 取代权限系统中的工具名白名单。
8. 用资源锁和 `isConcurrencySafe` 控制并发，禁止冲突写入在同一 `Promise.all` 中无序执行。
9. 统一 `ToolExecutionResult`，分离模型内容、UI 内容、结构化数据、错误、文件引用和副作用。
10. 对大工具结果在进入 ledger 前做批次预算和持久化，以虚拟句柄而不是放宽工作区文件权限来支持后续读取。
11. 为 MCP、插件和动态 Skills 预留 `ToolSourceAdapter`，但不要求首期实现 MCP。

这不是重写现有 24 个工具。第一阶段会通过 `LegacyToolAdapter` 包装现有 `Tool` 类，先建立新运行时边界，再逐步迁移实现。

---

## 2. 背景与已有设计关系

### 2.1 已完成的工作

`docs/superpowers/specs/2026-06-30-claude-tool-alignment-design.md` 已解决以下问题：

- 对齐 `Read / Edit / Write / NotebookEdit / Glob / Grep / Bash / PowerShell` 等核心工具名；
- 实现 AskUserQuestion、Skill、PushNotification；
- 保留 CodeZ 的事务编辑、回滚和恢复状态能力；
- 为多 Provider 提供基础 tool schema 映射；
- 对 Shell、Read、Edit 等工具描述进行 Claude Code 语义对齐。

`2026-07-11-shared-agent-tool-policy-design.md` 与并行执行相关设计又补充了：

- 主 Agent、Research、ExecutionPlanner、Executor 共享工具策略；
- `Read.files` 批量读取；
- `DelegateTasks`、Execution controller、worktree 隔离和执行 handoff；
- 工具批次在 renderer 中的展示语义。

因此，本设计不再讨论“是否需要某个核心工具”或逐项重写工具实现，而是解决工具调用平台本身的结构问题。

### 2.2 与 Claude Code 的关键架构差异

Claude Code 当前快照中的工具系统具有以下值得借鉴的机制：

- `Tool` 同时声明 input schema、output schema、只读性、破坏性、并发安全、中断行为、是否启用、是否延迟加载等元数据；
- 工具池按权限 deny 规则、运行模式、平台、feature gate、Agent 角色和 MCP 连接动态组合；
- ToolSearch 可以延迟加载 schema，避免所有 MCP/低频工具污染每轮上下文；
- schema 有会话级稳定缓存，减少工具描述轻微变化造成的 prompt cache 失效；
- 工具执行经过参数校验、权限、PreToolUse hook、执行、PostToolUse hook、结果映射和遥测；
- 大结果在回传模型前持久化，只发送预览和路径；
- 单工具和单批次结果都有独立预算；
- 权限支持 allow/deny/ask 多来源规则、沙箱、Hooks 和 headless agent 行为；
- 工具调用执行逻辑与 UI、Provider wire format 分离。

CodeZ 不能直接复制这些实现，原因是：

1. CodeZ 同时支持 OpenAI、Anthropic 和 Gemini，不应把 Anthropic `tool_reference` 或 `cache_control` 当作统一协议。
2. CodeZ 的 `Read` 严格限制在 workspace 内，不能照搬 Claude Code 将大结果保存到外部文件后要求模型直接 Read 的方式。
3. CodeZ 已有 ledger、事务编辑、文件指纹和 Executor lease，需要成为新运行时的一等数据，而不是绕过它们。
4. CodeZ 当前部署在 Electron/Windows 场景，Bash 与 PowerShell 的 sandbox 能力并不对称。
5. CodeZ 的工具定义仍是 JSON Schema，现阶段引入完整 Zod 工具体系会增加一次不必要的 schema 迁移。

---

## 3. 当前架构基线

### 3.1 当前调用链

```mermaid
flowchart TD
  A[SystemPromptService] --> B[ToolManager.getToolDefinitions]
  B --> C[ModelContextBuilder]
  C --> D[ChatService]
  D --> E[OpenAI / Anthropic / Gemini Provider]
  E --> F[AgentRunner accumulates streamed tool fragments]
  F --> G[JSON.parse arguments]
  G --> H[PermissionManager]
  H --> I{special tool name?}
  I -->|SubAgentRunner| J[subAgentRunnerHelper]
  I -->|DelegateTasks| K[delegateTasksHelper]
  I -->|ExecutionControl| L[executionControlHelper]
  I -->|ordinary| M[ToolManager.getTool and execute]
  J --> N[string result]
  K --> N
  L --> N
  M --> N
  N --> O[wrap as ok/data or ok/error]
  O --> P[SessionRuntimeCoordinator ledger]
  P --> C
```

### 3.2 现有核心契约

当前 `src/main/tools/Tool.ts` 的抽象契约为：

```ts
abstract class Tool {
  abstract get name(): string
  abstract get summary(): string
  abstract get description(): string
  abstract get parameters_schema(): Record<string, any>
  abstract execute(args: string, context: ToolContext): Promise<string>
}
```

这个契约简单，但存在四个扩展瓶颈：

- 输入仍是 JSON 字符串，解析和错误格式由每个工具重复实现；
- 输出仍以字符串为中心，框架通过字符串判断错误；
- 权限、并发、破坏性、结果预算等行为不在工具声明中；
- 工具执行和 Provider schema 没有版本化快照。

### 3.3 当前主要问题

| 问题 | 当前表现 | 风险 |
|---|---|---|
| 固定工具池 | 24 个工具每轮全部发送 | schema token 持续增长，后续 MCP 无法扩展 |
| 重复声明 | tool schema 和 `<available_tools>` 同时包含描述 | 重复 token，两个来源可能漂移 |
| 参数校验分散 | 每个工具手写 JSON.parse 和字段判断 | 错误文案不一致，漏校验 additional properties |
| 特殊工具硬编码 | AgentRunner 按名字 if/else | 每加一个编排工具都修改主循环 |
| 权限按名称分类 | PermissionManager 维护多个名称 Set | 改名或 alias 容易绕过/误触权限 |
| 无统一并发模型 | 同轮调用全部 Promise.all | 同文件写、交互工具和上下文修改可能竞态 |
| 字符串错误检测 | `Error:`、hash mismatch 等启发式 | 成功文本可能误判，结构化错误可能漏判 |
| 双重结果包装 | 工具可能自己返回 `{ok}`，Runner 再包一层 | 模型收到嵌套 JSON 字符串，UI 还需反解 |
| 大结果处理偏晚 | ToolOutputPruner 在后续 context build 才工作 | 单轮批量结果可能先进入 ledger 并触发溢出 |
| Provider 解析耦合 | 各 Provider 直接输出 tool chunk | 边界 fragment、重复 call id 和坏 JSON 难统一测试 |
| 动态扩展缺口 | 无 MCP/plugin adapter | 工具越多，ToolManager 和 AgentRunner 越难维护 |

---

## 4. 目标与非目标

### 4.1 目标

1. 工具注册、选择、授权、执行、结果和观察形成明确分层。
2. 内建工具不需要因为加入运行时 V2 而重写业务逻辑。
3. 工具 schema 与实际可执行工具来自同一个不可变快照。
4. 不允许模型调用本轮没有暴露的工具，即使注册表中存在。
5. 所有工具参数在进入业务实现前完成统一解析和 JSON Schema 校验。
6. 权限依据“将产生什么 effect”判断，而不是依据工具名字猜测。
7. 并行执行只发生在明确安全的调用之间；冲突调用按确定顺序串行。
8. 任何工具结果在进入 ledger 前都满足单工具和单批次预算。
9. Provider 只负责 wire format，不承载工具业务策略。
10. 为未来 MCP、插件、动态 Skills 和远程工具保留稳定接口。
11. 支持灰度启用、逐阶段回滚和 V1/V2 行为对照。

### 4.2 非目标

- 本设计不要求立即增加新的用户可见工具。
- 首期不实现 MCP server 管理、OAuth 或插件市场。
- 首期不移除现有 `Tool` 抽象和 24 个工具实现。
- 首期不改变 Edit/Write 的事务语义和用户 diff 审批流程。
- 首期不放宽 Read 的 workspace 边界。
- 首期不承诺 Bash/PowerShell 都具有完整 OS sandbox。
- 不将 Claude Code 的内部 feature gate、遥测字段或 Anthropic 专有协议直接复制进 CodeZ。
- 不在工具运行时中重新实现 Agent 规划策略；运行时只执行已产生的工具调用。

---

## 5. 设计原则

### 5.1 单一事实源

同一个 `ToolDescriptor` 必须同时驱动：

- 模型可见 schema；
- AvailableTools/ToolSearch 摘要；
- 权限能力分类；
- 并发和资源锁；
- UI 展示；
- 结果预算；
- 遥测中的工具身份。

禁止在 Prompt、PermissionManager、AgentRunner 和 renderer 分别维护工具名列表。

### 5.2 每轮快照稳定

一次模型请求开始后，工具目录不能在流式响应中途改变。MCP 连接、设置变化或 feature flag 更新只能影响下一轮 `ToolCatalogSnapshot`。

### 5.3 Provider 中立

内部 canonical contract 不出现 Anthropic `tool_use`、OpenAI `tool_calls` 或 Gemini `functionCall` 类型。Provider adapter 只在边界转换。

### 5.4 安全由 Runtime 保证

Prompt 可以指导模型，但不能授予权限。工具是否可见、是否允许、是否能写某路径、是否必须串行，都必须由运行时机械执行。

### 5.5 失败可恢复

错误必须提供稳定 code、是否可恢复和建议动作。模型不应依赖英文字符串猜测是否需要重新 Read、缩小 Grep 或请求用户批准。

### 5.6 渐进迁移

新架构首先包装旧实现并保持行为，再迁移契约。任何阶段都应可通过 feature flag 回到 V1。

---

## 6. 目标架构

```mermaid
flowchart TB
  subgraph Catalog[Tool Catalog Plane]
    R[ToolRegistry]
    SA[Built-in / Skill / MCP / Plugin adapters]
    S[ToolCatalogSnapshot]
    EP[ToolExposurePlanner]
    SC[ToolSchemaCompiler and Cache]
    SA --> R --> S --> EP --> SC
  end

  subgraph Request[Model Request Plane]
    CB[ModelContextBuilder]
    PA[ProviderAdapter]
    ASM[ToolCallAssembler]
    SC --> CB --> PA --> ASM
  end

  subgraph Runtime[Execution Plane]
    VAL[Input Validator]
    AUTH[Permission and Effect Engine]
    PRE[PreToolUse Hooks]
    SCH[ToolScheduler and Resource Locks]
    EXE[Tool Handler]
    POST[PostToolUse Hooks]
    RES[Result Normalizer and Budgeter]
    ASM --> VAL --> AUTH --> PRE --> SCH --> EXE --> POST --> RES
  end

  subgraph State[State Plane]
    LEDGER[Model Ledger]
    STORE[Large Result Store]
    UI[Renderer Events]
    OBS[Audit and Metrics]
    RES --> LEDGER
    RES --> STORE
    RES --> UI
    VAL --> OBS
    AUTH --> OBS
    SCH --> OBS
    EXE --> OBS
  end
```

### 6.1 分层职责

| 层 | 组件 | 职责 |
|---|---|---|
| Catalog | ToolRegistry | 注册、alias、来源、版本、冲突检测 |
| Catalog | ToolExposurePlanner | 决定本轮模型可以看到哪些工具 |
| Catalog | ToolSchemaCompiler | 生成稳定 Provider schema 和 fingerprint |
| Protocol | ToolCallAssembler | 拼接流式 fragment，输出 canonical calls |
| Validation | ToolInputValidator | JSON 解析、schema 校验、错误格式化 |
| Policy | ToolEffectPlanner | 根据参数解析预期副作用和资源范围 |
| Policy | PermissionEngine | allow/ask/deny、规则、hardline、重校验 |
| Hooks | ToolHookRunner | 执行前后策略扩展，不侵入工具实现 |
| Scheduling | ToolScheduler | 并行分组、资源锁、取消和超时 |
| Execution | ToolHandler | 执行业务逻辑，返回 typed result |
| Result | ToolResultProcessor | 预算、持久化、UI/模型分流、ledger 记录 |
| Observability | ToolExecutionJournal | 生命周期事件、耗时、错误和审计 |

---

## 7. 核心领域模型

### 7.1 ToolDescriptor

```ts
export interface ToolDescriptor {
  name: string
  aliases?: readonly string[]
  version: string
  source: 'builtin' | 'skill' | 'mcp' | 'plugin'

  summary: string
  description: string | ((ctx: ToolDescriptionContext) => string | Promise<string>)
  searchHint?: string

  inputSchema: JsonSchemaObject
  outputSchema?: JsonSchemaObject

  availability: {
    enabled(ctx: ToolAvailabilityContext): boolean | Promise<boolean>
    roles: readonly AgentRole[] | '*'
    platforms?: readonly NodeJS.Platform[]
    exposure: 'always' | 'core' | 'deferred' | 'internal'
  }

  behavior: {
    readOnly(input: unknown): boolean
    destructive(input: unknown): boolean
    concurrency: 'safe' | 'resource-locked' | 'exclusive'
    interrupt: 'cancel' | 'block' | 'detach'
    maxResultChars: number
    timeoutMs?: number
  }

  planEffects(input: unknown, ctx: ToolPlanningContext): Promise<ToolEffectPlan>
  resourceKeys(input: unknown, ctx: ToolPlanningContext): Promise<readonly string[]>
}
```

关键约束：

- `name` 是 canonical wire name，必须匹配 `[A-Za-z0-9_-]+`。
- alias 只用于兼容历史消息和旧配置，不主动暴露给模型。
- `description` 可以依赖角色和 Provider 能力，但同一会话快照内必须稳定。
- `internal` 工具只允许框架调用，不出现在模型 schema。
- `exposure` 不等于权限。工具可见不代表执行一定被允许。
- `resourceKeys` 必须返回规范化资源，例如 `file:F:/repo/src/a.ts`、`session:s1:tasks`、`ui:ask-user`。

### 7.2 ToolHandler

```ts
export interface ToolHandler<TInput = unknown, TOutput = unknown> {
  readonly descriptor: ToolDescriptor

  execute(
    input: TInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<TOutput>>
}
```

V2 handler 不再接收 JSON 字符串。JSON parse 和 schema validation 已在执行管线前完成。

### 7.3 ToolExecutionContext

```ts
export interface ToolExecutionContext {
  workspaceRoot: string
  sessionId: string
  turnId: string
  contextScopeId: string
  callId: string
  agentId?: string
  agentRole: AgentRole

  transaction?: {
    id: string
    service: EditTransactionService
  }

  runtimeCoordinator: SessionRuntimeCoordinator
  abortSignal: AbortSignal
  emitProgress(event: ToolProgressEvent): void
}
```

上下文中不应放置 Provider client、API key 或 renderer 对象。工具需要外部能力时通过显式 service dependency 注入。

### 7.4 ToolExecutionResult

```ts
export type ToolExecutionResult<T = unknown> =
  | {
      status: 'success'
      data?: T
      modelContent: ToolModelContent
      uiContent?: ToolUiContent
      fileReferences?: FileContextReference[]
      effects?: ToolEffectRecord[]
      cache?: { kind: 'stable' | 'volatile'; key?: string }
    }
  | {
      status: 'error' | 'denied' | 'cancelled'
      error: ToolExecutionError
      modelContent?: ToolModelContent
      uiContent?: ToolUiContent
      effects?: ToolEffectRecord[]
    }

export interface ToolExecutionError {
  code: string
  message: string
  recoverable: boolean
  suggestion?: string
  retryAfterMs?: number
  details?: Record<string, unknown>
}
```

`modelContent` 和 `uiContent` 必须分离：

- `modelContent` 进入 ledger 和下一轮模型上下文；
- `uiContent` 仅给 renderer，可包含完整 diff、执行器状态或富结构；
- `data` 供框架后处理，不应先 stringify 再被外层 stringify；
- `effects` 是实际发生的副作用，用于审计和事务收尾；
- 错误 code 是逻辑判断依据，禁止继续依赖 `Error:` 前缀。

### 7.5 LegacyToolAdapter

迁移期使用 adapter 包装现有工具：

```ts
class LegacyToolAdapter implements ToolHandler {
  constructor(private readonly legacy: Tool) {}

  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const output = await this.legacy.executeWithMetadata(
      JSON.stringify(input),
      toLegacyToolContext(ctx)
    )
    return normalizeLegacyOutput(output)
  }
}
```

`normalizeLegacyOutput` 仅作为迁移兼容层保留旧字符串错误识别。所有原生 V2 handler 禁止返回字符串错误。

---

## 8. ToolRegistry 与 Catalog Snapshot

### 8.1 Registry API

```ts
export interface ToolRegistry {
  register(handler: ToolHandler): void
  unregister(source: ToolSourceId): void
  resolve(nameOrAlias: string): ToolHandler | undefined
  createSnapshot(ctx: ToolAvailabilityContext): Promise<ToolCatalogSnapshot>
}

export interface ToolCatalogSnapshot {
  id: string
  createdAt: string
  handlersByCanonicalName: ReadonlyMap<string, ToolHandler>
  aliases: ReadonlyMap<string, string>
  descriptors: readonly ToolDescriptor[]
  fingerprint: string
}
```

### 8.2 注册冲突规则

1. 内建 canonical name 不能被 MCP/plugin 覆盖。
2. 同名外部工具必须规范化为 `mcp__<server>__<tool>` 或 `plugin__<plugin>__<tool>`。
3. alias 不得与任何 canonical name 冲突。
4. alias 冲突时注册失败并记录 source，不采用“后注册覆盖”。
5. snapshot 创建后不可变；外部工具连接变化只产生新 snapshot。

### 8.3 版本与 fingerprint

fingerprint 至少包含：

- canonical name；
- descriptor version；
- description 的最终文本；
- input/output schema 的 canonical JSON；
- exposure metadata；
- Provider schema compiler version。

JSON canonicalization 必须稳定排序 object keys，避免构造顺序不同造成无意义缓存失效。

---

## 9. 工具暴露与延迟 Schema

### 9.1 为什么需要暴露规划

当前 24 个工具的 schema 已经占用固定上下文。未来接入 MCP 后，一个 server 可能带来几十到几百个工具。如果全部加载：

- 每轮输入 token 成本线性增加；
- 模型更容易选择相似但错误的工具；
- Provider 可能超过工具数量或 schema 大小限制；
- 任意外部工具 schema 变化都会影响请求 fingerprint。

### 9.2 暴露等级

建议默认分层：

| 等级 | 默认工具 | 说明 |
|---|---|---|
| always | `ToolSearch`、`AskUserQuestion` | 运行时基础设施，始终可见 |
| core | `Read`、`Edit`、`Write`、`Glob`、`Grep`、平台主 Shell | 主编码路径 |
| role | Task、Agent、Delegate、Execution 工具 | 仅对适用 Agent 角色可见 |
| deferred | Web、PushNotification、NotebookEdit、低频外部工具 | 按需激活 |
| internal | rollback 协调、结果存储读取、框架控制工具 | 不直接暴露或条件暴露 |

最终分类需通过真实会话日志验证，不能只根据主观判断永久固定。

### 9.3 ToolExposurePlanner

输入：

```ts
interface ToolExposureRequest {
  catalog: ToolCatalogSnapshot
  agentRole: AgentRole
  permissionContext: PermissionContext
  providerCapabilities: ProviderToolCapabilities
  contextBudget: ContextBudgetSnapshot
  activatedDeferredTools: ReadonlySet<string>
  taskSignals?: readonly string[]
}
```

输出：

```ts
interface ToolExposurePlan {
  eagerTools: readonly ToolDescriptor[]
  deferredTools: readonly DeferredToolSummary[]
  hiddenTools: readonly { name: string; reason: string }[]
  schemaFingerprint: string
  estimatedSchemaTokens: number
}
```

规划顺序：

1. 移除当前平台/角色不可用工具。
2. 移除 blanket deny 工具，避免模型看见必然失败的能力。
3. 加入 always 工具。
4. 加入适用于角色的 core 工具。
5. 加入本会话已激活 deferred 工具。
6. 根据 Provider 工具数量和 schema 字节上限裁剪。
7. 若剩余 schema token 超过输入预算的指定比例，按优先级继续延迟。
8. 生成 deferred name/summary 列表供 ToolSearch 使用。

### 9.4 跨 Provider ToolSearch

CodeZ 不依赖 Anthropic 专有 `tool_reference`。统一流程如下：

1. 初始请求只暴露 eager tools 和 `ToolSearch`。
2. 模型调用 `ToolSearch({ query })`。
3. ToolSearch 在当前 catalog snapshot 中搜索 deferred tools。
4. 结果返回匹配名称、摘要和“将在下一轮启用”的提示。
5. Runtime 将匹配工具加入 session/context-scope 的 `activatedDeferredTools`。
6. 下一 Agent loop 重新生成 exposure plan，并把完整 schema 发给 Provider。
7. 模型随后正常调用已激活工具。

ToolSearch 返回结果示例：

```json
{
  "activated": ["WebSearch", "WebFetch"],
  "availableNextTurn": true,
  "summaries": [
    { "name": "WebSearch", "summary": "Search current web information" },
    { "name": "WebFetch", "summary": "Fetch and extract a web page" }
  ]
}
```

若模型直接调用未暴露工具，Runtime 返回：

```json
{
  "code": "TOOL_NOT_EXPOSED",
  "recoverable": true,
  "message": "WebSearch is registered but was not exposed in this turn.",
  "suggestion": "Call ToolSearch for web search tools first."
}
```

### 9.5 system prompt 调整原则

- eager tool 的完整描述只存在于 tool schema，不再在 `<available_tools>` 重复。
- system prompt 只保留选择原则和 deferred tool 名称/短摘要。
- `AvailableToolsModule` 必须接收当前 `ToolExposurePlan`，不能自行 `new ToolManager()`。
- Research/Executor 的 prompt 只能列出该角色实际可见工具。

---

## 10. Provider 工具协议归一化

### 10.1 ProviderToolCapabilities

```ts
export interface ProviderToolCapabilities {
  supportsParallelToolCalls: boolean
  supportsStrictSchema: boolean
  supportsToolChoice: boolean
  supportsStreamingArguments: boolean
  supportsNativeDeferredTools: boolean
  maxTools?: number
  maxSchemaBytes?: number
  preservesToolCallId: boolean
}
```

能力由 `ModelCapabilities` 按 `apiFormat + baseUrl + model` 解析，禁止仅根据 Provider 名称假设所有兼容端点行为一致。

### 10.2 Canonical fragment

Provider parser 统一输出：

```ts
export interface ToolCallFragment {
  provider: 'openai' | 'anthropic' | 'gemini'
  position: number
  callId?: string
  nameDelta?: string
  argumentsDelta?: string
  completeArguments?: unknown
  thoughtSignature?: string
  isFinal?: boolean
}
```

### 10.3 ToolCallAssembler

```ts
export interface NormalizedToolCall {
  callId: string
  position: number
  name: string
  rawArguments: string
  thoughtSignature?: string
  providerMetadata?: Record<string, unknown>
}
```

Assembler 必须处理：

- OpenAI 按 index 分片的 name/arguments；
- Anthropic content block start/delta/stop；
- Gemini 一次性 `functionCall.args` 对象；
- 缺失 call id 时生成确定性的 turn/loop/position id；
- 同 position 的重复 fragment；
- UTF-8 和 JSON 字符串跨 chunk 截断；
- Provider 在 stop reason 未标 tool use 时仍返回 functionCall；
- thought signature 在 turn 级或 call 级出现；
- 空名称、名称超长、参数超过上限；
- 流中断时未完成调用不得执行。

### 10.4 Provider adapter 边界

Provider 只负责：

- 将 canonical messages 和 exposure plan 编码为 wire request；
- 将响应流解析为 text/reasoning/tool fragments/usage；
- 映射 stop reason；
- 报告 Provider protocol error。

Provider 不负责：

- 查找工具；
- 参数校验；
- 权限判断；
- 特殊工具分发；
- 工具结果预算；
- ToolSearch 激活状态。

---

## 11. 输入解析与 Schema 校验

### 11.1 方案选择

保留 JSON Schema 作为工具声明单一来源，引入 Ajv 2020 作为统一 validator。原因：

- 现有 24 个工具已经维护 JSON Schema；
- 三家 Provider 都能从 JSON Schema 映射；
- 避免同时维护 Zod 和 JSON Schema；
- Ajv 可在 snapshot 创建时编译并缓存 validator；
- 可以统一处理 required、type、enum、minItems 和 additionalProperties。

### 11.2 校验流程

1. 对 `rawArguments` 做最大字节限制。
2. 严格 `JSON.parse`；空字符串只在 schema 允许空 object 时转 `{}`。
3. 必须得到 object，禁止 array、number、string 顶层输入。
4. 运行 snapshot 对应的 compiled validator。
5. 将 Ajv errors 转为对模型友好的稳定错误。
6. 校验通过后冻结或深拷贝 input，防止 Hook/工具之间共享可变对象。

错误示例：

```json
{
  "code": "TOOL_INPUT_INVALID",
  "recoverable": true,
  "message": "Read input is invalid.",
  "details": {
    "issues": [
      "The required parameter `files` is missing",
      "The unexpected parameter `path` was provided"
    ]
  },
  "suggestion": "Call Read with { files: [{ file_path: \"...\" }] }."
}
```

### 11.3 Schema 约束

- 新增或迁移的 schema 默认 `additionalProperties: false`。
- 所有数组必须设置合理 `maxItems`。
- 命令、内容和查询字段必须设置 Runtime 级最大字节限制，即使 Provider schema 不支持该关键字。
- 不能依靠 description 表达必需的安全约束。
- alias 参数若需兼容，应在 adapter 中规范化后再校验，不能无限期留在 canonical schema。

---

## 12. Effect Plan 与权限

### 12.1 从工具名判断迁移到副作用判断

当前 `PermissionManager` 用 `READ_ONLY_TOOLS`、`WRITE_TOOLS`、`WEB_TOOLS` 等名称集合分类。V2 改为每次调用先生成 effect plan：

```ts
export interface ToolEffectPlan {
  effects: readonly ToolEffect[]
  analysisStatus: 'parsed' | 'partial' | 'unparsed'
  snapshots?: readonly PermissionSnapshot[]
}

export type ToolEffect =
  | { kind: 'read-file'; path: string; scope: 'workspace' | 'external' }
  | { kind: 'write-file'; path: string; mode: 'create' | 'modify' | 'overwrite' }
  | { kind: 'delete-file'; path: string }
  | { kind: 'execute-command'; shell: 'bash' | 'powershell'; command: string }
  | { kind: 'network'; host?: string; method?: string }
  | { kind: 'notify-user'; channel: 'desktop' | 'remote' }
  | { kind: 'spawn-agent'; role: string; isolation: string }
  | { kind: 'control-execution'; executionId: string; action: string }
  | { kind: 'mutate-task-state'; sessionId: string }
  | { kind: 'read-memory'; path: string }
```

PermissionEngine 只消费 effects，不依赖 `Edit`、`Write`、`DelegateTasks` 等名称。

### 12.2 决策顺序

1. Registry/Exposure gate：工具是否注册且本轮暴露。
2. Agent role gate：当前角色是否允许此工具。
3. Lease gate：Executor token 是否仍有效。
4. Hardline safety：凭据、系统目录、破坏性 git、权限绕过等。
5. 显式 deny 规则。
6. 显式 ask 规则。
7. 工具 effect policy。
8. 当前 permission mode。
9. Smart approval/classifier。
10. 用户审批。
11. 输入 snapshot revalidation。

任何 later stage 不得覆盖 earlier hard deny。

### 12.3 Permission mode

短期保留 CodeZ 的 `auto | full-access`，但内部决策不要把 mode 与 capability 写死在同一个 class 中。建议将来扩展为：

- `default`：只读自动允许，写入和命令按规则判断；
- `accept-edits`：工作区内非敏感编辑自动允许；
- `auto`：安全命令和编辑可经 classifier 自动允许；
- `plan`：只读和计划文件例外；
- `dont-ask`：需要 ask 的调用转换为 deny；
- `full-access`：除 hardline 与显式 deny 外允许。

此扩展不是 V2 首期前置条件，但 effect model 必须能支持。

### 12.4 Sandbox 接口

```ts
interface SandboxAdapter {
  capability(shell: 'bash' | 'powershell'): 'none' | 'workspace' | 'strict'
  execute(request: SandboxedCommandRequest): Promise<SandboxedCommandResult>
}
```

策略：

- V2 首期可继续使用 `none`，但必须在 execution journal 中记录；
- 如果设置要求 `strict` 而平台 adapter 不支持，必须 fail closed，不能静默降级；
- `dangerouslyDisableSandbox` 只能触发显式审批，不能是普通布尔旁路；
- Bash 和 PowerShell 可以有不同 capability；
- sandbox 不能替代命令语法分析、权限规则和 critical guard。

---

## 13. Tool Hooks

### 13.1 Hook 类型

```ts
type ToolHookEvent =
  | 'before-validate'
  | 'before-permission'
  | 'permission-request'
  | 'before-execute'
  | 'after-execute'
  | 'execute-failed'
  | 'after-result-processed'
```

首期只实现内部 typed hooks；用户配置 shell hooks 可在后续建立在同一接口上。

### 13.2 Hook 决策

```ts
type BeforeToolHookResult =
  | { action: 'continue' }
  | { action: 'deny'; code: string; message: string }
  | { action: 'ask'; message: string }
  | { action: 'replace-input'; input: unknown; reason: string }
```

约束：

- `replace-input` 后必须重新 schema 校验和 effect planning；
- Hook 不能把 hardline deny 改为 allow；
- Hook 超时按类型 fail closed 或记录后继续，策略必须显式；
- Hook 输出进入模型前视为非权威数据，不能被当作 system instruction；
- 每次 Hook 修改必须记录 before/after fingerprint，敏感值需脱敏。

### 13.3 CodeZ 内部 Hook 用例

- Edit/Write 前建立事务备份；
- 工具结束后更新 verification tracking；
- 文件工具结束后更新 Read fingerprint delivery；
- task 工具结束后持久化 session task state；
- shell 工具结束后提取 test/build/lint 结果；
- 外部工具失败后添加可恢复建议；
- 统一 renderer progress 事件。

这些逻辑从 AgentRunner 移出后，主循环不再按工具名更新 `filesModifiedInSession`。

---

## 14. 并发调度与资源锁

### 14.1 当前问题

当前同轮所有工具调用直接 `Promise.all`。以下组合存在风险：

- 两个 Edit 同时修改同一文件；
- Write 与 NotebookEdit 修改同一路径；
- AskUserQuestion 与另一个阻塞 UI 工具并发；
- TaskUpdate 同时把多个任务设为 in_progress；
- ExecutionControl 与 ExecutionInspect 读取/修改同一执行状态；
- Shell 命令与文件工具同时操作相同目录或 git index；
- 工具通过 `contextModifier` 或 session state 改变后续调用前提。

### 14.2 调度分类

| 类型 | 示例 | 调度 |
|---|---|---|
| safe | 独立 Read、Glob、Grep、只读 WebFetch | 并行 |
| resource-locked | Edit、Write、TaskUpdate、ExecutionControl | 获取资源键后并行或排队 |
| exclusive | AskUserQuestion、进入模式、全局配置修改 | 本批次独占 |
| detached | background shell、子代理 | 启动阶段受调度，运行后由 controller 管理 |

### 14.3 Resource keys

示例：

```text
Read(src/a.ts)              -> file:F:/repo/src/a.ts:read
Edit(src/a.ts)              -> file:F:/repo/src/a.ts:write
Write(src/a.ts)             -> file:F:/repo/src/a.ts:write
TaskUpdate(t1)              -> session:s1:tasks
AskUserQuestion             -> session:s1:user-interaction
ExecutionControl(exec-1)    -> execution:exec-1
Bash(git add ...)           -> repo:F:/repo:git-index
```

锁规则：

- 同资源的 read/read 可以并发；
- read/write 和 write/write 串行；
- 多资源调用按排序后的 key 一次性获取，避免死锁；
- 无法可靠推导资源的写操作按 workspace exclusive 处理；
- 原始模型调用顺序作为冲突调用的确定性串行顺序；
- 权限审批可以并行预计算，但需要用户交互的审批应排队展示。

### 14.4 Scheduler 输出

```ts
interface ToolExecutionWave {
  index: number
  calls: PreparedToolCall[]
  reason: 'independent' | 'resource-serialized' | 'exclusive'
}
```

同轮 5 个调用可能被拆为：

```text
Wave 0: Read(a), Read(b), Grep(x)
Wave 1: Edit(a)
Wave 2: AskUserQuestion
```

结果写回模型时仍按原始 position 排序，不按完成时间排序，保证 Provider transcript 稳定。

### 14.5 中断行为

- `cancel`：Read/Grep/前台 shell 在用户 steer 或 stop 时取消；
- `block`：事务 commit、关键状态迁移完成前阻塞新输入；
- `detach`：后台 shell/Executor 继续，由 controller 持有状态；
- 被取消的调用必须写入 canonical cancelled result，不能从 ledger 中消失；
- 同一批次中依赖被取消调用的后续 wave 标为 `DEPENDENCY_CANCELLED`。

---

## 15. 特殊工具去特例化

### 15.1 当前特例

AgentRunner 当前直接识别：

- `SubAgentRunner`
- `DelegateTasks`
- `ExecutionControl`
- `AskUserQuestion` intercept
- Edit/Write 修改追踪
- Bash/PowerShell verification 命令追踪

### 15.2 目标

特殊行为通过 handler 和 hooks 注册：

```ts
registry.register(new SubAgentRunnerHandler(subAgentManager))
registry.register(new DelegateTasksHandler(executionController))
registry.register(new ExecutionControlHandler(executionController))
registry.register(new AskUserQuestionHandler(userInteractionService))
```

AgentRunner 不知道这些工具名字，只负责：

```ts
const calls = assembler.finalize()
const results = await toolRuntime.executeBatch(calls, turnContext)
await runtimeCoordinator.recordToolResults(turn, results)
```

### 15.3 内部控制能力

某些操作不应伪装成普通模型工具：

- transaction handoff/rollback；
- tool result store cleanup；
- executor lease renewal；
- context compaction；
- exposure activation bookkeeping。

这些能力作为 runtime service 或 internal handler，不放进模型工具目录。

---

## 16. 工具结果与上下文预算

### 16.1 两阶段预算

1. 执行前预算：估算本批次最坏结果，必要时限制并行数量或向工具传入更小 limit。
2. 执行后预算：结果进入 ledger 前执行单工具和单批次裁剪/持久化。

建议初始阈值：

| 预算 | 初始值 | 说明 |
|---|---:|---|
| 单工具软上限 | 50,000 chars | 超过则持久化或工具自身分页 |
| 单工具硬上限 | 400,000 bytes | 超过必须持久化或报错 |
| 单批次模型内容 | 200,000 chars | 从最大结果开始替换为预览 |
| 持久化预览 | 2,000 chars | 包含开头、必要时加尾部摘要 |
| 错误文本上限 | 10,000 chars | 保留头尾，中间截断 |

最终值应按模型上下文动态缩放，不应永久写死。

### 16.2 LargeToolResultStore

CodeZ 的 Read 不允许 workspace 外路径，因此不能直接照搬 Claude Code 的“保存文件后让模型 Read 路径”。建议保存到：

```text
~/.codez/projects/<workspace-hash>/sessions/<session-id>/tool-results/<call-id>.<ext>
```

模型收到虚拟句柄：

```xml
<persisted-tool-result id="tool-result://call_123" original_chars="183420">
Output was too large. A preview follows.
...
</persisted-tool-result>
```

后续通过受控的 `ToolResultRead` 工具读取：

```ts
{
  handle: 'tool-result://call_123',
  offset: 1,
  limit: 200
}
```

`ToolResultRead` 只解析 opaque handle，不能接受任意文件路径，因此不破坏 workspace 边界。

### 16.3 持久化规则

- 文件使用 `wx` 或原子临时文件 + rename，避免同 call id 重写竞态；
- 元数据记录 content type、size、sha256、createdAt、sessionId、toolName；
- 结果保留期跟随 session retention；
- session 删除时清理结果；
- 敏感工具可以声明 `persist: never`；
- 图片/二进制结果不能作为普通文本落盘，必须使用 content block store；
- renderer 可读取完整 uiContent，但不得把未裁剪内容自动重新注入模型。

### 16.4 与 ToolOutputPruner 的关系

- `ToolResultProcessor` 控制新结果第一次进入 ledger 的大小；
- `ToolOutputPruner` 控制历史结果在上下文压力下的二次清理；
- 两者职责不同，不能互相替代；
- 已持久化结果在后续 prune 时保留 handle 和最小摘要；
- 未被下一条 assistant 消费的当前轮结果继续受 protected message 保护。

---

## 17. Ledger 与协议完整性

### 17.1 Canonical records

建议 ledger 分别记录：

```ts
interface ToolCallRecord {
  callId: string
  turnId: string
  position: number
  canonicalName: string
  requestedName: string
  rawArguments: string
  parsedInputHash?: string
  catalogSnapshotId: string
  exposurePlanId: string
  thoughtSignature?: string
  status: 'received' | 'validated' | 'authorized' | 'running' | 'completed'
}

interface ToolResultRecord {
  callId: string
  canonicalName: string
  status: 'success' | 'error' | 'denied' | 'cancelled'
  modelContent: ToolModelContent
  error?: ToolExecutionError
  fileReferences?: FileContextReference[]
  effects?: ToolEffectRecord[]
  startedAt: string
  completedAt: string
}
```

### 17.2 不变量

1. 每个 assistant tool call 恰好对应一个 tool result。
2. tool result 的 canonical name 与 call record 一致。
3. call id 在 session/context scope 内唯一。
4. 同批次结果按 call position 进入 Provider transcript。
5. cancelled/denied 也必须产生结果。
6. compaction 不得留下孤立 tool call 或 tool result。
7. session restore 后未完成调用不自动重放副作用；必须标记 interrupted 并由恢复策略处理。

### 17.3 幂等性

ToolDescriptor 可选声明：

```ts
idempotency?: {
  mode: 'none' | 'by-call-id' | 'by-input'
  key(input: unknown, ctx: ToolExecutionContext): string
}
```

- Read/Grep 可按 input cache；
- PushNotification、外部消息和写操作默认不自动重试；
- Provider timeout 后如果不确定工具是否执行，不得根据相同 call id 再次执行破坏性调用；
- transaction 和 effect record 用于判断已执行状态。

---

## 18. 完整执行生命周期

```mermaid
sequenceDiagram
  participant M as Model
  participant A as ToolCallAssembler
  participant R as ToolRuntime
  participant V as Validator
  participant P as PermissionEngine
  participant H as Hooks
  participant S as Scheduler
  participant T as ToolHandler
  participant B as ResultBudgeter
  participant L as Ledger

  M->>A: streamed tool fragments
  A->>A: assemble and finalize
  A->>R: NormalizedToolCall[]
  R->>R: resolve against catalog and exposure snapshot
  R->>V: parse and validate arguments
  V-->>R: PreparedToolCall or typed error
  R->>P: plan effects and authorize
  P-->>R: allow / ask / deny
  R->>H: before-execute
  H-->>R: continue / deny / replace input
  R->>S: schedule calls by resources
  loop each execution wave
    S->>T: execute typed input
    T-->>S: ToolExecutionResult
  end
  S->>H: after-execute / execute-failed
  H-->>R: enriched result
  R->>B: enforce per-tool and batch budgets
  B-->>R: model content + UI content + handles
  R->>L: durable call and result records
  L-->>M: provider-formatted tool results next loop
```

### 18.1 Pipeline 伪代码

```ts
async function executeBatch(
  calls: readonly NormalizedToolCall[],
  turn: ToolRuntimeTurnContext
): Promise<readonly CanonicalToolResult[]> {
  const prepared = await Promise.all(
    calls.map(call => prepareCall(call, turn.catalog, turn.exposure))
  )

  const authorized = await authorizePreparedCalls(prepared, turn)
  const waves = await scheduler.plan(authorized, turn)
  const rawResults = await scheduler.execute(waves, turn.abortSignal)
  const processed = await resultProcessor.processBatch(rawResults, turn.budget)

  await ledger.recordToolBatch(turn, processed)
  return processed.sort((a, b) => a.position - b.position)
}
```

### 18.2 prepareCall 顺序

```text
resolve canonical name / alias
→ verify tool existed in catalog snapshot
→ verify tool was exposed in this turn
→ parse JSON
→ normalize legacy aliases
→ validate schema
→ run before-validate/before-permission hooks
→ plan effects
→ compute resource keys
→ produce PreparedToolCall
```

---

## 19. 典型场景

### 19.1 批量 Read 后并行 Edit 不同文件

模型调用：

```text
Read(a.ts, b.ts)
```

下一轮调用：

```text
Edit(a.ts), Edit(b.ts)
```

Runtime 行为：

- 两个 Edit 都验证对应 Read fingerprint；
- effect plan 生成两个不同 write-file 路径；
- resource keys 不冲突，可同 wave 并行；
- 每个 Edit 仍进入同一个 transaction，但事务服务按路径资源锁保护；
- 结果按原始 call position 写回。

### 19.2 同文件双 Edit

模型同轮调用两个 `Edit(a.ts)`：

- scheduler 发现 `file:a.ts:write` 冲突；
- 按模型 position 串行执行；
- 第一个 Edit 更新 fingerprint；
- 第二个 Edit 若基于旧内容则返回 `STALE_FILE_CONTEXT`，不会覆盖第一个结果；
- 模型下一轮重新 Read 或根据 diff 调整。

### 19.3 延迟 WebSearch

初始 exposure 没有 WebSearch schema：

```text
ToolSearch("current web documentation")
```

ToolSearch 激活 WebSearch。下一 loop 的 schema fingerprint 变化并包含 WebSearch，模型才能调用。OpenAI、Anthropic、Gemini 均遵循相同两轮语义。

### 19.4 Shell 被拒绝

模型调用 `PowerShell(Remove-Item -Recurse ...)`：

- schema validation 通过；
- ShellAnalysisService 生成 delete/system effects；
- CriticalOperationGuard 或 deny rule 决定 ask/deny；
- 被拒绝时不进入 scheduler 和 handler；
- ledger 记录 denied result 和 rule id；
- 模型收到 typed error，不应重试相同调用。

### 19.5 大批量 Grep

三个并行 Grep 各返回 80K chars：

- 单工具超过 50K，三个结果分别持久化；
- 每个结果向模型返回 2K preview + handle；
- batch 总量保持在预算内；
- 模型可调用 `ToolResultRead` 定向读取某个 handle；
- 后续 context prune 只清理 preview，handle 仍有效。

### 19.6 用户 steer

用户在长 Bash 执行时发送新消息：

- 若 Bash 为前台且 `interrupt=cancel`，abort signal 终止子进程并记录 cancelled；
- 若为 background，则 `interrupt=detach`，新消息进入当前 turn continuation；
- Edit transaction commit 阶段为 `block`，必须先完成一致性收尾；
- 任何情况都不能留下 assistant tool call 没有 tool result。

---

## 20. 可观测性与审计

### 20.1 ToolExecutionJournal 事件

```text
catalog.snapshot.created
exposure.plan.created
tool.call.received
tool.call.validation_failed
tool.call.permission_started
tool.call.permission_decided
tool.call.queued
tool.call.started
tool.call.progress
tool.call.completed
tool.call.failed
tool.call.cancelled
tool.result.persisted
tool.batch.completed
```

### 20.2 必需字段

- sessionId、turnId、contextScopeId；
- callId、canonical tool name、source、descriptor version；
- catalog snapshot id、exposure plan id、schema fingerprint；
- permission mode、decision、rule id、审批耗时；
- queue duration、execution duration、hook duration；
- input bytes、result bytes、model result bytes、persisted bytes；
- status、error code、recoverable；
- resource key 数量、execution wave；
- Provider、model、API format。

### 20.3 数据保护

- 默认不记录完整命令、文件内容、URL query、tool args 或 tool output；
- 对路径只记录 workspace-relative path 或稳定 hash；
- debug 日志显式开启且标记可能包含敏感信息；
- permission audit 可保留必要的 normalized pattern，但必须有 retention；
- MCP/plugin 元数据在进入日志前按来源定义 redaction。

### 20.4 关键指标

- 每轮 eager schema token；
- deferred tool 激活率和 ToolSearch 命中率；
- TOOL_NOT_EXPOSED 发生率；
- 输入 schema validation failure rate；
- permission ask/allow/deny 比例和等待时间；
- 并行度、资源冲突串行率；
- 单批次结果大小和持久化率；
- 工具错误恢复成功率；
- Provider tool protocol error rate；
- V1/V2 同任务工具轮数和总 token 差异。

---

## 21. MCP、插件和 Skills 扩展点

### 21.1 ToolSourceAdapter

```ts
interface ToolSourceAdapter {
  readonly sourceId: ToolSourceId
  connect(signal: AbortSignal): Promise<void>
  listTools(): Promise<readonly ExternalToolDefinition[]>
  execute(name: string, input: unknown, ctx: ExternalToolContext): Promise<ToolExecutionResult>
  disconnect(): Promise<void>
}
```

### 21.2 外部工具默认策略

- canonical name 命名空间化；
- 默认 `exposure: deferred`；
- 默认 `concurrency: resource-locked` 或 `exclusive`，除非 adapter 明确证明只读安全；
- 默认 effect `external_effect + network`；
- schema 超限或包含不支持关键字时注册失败，不静默删约束；
- server instructions 作为独立、标明来源的上下文，不拼入核心 system prompt 静态前缀；
- MCP 返回的 `_meta` 和 structured content 存在 canonical result 的扩展字段，不直接混入模型文本。

### 21.3 Skill 与 Tool 的边界

- Skill 是加载工作流说明的工具，不自动获得额外权限；
- Skill 可以建议后续 ToolSearch，但不能直接注册任意本地执行代码；
- 将来 plugin skill 若附带工具，由 plugin adapter 单独注册并走完整权限；
- 用户手动 `/skill` 已加载的情况仍由 command metadata 去重。

---

## 22. 迁移方案

### Phase 0：基线与保护

目标：在不改变行为前建立可比较基线。

工作项：

- 固化当前 24 工具的 schema snapshot 测试；
- 固化三 Provider 的 tool call fragment fixtures；
- 记录典型任务的工具轮数、schema token、结果大小和权限行为；
- 为现有 AgentRunner 工具分发增加端到端 transcript 测试；
- 明确 dirty workspace 下测试不依赖工作区现有修改。

验收：

- 有可重复的 V1 baseline；
- 任何 V2 行为差异都能被解释，而不是无基准猜测。

### Phase 1：契约与 Registry，行为保持

新增建议模块：

```text
src/main/tools/runtime/ToolDescriptor.ts
src/main/tools/runtime/ToolHandler.ts
src/main/tools/runtime/ToolRegistry.ts
src/main/tools/runtime/ToolCatalogSnapshot.ts
src/main/tools/runtime/LegacyToolAdapter.ts
src/main/tools/runtime/ToolSchemaCompiler.ts
```

工作项：

- 用 LegacyToolAdapter 注册现有 24 个工具；
- ToolManager 暂时成为 ToolRegistry facade；
- snapshot 生成稳定 fingerprint；
- Provider schema 与当前输出做 golden comparison；
- AgentRunner 仍走原执行路径。

验收：

- 默认 feature flag 下用户行为不变；
- V2 registry 输出的 canonical schema 与 V1 等价；
- alias/冲突/平台 enable 有单元测试。

### Phase 2：Assembler、Validator 与 Execution Pipeline

新增建议模块：

```text
src/main/tools/runtime/ToolCallAssembler.ts
src/main/tools/runtime/ToolInputValidator.ts
src/main/tools/runtime/ToolExecutionPipeline.ts
src/main/tools/runtime/ToolResultNormalizer.ts
src/main/tools/runtime/ToolExecutionJournal.ts
```

工作项：

- Provider 输出 canonical fragments；
- AgentRunner 使用 assembler；
- Ajv 在 registry snapshot 时编译；
- Legacy adapter 继续承接 string output；
- 特殊工具逐个迁移为 handler；
- 通过 `CODEZ_TOOL_RUNTIME_V2` 灰度。

验收：

- 三 Provider 坏 JSON、碎片化参数、重复 fragment 测试通过；
- 每个 call 都有且仅有一个 result；
- AgentRunner 不再手工 JSON.parse 工具参数；
- V1/V2 transcript 语义等价。

### Phase 3：声明式权限与并发调度

新增建议模块：

```text
src/main/tools/runtime/ToolEffectPlanner.ts
src/main/tools/runtime/ToolScheduler.ts
src/main/tools/runtime/ResourceLockManager.ts
src/main/tools/runtime/ToolHookRunner.ts
```

工作项：

- 先为文件、Shell、Web、Task、Agent/Execution 工具实现 effect plan；
- PermissionManager 从 descriptor/effects 读取策略；
- 保留旧名称集合做 shadow comparison，不再作为最终决策；
- scheduler 替换无条件 Promise.all；
- Edit/Write/Task/Execution 加资源键；
- verification tracking 迁移为 after-execute hook。

验收：

- V1/V2 权限 shadow 决策差异都有测试或迁移说明；
- 同文件写不会并行；
- 不同文件写仍可并行；
- denied/cancelled 调用保持协议完整。

### Phase 4：动态暴露与 ToolSearch

新增建议模块：

```text
src/main/tools/runtime/ToolExposurePlanner.ts
src/main/tools/runtime/ToolExposureState.ts
src/main/tools/builtin/ToolSearchTool.ts
```

工作项：

- AvailableToolsModule 使用 exposure plan；
- 移除 eager 工具描述的 prompt 重复；
- 先只延迟 Web/Push/Notebook/低频 execution 工具；
- 采集 ToolSearch 失败和额外轮次成本；
- 按 Provider/model capability 设置 fallback：不支持或效果差时继续 eager load。

验收：

- 默认编码任务的 schema token 显著下降；
- 延迟工具可在所有 Provider 上通过下一轮激活；
- 未暴露工具不会被直接执行；
- session restore 保留已激活工具集合。

### Phase 5：大结果存储与结果原生化

新增建议模块：

```text
src/main/tools/runtime/ToolResultProcessor.ts
src/main/tools/runtime/LargeToolResultStore.ts
src/main/tools/builtin/ToolResultReadTool.ts
```

工作项：

- 单工具和单批次预算；
- tool-result URI；
- session retention cleanup；
- 现有工具逐个迁移 typed result；
- 删除 string error heuristic；
- renderer 直接消费 uiContent。

验收：

- 任意单轮工具结果不会突破 hard request budget；
- 大结果可按 handle 恢复读取；
- workspace 不出现缓存文件；
- 工具成功和错误不再双重 JSON 包装。

### Phase 6：外部工具与 Sandbox

工作项：

- ToolSourceAdapter；
- MCP prototype；
- 外部 schema normalization；
- Windows Bash/PowerShell sandbox capability 探测；
- internal hook 扩展为配置化 hooks。

此阶段单独立项，不作为 Tool Runtime V2 核心上线门槛。

---

## 23. Feature Flags 与回滚

建议开关：

```text
CODEZ_TOOL_RUNTIME_V2=0|1
CODEZ_TOOL_EFFECT_POLICY=0|shadow|enforce
CODEZ_TOOL_SCHEDULER=0|shadow|enforce
CODEZ_TOOL_SEARCH=0|1
CODEZ_TOOL_RESULT_STORE=0|1
CODEZ_TOOL_HOOKS=0|internal|configured
CODEZ_SHELL_SANDBOX=none|workspace|strict
```

规则：

- shadow 模式只计算决策，不改变实际行为；
- 每个开关都必须有独立回退路径；
- ledger schema 若新增字段，旧版本必须能忽略；
- V2 产生的 canonical result 必须能由 V1 session renderer 展示；
- ToolSearch 关闭时恢复 eager schema，不影响工具可用性；
- 结果 store 关闭时使用现有 ToolOutputPruner，但仍执行 hard size guard。

---

## 24. 测试策略

### 24.1 Registry 与 Schema

- canonical name 和 alias 冲突；
- 外部工具命名空间；
- snapshot 不可变；
- schema canonical JSON 稳定；
- description async 构建在同一 snapshot 只执行一次；
- Provider schema golden tests；
- disabled/denied 工具不暴露。

### 24.2 Provider protocol fixtures

OpenAI：

- name 和 arguments 跨多 chunk；
- 两个并行 tool calls index 交错；
- call id 后到；
- finish_reason 缺失或异常；
- OpenAI-compatible endpoint 返回非标准 reasoning 字段。

Anthropic：

- content block start/delta/stop；
- input_json_delta 跨 Unicode 边界；
- tool_use 与 text block 混合；
- thought signature 传递；
- stop_reason 为 tool_use。

Gemini：

- functionCall args 是 object；
- 多 functionCall parts；
- thoughtSignature；
- functionResponse 按批次回放；
- finishReason 未明确工具调用。

### 24.3 Validation

- 缺必填字段；
- unexpected property；
- enum/type/minItems/maxItems；
- 超大 arguments；
- 非 object 顶层；
- 空参数；
- alias normalization 后重新校验；
- Hook replace-input 后重新校验。

### 24.4 Permission

- workspace 内外路径；
- symlink/TOCTOU 重校验；
- sensitive credential path；
- shell nested command；
- explicit deny 优先于 full access；
- hardline 只能 once approval；
- headless agent 无审批 UI 时 fail closed；
- Executor lease 撤销；
- Hook 不可覆盖 hard deny。

### 24.5 Scheduler

- Read/Read 同文件并行；
- Read/Edit 同文件串行；
- Edit/Edit 同文件按 position；
- 不同文件 Edit 并行；
- 多资源锁无死锁；
- exclusive user interaction；
- abort/cancel/detach；
- wave 中一个失败不丢失其他结果；
- 结果顺序与模型调用 position 一致。

### 24.6 Result handling

- typed success/error/denied/cancelled；
- legacy string normalization；
- 单工具持久化；
- 单批次聚合预算；
- tool-result URI 越权；
- session cleanup；
- 二进制结果；
- renderer uiContent 不进入模型；
- compaction 后 handle 保留；
- 未消费结果受 prune 保护。

### 24.7 端到端任务

至少覆盖：

1. 定位并修改单文件，运行测试。
2. 批量读取并修改两个独立文件。
3. 同轮冲突双 Edit。
4. AskUserQuestion 后继续执行。
5. WebSearch 延迟激活。
6. Research 子代理只读限制。
7. DelegateTasks worktree wave。
8. Executor 被 stop 后拒绝后续工具。
9. 大 Grep 结果持久化再定向读取。
10. context overflow 压缩后继续工具协议。
11. session restore 后不重复外部副作用。
12. OpenAI、Anthropic、Gemini 各跑一遍核心 read/edit/verify 流程。

### 24.8 Fuzz 与属性测试

- 随机拆分 JSON arguments chunks，assembler 结果必须等于原 JSON；
- 任意 call list 执行后 call/result 数量相等；
- 任意资源键顺序都不会死锁；
- canonical schema 多次序列化 fingerprint 相同；
- 任意大结果处理后不超过 batch hard budget；
- denied tool 永远不会进入 handler execute mock。

---

## 25. 性能与容量目标

初始目标，不作为绝对 SLA：

- Registry snapshot 在无外部工具时低于 20 ms；
- 已编译 validator cache hit 时单调用校验低于 2 ms；
- scheduler 规划 32 个调用低于 5 ms；
- 不含用户等待时，权限与 hooks 框架开销低于 10 ms；
- 默认编码请求 eager schema token 比当前 24 全量方案降低至少 20%；
- result processor 能处理 10 个并行、每个 400 KB 的结果而不把完整内容复制进模型消息；
- journal 不记录内容时单调用附加数据低于 5 KB；
- 运行时内部 map/cache 都有 session 或 LRU 边界。

---

## 26. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 延迟工具增加一轮模型调用 | 某些任务更慢 | 只延迟低频工具，按日志调整，Provider 不适配时 eager fallback |
| schema 选择错误导致工具不可见 | 模型无法完成任务 | ToolSearch always visible，TOOL_NOT_EXPOSED 可恢复错误，任务信号预激活 |
| effect plan 漏报副作用 | 权限绕过 | 未解析 effect 按更高风险处理，shadow 对比，critical guard 保留 |
| scheduler 改变旧并发时序 | 行为回归 | 先 shadow 规划，结果仍按 position，逐工具声明资源 |
| typed result 迁移周期长 | 新旧结果混杂 | LegacyToolAdapter 集中兼容，禁止兼容逻辑扩散 |
| Ajv 与 Provider schema 支持不同 | Provider 拒绝 schema | canonical schema 子集规范，Provider compiler 降级必须显式报告 |
| 大结果保存敏感数据 | 磁盘泄露 | `persist: never`、目录权限、retention、清理和审计 |
| ToolResultRead 变成任意文件读取旁路 | 越权 | opaque handle、session 绑定、禁止路径输入、TTL 和 HMAC/随机 id |
| sandbox 能力不一致 | 用户误以为已隔离 | capability 明示，strict 不支持时 fail closed，日志记录实际模式 |
| dirty workspace 和事务交互复杂 | 覆盖用户修改 | Read fingerprint、CAS、事务备份、资源锁和用户 diff 审批保持 |
| catalog 在会话中变化 | schema/cache 不稳定 | 每轮 snapshot，不在流中热替换；变化只影响下一轮 |

---

## 27. 关键设计决策

### D1：保留 JSON Schema，不切换 Zod

决定：V2 使用 JSON Schema + Ajv。

理由：当前工具和三 Provider 已围绕 JSON Schema 工作，切换 Zod 会同时改变工具实现和 wire schema，扩大迁移面。

### D2：ToolSearch 使用“下一轮激活”

决定：所有 Provider 使用相同的两轮激活语义。

理由：只有 Anthropic 可能支持原生 deferred tool reference，CodeZ 不能让核心行为依赖某家 Provider。后续可为支持原生能力的 Provider 优化，但 canonical 语义保持一致。

### D3：不放宽 Read 工作区限制

决定：大结果通过 `tool-result://` 和 `ToolResultRead` 访问。

理由：允许 Read 任意外部路径会显著扩大权限面，只为读取运行时缓存不值得。

### D4：并发由资源声明控制

决定：不再把“同一模型响应里的调用”自动视为可并行。

理由：模型不知道事务、UI 和内部状态锁，Runtime 必须做最终仲裁。

### D5：特殊工具成为 handler，不留 AgentRunner 分支

决定：SubAgent、Delegate、Execution 和 AskUser 都通过相同 pipeline。

理由：权限、日志、取消和结果协议应一致；特殊业务可以特殊，但执行框架不能按名字增长。

### D6：结果进入 ledger 前完成预算

决定：ToolResultProcessor 在 `recordToolResult` 前运行。

理由：后续 pruning 无法挽救已经造成的单轮超大请求和持久 ledger 膨胀。

### D7：Catalog snapshot 按轮冻结

决定：工具连接变化不影响正在流式生成或执行的调用。

理由：模型看到的 schema、Runtime 查找和权限必须来自同一版本，否则存在 TOCTOU 和不可复现行为。

---

## 28. 建议的未来文件改动范围

以下仅用于后续实施规划，本次不修改：

| 区域 | 预计操作 |
|---|---|
| `src/main/tools/runtime/` | 新增 Tool Runtime 核心模块 |
| `src/main/tools/Tool.ts` | 保留 V1，逐步标记 legacy |
| `src/main/tools/ToolManager.ts` | 改为 Registry facade，最终删除固定数组职责 |
| `src/main/agent/AgentRunner/index.ts` | 移除 fragment 拼接、权限、特殊工具和结果包装细节 |
| `src/main/services/chat/*Provider.ts` | 输出 canonical fragments，保持 wire adapter 职责 |
| `src/main/services/PermissionManager.ts` | 消费 ToolEffectPlan，移除工具名能力 Set |
| `src/main/services/context/ModelContextBuilder.ts` | 接收 exposure plan/schema fingerprint |
| `src/main/services/context/ToolOutputPruner.ts` | 识别 persisted result handle |
| `src/main/services/prompts/dynamic/AvailableTools.ts` | 基于 exposure plan，不再 new ToolManager |
| `src/shared/types/provider.ts` | 增加 canonical provider fragment 类型或迁移到 runtime types |
| `src/shared/types/toolExecution.ts` | 扩展 typed result、progress 和 journal DTO |
| `src/tests/` | 增加 registry、assembler、scheduler、effect、result store 测试 |

---

## 29. 完成标准

Tool Runtime V2 只有满足以下条件才算完成：

- [ ] ToolRegistry 是工具身份、schema、权限 metadata 和行为 metadata 的单一事实源。
- [ ] 每次模型请求都绑定不可变 catalog snapshot 和 exposure plan。
- [ ] 三家 Provider 均通过 canonical ToolCallAssembler。
- [ ] 工具输入在 handler 前统一完成 JSON parse 和 schema validation。
- [ ] AgentRunner 不再按工具名分发特殊工具。
- [ ] PermissionManager 不再依赖工具名白名单判断主要 capability。
- [ ] 同文件写、用户交互和全局状态工具不会被无条件并行。
- [ ] 每个 assistant tool call 都有一个 durable result，包括 deny/cancel。
- [ ] 新工具原生返回 typed result，legacy 字符串兼容被隔离在 adapter。
- [ ] 单工具和单批次结果在进入 ledger 前受预算限制。
- [ ] 大结果可通过受控 handle 读取，不放宽 workspace 文件边界。
- [ ] eager schema 不再在 system prompt 中重复描述。
- [ ] deferred tool 在 OpenAI、Anthropic、Gemini 都能按下一轮激活。
- [ ] session restore、compaction、steer 和 abort 不破坏工具调用协议。
- [ ] V1/V2 有可比较基线、灰度开关和独立回滚路径。
- [ ] 新增架构有单元、集成、Provider fixture、并发和属性测试。
- [ ] 日志和审计默认不记录完整参数或结果内容。

---

## 30. 最终建议

实施顺序应严格遵循：

```text
契约与快照
→ Provider 调用归一化
→ 统一校验与执行管线
→ 声明式权限和调度
→ 动态工具暴露
→ 大结果存储
→ 外部工具与 sandbox
```

不建议先实现 MCP 或先删除 ToolManager。当前最重要的工作是把“模型看到的工具、Runtime 能执行的工具、权限判断的工具”收敛到同一个 catalog snapshot，并把 AgentRunner 中的工具细节迁移到独立执行管线。完成这一层后，MCP、插件、更多 Agent 类型和 Provider 特性才有稳定的接入基础。

