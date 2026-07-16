import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { desktopApi } from '../shared/desktop/api'
import type { PermissionMode } from '../shared/desktop/generated/contracts'
import { defaultSettings, defaultWebSearchSettings } from '@shared/types/settings'
import type {
  McpListPayload,
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
} from '../components/SettingsMcpTab/types'
import type {
  ChatAskUserAnswer,
  ChatAskUserRequest,
  ChatAskUserRequestEvent,
} from '../shared/desktop/generated/contracts'

function ignoredAskUserAnswers(request: ChatAskUserRequest): ChatAskUserAnswer[] {
  return request.questions.map((question) => ({
    question: question.question,
    answer: question.multiSelect ? ['__IGNORED__'] : '__IGNORED__',
  }))
}

/**
 * Merge raw settings from disk with defaultSettings, including deep-merge
 * for nested objects like webSearch. Mirrors SettingsService.init() in Electron.
 */
function mergeWithDefaults(raw: any): any {
  if (!raw || typeof raw !== 'object') return { ...defaultSettings }
  return {
    ...defaultSettings,
    ...raw,
    webSearch: {
      ...defaultWebSearchSettings,
      ...(raw.webSearch || {}),
      engines: {
        ...defaultWebSearchSettings.engines,
        ...(raw.webSearch?.engines || {}),
      },
    },
  }
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
    rollbackPromotion: async () => {},
    discardDrafts: (draftIds: string[]) => invoke('attachment_discard_drafts', { draftIds }),
    readPreview: (attachment: any, variant: string) =>
      invoke('attachment_read_preview', { attachment, variant }),
  },
  settings: {
    get: async () => {
      try {
        const raw = await invoke('settings_get');
        return mergeWithDefaults(raw);
      } catch {
        return { ...defaultSettings };
      }
    },
    save: (settings: any) => invoke('settings_save', { settings }),
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
    stream: (providerId: string, model: string, sessionId: string, input: any, callbacks: any) => {
      const requestedRunId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const events = new Channel<any>()
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
      let activeRunId: string | null = requestedRunId
      let accumulatedContent = ''
      let cleanedUp = false
      let terminalReceived = false

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
              callbacks.onError?.(payload.error?.message || 'The Rust chat run failed.')
              break
            case 'interrupted':
              terminal = true
              terminalReceived = true
              callbacks.onError?.(payload.reason || 'The Rust chat run was interrupted.')
              break
            case 'usage':
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
    list: () => invoke('session_list').catch(() => []),
    get: (sessionId: string) => invoke('session_get', { sessionId }).catch(() => null),
    save: (session: any) => invoke('session_save', { session }),
    delete: (sessionId: string) => invoke('session_delete', { sessionId }),
  },
  terminal: {
    start: (workspaceId: string, rootPath: string) => invoke('terminal_start', { workspaceId, rootPath }),
    write: (workspaceId: string, text: string) => invoke('terminal_write', { workspaceId, text }),
    resize: (workspaceId: string, cols: number, rows: number) => invoke('terminal_resize', { workspaceId, cols, rows }),
    kill: (workspaceId: string) => invoke('terminal_kill', { workspaceId }),
    onOutput: (callback: any) => {
      let active = true;
      const unlisten = listen('terminal:output', (event: any) => {
        if (!active) return;
        const { id, sequence, data } = event.payload;
        try {
          callback(id, data);
        } finally {
          void invoke('terminal_ack', { workspaceId: id, sequence }).catch(() => undefined);
        }
      });
      return () => { active = false; unlisten.then((f) => f()); };
    },
    onExit: (callback: any) => {
      let active = true;
      const unlisten = listen('terminal:exit', (event: any) => {
        if (active) callback(event.payload.id);
      });
      return () => { active = false; unlisten.then((f) => f()); };
    },
  },
  task: {
    list: async () => invoke('task_list'),
    get: async (taskId: string) => invoke('task_get', { taskId }),
    getByProject: async (projectId: string) => invoke('task_get_by_project', { projectId }),
    save: async (task: any) => invoke('task_save', { task }),
    delete: async (taskId: string) => invoke('task_delete', { taskId }),
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
    list: async (): Promise<McpListPayload> => invoke('mcp_list'),
    saveUser: async (servers: Record<string, McpServerConfig>): Promise<McpListPayload> =>
      invoke('mcp_save_user', { servers }),
    setEnabled: async (name: string, enabled: boolean): Promise<McpListPayload> =>
      invoke('mcp_set_enabled', { name, enabled }),
    getCatalog: async (name: string): Promise<McpServerCatalog> => invoke('mcp_get_catalog', { name }),
    reconnect: async (name: string): Promise<void> => invoke('mcp_reconnect', { name }),
    authorize: async (name: string): Promise<void> => invoke('mcp_authorize', { name }),
    logout: async (name: string): Promise<void> => invoke('mcp_logout', { name }),
    trustProject: async (fingerprint: string): Promise<void> => invoke('mcp_trust_project', { fingerprint }),
    listSecretKeys: async (): Promise<string[]> => invoke('mcp_list_secret_keys'),
    setSecret: async (key: string, value: string): Promise<string[]> => invoke('mcp_set_secret', { key, value }),
    deleteSecret: async (key: string): Promise<string[]> => invoke('mcp_delete_secret', { key }),
    onChanged: (callback: (statuses: McpServerStatus[]) => void) => {
      let active = true;
      const unlisten = listen<McpServerStatus[]>('mcp:status-changed', (event) => {
        if (active) callback(event.payload);
      });
      return () => { active = false; unlisten.then((f) => f()); };
    },
  },
  subAgent: {
    list: async () => invoke('subagent_list'),
    toggle: async (type: string, enabled: boolean) => invoke('subagent_toggle', { subagentType: type, enabled }),
    getDetail: async (type: string) => invoke('subagent_get_detail', { subagentType: type }),
    setModel: async (type: string, selections: any[]) => invoke('subagent_set_model', { subagentType: type, selections }),
  },
  logger: {
    info: (...args: any[]) => console.log('[CodeZ]', ...args),
    warn: (...args: any[]) => console.warn('[CodeZ]', ...args),
    error: (...args: any[]) => console.error('[CodeZ]', ...args),
    debug: (...args: any[]) => console.debug('[CodeZ]', ...args),
  },
};
