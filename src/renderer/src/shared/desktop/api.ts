import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type {
  DesktopEvent,
  EditorInfo,
  FileContent,
  FileTreeNode,
  GitSnapshotResult,
  GlobResult,
  GrepResult,
  HealthResponse,
  ProjectInfo,
  ProjectSnapshotResult,
  SystemProbeEvent,
  ThemeInfo,
  ThemeSource,
  WindowAction,
  WorkspaceInfo,
  WorkspacePathItem,
  WorktreeInfo,
  AttachmentPreviewBytes as WireAttachmentPreviewBytes,
  ComposerImageAttachment as WireComposerImageAttachment,
  DraftImageAttachment as WireDraftImageAttachment,
  SessionImageAttachment as WireSessionImageAttachment,
  ProviderInfo,
  ProviderFormData,
  ConnectionTestResult,
  ChatAskUserAnswer,
  ChatAskUserRequest,
  ChatAskUserRequestEvent,
  ChatCompactionResponse,
  ContextCompactionCompleted,
  ContextCompactionFailed,
  ContextCompactionStarted,
  ChatHistoryRevertPreview,
  ChatHistoryRevertResult,
  ChatPermissionApprovalEvent,
  ChatStreamFrame as WireChatStreamFrame,
  McpReverseRequestEvent,
  McpReverseRequestResponse,
  SubAgentDetailResult,
  SubAgentInfo,
  SubAgentModelSelection,
  SubAgentRunCancelResult,
  SubAgentRunRequest,
  SubAgentRunState,
  SubAgentSettingsDetail,
  AgentActiveIdsResult,
  AgentRuntimeSnapshot,
  TodoItem as WireTodoItem,
  TodoListSnapshot,
} from './generated/contracts'
import type {
  ContextBudgetSnapshot,
  LedgerAppendRequest,
  LedgerEvent,
  SessionRuntimeSnapshot,
  StreamRequestV2
} from '@shared/types/context'
import type { SessionData } from '@shared/types/session'
import type {
  PromptPredictionRequest,
  PromptPredictionResponse
} from '@shared/types/promptPrediction'
import type {
  SessionRuntimeStatus,
  SessionRuntimeStatusChanged
} from '@shared/types/subagent'
import type { ChatSteerInput, ChatSteerResult } from '@shared/types/queuedPrompt'
import type { PermissionMode } from '@shared/types/permission'
import type { RuleFile } from '@shared/types/rules'
import type { PermissionApprovalResponse } from '@shared/types/permission'
import type { ToolBatchMeta } from '@shared/types/toolExecution'
import type {
  ExternalSkillCheckResult,
  ExternalSkillGroup,
  SkillDefinition
} from '@shared/types/skill'
import type {
  AttachmentPreviewBytes as UiAttachmentPreviewBytes,
  ComposerImageAttachment as UiComposerImageAttachment,
  DraftImageAttachment as UiDraftImageAttachment,
  ImageAttachment as UiSessionImageAttachment,
  ImageMimeType
} from '@shared/types/attachment'
import {
  defaultSettings,
  defaultWebSearchSettings,
  type GeneralSettings
} from '@shared/types/settings'
import type {
  McpListPayload,
  McpPromptGetResult,
  McpResourceReadResult,
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
} from '../../components/SettingsMcpTab/types'
import { normalizeDesktopError } from './errors'
import { desktopEvents, getLegacyTodoRevision } from './events'

type RendererLogLevel = 'debug' | 'info' | 'warn' | 'error'

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args)
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return true
  if ('__TAURI_INTERNALS__' in window) return true
  return !(window as unknown as { api?: Window['api'] }).api
}

function legacyWorkspace(): Window['api']['workspace'] {
  const workspace = (window as unknown as { api?: Window['api'] }).api?.workspace
  if (!workspace) throw new Error('The desktop workspace API is unavailable.')
  return workspace
}

function legacyProvider(): Window['api']['provider'] {
  const provider = (window as unknown as { api?: Window['api'] }).api?.provider
  if (!provider) throw new Error('The desktop provider API is unavailable.')
  return provider
}

function legacyTheme(): Window['api']['theme'] {
  const theme = (window as unknown as { api?: Window['api'] }).api?.theme
  if (!theme) throw new Error('The desktop theme API is unavailable.')
  return theme
}

function legacySettings(): Window['api']['settings'] {
  const settings = (window as unknown as { api?: Window['api'] }).api?.settings
  if (!settings) throw new Error('The desktop settings API is unavailable.')
  return settings
}

function legacyPermission(): Window['api']['permission'] {
  const permission = (window as unknown as { api?: Window['api'] }).api?.permission
  if (!permission) throw new Error('The desktop permission API is unavailable.')
  return permission
}

function legacyRules(): Window['api']['rules'] {
  const rules = (window as unknown as { api?: Window['api'] }).api?.rules
  if (!rules) throw new Error('The desktop rules API is unavailable.')
  return rules
}

function sendLegacyWindowControl(action: WindowAction): void {
  const ipcRenderer = (window as unknown as {
    electron?: { ipcRenderer?: { send(channel: string, ...args: unknown[]): void } }
  }).electron?.ipcRenderer
  if (!ipcRenderer) throw new Error('The desktop window API is unavailable.')

  const legacyAction = action === 'toggleMaximize' ? 'maximize' : action
  ipcRenderer.send('window-control', legacyAction)
}

function legacyAttachment(): Window['api']['attachment'] {
  const attachment = (window as unknown as { api?: Window['api'] }).api?.attachment
  if (!attachment) throw new Error('The desktop attachment API is unavailable.')
  return attachment
}

function legacyChat(): Window['api']['chat'] {
  const chat = (window as unknown as { api?: Window['api'] }).api?.chat
  if (!chat) throw new Error('The desktop chat API is unavailable.')
  return chat
}

async function invokeLegacyChatHistory<T>(
  channel: 'chat:revert-messages' | 'chat:preview-revert-messages',
  sessionId: string,
  messageId: string,
  transactionIds: string[]
): Promise<T> {
  const ipcRenderer = (window as unknown as {
    electron?: {
      ipcRenderer?: {
        invoke<T>(channel: string, ...args: unknown[]): Promise<T>
      }
    }
  }).electron?.ipcRenderer
  if (!ipcRenderer) throw new Error('The desktop chat history API is unavailable.')
  return ipcRenderer.invoke<T>(channel, sessionId, messageId, transactionIds)
}

function legacySession(): Window['api']['session'] {
  const session = (window as unknown as { api?: Window['api'] }).api?.session
  if (!session) throw new Error('The desktop session API is unavailable.')
  return session
}

function legacyTerminal(): Window['api']['terminal'] {
  const terminal = (window as unknown as { api?: Window['api'] }).api?.terminal
  if (!terminal) throw new Error('The desktop terminal API is unavailable.')
  return terminal
}

function legacyMcp(): Window['api']['mcp'] {
  const mcp = (window as unknown as { api?: Window['api'] }).api?.mcp
  if (!mcp) throw new Error('The desktop MCP API is unavailable.')
  return mcp
}

function legacySkill(): Window['api']['skill'] {
  const skill = (window as unknown as { api?: Window['api'] }).api?.skill
  if (!skill) throw new Error('The desktop skill API is unavailable.')
  return skill
}

function legacyTask(): Window['api']['task'] {
  const task = (window as unknown as { api?: Window['api'] }).api?.task
  if (!task) throw new Error('The desktop task API is unavailable.')
  return task
}

