import * as path from 'path'
import type { Tool, ToolContext } from '../Tool'
import type {
  AgentRole,
  ToolDescriptor,
  ToolEffect,
  ToolEffectPlan,
  ToolExecutionResult,
  ToolExposure,
  ToolHandler,
  ToolPlanningContext
} from './types'
import { fingerprint } from './canonicalJson'

const READ_ONLY = new Set([
  'Read', 'list_files', 'Glob', 'Grep', 'Skill', 'TaskGet', 'TaskList',
  'ExecutionInspect', 'update_resume_state', 'AskUserQuestion', 'ToolSearch', 'ToolResultRead',
  'ListMcpResources', 'ReadMcpResource', 'GetMcpPrompt'
])
const CORE = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'PowerShell'])
const ALWAYS = new Set(['AskUserQuestion', 'ToolSearch'])
const DEFERRED = new Set([
  'NotebookEdit', 'PushNotification', 'WebSearch', 'WebFetch',
  'Skill', 'rollback_last_edit', 'SubAgentRunner', 'DelegateTasks',
  'ExecutionControl', 'ExecutionInspect',
  'ListMcpResources', 'ReadMcpResource', 'GetMcpPrompt', 'McpAuth'
])
const EXCLUSIVE = new Set(['AskUserQuestion'])
const TASK_TOOLS = new Set(['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])
const MUTATING_TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

function exposureFor(name: string): ToolExposure {
  if (ALWAYS.has(name)) return 'always'
  if (CORE.has(name)) return 'core'
  if (DEFERRED.has(name)) return 'deferred'
  return 'core'
}

function rolesFor(name: string): readonly AgentRole[] | '*' {
  if (name === 'DelegateTasks' || name === 'ExecutionControl' || name === 'ExecutionInspect') {
    return ['main']
  }
  if (name === 'SubAgentRunner') return ['main']
  return '*'
}

function getPath(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.filePath ?? input.notebook_path ?? input.path
  return typeof value === 'string' ? value : undefined
}

function resolvePath(value: string, workspaceRoot: string): string {
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value))
}

function legacyError(content: string): boolean {
  const trimmed = content.trim()
  if (/^(Error:|Access denied\.|Hash mismatch!)/i.test(trimmed)) return true
  try {
    const parsed = JSON.parse(trimmed)
    return parsed?.ok === false || Boolean(parsed?.error && !parsed?.changedFiles)
  } catch {
    return false
  }
}

function normalizeLegacyContent(content: string): {
  ok: boolean
  data?: unknown
  modelContent: string
  error?: string
} {
  try {
    const parsed = JSON.parse(content)
    if (parsed?.ok === true) {
      const data = parsed.data
      return {
        ok: true,
        data,
        modelContent: typeof data === 'string' ? data : JSON.stringify(data)
      }
    }
    if (parsed?.ok === false) {
      const value = typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message || JSON.stringify(parsed.error)
      return { ok: false, modelContent: content, error: value }
    }
  } catch {}
  return { ok: !legacyError(content), data: content, modelContent: content, error: legacyError(content) ? content : undefined }
}

async function planLegacyEffects(
  name: string,
  rawInput: unknown,
  context: ToolPlanningContext
): Promise<ToolEffectPlan> {
  const input = rawInput && typeof rawInput === 'object'
    ? rawInput as Record<string, unknown>
    : {}
  const effects: ToolEffect[] = []
  const filePath = getPath(input)
  if (name === 'Read') {
    if (Array.isArray(input.files)) {
      for (const file of input.files) {
        const candidate = file && typeof file === 'object' ? (file as any).file_path : undefined
        if (typeof candidate === 'string') {
          effects.push({ kind: 'read-file', path: resolvePath(candidate, context.workspaceRoot), scope: 'workspace' })
        }
      }
    } else if (filePath) {
      effects.push({ kind: 'read-file', path: resolvePath(filePath, context.workspaceRoot), scope: 'workspace' })
    }
  } else if (filePath && ['Edit', 'Write', 'NotebookEdit'].includes(name)) {
    effects.push({
      kind: 'write-file',
      path: resolvePath(filePath, context.workspaceRoot),
      mode: name === 'Write' ? 'overwrite' : 'modify'
    })
  } else if (filePath && ['list_files', 'Glob', 'Grep'].includes(name)) {
    effects.push({ kind: 'read-file', path: resolvePath(filePath, context.workspaceRoot), scope: 'workspace' })
  } else if (name === 'Bash' || name === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : ''
    effects.push({ kind: 'execute-command', shell: name === 'Bash' ? 'bash' : 'powershell', command })
  } else if (name === 'WebSearch' || name === 'WebFetch') {
    const target = typeof input.url === 'string' ? input.url : typeof input.query === 'string' ? input.query : undefined
    effects.push({ kind: 'network', target })
  } else if (name === 'PushNotification') {
    effects.push({ kind: 'notify-user', channel: 'desktop' })
  } else if (name === 'SubAgentRunner' || name === 'DelegateTasks') {
    effects.push({ kind: 'spawn-agent', role: String(input.subagent_type || 'executor'), isolation: String(input.isolation || '') })
  } else if (name === 'ExecutionControl') {
    effects.push({
      kind: 'control-execution',
      executionId: String(input.execution_id || ''),
      action: String(input.action || '')
    })
  } else if (MUTATING_TASK_TOOLS.has(name) || name === 'update_resume_state') {
    effects.push({ kind: 'mutate-task-state', sessionId: context.sessionId })
  } else if (name === 'TaskGet' || name === 'TaskList') {
    effects.push({ kind: 'read-memory', path: `session:${context.sessionId || 'unknown'}:tasks` })
  } else if (name === 'AskUserQuestion') {
    effects.push({ kind: 'user-interaction', channel: 'ask-user' })
  } else if (name === 'ToolSearch' || name === 'ToolResultRead' || name === 'Skill') {
    effects.push({ kind: 'internal', target: name })
  } else if (name === 'rollback_last_edit') {
    effects.push({ kind: 'rollback', target: context.workspaceRoot })
  } else if (name === 'ListMcpResources' || name === 'ReadMcpResource' || name === 'GetMcpPrompt') {
    effects.push({ kind: 'network', target: `mcp:${String(input.server || '*')}` })
  } else if (name === 'McpAuth') {
    effects.push({ kind: 'network', target: `mcp-auth:${String(input.server || 'unknown')}` })
    effects.push({ kind: 'external-effect', target: `mcp-auth:${String(input.server || 'unknown')}` })
  } else if (name === 'ExecutionInspect') {
    effects.push({ kind: 'read-memory', path: `execution:${String(input.execution_id || 'unknown')}` })
  } else if (READ_ONLY.has(name)) {
    effects.push({ kind: 'read-memory', path: name })
  } else {
    effects.push({ kind: 'unknown', target: name })
  }
  return { effects, analysisStatus: effects.length > 0 ? 'parsed' : 'unparsed' }
}

