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
  /** 默认模型（未设置则跟随主 Agent） */
  defaultModel?: string
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
