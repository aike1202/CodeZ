import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { desktopApi } from '../shared/desktop/api'
import type {
  MigrationCredentialInput,
  MigrationRecoveryStatus,
  PermissionMode,
  SubAgentModelSelection,
  SubAgentRunCancelResult,
  SubAgentRunRequest,
  SubAgentRunState,
} from '../shared/desktop/generated/contracts'

const subAgentRunSessions = new Map<string, string>()

function subAgentSessionForRun(runId: string): string {
  const sessionId = subAgentRunSessions.get(runId)
  if (!sessionId) throw new Error('The sub-agent run session is unavailable.')
  return sessionId
}
import type {
  McpListPayload,
  McpPromptGetResult,
  McpResourceReadResult,
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
} from '../components/SettingsMcpTab/types'
import type {
  ChatAskUserAnswer,
  ChatAskUserRequest,
  ChatAskUserRequestEvent,
  ChatPermissionApprovalEvent,
  McpReverseRequestEvent,
  McpReverseRequestResponse,
} from '../shared/desktop/generated/contracts'

function permissionRequestForUi(request: any): any {
  const checks = Array.isArray(request?.checks) ? request.checks : []
  const absoluteRedline = checks.some((check: any) => check?.absoluteRedline)
  return {
    id: request?.id || '',
    sessionId: request?.sessionId,
    agentId: request?.agentRole,
    toolName: request?.toolName || 'Unknown',
    description: request?.description || '',
    args: request?.input ?? {},
    checks,
    allowedScopes: request?.allowedScopes || ['once'],
    action: 'ask',
    permission: absoluteRedline ? 'hardline' : 'unknown',
    analysisStatus: 'parsed',
    hardline: absoluteRedline,
    riskLevel: absoluteRedline ? 4 : 2,
    reason: request?.description || 'Tool execution requires approval.',
    ruleId: 'runtime-policy',
    normalizedPattern: request?.toolName || 'unknown',
    impacts: [],
    snapshots: [],
    critical: absoluteRedline,
    absoluteRedline,
  }
}

function ignoredAskUserAnswers(request: ChatAskUserRequest): ChatAskUserAnswer[] {
  return request.questions.map((question) => ({
    question: question.question,
    answer: question.multiSelect ? ['__IGNORED__'] : '__IGNORED__',
  }))
}