function legacySubAgent(): Window['api']['subAgent'] {
  const subAgent = (window as unknown as { api?: Window['api'] }).api?.subAgent
  if (!subAgent) throw new Error('The desktop sub-agent API is unavailable.')
  return subAgent
}

function legacyLogger(): Window['api']['logger'] {
  const logger = (window as unknown as { api?: Window['api'] }).api?.logger
  if (!logger) throw new Error('The desktop logger API is unavailable.')
  return logger
}

async function legacyEditorInfo(): Promise<EditorInfo[]> {
  const editors = await legacyWorkspace().detectInstalledEditors()
  return editors.map((editor) => ({
    id: editor.id,
    name: editor.name,
    exePath: editor.exePath ?? undefined,
    iconData: editor.iconPath ?? undefined
  }))
}

async function workspaceCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function providerCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function permissionCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function rulesCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function attachmentCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function sessionCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function terminalCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function chatCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function mcpCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function skillCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function executionHistoryCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function todoCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function agentCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function subAgentCommand<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  electron: () => Promise<T>
): Promise<T> {
  if (isTauriRuntime()) return command<T>(name, args)
  try {
    return await electron()
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

async function rendererLogCommand(level: RendererLogLevel, message: string): Promise<void> {
  if (isTauriRuntime()) {
    await command<void>('renderer_log', { level, message })
    return
  }
  try {
    legacyLogger()[level](message)
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ExecutionHistoryRecord {
  id: string
  projectId?: string
  title?: string
  timestamp?: string | number
  status?: string
  description?: string
  filesModified?: string[]
  commandsRun?: string[]
}

export type SubAgentDetailResponse = SubAgentDetailResult | SubAgentSettingsDetail | null

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  throw new Error(`The desktop returned a task with an invalid ${field}.`)
}

function optionalTaskTimestamp(value: unknown): string | number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('The desktop returned a task with an invalid timestamp.')
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  throw new Error(`The desktop returned a task with an invalid ${field}.`)
}

function normalizeExecutionHistoryRecord(value: unknown): ExecutionHistoryRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('The desktop returned a task without a valid id.')
  }

  return {
    id: value.id,
    projectId: optionalString(value.projectId, 'project id'),
    title: optionalString(value.title, 'title'),
    timestamp: optionalTaskTimestamp(value.timestamp),
    status: optionalString(value.status, 'status'),
    description: optionalString(value.description, 'description'),
    filesModified: optionalStringArray(value.filesModified, 'filesModified'),
    commandsRun: optionalStringArray(value.commandsRun, 'commandsRun')
  }
}

function normalizeExecutionHistoryRecords(value: unknown): ExecutionHistoryRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('The desktop returned an invalid task list.')
  }
  return value.map(normalizeExecutionHistoryRecord)
}

function legacyTodoItem(task: import('@shared/types/todo').TodoItem): WireTodoItem {
  const requiresApproval = task.requiresApproval === true
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    files: task.files,
    activeForm: task.activeForm,
    groupId: task.groupId,
    groupTitle: task.groupTitle,
    groupSubtitle: task.groupSubtitle,
    riskLevel: task.riskLevel,
    requiresApproval,
    approvalStatus: task.approvalStatus ?? (requiresApproval ? 'pending' : 'not_required'),
    acceptanceCriteria: task.acceptanceCriteria,
    verificationCommand: task.verificationCommand,
    contextBundle: task.contextBundle
  }
}

async function legacyTodoSnapshot(sessionId: string): Promise<TodoListSnapshot> {
  const session = await legacySession().get(sessionId)
  return {
    version: 1,
    sessionId,
    revision: getLegacyTodoRevision(sessionId),
    nextSequence: 0,
    items: (session?.tasks ?? []).map(legacyTodoItem)
  }
}

async function unavailableLegacyAgentSnapshot(): Promise<never> {
  throw new Error('Typed Agent lifecycle snapshots are unavailable in the frozen Electron runtime.')
}

export interface ChatStreamHandle {
  stop(): void
  started: Promise<void>
}

export interface ChatToolInterruptResult {
  ok: boolean
  status?: 'running' | 'completed' | 'failed' | 'interrupted'
  taskId?: string
  error?: string
}

export interface ChatFileDiff {
  path: string
  diff: string
}

/** Renderer-safe form of a runtime permission request. */
export interface ChatPermissionRequest {
  id: string
  sessionId?: string
  agentId?: string
  toolName: string
  description: string
  args: Record<string, unknown>
  checks: ChatPermissionApprovalEvent['request']['checks']
  allowedScopes: PermissionApprovalResponse['scope'][]
  action: 'ask'
  permission: 'hardline' | 'unknown'
  analysisStatus: 'parsed'
  hardline: boolean
  riskLevel: 2 | 4
  reason: string
  ruleId: 'runtime-policy'
  normalizedPattern: string
  impacts: []
  snapshots: []
  critical: boolean
  absoluteRedline: boolean
}

export interface ChatStreamCallbacks {
  onChunk(delta: string, reasoningDelta?: string): void
  onDone(fullContent: string, stopReason?: string, txId?: string): void
  onError(error: string, txId?: string): void
  onSteerConsumed?(input: ChatSteerInput): void
  onToolStart?(
    toolCallId: string,
    name: string,
    args: string,
    thoughtSignature?: string,
    batch?: ToolBatchMeta
  ): void
  onToolEnd?(toolCallId: string, result: string): void
  onPermissionRequest?(request: ChatPermissionRequest): void
  onAskUserRequest?(request: ChatAskUserRequest): void
  onSubAgentStart?(subAgentId: string, meta: unknown): void
  onSubAgentEnd?(subAgentId: string, result: unknown): void
  onSubAgentChunk?(subAgentId: string, delta: string, reasoningDelta: string): void
  onSubAgentToolStart?(
    subAgentId: string,
    toolCallId: string,
    name: string,
    args: string,
    thoughtSignature?: string
  ): void
  onSubAgentToolEnd?(subAgentId: string, toolCallId: string, result: string): void
  onContextBudget?(snapshot: ContextBudgetSnapshot): void
  onCompactionStarted?(payload: ContextCompactionStarted): void
  onCompactionCompleted?(payload: ContextCompactionCompleted): void
  onCompactionFailed?(payload: ContextCompactionFailed): void
}

type TauriChatStreamFrame = WireChatStreamFrame

function isTauriChatStreamFrame(value: unknown): value is TauriChatStreamFrame {
  if (!isRecord(value) || !isRecord(value.payload)) return false
  return value.version === 1
    && typeof value.runId === 'string'
    && value.runId.length > 0
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) >= 0
    && typeof value.kind === 'string'
    && [
      'delta', 'steerConsumed', 'completed', 'failed', 'interrupted', 'usage', 'contextBudget',
      'contextCompactionStarted', 'contextCompactionCompleted', 'contextCompactionFailed',
      'toolCalls', 'toolResult'
    ].includes(value.kind)
}

function permissionRequestForUi(
  request: ChatPermissionApprovalEvent['request']
): ChatPermissionRequest {
  const checks = Array.isArray(request.checks) ? request.checks : []
  const absoluteRedline = checks.some((check) => check.absoluteRedline)
  return {
    id: request.id,
    sessionId: request.sessionId,
    agentId: request.agentRole,
    toolName: request.toolName,
    description: request.description,
    args: request.input,
    checks,
    allowedScopes: request.allowedScopes,
    action: 'ask',
    permission: absoluteRedline ? 'hardline' : 'unknown',
    analysisStatus: 'parsed',
    hardline: absoluteRedline,
    riskLevel: absoluteRedline ? 4 : 2,
    reason: request.description || 'Tool execution requires approval.',
    ruleId: 'runtime-policy',
    normalizedPattern: request.toolName || 'unknown',
    impacts: [],
    snapshots: [],
    critical: absoluteRedline,
    absoluteRedline
  }
}

