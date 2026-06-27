# 16. 关键数据结构

> 模块：推荐 TypeScript 类型定义

---

## 1. ModelProviderConfig

```ts
export interface ModelProviderConfig {
  id: string
  name: string
  type: 'openai-compatible' | 'deepseek' | 'qwen' | 'glm' | 'ollama' | 'custom'
  baseUrl: string
  apiKeyRef?: string
  defaultModel: string
  enabled: boolean
  timeoutMs: number
  maxContextTokens?: number
  maxOutputTokens?: number
}
```

---

## 2. Workspace

```ts
export interface Workspace {
  id: string
  rootPath: string
  name: string
  projectType: string
  openedAt: string
  lastOpenedAt: string
  ignoredPatterns: string[]
}
```

---

## 3. AgentTask

```ts
export interface AgentTask {
  id: string
  workspaceId: string
  sessionId: string
  title: string
  userRequest: string
  status:
    | 'pending'
    | 'planning'
    | 'waiting_permission'
    | 'running'
    | 'waiting_diff_approval'
    | 'verifying'
    | 'completed'
    | 'failed'
    | 'cancelled'
  plan: AgentPlanStep[]
  affectedFiles: string[]
  createdAt: string
  updatedAt: string
}
```

---

## 4. AgentPlanStep

```ts
export interface AgentPlanStep {
  id: string
  title: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  expectedTools: string[]
}
```

---

## 5. ToolCall

```ts
export interface ToolCall {
  id: string
  taskId?: string
  toolName: string
  args: unknown
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  result?: unknown
  error?: string
  startedAt: string
  endedAt?: string
}
```

---

## 6. FileChange

```ts
export interface FileChange {
  id: string
  taskId: string
  filePath: string
  changeType: 'create' | 'modify' | 'delete' | 'rename'
  reason: string
  beforeContent?: string
  afterContent?: string
  diff: string
  status: 'pending' | 'accepted' | 'rejected' | 'applied' | 'failed'
}
```

---

## 7. CommandExecution

```ts
export interface CommandExecution {
  id: string
  taskId?: string
  command: string
  cwd: string
  purpose: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'denied'
  stdout: string
  stderr: string
  exitCode?: number
  startedAt: string
  endedAt?: string
  durationMs?: number
}
```

---

## 8. PermissionRequest

```ts
export interface PermissionRequest {
  id: string
  taskId?: string
  action: 'read_sensitive_file' | 'write_file' | 'delete_file' | 'run_command' | 'git_commit' | 'git_push' | 'network_access'
  title: string
  description: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  payload: unknown
  status: 'pending' | 'approved' | 'denied'
  createdAt: string
  resolvedAt?: string
}
```
