export type {
  WorkspaceInfo,
  FileTreeNode,
  FileContent,
  ProjectInfo,
} from './workspace'

export type {
  ProviderConfig,
  ProviderInfo,
  ProviderFormData,
  ModelInfo,
  ConnectionTestResult,
  ChatMessage,
  ChatStreamChunk,
  ChatStreamEnd,
} from './provider'

export type {
  ProjectSnapshot,
  ProjectSnapshotOptions,
  ReadManyFilesOptions,
  ReadManyFilesResult,
  SearchCodeOptions,
  CodeSearchResult,
  SymbolMapOptions,
  SymbolMapResult,
} from './project-analysis'

export interface AgentTask {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  createdAt: string
}

export type {
  SessionData
} from './session'