function ignoredAskUserAnswers(request: ChatAskUserRequest): ChatAskUserAnswer[] {
  return request.questions.map((question) => ({
    question: question.question,
    answer: question.multiSelect ? ['__IGNORED__'] : '__IGNORED__'
  }))
}

function normalizeSettings(value: unknown): GeneralSettings {
  const settings = isRecord(value) ? value : {}
  const webSearch = isRecord(settings.webSearch) ? settings.webSearch : {}
  const engines = isRecord(webSearch.engines) ? webSearch.engines : {}

  return {
    ...defaultSettings,
    ...settings,
    webSearch: {
      ...defaultWebSearchSettings,
      ...webSearch,
      engines: {
        ...defaultWebSearchSettings.engines,
        ...engines
      }
    }
  } as GeneralSettings
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
}

function boundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength
}

function isMcpReverseRequestEvent(value: unknown): value is McpReverseRequestEvent {
  if (!isRecord(value)) return false
  if (
    !boundedString(value.requestId, 512)
    || !boundedString(value.serverName, 512)
    || !boundedString(value.fingerprint, 512)
    || (value.policy !== 'ask' && value.policy !== 'allow')
    || !isRecord(value.request)
  ) {
    return false
  }

  const { request } = value
  if (request.kind === 'sampling') {
    return Number.isSafeInteger(request.maxTokens)
      && (request.maxTokens as number) > 0
      && Number.isSafeInteger(request.messageCount)
      && (request.messageCount as number) >= 0
      && typeof request.hasSystemPrompt === 'boolean'
  }
  if (request.kind === 'elicitationUrl') {
    return boundedText(request.message, 8_192) && boundedString(request.origin, 8_192)
  }
  if (request.kind === 'elicitationForm') {
    return boundedText(request.message, 8_192) && isRecord(request.requestedSchema)
  }
  return false
}

export interface TerminalOutputEvent {
  workspaceId: string
  data: string | Uint8Array
  sequence?: number
}

export interface TerminalExitEvent {
  workspaceId: string
  exitCode: number | null
}

function terminalOutputEvent(value: unknown): TerminalOutputEvent | null {
  if (!isRecord(value)) return null
  const { id, data, sequence } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return null
  if (typeof data === 'string') return { workspaceId: id, data, sequence: sequence as number }
  if (!Array.isArray(data) || data.length > 4_096) return null

  const bytes = new Uint8Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index]
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null
    bytes[index] = byte
  }
  return { workspaceId: id, data: bytes, sequence: sequence as number }
}

function terminalExitEvent(value: unknown): TerminalExitEvent | null {
  if (!isRecord(value)) return null
  const { id, exit_code: exitCode } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)) return null
  return { workspaceId: id, exitCode: exitCode as number | null }
}

function sessionString(value: unknown, field: string): string {
  if (typeof value === 'string') return value
  throw new Error(`The desktop returned a session with an invalid ${field}.`)
}

function requiredSessionString(value: unknown, field: string): string {
  const result = sessionString(value, field)
  if (result.length > 0) return result
  throw new Error(`The desktop returned a session with an invalid ${field}.`)
}

function normalizeSessionMessage(value: unknown): SessionData['messages'][number] {
  if (!isRecord(value)) {
    throw new Error('The desktop returned an invalid session message.')
  }

  return {
    ...value,
    id: requiredSessionString(value.id, 'message id'),
    role: requiredSessionString(value.role, 'message role'),
    content: sessionString(value.content, 'message content')
  } as SessionData['messages'][number]
}

/**
 * Session commands currently cross the Tauri boundary as JSON values. Validate
 * the stable persisted fields here while retaining richer renderer-only fields
 * such as execution timelines and permission requests for round-trip storage.
 */
function normalizeSession(value: unknown): SessionData {
  if (!isRecord(value)) {
    throw new Error('The desktop returned an invalid session document.')
  }
  if (!Array.isArray(value.messages)) {
    throw new Error('The desktop returned a session without a message list.')
  }

  return {
    ...value,
    id: requiredSessionString(value.id, 'id'),
    projectId: requiredSessionString(value.projectId, 'project id'),
    summary: sessionString(value.summary, 'summary'),
    relativeTime: sessionString(value.relativeTime, 'relative time'),
    messages: value.messages.map(normalizeSessionMessage)
  } as SessionData
}

function imageMimeType(value: string): ImageMimeType {
  if (value === 'image/jpeg' || value === 'image/png' || value === 'image/webp') return value
  throw new Error('The desktop returned an unsupported attachment MIME type.')
}

function attachmentSize(value: bigint | number): number {
  const size = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('The desktop returned an attachment size outside the supported range.')
  }
  return size
}

function wireAttachmentToUi(attachment: WireComposerImageAttachment): UiComposerImageAttachment {
  const common = {
    id: attachment.id,
    kind: 'image' as const,
    name: attachment.name,
    mimeType: imageMimeType(attachment.mimeType),
    width: attachment.width,
    height: attachment.height,
    sizeBytes: attachmentSize(attachment.sizeBytes as bigint | number),
    storageKey: attachment.storageKey
  }
  if ('draftId' in attachment) {
    return { ...common, scope: 'draft', draftId: attachment.draftId }
  }
  return { ...common, scope: 'session', sessionId: attachment.sessionId }
}

function uiAttachmentToWire(attachment: UiComposerImageAttachment): WireComposerImageAttachment {
  return attachment as unknown as WireComposerImageAttachment
}

function wirePreviewToUi(preview: WireAttachmentPreviewBytes): UiAttachmentPreviewBytes {
  return {
    mimeType: imageMimeType(preview.mimeType),
    bytes: new Uint8Array(preview.bytes)
  }
}