// Compatibility layer implementing window.api interface over Tauri IPC commands
export const tauriBridge: any = {
  workspace: {
    openDirectory: () => desktopApi.workspace.openDirectory(),
    scanFileTree: (rootPath: string) => desktopApi.workspace.scanFileTree(rootPath),
    getAllPaths: (rootPath: string) => invoke('workspace_get_all_paths', { rootPath }),
    readFile: (filePath: string, rootPath: string) => desktopApi.workspace.readFile(filePath, rootPath),
    detectProject: (rootPath: string) => desktopApi.workspace.detectProject(rootPath),
    getRecentProjects: () => desktopApi.workspace.getRecentProjects(),
    addRecentProject: (project: any) => desktopApi.workspace.addRecentProject(project),
    removeRecentProject: (id: string) => desktopApi.workspace.removeRecentProject(id),
    openInEditor: (rootPath: string, editorId: string, exePath: string | null) =>
      desktopApi.workspace.openInEditor(rootPath, editorId, exePath ?? undefined),
    openInExplorer: (rootPath: string) => desktopApi.workspace.openInExplorer(rootPath),
    renameRecentProject: (id: string, newName: string) => desktopApi.workspace.renameRecentProject(id, newName),
    detectInstalledEditors: () => desktopApi.workspace.detectInstalledEditors(),
  },
  permission: {
    getMode: (rootPath: string) => invoke<PermissionMode>('permission_mode_get', { rootPath }),
    setMode: async (rootPath: string, mode: string) => {
      return invoke<PermissionMode>('permission_mode_set', { rootPath, mode })
    },
  },
  migration: {
    getStatus: () => invoke<MigrationRecoveryStatus>('migration_get_status'),
    submitCredentials: (inputs: MigrationCredentialInput[]) =>
      invoke<MigrationRecoveryStatus>('migration_submit_credentials', { inputs }),
    restart: () => invoke<void>('migration_restart'),
  },
  provider: {
    list: () => invoke('provider_get_all').catch(() => []),
    add: (form: any) => invoke('provider_create', { data: form }),
    update: (id: string, form: any) => invoke('provider_update', { id, data: form }),
    remove: (id: string) => invoke('provider_delete', { id }),
    testConnection: (id: string) => invoke('provider_test_connection', { id }),
    setActive: (id: string) => invoke('provider_set_active', { id }),
  },
  attachment: {
    importDraft: (input: any) =>
      invoke('attachment_import_draft', {
        name: input.name,
        declaredMimeType: input.declaredMimeType,
        bytes: Array.from(input.bytes || []),
      }),
    promoteDrafts: (sessionId: string, attachments: any[]) =>
      invoke('attachment_promote_drafts', { sessionId, attachments }),
    rollbackPromotion: (sessionId: string, attachmentIds: string[]) =>
      invoke('attachment_rollback_promotion', { sessionId, attachmentIds }),
    discardDrafts: (draftIds: string[]) => invoke('attachment_discard_drafts', { draftIds }),
    readPreview: (attachment: any, variant: string) =>
      invoke('attachment_read_preview', { attachment, variant }),
  },
  settings: {
    get: () => desktopApi.settings.get(),
    save: (settings: any) => desktopApi.settings.save(settings),
  },
  chat: {
    predictNextInput: async (request: any) => invoke('chat_predict_next_input', { request }),
    getRuntimeStatus: async (sessionId: string) => invoke('chat_get_runtime_status', { sessionId }),
    onRuntimeStatusChanged: (callback: (payload: any) => void) => {
      let active = true
      const unlisten = listen('chat:runtime-status-changed', (event: any) => {
        if (active) callback(event.payload)
      })
      return () => {
        active = false
        void unlisten.then((dispose) => dispose())
      }
    },
    steer: async (sessionId: string, input: any) => invoke('chat_steer', { sessionId, input }),
    interruptTool: async (toolCallId: string) => invoke('chat_interrupt_tool', { toolCallId }),
    stream: (
      providerId: string,
      model: string,
      sessionId: string,
      input: any,
      callbacks: any,
      workspaceRoot?: string,
    ) => {
      const requestedRunId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const events = new Channel<any>()
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
        void invoke('chat_respond_ask_user', {
          requestId: payload.request.id,
          answers: ignoredAskUserAnswers(payload.request),
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
        void invoke('chat_respond_to_approval', {
          requestId: request.id,
          response: { approved: false, scope: 'once' },
        }).catch(() => undefined)
      })

      const acknowledge = (frame: any): void => {
        if (typeof frame?.runId !== 'string' || !Number.isSafeInteger(frame?.sequence)) return
        void invoke('chat_stream_ack', {
          runId: frame.runId,
          sequence: frame.sequence,
        }).catch(() => undefined)
      }

      const cleanup = (stopBackend: boolean): void => {
        if (cleanedUp) return
        cleanedUp = true
        const runId = activeRunId
        activeRunId = null
        events.onmessage = () => undefined
        void askUserListener.then((unlisten) => unlisten()).catch(() => undefined)
        void permissionListener.then((unlisten) => unlisten()).catch(() => undefined)
        if (stopBackend && runId) {
          void invoke('chat_stream_stop', { runId }).catch(() => undefined)
        }
      }

      events.onmessage = (frame: any) => {
        if (frame?.runId !== activeRunId || frame?.version !== 1) return
        let terminal = false
        try {
          const payload = frame.payload || {}
          switch (frame.kind) {
            case 'delta':
              accumulatedContent += typeof payload.delta === 'string' ? payload.delta : ''
              callbacks.onChunk?.(payload.delta || '', payload.reasoningDelta)
              break
            case 'steerConsumed':
              callbacks.onSteerConsumed?.(payload.input)
              break
            case 'completed':
              terminal = true
              terminalReceived = true
              callbacks.onDone?.(
                payload.fullContent || accumulatedContent,
                payload.stopReason,
                payload.txId,
              )
              break
            case 'failed':
              terminal = true
              terminalReceived = true
              callbacks.onError?.(
                payload.error?.message || 'The Rust chat run failed.',
                payload.txId,
              )
              break
            case 'interrupted':
              terminal = true
              terminalReceived = true
              callbacks.onError?.(
                payload.reason || 'The Rust chat run was interrupted.',
                payload.txId,
              )
              break
            case 'usage':
              break
            case 'toolCalls':
              for (const call of payload.calls || []) {
                callbacks.onToolStart?.(
                  call.id,
                  call.function?.name || 'Unknown',
                  call.function?.arguments || '{}',
                  call.thoughtSignature,
                )
              }
              break
            case 'toolResult':
              callbacks.onToolEnd?.(payload.callId, payload.result || '')
              break
          }
        } catch (error) {
          console.error('[CodeZ] Tauri chat callback failed', error)
        } finally {
          acknowledge(frame)
          if (terminal) cleanup(false)
        }
      }

      const started = askUserListener.then(() => invoke<string>('chat_stream_start', {
        request: {
          streamId: requestedRunId,
          providerId,
          model,
          sessionId,
          workspaceRoot,
          input,
        },
        events,
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
        started,
      }
    },
    compact: async (sessionId: string, instructions?: string) =>
      invoke('chat_compact', { sessionId, instructions }),
    acceptFile: async (txId: string, filePath: string) =>
      invoke('chat_accept_file', { txId, filePath }),
    rejectFile: async (txId: string, filePath: string) =>
      invoke('chat_reject_file', { txId, filePath }),
    getDiff: async (txId: string) => invoke('chat_get_diff', { txId }),
    respondToApproval: async (requestId: string, response: any) =>
      invoke('chat_respond_to_approval', { requestId, response }),
    respondAskUser: async (requestId: string, answers: ChatAskUserAnswer[]) =>
      invoke('chat_respond_ask_user', { requestId, answers }),
  },
  session: {
    list: () => desktopApi.session.list(),
    get: (sessionId: string) => desktopApi.session.get(sessionId),
    save: (session: any) => desktopApi.session.save(session),
    delete: (sessionId: string) => desktopApi.session.delete(sessionId),
  },
  terminal: {
    start: (workspaceId: string, rootPath: string) => desktopApi.terminal.start(workspaceId, rootPath),
    write: (workspaceId: string, text: string) => desktopApi.terminal.write(workspaceId, text),
    resize: (workspaceId: string, cols: number, rows: number) =>
      desktopApi.terminal.resize(workspaceId, cols, rows),
    kill: (workspaceId: string) => desktopApi.terminal.kill(workspaceId),
    onOutput: (callback: (workspaceId: string, data: string | Uint8Array) => void) =>
      desktopApi.terminal.onOutput(({ workspaceId, data }) => callback(workspaceId, data)),
    onExit: (callback: (workspaceId: string) => void) =>
      desktopApi.terminal.onExit(({ workspaceId }) => callback(workspaceId)),
  },
  task: {
    list: async () => invoke('task_list'),
    get: async (taskId: string) => invoke('task_get', { taskId }),
    getByProject: (projectId: string) => desktopApi.task.getByProject(projectId),
    save: async (task: any) => invoke('task_save', { task }),
    delete: (taskId: string) => desktopApi.task.delete(taskId),
  },
  theme: {
    get: () => invoke('theme_get'),
    set: (source: string) => invoke('theme_set', { source }),
    onUpdated: (callback: any) => {
      let active = true;
      const unlisten = listen('desktop://theme-changed', (event: any) => {
        if (active) callback(event.payload);
      });
      return () => { active = false; unlisten.then((f) => f()); };
    },
  },
  skill: {
    getAll: async (rootPath?: string | null) => invoke('skill_get_all', { rootPath }),
    toggle: async (rootPath: string | null, id: string, enabled: boolean) => invoke('skill_toggle', { rootPath, id, enabled }),
    checkExternal: async (rootPath?: string | null) => invoke('skill_check_external', { rootPath }),
    importExternal: async (
      sourceName?: string,
      customPath?: string,
      forceOverwrite?: boolean,
      rootPath?: string | null,
    ) => invoke('skill_import_external', { sourceName, customPath, forceOverwrite, rootPath }),
    listExternal: async (rootPath?: string | null) => invoke('skill_list_external', { rootPath }),
    importSingle: async (sourceName: string, dirName: string, rootPath?: string | null) =>
      invoke('skill_import_single', { sourceName, dirName, rootPath }),
    remove: async (rootPath: string | null, id: string) => invoke('skill_remove', { rootPath, id }),
  },
  rules: {
    getList: async (workspaces?: any[]) => invoke('rules_get_list', { workspaces: workspaces || [] }),
    save: async (rule: any, workspaceRoot: string) => invoke('rules_save', { rule, workspaceRoot }),
    delete: async (rulePath: string) => invoke('rules_delete', { rulePath }),
    rename: async (oldPath: string, newFilename: string, workspaceRoot: string, scope: string) => invoke('rules_rename', { oldPath, newFilename, workspaceRoot, scope }),
  },
  mcp: {
    list: async (workspaceRoot?: string | null): Promise<McpListPayload> =>
      invoke('mcp_list', { workspaceRoot }),
    saveUser: async (
      servers: Record<string, McpServerConfig>,
      workspaceRoot?: string | null,
    ): Promise<McpListPayload> => invoke('mcp_save_user', { servers, workspaceRoot }),
    setEnabled: async (
      name: string,
      enabled: boolean,
      workspaceRoot?: string | null,
    ): Promise<McpListPayload> => invoke('mcp_set_enabled', { name, enabled, workspaceRoot }),
    getCatalog: async (name: string, workspaceRoot?: string | null): Promise<McpServerCatalog> =>
      invoke('mcp_get_catalog', { name, workspaceRoot }),
    readResource: async (
      name: string,
      uri: string,
      workspaceRoot?: string | null,
    ): Promise<McpResourceReadResult> => invoke('mcp_read_resource', { name, uri, workspaceRoot }),
    subscribeResource: async (
      name: string,
      uri: string,
      workspaceRoot?: string | null,
    ): Promise<void> => invoke('mcp_subscribe_resource', { name, uri, workspaceRoot }),
    unsubscribeResource: async (
      name: string,
      uri: string,
      workspaceRoot?: string | null,
    ): Promise<void> => invoke('mcp_unsubscribe_resource', { name, uri, workspaceRoot }),
    getPrompt: async (
      name: string,
      prompt: string,
      arguments_: Record<string, unknown>,
      workspaceRoot?: string | null,
    ): Promise<McpPromptGetResult> =>
      invoke('mcp_get_prompt', { name, prompt, arguments: arguments_, workspaceRoot }),
    reconnect: async (name: string, workspaceRoot?: string | null): Promise<void> =>
      invoke('mcp_reconnect', { name, workspaceRoot }),
    authorize: async (name: string, workspaceRoot?: string | null): Promise<void> =>
      invoke('mcp_authorize', { name, workspaceRoot }),
    logout: async (name: string, workspaceRoot?: string | null): Promise<void> =>
      invoke('mcp_logout', { name, workspaceRoot }),
    trustProject: async (fingerprint: string, workspaceRoot?: string | null): Promise<void> =>
      invoke('mcp_trust_project', { fingerprint, workspaceRoot }),
    listSecretKeys: async (workspaceRoot?: string | null): Promise<string[]> =>
      invoke('mcp_list_secret_keys', { workspaceRoot }),
    setSecret: async (key: string, value: string): Promise<string[]> => invoke('mcp_set_secret', { key, value }),
    deleteSecret: async (key: string): Promise<string[]> => invoke('mcp_delete_secret', { key }),
    respondReverseRequest: async (
      requestId: string,
      response: McpReverseRequestResponse,
    ): Promise<void> => invoke('mcp_respond_reverse_request', { requestId, response }),
    onChanged: (callback: (statuses: McpServerStatus[]) => void) => {
      let active = true;
      const unlisten = listen<McpServerStatus[]>('mcp:status-changed', (event) => {
        if (active) callback(event.payload);
      });
      return () => { active = false; unlisten.then((f) => f()); };
    },
    onReverseRequest: (callback: (event: McpReverseRequestEvent) => void) => {
      let active = true;
      const unlisten = listen<McpReverseRequestEvent>('mcp:reverse-request', (event) => {
        if (active) callback(event.payload);
      });
      return () => { active = false; void unlisten.then((dispose) => dispose()).catch(() => undefined); };
    },
  },
  subAgent: {
    list: () => desktopApi.subAgent.list(),
    toggle: (type: string, enabled: boolean) => desktopApi.subAgent.toggle(type, enabled),
    getDetail: (type: string) => desktopApi.subAgent.getDetail(type),
    setModel: (type: string, selections: SubAgentModelSelection[]) =>
      desktopApi.subAgent.setModel(type, selections),
    run: async (request: SubAgentRunRequest): Promise<SubAgentRunState> => {
      const state = await desktopApi.subAgent.run(request)
      subAgentRunSessions.set(state.runId, state.sessionId)
      return state
    },
    getRun: async (runId: string): Promise<SubAgentRunState> =>
      desktopApi.subAgent.getRun(subAgentSessionForRun(runId), runId),
    cancelRun: async (runId: string): Promise<SubAgentRunCancelResult> =>
      desktopApi.subAgent.cancelRun(subAgentSessionForRun(runId), runId),
    onState: (callback: (state: SubAgentRunState) => void) => {
      return desktopApi.subAgent.onState((state) => {
        subAgentRunSessions.set(state.runId, state.sessionId)
        callback(state)
      })
    },
  },
  logger: {
    info: (message: string) => {
      console.info('[CodeZ]', message)
      void desktopApi.logger.info(message).catch(() => undefined)
    },
    warn: (message: string) => {
      console.warn('[CodeZ]', message)
      void desktopApi.logger.warn(message).catch(() => undefined)
    },
    error: (message: string) => {
      console.error('[CodeZ]', message)
      void desktopApi.logger.error(message).catch(() => undefined)
    },
    debug: (message: string) => {
      console.debug('[CodeZ]', message)
      void desktopApi.logger.debug(message).catch(() => undefined)
    },
  },
};