async function resourceKeysFor(
  name: string,
  rawInput: unknown,
  context: ToolPlanningContext
): Promise<readonly string[]> {
  const input = rawInput && typeof rawInput === 'object'
    ? rawInput as Record<string, unknown>
    : {}
  if (name === 'Read' && Array.isArray(input.files)) {
    return input.files.flatMap((file) => {
      const candidate = file && typeof file === 'object' ? (file as any).file_path : undefined
      return typeof candidate === 'string'
        ? [`file:${resolvePath(candidate, context.workspaceRoot)}:read`]
        : []
    }).sort()
  }
  const filePath = getPath(input)
  if (filePath) {
    const access = ['Edit', 'Write', 'NotebookEdit'].includes(name) ? 'write' : 'read'
    return [`file:${resolvePath(filePath, context.workspaceRoot)}:${access}`]
  }
  if (TASK_TOOLS.has(name)) return [`session:${context.sessionId || 'unknown'}:tasks`]
  if (name === 'AskUserQuestion') return [`session:${context.sessionId || 'unknown'}:user-interaction`]
  if (name === 'ExecutionControl' || name === 'ExecutionInspect') {
    return [`execution:${String(input.execution_id || 'unknown')}`]
  }
  if (name === 'Bash' || name === 'PowerShell') return [`workspace:${context.workspaceRoot}:shell`]
  return []
}

export class LegacyToolAdapter implements ToolHandler<Record<string, unknown>, unknown> {
  readonly descriptor: ToolDescriptor

  constructor(readonly legacyTool: Tool) {
    const inputSchema = legacyTool.parameters_schema
    this.descriptor = {
      name: legacyTool.name,
      aliases: [],
      version: fingerprint({ name: legacyTool.name, description: legacyTool.description, inputSchema }).slice(0, 16),
      source: 'builtin',
      sourceId: 'codez:builtins',
      summary: legacyTool.summary,
      description: legacyTool.description,
      inputSchema,
      availability: {
        enabled: () => true,
        roles: rolesFor(legacyTool.name),
        exposure: exposureFor(legacyTool.name)
      },
      behavior: {
        readOnly: () => READ_ONLY.has(legacyTool.name),
        destructive: () => ['Write', 'rollback_last_edit', 'ExecutionControl'].includes(legacyTool.name),
        concurrency: EXCLUSIVE.has(legacyTool.name)
          ? 'exclusive'
          : ['Edit', 'Write', 'NotebookEdit', 'TaskCreate', 'TaskUpdate', 'ExecutionControl'].includes(legacyTool.name)
            ? 'resource-locked'
            : 'safe',
        interrupt: ['Bash', 'PowerShell'].includes(legacyTool.name) ? 'cancel' : 'block',
        maxResultChars: 50_000
      },
      planEffects: (input, context) => planLegacyEffects(legacyTool.name, input, context),
      resourceKeys: (input, context) => resourceKeysFor(legacyTool.name, input, context)
    }
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const runtimeOutput = context.runtimeToolInvoker
        ? await context.runtimeToolInvoker(this.descriptor.name, input, context)
        : null
      if (!runtimeOutput) {
        const typedResult = await this.legacyTool.executeTyped(input, context)
        if (typedResult) return typedResult
      }
      const output = runtimeOutput || await this.legacyTool.executeWithMetadata(JSON.stringify(input), context)
      const normalized = normalizeLegacyContent(output.content)
      if (!normalized.ok) {
        return {
          status: 'error',
          error: {
            code: 'LEGACY_TOOL_ERROR',
            message: (normalized.error || output.content).replace(/^Error:\s*/i, ''),
            recoverable: /re-read|retry|not found|not unique|hash mismatch/i.test(normalized.error || output.content)
          },
          modelContent: output.content,
          uiContent: output.uiContent
        }
      }
      return {
        status: 'success',
        data: normalized.data,
        modelContent: normalized.modelContent,
        uiContent: output.uiContent,
        fileReferences: output.fileReferences
      }
    } catch (error: any) {
      return {
        status: context.abortSignal?.aborted ? 'cancelled' : 'error',
        error: {
          code: context.abortSignal?.aborted ? 'TOOL_CANCELLED' : 'LEGACY_TOOL_EXCEPTION',
          message: error?.message || String(error),
          recoverable: false
        }
      }
    }
  }
}