export interface DesktopApi {
  capabilities: {
    readonly plan: boolean
  }
  system: {
    health(): Promise<HealthResponse>
    probe(): Promise<Array<DesktopEvent<SystemProbeEvent>>>
  }
  window: {
    control(action: WindowAction): Promise<void>
    openExternal(target: string): Promise<void>
  }
  logger: {
    debug(message: string): Promise<void>
    info(message: string): Promise<void>
    warn(message: string): Promise<void>
    error(message: string): Promise<void>
  }
  workspace: {
    openDirectory(): Promise<string | null>
    scanFileTree(rootPath: string): Promise<FileTreeNode[]>
    getAllPaths(rootPath: string): Promise<WorkspacePathItem[]>
    readFile(filePath: string, rootPath: string): Promise<FileContent>
    detectProject(rootPath: string): Promise<ProjectInfo>
    getRecentProjects(): Promise<WorkspaceInfo[]>
    addRecentProject(project: WorkspaceInfo): Promise<void>
    removeRecentProject(id: string): Promise<void>
    renameRecentProject(id: string, newName: string): Promise<void>
    glob(rootPath: string, pattern: string, path?: string, headLimit?: number): Promise<GlobResult>
    grep(
      rootPath: string,
      pattern: string,
      options?: {
        path?: string
        outputMode?: string
        globFilter?: string
        typeFilter?: string
        caseInsensitive?: boolean
        multiline?: boolean
        contextAfter?: number
        contextBefore?: number
        contextAround?: number
        lineNumbers?: boolean
        onlyMatching?: boolean
        headLimit?: number
        offset?: number
      }
    ): Promise<GrepResult>
    openInExplorer(rootPath: string): Promise<boolean>
    openInEditor(rootPath: string, editorId: string, exePath?: string): Promise<boolean>
    detectInstalledEditors(): Promise<EditorInfo[]>
    getProjectSnapshot(
      rootPath: string,
      options?: { dirPaths?: string[]; maxDepth?: number; includeFiles?: boolean }
    ): Promise<ProjectSnapshotResult>
  }
  git: {
    getSnapshot(rootPath: string): Promise<GitSnapshotResult>
    createWorktree(rootPath: string, name: string): Promise<WorktreeInfo>
    removeWorktree(rootPath: string, name: string, force?: boolean): Promise<void>
    listWorktrees(rootPath: string): Promise<WorktreeInfo[]>
  }
  theme: {
    get(): Promise<ThemeInfo>
    set(source: ThemeSource): Promise<ThemeInfo>
    onUpdated(callback: (info: ThemeInfo) => void): () => void
  }
  settings: {
    get(): Promise<GeneralSettings>
    save(settings: GeneralSettings): Promise<void>
  }
  permission: {
    getMode(rootPath: string): Promise<PermissionMode>
    setMode(rootPath: string, mode: PermissionMode): Promise<PermissionMode>
  }
  rules: {
    getList(workspaces: Array<Pick<WorkspaceInfo, 'id' | 'rootPath'>>): Promise<RuleFile[]>
    save(rule: RuleFile, workspaceRoot: string): Promise<boolean>
    delete(rulePath: string): Promise<boolean>
    rename(
      oldPath: string,
      newFilename: string,
      workspaceRoot: string,
      scope: RuleFile['scope']
    ): Promise<boolean>
  }
  attachment: {
    importDraft(name: string, declaredMimeType?: string, bytes?: number[] | Uint8Array): Promise<UiDraftImageAttachment>
    promoteDrafts(sessionId: string, attachments: UiComposerImageAttachment[]): Promise<UiSessionImageAttachment[]>
    rollbackPromotion(sessionId: string, attachmentIds: string[]): Promise<void>
    discardDrafts(draftIds: string[]): Promise<void>
    readPreview(attachment: UiComposerImageAttachment, variant: string): Promise<UiAttachmentPreviewBytes>
  }
  chat: {
    predictNextInput(request: PromptPredictionRequest): Promise<PromptPredictionResponse>
    getRuntimeStatus(sessionId: string): Promise<SessionRuntimeStatus>
    onRuntimeStatusChanged(callback: (payload: SessionRuntimeStatusChanged) => void): () => void
    steer(sessionId: string, input: ChatSteerInput): Promise<ChatSteerResult>
    interruptTool(toolCallId: string): Promise<ChatToolInterruptResult>
    stream(
      providerId: string,
      model: string,
      sessionId: string,
      input: StreamRequestV2['input'],
      callbacks: ChatStreamCallbacks,
      workspaceRoot?: string
    ): ChatStreamHandle
    compact(sessionId: string, instructions?: string): Promise<ChatCompactionResponse>
    revertHistory(
      sessionId: string,
      messageId: string,
      transactionIds: string[]
    ): Promise<ChatHistoryRevertResult>
    previewHistoryRevert(
      sessionId: string,
      messageId: string,
      transactionIds: string[]
    ): Promise<ChatHistoryRevertPreview>
    acceptFile(txId: string, filePath: string): Promise<boolean>
    rejectFile(txId: string, filePath: string): Promise<boolean>
    getDiff(txId: string): Promise<ChatFileDiff[]>
    respondToApproval(requestId: string, response: PermissionApprovalResponse): Promise<void>
    respondAskUser(requestId: string, answers: ChatAskUserAnswer[]): Promise<void>
  }
  session: {
    list(): Promise<SessionData[]>
    get(sessionId: string): Promise<SessionData | null>
    save(session: SessionData): Promise<void>
    delete(sessionId: string): Promise<void>
  }
  terminal: {
    start(workspaceId: string, rootPath: string): Promise<void>
    write(workspaceId: string, text: string): Promise<void>
    resize(workspaceId: string, cols: number, rows: number): Promise<void>
    kill(workspaceId: string): Promise<void>
    onOutput(callback: (event: TerminalOutputEvent) => void): () => void
    onExit(callback: (event: TerminalExitEvent) => void): () => void
  }
  context: {
    ledgerAppendEvent(sessionId: string, event: LedgerAppendRequest): Promise<LedgerEvent>
    ledgerGetSnapshot(sessionId: string): Promise<SessionRuntimeSnapshot | null>
  }
  provider: {
    getAll(): Promise<ProviderInfo[]>
    create(data: ProviderFormData): Promise<ProviderInfo>
    update(id: string, data: ProviderFormData): Promise<ProviderInfo | null>
    delete(id: string): Promise<void>
    setActive(id: string): Promise<void>
    testConnection(id: string): Promise<ConnectionTestResult>
  }
  skill: {
    getAll(rootPath?: string | null): Promise<SkillDefinition[]>
    toggle(rootPath: string | null, id: string, enabled: boolean): Promise<void>
    checkExternal(rootPath?: string | null): Promise<ExternalSkillCheckResult>
    listExternal(rootPath?: string | null): Promise<ExternalSkillGroup[]>
    importSingle(sourceName: string, dirName: string, rootPath?: string | null): Promise<boolean>
    remove(rootPath: string | null, id: string): Promise<boolean>
  }
  todo: {
    snapshot(sessionId: string): Promise<TodoListSnapshot>
  }
  executionHistory: {
    getByProject(projectId: string): Promise<ExecutionHistoryRecord[]>
    delete(executionId: string): Promise<void>
  }
  agent: {
    snapshot(sessionId: string): Promise<AgentRuntimeSnapshot>
    activeIds(sessionId: string): Promise<AgentActiveIdsResult>
  }
  subAgent: {
    list(): Promise<SubAgentInfo[]>
    toggle(type: string, enabled: boolean): Promise<void>
    getDetail(type: string): Promise<SubAgentDetailResponse>
    setModel(type: string, selections: SubAgentModelSelection[]): Promise<void>
    run(request: SubAgentRunRequest): Promise<SubAgentRunState>
    getRun(sessionId: string, runId: string): Promise<SubAgentRunState>
    cancelRun(sessionId: string, runId: string): Promise<SubAgentRunCancelResult>
    onState(callback: (state: SubAgentRunState) => void): () => void
  }
  mcp: {
    list(workspaceRoot?: string | null): Promise<McpListPayload>
    saveUser(servers: Record<string, McpServerConfig>, workspaceRoot?: string | null): Promise<McpListPayload>
    setEnabled(name: string, enabled: boolean, workspaceRoot?: string | null): Promise<McpListPayload>
    getCatalog(name: string, workspaceRoot?: string | null): Promise<McpServerCatalog>
    readResource(name: string, uri: string, workspaceRoot?: string | null): Promise<McpResourceReadResult>
    subscribeResource(name: string, uri: string, workspaceRoot?: string | null): Promise<void>
    unsubscribeResource(name: string, uri: string, workspaceRoot?: string | null): Promise<void>
    getPrompt(
      name: string,
      prompt: string,
      arguments_: Record<string, unknown>,
      workspaceRoot?: string | null
    ): Promise<McpPromptGetResult>
    reconnect(name: string, workspaceRoot?: string | null): Promise<void>
    authorize(name: string, workspaceRoot?: string | null): Promise<void>
    logout(name: string, workspaceRoot?: string | null): Promise<void>
    trustProject(fingerprint: string, workspaceRoot?: string | null): Promise<void>
    listSecretKeys(workspaceRoot?: string | null): Promise<string[]>
    setSecret(key: string, value: string): Promise<string[]>
    deleteSecret(key: string): Promise<string[]>
    respondReverseRequest(requestId: string, response: McpReverseRequestResponse): Promise<void>
    onChanged(callback: (statuses: McpServerStatus[]) => void): () => void
    onReverseRequest(callback: (event: McpReverseRequestEvent) => void): () => void
  }
}

