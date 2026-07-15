export interface SubAgentModelSelection {
  providerId: string
  model: string
}

/** 子智能体的展示信息 —— 用于设置页面渲染与开关控制 */
export interface SubAgentInfo {
  /** 子智能体类型标识（唯一） */
  type: string
  /** 一句话描述 */
  description: string
  /** 主 Agent 何时应委派给此子 Agent */
  whenToUse?: string
  /** 调用成本提示 */
  costHint?: string
  /** 是否启用（false 时对主 Agent 不可见） */
  enabled: boolean
  /** 用户手动指定的 Provider 与模型；未设置时使用默认策略 */
  configuredModels?: SubAgentModelSelection[]
}

/** 子智能体输出字段（镜像 main 侧 SubAgentOutputField） */
export interface SubAgentOutputFieldInfo {
  name: string
  type: string
  description: string
  required: boolean
}

/** 子智能体完整详情 —— 用于「查看详情」弹窗 */
export interface SubAgentDetail extends SubAgentInfo {
  /** 主 Agent 何时不应委派 */
  whenNotToUse?: string
  /** 最大工具调用轮数 */
  maxLoops: number
  /** 隔离方式 */
  isolation?: string
  /** 是否可后台运行 */
  canRunInBackground?: boolean
  /** 可用工具名列表 */
  tools: string[]
  /** 结构化输出规格（若有） */
  outputSpec?: {
    description: string
    fields: SubAgentOutputFieldInfo[]
  }
  /**
   * 完整系统提示词预览。
   * 运行时才注入的动态值以 {{...}} 占位标注。
   */
  systemPrompt: string
}

/** 主进程对指定会话当前执行状态的权威快照。 */
export interface SessionRuntimeStatus {
  sessionId: string
  mainRunnerActive: boolean
  activeSubAgentIds: string[]
}

/** 会话 runtime 状态变化事件；version 在同一会话内单调递增。 */
export interface SessionRuntimeStatusChanged {
  version: number
  status: SessionRuntimeStatus
}

export interface SubAgentHandoffTool {
  name: string
  status: 'success' | 'error' | 'interrupted'
  target?: string
  summary?: string
}

/** SubAgent 未完成时交给主 Agent 的有界、结构化执行快照。 */
export interface SubAgentHandoff {
  reasonCode: 'parent_interrupted' | 'provider_error' | 'protocol_failure' | 'runtime_error' | 'runtime_missing' | 'parent_delivery_missing'
  reason: string
  originalTask: string
  knownContext?: string
  scope?: { directories?: string[]; excludeGlobs?: string[] }
  expectations?: { questions: string[]; outOfScope?: string[] }
  depth?: 'quick' | 'normal' | 'exhaustive'
  lastProgress?: string
  filesExamined: string[]
  filesModified: string[]
  filesPossiblyModified: string[]
  recentTools: SubAgentHandoffTool[]
  workspaceMayHaveUntrackedChanges: boolean
  canResume: boolean
}

export type AgentMessageType = 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER'
export type AgentRuntimeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface AgentResultSnapshot {
  status: Exclude<AgentRuntimeStatus, 'queued' | 'running'>
  report: string
  conclusion?: string
  qualitySummary?: {
    coverage: number
    confidence: string
    unresolvedCount: number
    filesExaminedCount: number
    warning: string | null
  }
  toolCallCount: number
  filesExamined: string[]
  handoff?: SubAgentHandoff
}

/** Durable identity and latest result for one addressable SubAgent thread. */
export interface AgentRecord {
  id: string
  sessionId: string
  parentAgentId: string
  parentPath: string
  path: string
  type: string
  taskName: string
  description: string
  status: AgentRuntimeStatus
  contextScopeId: `subagent:${string}`
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  runCount: number
  launch?: AgentLaunchSnapshot
  result?: AgentResultSnapshot
}

/** Persisted mailbox envelope. Payload is Markdown for model-facing messages. */
export interface AgentMailboxMessage {
  id: string
  sessionId: string
  type: AgentMessageType
  author: string
  recipient: string
  payload: string
  createdAt: number
  readAt?: number
}

/** Spawn-time constraints retained for durable follow-up turns. */
export interface AgentLaunchSnapshot {
  context?: string
  expectations?: { questions: string[]; outOfScope?: string[] }
  scope?: { directories?: string[]; excludeGlobs?: string[] }
  depth?: 'quick' | 'normal' | 'exhaustive'
  permissionScope?: {
    allowedWriteFiles?: string[]
    allowBash?: boolean
    shellPolicy?: 'verification'
    allowAllWritesInWorkspace?: boolean
  }
}

export interface AgentRuntimeSnapshot {
  version: 1
  agents: AgentRecord[]
  messages: AgentMailboxMessage[]
}