export const desktopApi: DesktopApi = {
  capabilities: {
    get plan(): boolean {
      if (isTauriRuntime()) return false
      return Boolean((window as unknown as { api?: { plan?: unknown } }).api?.plan)
    }
  },
  system: {
    health: () => command('system_health'),
    probe: () => new Promise((resolve, reject) => {
      const received: Array<DesktopEvent<SystemProbeEvent>> = []
      const events = new Channel<DesktopEvent<SystemProbeEvent>>()
      let commandCompleted = false
      const timeout = window.setTimeout(() => {
        reject(new Error('Desktop channel probe timed out'))
      }, 5_000)
      const finish = (): void => {
        if (!commandCompleted || received.length !== 3) return
        window.clearTimeout(timeout)
        resolve(received)
      }
      events.onmessage = (event) => {
        if (received.length < 3) received.push(event)
        finish()
      }
      void command<void>('system_probe_channel', { events }).then(() => {
        commandCompleted = true
        finish()
      }).catch((error) => {
        window.clearTimeout(timeout)
        reject(error)
      })
    })
  },
  window: {
    control: async (action) => {
      if (isTauriRuntime()) {
        await command<void>('window_control', { action })
        return
      }
      sendLegacyWindowControl(action)
    },
    openExternal: (target) => command('open_external', { target })
  },
  logger: {
    debug: (message) => rendererLogCommand('debug', message),
    info: (message) => rendererLogCommand('info', message),
    warn: (message) => rendererLogCommand('warn', message),
    error: (message) => rendererLogCommand('error', message)
  },
  workspace: {
    openDirectory: () =>
      workspaceCommand('workspace_open_directory', undefined, () => legacyWorkspace().openDirectory()),
    scanFileTree: (rootPath) =>
      workspaceCommand('workspace_scan_file_tree', { rootPath }, () =>
        legacyWorkspace().scanFileTree(rootPath)
      ),
    getAllPaths: (rootPath) => command('workspace_get_all_paths', { rootPath }),
    readFile: (filePath, rootPath) =>
      workspaceCommand('workspace_read_file', { filePath, rootPath }, () =>
        legacyWorkspace().readFile(filePath, rootPath)
      ),
    detectProject: (rootPath) =>
      workspaceCommand('workspace_detect_project', { rootPath }, () =>
        legacyWorkspace().detectProject(rootPath)
      ),
    getRecentProjects: () =>
      workspaceCommand('workspace_get_recent_projects', undefined, () =>
        legacyWorkspace().getRecentProjects()
      ),
    addRecentProject: (project) =>
      workspaceCommand('workspace_add_recent_project', { project }, () =>
        legacyWorkspace().addRecentProject(project)
      ),
    removeRecentProject: (id) =>
      workspaceCommand('workspace_remove_recent_project', { id }, () =>
        legacyWorkspace().removeRecentProject(id)
      ),
    renameRecentProject: (id, newName) =>
      workspaceCommand('workspace_rename_recent_project', { id, newName }, () =>
        legacyWorkspace().renameRecentProject(id, newName)
      ),
    glob: (rootPath, pattern, path, headLimit) =>
      command('workspace_glob', { rootPath, pattern, path, headLimit }),
    grep: (rootPath, pattern, options) =>
      command('workspace_grep', {
        rootPath,
        pattern,
        path: options?.path,
        outputMode: options?.outputMode,
        globFilter: options?.globFilter,
        typeFilter: options?.typeFilter,
        caseInsensitive: options?.caseInsensitive,
        multiline: options?.multiline,
        contextAfter: options?.contextAfter,
        contextBefore: options?.contextBefore,
        contextAround: options?.contextAround,
        lineNumbers: options?.lineNumbers,
        onlyMatching: options?.onlyMatching,
        headLimit: options?.headLimit,
        offset: options?.offset
      }),
    openInExplorer: (rootPath) =>
      workspaceCommand('workspace_open_in_explorer', { rootPath }, () =>
        legacyWorkspace().openInExplorer(rootPath)
      ),
    openInEditor: (rootPath, editorId, exePath) =>
      workspaceCommand('workspace_open_in_editor', { rootPath, editorId, exePath }, () =>
        legacyWorkspace().openInEditor(rootPath, editorId, exePath ?? null)
      ),
    detectInstalledEditors: () =>
      workspaceCommand('workspace_detect_installed_editors', undefined, () =>
        legacyEditorInfo()
      ),
    getProjectSnapshot: (rootPath, options) =>
      command('workspace_get_project_snapshot', {
        rootPath,
        dirPaths: options?.dirPaths,
        maxDepth: options?.maxDepth,
        includeFiles: options?.includeFiles
      })
  },
  git: {
    getSnapshot: (rootPath) => command('workspace_get_git_snapshot', { rootPath }),
    createWorktree: (rootPath, name) => command('workspace_create_worktree', { rootPath, name }),
    removeWorktree: (rootPath, name, force) => command('workspace_remove_worktree', { rootPath, name, force }),
    listWorktrees: (rootPath) => command('workspace_list_worktrees', { rootPath })
  },
  theme: {
    get: () => {
      if (isTauriRuntime()) return command('theme_get')
      return legacyTheme().get()
    },
    set: (source) => {
      if (isTauriRuntime()) return command('theme_set', { source })
      return legacyTheme().set(source)
    },
    onUpdated: (callback) => {
      if (!isTauriRuntime()) return legacyTheme().onUpdated(callback)

      let disposed = false
      const unlisten = listen<DesktopEvent<ThemeInfo>>('desktop://theme-changed', (event) => {
        if (!disposed) callback(event.payload.payload)
      })
      return () => {
        disposed = true
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    }
  },
  settings: {
    get: async () => {
      if (isTauriRuntime()) {
        return normalizeSettings(await command<unknown>('settings_get'))
      }
      return normalizeSettings(await legacySettings().get())
    },
    save: async (settings) => {
      const normalized = normalizeSettings(settings)
      if (isTauriRuntime()) {
        await command<boolean>('settings_save', { settings: normalized })
        return
      }
      await legacySettings().save(normalized)
    }
  },
  permission: {
    getMode: (rootPath) =>
      permissionCommand('permission_mode_get', { rootPath }, () => legacyPermission().getMode(rootPath)),
    setMode: (rootPath, mode) =>
      permissionCommand('permission_mode_set', { rootPath, mode }, () =>
        legacyPermission().setMode(rootPath, mode)
      )
  },
  rules: {
    getList: (workspaces) =>
      rulesCommand('rules_get_list', { workspaces }, () => legacyRules().getList(workspaces)),
    save: (rule, workspaceRoot) =>
      rulesCommand('rules_save', { rule, workspaceRoot }, () => legacyRules().save(rule, workspaceRoot)),
    delete: (rulePath) =>
      rulesCommand('rules_delete', { rulePath }, () => legacyRules().delete(rulePath)),
    rename: (oldPath, newFilename, workspaceRoot, scope) =>
      rulesCommand('rules_rename', { oldPath, newFilename, workspaceRoot, scope }, () =>
        legacyRules().rename(oldPath, newFilename, workspaceRoot, scope)
      )
  },
  attachment: {
    importDraft: async (name, declaredMimeType, bytes) => {
      const input = {
        name,
        declaredMimeType: declaredMimeType ?? '',
        bytes: new Uint8Array(bytes || [])
      }
      if (!isTauriRuntime()) return legacyAttachment().importDraft(input)
      const attachment = await command<WireDraftImageAttachment>('attachment_import_draft', {
        name,
        declaredMimeType,
        bytes: Array.from(input.bytes)
      })
      return wireAttachmentToUi(attachment) as UiDraftImageAttachment
    },
    promoteDrafts: async (sessionId, attachments) => {
      if (!isTauriRuntime()) return legacyAttachment().promoteDrafts(sessionId, attachments)
      const promoted = await command<WireSessionImageAttachment[]>('attachment_promote_drafts', {
        sessionId,
        attachments: attachments.map(uiAttachmentToWire)
      })
      return promoted.map((attachment) => wireAttachmentToUi(attachment) as UiSessionImageAttachment)
    },
    rollbackPromotion: (sessionId, attachmentIds) =>
      attachmentCommand('attachment_rollback_promotion', { sessionId, attachmentIds }, () =>
        legacyAttachment().rollbackPromotion(sessionId, attachmentIds)
      ),
    discardDrafts: (draftIds) =>
      attachmentCommand('attachment_discard_drafts', { draftIds }, () =>
        legacyAttachment().discardDrafts(draftIds)
      ),
    readPreview: async (attachment, variant) => {
      if (!isTauriRuntime()) return legacyAttachment().readPreview(attachment, variant as 'thumbnail' | 'original')
      const preview = await command<WireAttachmentPreviewBytes>('attachment_read_preview', {
        attachment: uiAttachmentToWire(attachment),
        variant
      })
      return wirePreviewToUi(preview)
    },
  },
  chat: {
    predictNextInput: (request) =>
      chatCommand('chat_predict_next_input', { request }, () => legacyChat().predictNextInput(request)),
    getRuntimeStatus: (sessionId) =>
      chatCommand('chat_get_runtime_status', { sessionId }, () => legacyChat().getRuntimeStatus(sessionId)),
    onRuntimeStatusChanged: (callback) => {
      if (!isTauriRuntime()) return legacyChat().onRuntimeStatusChanged(callback)

      let active = true
      const unlisten = listen<SessionRuntimeStatusChanged>('chat:runtime-status-changed', (event) => {
        if (active) callback(event.payload)
      })
      return () => {
        active = false
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    },
    steer: (sessionId, input) =>
      chatCommand('chat_steer', { sessionId, input }, () => legacyChat().steer(sessionId, input)),
    interruptTool: (toolCallId) =>
      chatCommand('chat_interrupt_tool', { toolCallId }, () => legacyChat().interruptTool(toolCallId)),
    stream: (providerId, model, sessionId, input, callbacks, workspaceRoot) => {
      if (!isTauriRuntime()) {
        return legacyChat().stream(providerId, model, sessionId, input, callbacks)
      }

      const requestedRunId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const events = new Channel<TauriChatStreamFrame>()
      let activeRunId: string | null = requestedRunId
      let accumulatedContent = ''
      let cleanedUp = false
      let terminalReceived = false
      const askUserListener = listen<ChatAskUserRequestEvent>('chat:ask-user-request', (event) => {
        const payload = event.payload
        if (payload.runId !== activeRunId) return
        try {
          if (callbacks.onAskUserRequest) {
            callbacks.onAskUserRequest(payload.request)
            return
          }
        } catch (error) {
          console.error('[CodeZ] Tauri ask-user callback failed', error)
        }
        void command<void>('chat_respond_ask_user', {
          requestId: payload.request.id,
          answers: ignoredAskUserAnswers(payload.request)
        }).catch(() => undefined)
      })
      const permissionListener = listen<ChatPermissionApprovalEvent>('chat:permission-request', (event) => {
        const payload = event.payload
        if (payload.runId !== activeRunId) return
        const request = permissionRequestForUi(payload.request)
        try {
          if (callbacks.onPermissionRequest) {
            callbacks.onPermissionRequest(request)
            return
          }
        } catch (error) {
          console.error('[CodeZ] Tauri permission callback failed', error)
        }
        void command<void>('chat_respond_to_approval', {
          requestId: request.id,
          response: { approved: false, scope: 'once' }
        }).catch(() => undefined)
      })

      const acknowledge = (frame: TauriChatStreamFrame): void => {
        void command<void>('chat_stream_ack', {
          runId: frame.runId,
          sequence: frame.sequence
        }).catch(() => undefined)
      }

      const cleanup = (stopBackend: boolean): void => {
        if (cleanedUp) return
        cleanedUp = true
        const runId = activeRunId
        activeRunId = null
        events.onmessage = () => undefined
        void askUserListener.then((dispose) => dispose()).catch(() => undefined)
        void permissionListener.then((dispose) => dispose()).catch(() => undefined)
        if (stopBackend && runId) {
          void command('chat_stream_stop', { runId }).catch(() => undefined)
        }
      }

      events.onmessage = (frame) => {
        if (!isTauriChatStreamFrame(frame) || frame.runId !== activeRunId) return
        let terminal = false
        try {
          switch (frame.kind) {
            case 'delta': {
              const delta = typeof frame.payload.delta === 'string' ? frame.payload.delta : ''
              accumulatedContent += delta
              callbacks.onChunk(delta, typeof frame.payload.reasoningDelta === 'string'
                ? frame.payload.reasoningDelta
                : undefined)
              break
            }
            case 'steerConsumed': {
              const input = frame.payload.input as ChatSteerInput | undefined
              if (input) callbacks.onSteerConsumed?.(input)
              break
            }
            case 'completed':
              terminal = true
              terminalReceived = true
              callbacks.onDone(
                typeof frame.payload.fullContent === 'string' && frame.payload.fullContent
                  ? frame.payload.fullContent
                  : accumulatedContent,
                typeof frame.payload.stopReason === 'string' ? frame.payload.stopReason : undefined,
                typeof frame.payload.txId === 'string' ? frame.payload.txId : undefined
              )
              break
            case 'failed': {
              terminal = true
              terminalReceived = true
              const error = isRecord(frame.payload.error) && typeof frame.payload.error.message === 'string'
                ? frame.payload.error.message
                : 'The Rust chat run failed.'
              callbacks.onError(
                error,
                typeof frame.payload.txId === 'string' ? frame.payload.txId : undefined
              )
              break
            }
            case 'interrupted':
              terminal = true
              terminalReceived = true
              callbacks.onError(
                typeof frame.payload.reason === 'string'
                  ? frame.payload.reason
                  : 'The Rust chat run was interrupted.',
                typeof frame.payload.txId === 'string' ? frame.payload.txId : undefined
              )
              break
            case 'usage':
              break
            case 'contextBudget':
              callbacks.onContextBudget?.(frame.payload)
              break
            case 'contextCompactionStarted':
              callbacks.onCompactionStarted?.(frame.payload)
              break
            case 'contextCompactionCompleted':
              callbacks.onCompactionCompleted?.(frame.payload)
              break
            case 'contextCompactionFailed':
              callbacks.onCompactionFailed?.(frame.payload)
              break
            case 'toolCalls': {
              const calls = Array.isArray(frame.payload.calls) ? frame.payload.calls : []
              for (const call of calls) {
                if (!isRecord(call)) continue
                const functionPayload: Record<string, unknown> = isRecord(call.function)
                  ? call.function
                  : {}
                callbacks.onToolStart?.(
                  typeof call.id === 'string' ? call.id : '',
                  typeof functionPayload.name === 'string' ? functionPayload.name : 'Unknown',
                  typeof functionPayload.arguments === 'string' ? functionPayload.arguments : '{}',
                  typeof call.thoughtSignature === 'string' ? call.thoughtSignature : undefined
                )
              }
              break
            }
            case 'toolResult':
              callbacks.onToolEnd?.(
                typeof frame.payload.callId === 'string' ? frame.payload.callId : '',
                typeof frame.payload.result === 'string' ? frame.payload.result : ''
              )
              break
          }
        } catch (error) {
          console.error('[CodeZ] Tauri chat callback failed', error)
        } finally {
          acknowledge(frame)
          if (terminal) cleanup(false)
        }
      }

      const started = askUserListener.then(() => command<string>('chat_stream_start', {
        request: {
          streamId: requestedRunId,
          providerId,
          model,
          sessionId,
          workspaceRoot,
          input
        },
        events
      })).then((runId) => {
        if (runId !== requestedRunId) {
          cleanup(true)
          throw new Error('The backend returned a different chat run ID.')
        }
        if (!cleanedUp) activeRunId = runId
      }).catch((error) => {
        if (!terminalReceived) cleanup(false)
        throw error
      })

      return {
        stop: () => cleanup(true),
        started
      }
    },
    compact: (sessionId, instructions) =>
      chatCommand('chat_compact', { sessionId, instructions }, () =>
        legacyChat().compact(sessionId, instructions)
      ),
    revertHistory: (sessionId, messageId, transactionIds) =>
      chatCommand('chat_revert_history', { sessionId, messageId, transactionIds }, () =>
        invokeLegacyChatHistory<ChatHistoryRevertResult>(
          'chat:revert-messages',
          sessionId,
          messageId,
          transactionIds
        )
      ),
    previewHistoryRevert: (sessionId, messageId, transactionIds) =>
      chatCommand('chat_preview_history_revert', { sessionId, messageId, transactionIds }, () =>
        invokeLegacyChatHistory<ChatHistoryRevertPreview>(
          'chat:preview-revert-messages',
          sessionId,
          messageId,
          transactionIds
        )
      ),
    acceptFile: (txId, filePath) =>
      chatCommand('chat_accept_file', { txId, filePath }, () => legacyChat().acceptFile(txId, filePath)),
    rejectFile: (txId, filePath) =>
      chatCommand('chat_reject_file', { txId, filePath }, () => legacyChat().rejectFile(txId, filePath)),
    getDiff: (txId) =>
      chatCommand('chat_get_diff', { txId }, () => legacyChat().getDiff(txId)),
    respondToApproval: (requestId, response) =>
      chatCommand('chat_respond_to_approval', { requestId, response }, () =>
        legacyChat().respondToApproval(requestId, response)
      ),
    respondAskUser: (requestId, answers) =>
      chatCommand('chat_respond_ask_user', { requestId, answers }, () =>
        legacyChat().respondAskUser(requestId, answers)
      )
  },
  session: {
    list: async () => {
      const sessions = await sessionCommand<unknown>(
        'session_list',
        undefined,
        () => legacySession().list()
      )
      if (!Array.isArray(sessions)) {
        throw new Error('The desktop returned an invalid session list.')
      }
      return sessions.map(normalizeSession)
    },
    get: async (sessionId) => {
      const session = await sessionCommand<unknown>(
        'session_get',
        { sessionId },
        () => legacySession().get(sessionId)
      )
      return session === null ? null : normalizeSession(session)
    },
    save: async (session) => {
      const normalized = normalizeSession(session)
      await sessionCommand<void>(
        'session_save',
        { session: normalized },
        () => legacySession().save(normalized)
      )
    },
    delete: (sessionId) =>
      sessionCommand<void>('session_delete', { sessionId }, () => legacySession().delete(sessionId))
  },
  terminal: {
    start: (workspaceId, rootPath) =>
      terminalCommand('terminal_start', { workspaceId, rootPath }, () =>
        legacyTerminal().start(workspaceId, rootPath)
      ),
    write: (workspaceId, text) =>
      terminalCommand('terminal_write', { workspaceId, text }, () =>
        legacyTerminal().write(workspaceId, text)
      ),
    resize: (workspaceId, cols, rows) =>
      terminalCommand('terminal_resize', { workspaceId, cols, rows }, () =>
        legacyTerminal().resize(workspaceId, cols, rows)
      ),
    kill: (workspaceId) =>
      terminalCommand('terminal_kill', { workspaceId }, () => legacyTerminal().kill(workspaceId)),
    onOutput: (callback) => {
      if (!isTauriRuntime()) {
        return legacyTerminal().onOutput((workspaceId, data) => callback({ workspaceId, data }))
      }

      let active = true
      const unlisten = listen<unknown>('terminal:output', (event) => {
        if (!active) return
        const output = terminalOutputEvent(event.payload)
        if (!output || output.sequence === undefined) return
        try {
          callback(output)
        } finally {
          void command<void>('terminal_ack', {
            workspaceId: output.workspaceId,
            sequence: output.sequence
          }).catch(() => undefined)
        }
      })
      return () => {
        active = false
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    },
    onExit: (callback) => {
      if (!isTauriRuntime()) {
        return legacyTerminal().onExit((workspaceId) => callback({ workspaceId, exitCode: null }))
      }

      let active = true
      const unlisten = listen<unknown>('terminal:exit', (event) => {
        if (!active) return
        const exit = terminalExitEvent(event.payload)
        if (exit) callback(exit)
      })
      return () => {
        active = false
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    }
  },
  provider: {
    getAll: () =>
      providerCommand('provider_get_all', undefined, () => legacyProvider().list()),
    create: (data) =>
      providerCommand('provider_create', { data }, () => legacyProvider().add(data)),
    update: (id, data) =>
      providerCommand('provider_update', { id, data }, () => legacyProvider().update(id, data)),
    delete: async (id) => {
      await providerCommand('provider_delete', { id }, async () => {
        await legacyProvider().remove(id)
      })
    },
    setActive: (id) =>
      providerCommand('provider_set_active', { id }, () => legacyProvider().setActive(id)),
    testConnection: (id) =>
      providerCommand('provider_test_connection', { id }, () =>
        legacyProvider().testConnection(id)
      )
  },
  skill: {
    getAll: (rootPath) =>
      skillCommand('skill_get_all', { rootPath }, () => legacySkill().getAll(rootPath ?? null)),
    toggle: (rootPath, id, enabled) =>
      skillCommand('skill_toggle', { rootPath, id, enabled }, () =>
        legacySkill().toggle(rootPath, id, enabled)
      ),
    checkExternal: (rootPath) =>
      skillCommand('skill_check_external', { rootPath }, () =>
        legacySkill().checkExternal(rootPath)
      ),
    listExternal: (rootPath) =>
      skillCommand('skill_list_external', { rootPath }, () => legacySkill().listExternal(rootPath)),
    importSingle: (sourceName, dirName, rootPath) =>
      skillCommand('skill_import_single', { sourceName, dirName, rootPath }, () =>
        legacySkill().importSingle(sourceName, dirName, rootPath)
      ),
    remove: (rootPath, id) =>
      skillCommand('skill_remove', { rootPath, id }, () => legacySkill().remove(rootPath, id))
  },
  todo: {
    snapshot: (sessionId) => todoCommand<TodoListSnapshot>(
      'todo_list',
      { request: { sessionId } },
      () => legacyTodoSnapshot(sessionId)
    )
  },
  executionHistory: {
    getByProject: async (projectId) => normalizeExecutionHistoryRecords(await executionHistoryCommand<unknown>(
      'task_get_by_project',
      { projectId },
      () => legacyTask().getByProject(projectId)
    )),
    delete: (executionId) => executionHistoryCommand<void>(
      'task_delete',
      { taskId: executionId },
      () => legacyTask().delete(executionId)
    )
  },
  agent: {
    snapshot: (sessionId) => agentCommand<AgentRuntimeSnapshot>(
      'agent_snapshot',
      { request: { sessionId } },
      unavailableLegacyAgentSnapshot
    ),
    activeIds: (sessionId) => agentCommand<AgentActiveIdsResult>(
      'agent_active_ids',
      { request: { sessionId } },
      unavailableLegacyAgentSnapshot
    )
  },
  subAgent: {
    list: () => subAgentCommand<SubAgentInfo[]>(
      'subagent_list',
      undefined,
      () => legacySubAgent().list()
    ),
    toggle: (type, enabled) => subAgentCommand<void>(
      'subagent_toggle',
      { subagentType: type, enabled },
      () => legacySubAgent().toggle(type, enabled)
    ),
    getDetail: (type) => subAgentCommand<SubAgentDetailResponse>(
      'subagent_get_detail',
      { subagentType: type },
      () => legacySubAgent().getDetail(type)
    ),
    setModel: (type, selections) => subAgentCommand<void>(
      'subagent_set_model',
      { subagentType: type, selections },
      () => legacySubAgent().setModel(type, selections)
    ),
    run: (request) => subAgentCommand<SubAgentRunState>(
      'subagent_run',
      { request },
      () => legacySubAgent().run(request)
    ),
    getRun: (sessionId, runId) => subAgentCommand<SubAgentRunState>(
      'subagent_get_run',
      { sessionId, runId },
      () => legacySubAgent().getRun(runId)
    ),
    cancelRun: (sessionId, runId) => subAgentCommand<SubAgentRunCancelResult>(
      'subagent_cancel_run',
      { sessionId, runId },
      () => legacySubAgent().cancelRun(runId)
    ),
    onState: (callback) => {
      let active = true
      let dispose: (() => void) | null = null
      void desktopEvents.subAgent.onState((state) => {
        if (active) callback(state)
      }).then((unlisten) => {
        if (active) dispose = unlisten
        else unlisten()
      }).catch(() => undefined)
      return () => {
        active = false
        dispose?.()
      }
    }
  },
  mcp: {
    list: (workspaceRoot) =>
      mcpCommand('mcp_list', { workspaceRoot }, () => legacyMcp().list()),
    saveUser: (servers, workspaceRoot) =>
      mcpCommand('mcp_save_user', { servers, workspaceRoot }, () =>
        legacyMcp().saveUser(servers)
      ),
    setEnabled: (name, enabled, workspaceRoot) =>
      mcpCommand('mcp_set_enabled', { name, enabled, workspaceRoot }, () =>
        legacyMcp().setEnabled(name, enabled)
      ),
    getCatalog: (name, workspaceRoot) =>
      mcpCommand('mcp_get_catalog', { name, workspaceRoot }, () =>
        legacyMcp().getCatalog(name)
      ),
    readResource: (name, uri, workspaceRoot) =>
      mcpCommand('mcp_read_resource', { name, uri, workspaceRoot }, async () => {
        const readResource = (legacyMcp() as Partial<Window['api']['mcp']>).readResource
        if (!readResource) throw new Error('MCP resource reads require the Tauri desktop host.')
        return readResource(name, uri, workspaceRoot)
      }),
    subscribeResource: (name, uri, workspaceRoot) =>
      mcpCommand('mcp_subscribe_resource', { name, uri, workspaceRoot }, async () => {
        const subscribeResource = (legacyMcp() as Partial<Window['api']['mcp']>).subscribeResource
        if (!subscribeResource) throw new Error('MCP resource subscriptions require the Tauri desktop host.')
        return subscribeResource(name, uri, workspaceRoot)
      }),
    unsubscribeResource: (name, uri, workspaceRoot) =>
      mcpCommand('mcp_unsubscribe_resource', { name, uri, workspaceRoot }, async () => {
        const unsubscribeResource = (legacyMcp() as Partial<Window['api']['mcp']>).unsubscribeResource
        if (!unsubscribeResource) throw new Error('MCP resource subscriptions require the Tauri desktop host.')
        return unsubscribeResource(name, uri, workspaceRoot)
      }),
    getPrompt: (name, prompt, arguments_, workspaceRoot) =>
      mcpCommand('mcp_get_prompt', { name, prompt, arguments: arguments_, workspaceRoot }, async () => {
        const getPrompt = (legacyMcp() as Partial<Window['api']['mcp']>).getPrompt
        if (!getPrompt) throw new Error('MCP prompt reads require the Tauri desktop host.')
        return getPrompt(name, prompt, arguments_, workspaceRoot)
      }),
    reconnect: (name, workspaceRoot) =>
      mcpCommand('mcp_reconnect', { name, workspaceRoot }, () =>
        legacyMcp().reconnect(name)
      ),
    authorize: (name, workspaceRoot) =>
      mcpCommand('mcp_authorize', { name, workspaceRoot }, () => legacyMcp().authorize(name)),
    logout: (name, workspaceRoot) =>
      mcpCommand('mcp_logout', { name, workspaceRoot }, () => legacyMcp().logout(name)),
    trustProject: (fingerprint, workspaceRoot) =>
      mcpCommand('mcp_trust_project', { fingerprint, workspaceRoot }, () =>
        legacyMcp().trustProject(fingerprint)
      ),
    listSecretKeys: (workspaceRoot) =>
      mcpCommand('mcp_list_secret_keys', { workspaceRoot }, () =>
        legacyMcp().listSecretKeys(workspaceRoot)
      ),
    setSecret: (key, value) =>
      mcpCommand('mcp_set_secret', { key, value }, () => legacyMcp().setSecret(key, value)),
    deleteSecret: (key) =>
      mcpCommand('mcp_delete_secret', { key }, () => legacyMcp().deleteSecret(key)),
    respondReverseRequest: (requestId, response) => {
      if (!isTauriRuntime()) {
        return Promise.reject(new Error('MCP reverse-request approval requires the Tauri desktop host.'))
      }
      return command('mcp_respond_reverse_request', { requestId, response })
    },
    onChanged: (callback) => {
      if (!isTauriRuntime()) return legacyMcp().onChanged(callback)

      let active = true
      const unlisten = listen<McpServerStatus[]>('mcp:status-changed', (event) => {
        if (active) callback(event.payload)
      })
      return () => {
        active = false
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    },
    onReverseRequest: (callback) => {
      if (!isTauriRuntime()) return () => undefined

      let active = true
      const unlisten = listen<unknown>('mcp:reverse-request', (event) => {
        if (!active || !isMcpReverseRequestEvent(event.payload)) return
        callback(event.payload)
      })
      return () => {
        active = false
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    }
  },
  context: {
    ledgerAppendEvent: async (sessionId, event) => command('ledger_append_event', { sessionId, event }),
    ledgerGetSnapshot: async (sessionId) => command('ledger_get_snapshot', { sessionId }),
  }
}
