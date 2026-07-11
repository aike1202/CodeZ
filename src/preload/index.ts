import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC_CHANNELS } from '../shared/ipc/channels'
import type { ProviderFormData, ProviderInfo, ConnectionTestResult } from '../shared/types/provider'
import type { SessionData } from '../shared/types/session'
import type { StreamRequestV2 } from '../shared/types/context'
import type { ToolBatchMeta } from '../shared/types/toolExecution'
import type {
  AttachmentPreviewBytes,
  ComposerImageAttachment,
  DraftImageAttachment,
  ImageAttachment
} from '../shared/types/attachment'

export interface ChatStreamHandle {
  stop: () => void
  started: Promise<void>
}

const api = {
  workspace: {
    openDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.OPEN_DIRECTORY),

    scanFileTree: (rootPath: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.SCAN_FILE_TREE, rootPath),

    getAllPaths: (rootPath: string): Promise<Array<{ name: string; path: string; isDir: boolean }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_ALL_PATHS, rootPath),

    readFile: (filePath: string, rootPath: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, filePath, rootPath),

    detectProject: (rootPath: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.DETECT_PROJECT, rootPath),

    getRecentProjects: (): Promise<unknown> =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_RECENT_PROJECTS),

    addRecentProject: (project: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.ADD_RECENT_PROJECT, project),

    removeRecentProject: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.REMOVE_RECENT_PROJECT, id),

    openInEditor: (rootPath: string, editorId: string, exePath: string | null): Promise<boolean> =>
      ipcRenderer.invoke('workspace:open-in-editor', rootPath, editorId, exePath),

    openInExplorer: (rootPath: string): Promise<boolean> =>
      ipcRenderer.invoke('workspace:open-in-explorer', rootPath),

    renameRecentProject: (id: string, newName: string): Promise<void> =>
      ipcRenderer.invoke('workspace:rename-recent-project', id, newName),

    detectInstalledEditors: (): Promise<any[]> =>
      ipcRenderer.invoke('workspace:detect-installed-editors')
  },

  permission: {
    getMode: (rootPath: string) => ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_MODE_GET, rootPath),
    setMode: (rootPath: string, mode: 'auto' | 'full-access') =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_MODE_SET, rootPath, mode)
  },

  provider: {
    list: (): Promise<ProviderInfo[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST),

    add: (form: ProviderFormData): Promise<ProviderInfo> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_ADD, form),

    update: (id: string, form: Partial<ProviderFormData>): Promise<ProviderInfo | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_UPDATE, id, form),

    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_REMOVE, id),

    testConnection: (id: string): Promise<ConnectionTestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_TEST, id),

    setActive: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SET_ACTIVE, id)
  },

  attachment: {
    importDraft: (input: {
      name: string
      declaredMimeType: string
      bytes: Uint8Array
    }): Promise<DraftImageAttachment> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_IMPORT_DRAFT, input),

    promoteDrafts: (
      sessionId: string,
      attachments: ComposerImageAttachment[]
    ): Promise<ImageAttachment[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_PROMOTE_DRAFTS, sessionId, attachments),

    rollbackPromotion: (sessionId: string, attachmentIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_ROLLBACK_PROMOTION, sessionId, attachmentIds),

    discardDrafts: (draftIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_DISCARD_DRAFTS, draftIds),

    readPreview: (
      attachment: ComposerImageAttachment,
      variant: 'thumbnail' | 'original'
    ): Promise<AttachmentPreviewBytes> =>
      ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_READ_PREVIEW, attachment, variant)
  },

  chat: {
    /**
     * 发起流式聊天请求，并接收 tool call 日志。
     */
    stream: (
      providerId: string,
      model: string,
      sessionId: string,
      input: StreamRequestV2['input'],
      callbacks: {
        onChunk: (delta: string, reasoningDelta?: string) => void
        onDone: (fullContent: string, stopReason?: string, txId?: string) => void
        onError: (error: string) => void
        onToolStart?: (
          toolCallId: string,
          name: string,
          args: string,
          thoughtSignature?: string,
          batch?: ToolBatchMeta
        ) => void
        onToolEnd?: (toolCallId: string, result: string) => void
        onPermissionRequest?: (request: any) => void
        onAskUserRequest?: (request: any) => void
        onSubAgentStart?: (subAgentId: string, meta: any) => void
        onSubAgentEnd?: (subAgentId: string, result: any) => void
        onSubAgentChunk?: (subAgentId: string, delta: string, reasoningDelta: string) => void
        onSubAgentToolStart?: (subAgentId: string, toolCallId: string, name: string, args: string, thoughtSignature?: string) => void
        onSubAgentToolEnd?: (subAgentId: string, toolCallId: string, result: string) => void
        onContextBudget?: (snapshot: import('../shared/types/context').ContextBudgetSnapshot) => void
        onCompactionStarted?: (payload: any) => void
        onCompactionCompleted?: (payload: any) => void
        onCompactionFailed?: (payload: any) => void
      }
    ): ChatStreamHandle => {
      const requestedStreamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      let activeStreamId: string | null = requestedStreamId
      let cleanedUp = false
      let resolveStarted!: () => void
      let rejectStarted!: (error: Error) => void
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve
        rejectStarted = reject
      })

      // 注册监听
      const chunkHandler = (_event: unknown, streamId: string, delta: string, reasoningDelta?: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onChunk(delta, reasoningDelta)
      }
      const endHandler = (_event: unknown, streamId: string, fullContent: string, stopReason?: string, txId?: string) => {
        if (streamId !== activeStreamId) return
        cleanup()
        callbacks.onDone(fullContent, stopReason, txId)
      }
      const errorHandler = (_event: unknown, streamId: string, error: string) => {
        if (streamId !== activeStreamId) return
        cleanup()
        callbacks.onError(error)
      }
      const contextBudgetHandler = (_event: unknown, streamId: string, _sessionId: string, snapshot: import('../shared/types/context').ContextBudgetSnapshot) => {
        if (streamId !== activeStreamId) return
        callbacks.onContextBudget?.(snapshot)
      }
      const compactionStartedHandler = (_event: unknown, streamId: string, _sessionId: string, payload: any) => {
        if (streamId !== activeStreamId) return
        callbacks.onCompactionStarted?.(payload)
      }
      const compactionCompletedHandler = (_event: unknown, streamId: string, _sessionId: string, payload: any) => {
        if (streamId !== activeStreamId) return
        callbacks.onCompactionCompleted?.(payload)
      }
      const compactionFailedHandler = (_event: unknown, streamId: string, _sessionId: string, payload: any) => {
        if (streamId !== activeStreamId) return
        callbacks.onCompactionFailed?.(payload)
      }
      const toolStartHandler = (
        _event: unknown,
        streamId: string,
        toolCallId: string,
        name: string,
        args: string,
        thoughtSignature?: string,
        batch?: ToolBatchMeta
      ) => {
        if (streamId !== activeStreamId) return
        callbacks.onToolStart?.(toolCallId, name, args, thoughtSignature, batch)
      }
      const toolEndHandler = (_event: unknown, streamId: string, toolCallId: string, result: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onToolEnd?.(toolCallId, result)
      }
      const subAgentStartHandler = (_event: unknown, streamId: string, subAgentId: string, meta: any) => {
        if (streamId !== activeStreamId) return
        callbacks.onSubAgentStart?.(subAgentId, meta)
      }
      const subAgentEndHandler = (_event: unknown, streamId: string, subAgentId: string, result: any) => {
        if (streamId !== activeStreamId) return
        callbacks.onSubAgentEnd?.(subAgentId, result)
      }
      const subAgentChunkHandler = (_event: unknown, streamId: string, subAgentId: string, delta: string, reasoningDelta: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onSubAgentChunk?.(subAgentId, delta, reasoningDelta)
      }
      const subAgentToolStartHandler = (_event: unknown, streamId: string, subAgentId: string, toolCallId: string, name: string, args: string, thoughtSignature?: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onSubAgentToolStart?.(subAgentId, toolCallId, name, args, thoughtSignature)
      }
      const subAgentToolEndHandler = (_event: unknown, streamId: string, subAgentId: string, toolCallId: string, result: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onSubAgentToolEnd?.(subAgentId, toolCallId, result)
      }
      const approvalHandler = (_event: unknown, streamId: string, request: any) => {
        if (streamId !== activeStreamId) return
        if (callbacks.onPermissionRequest) {
          callbacks.onPermissionRequest(request)
        } else {
          console.warn('Denying permission request because UI has not implemented onPermissionRequest:', request)
          ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_APPROVAL_RESPONSE}:${request.id}`, false).catch(console.error)
        }
      }
      const askUserHandler = (_event: unknown, streamId: string, request: any) => {
        if (streamId !== activeStreamId) return
        if (callbacks.onAskUserRequest) {
          callbacks.onAskUserRequest(request)
        } else {
          // 无 handler 时回空答案作安全默认，避免主进程卡死
          ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${request.id}`, []).catch(console.error)
        }
      }

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        const streamId = activeStreamId
        activeStreamId = null
        if (streamId) {
          ipcRenderer.invoke(IPC_CHANNELS.CHAT_STREAM_STOP, streamId)
        }
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunkHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_END, endHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_ERROR, errorHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_START, toolStartHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_END, toolEndHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_START, subAgentStartHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_END, subAgentEndHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_CHUNK, subAgentChunkHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_TOOL_START, subAgentToolStartHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_TOOL_END, subAgentToolEndHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_APPROVAL, approvalHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, askUserHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_CONTEXT_BUDGET_UPDATED, contextBudgetHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_COMPACTION_STARTED, compactionStartedHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_COMPACTION_COMPLETED, compactionCompletedHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_COMPACTION_FAILED, compactionFailedHandler)
      }

      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunkHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_END, endHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_ERROR, errorHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_START, toolStartHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_END, toolEndHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_START, subAgentStartHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_END, subAgentEndHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_CHUNK, subAgentChunkHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_TOOL_START, subAgentToolStartHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_SUBAGENT_TOOL_END, subAgentToolEndHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_APPROVAL, approvalHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, askUserHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_CONTEXT_BUDGET_UPDATED, contextBudgetHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_COMPACTION_STARTED, compactionStartedHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_COMPACTION_COMPLETED, compactionCompletedHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_COMPACTION_FAILED, compactionFailedHandler)

      // 发起请求
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_STREAM_START, {
        streamId: requestedStreamId,
        providerId,
        model,
        sessionId,
        input
      } satisfies StreamRequestV2)
        .then((streamId: string) => {
          if (cleanedUp) return
          if (streamId !== requestedStreamId) {
            cleanup()
            const error = new Error('IPC 错误: 主进程返回了不匹配的 stream ID')
            rejectStarted(error)
            callbacks.onError(error.message)
            return
          }
          resolveStarted()
        })
        .catch((err) => {
          cleanup()
          const error = err instanceof Error ? err : new Error(String(err))
          rejectStarted(error)
          callbacks.onError(`IPC 错误: ${error.message}`)
        })

      return { stop: cleanup, started }
    },

    compact: (sessionId: string, instructions?: string): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_COMPACT_START, { sessionId, instructions }),

    acceptFile: (txId: string, filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_ACCEPT_FILE, txId, filePath),

    rejectFile: (txId: string, filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_REJECT_FILE, txId, filePath),

    getDiff: (txId: string): Promise<Array<{ path: string; diff: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_DIFF, txId),
      
    respondToApproval: (requestId: string, response: import('../shared/types/permission').PermissionApprovalResponse): Promise<void> =>
      ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_APPROVAL_RESPONSE}:${requestId}`, response),

    respondAskUser: (requestId: string, answers: any): Promise<void> =>
      ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${requestId}`, answers)
  },

  session: {
    list: (): Promise<SessionData[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),

    get: (sessionId: string): Promise<SessionData | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),

    save: (session: SessionData): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SAVE, session),

    delete: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId)
  },

  terminal: {
    start: (workspaceId: string, rootPath: string): Promise<void> =>
      ipcRenderer.invoke('terminal:start', workspaceId, rootPath),

    write: (workspaceId: string, text: string): Promise<void> =>
      ipcRenderer.invoke('terminal:write', workspaceId, text),

    resize: (workspaceId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', workspaceId, cols, rows),

    kill: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:kill', workspaceId),

    onOutput: (callback: (workspaceId: string, data: string) => void): (() => void) => {
      const handler = (_event: unknown, workspaceId: string, data: string) => {
        callback(workspaceId, data)
      }
      ipcRenderer.on('terminal:output', handler)
      return () => {
        ipcRenderer.removeListener('terminal:output', handler)
      }
    },

    onExit: (callback: (workspaceId: string) => void): (() => void) => {
      const handler = (_event: unknown, workspaceId: string) => {
        callback(workspaceId)
      }
      ipcRenderer.on('terminal:exit', handler)
      return () => {
        ipcRenderer.removeListener('terminal:exit', handler)
      }
    }
  },

  theme: {
    get: (): Promise<{ shouldUseDarkColors: boolean; themeSource: 'system' | 'light' | 'dark' }> =>
      ipcRenderer.invoke(IPC_CHANNELS.THEME_GET),
    set: (source: 'system' | 'light' | 'dark'): Promise<{ shouldUseDarkColors: boolean; themeSource: 'system' | 'light' | 'dark' }> =>
      ipcRenderer.invoke(IPC_CHANNELS.THEME_SET, source),
    onUpdated: (callback: (info: { shouldUseDarkColors: boolean; themeSource: 'system' | 'light' | 'dark' }) => void): (() => void) => {
      const handler = (_event: unknown, info: any) => callback(info)
      ipcRenderer.on('theme:updated', handler)
      return () => ipcRenderer.removeListener('theme:updated', handler)
    }
  },

  skill: {
    getAll: (workspaceRoot: string | null): Promise<any[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET_ALL, workspaceRoot),
    toggle: (workspaceRoot: string | null, id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_TOGGLE, id, enabled),
    checkExternal: (): Promise<{ hasUpdates: boolean, totalCount: number, sources: { sourceName: string, count: number }[] }> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_CHECK_EXTERNAL),
    importExternal: (sourceName?: string, customPath?: string, forceOverwrite?: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_IMPORT_EXTERNAL, sourceName, customPath, forceOverwrite),
    listExternal: (): Promise<any[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST_EXTERNAL),
    importSingle: (sourceName: string, dirName: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_IMPORT_SINGLE, sourceName, dirName),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, id)
  },

  rules: {
    getList: (workspaces: any[]): Promise<any[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.RULES_GET_LIST, workspaces),
    save: (rule: any, workspaceRoot: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.RULES_SAVE, rule, workspaceRoot),
    delete: (rulePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.RULES_DELETE, rulePath),
    rename: (oldPath: string, newFilename: string, workspaceRoot: string, scope: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.RULES_RENAME, oldPath, newFilename, workspaceRoot, scope)
  },

  settings: {
    get: (): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    save: (settings: any): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings)
  },

  subAgent: {
    list: (): Promise<any[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_LIST),
    toggle: (type: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_TOGGLE, type, enabled),
    getDetail: (type: string): Promise<any | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SUBAGENT_GET_DETAIL, type)
  },

  plan: {
    list: (workspaceRoot: string): Promise<any[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_LIST, workspaceRoot),
    load: (workspaceRoot: string, slug: string): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_LOAD, workspaceRoot, slug),
    getActive: (workspaceRoot: string): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET_ACTIVE, workspaceRoot),
  },

  parallel: {
    /**
     * 订阅并行执行的 3 个广播事件。返回取消订阅函数。
     * 这些事件面向所有窗口广播（非 stream 作用域），因此独立于 chat.stream 订阅。
     */
    subscribe: (callbacks: {
      onStarted?: (payload: { planSlug: string; waves: any[]; isolation: string; rationale: string }) => void
      onWaveUpdate?: (payload: { waveIndex: number; status: string; stepResults: any[] }) => void
      onDone?: (payload: { report: any }) => void
    }): (() => void) => {
      const startedHandler = (_e: unknown, payload: any) => callbacks.onStarted?.(payload)
      const waveHandler = (_e: unknown, payload: any) => callbacks.onWaveUpdate?.(payload)
      const doneHandler = (_e: unknown, payload: any) => callbacks.onDone?.(payload)

      ipcRenderer.on(IPC_CHANNELS.PARALLEL_EXEC_STARTED, startedHandler)
      ipcRenderer.on(IPC_CHANNELS.PARALLEL_WAVE_UPDATE, waveHandler)
      ipcRenderer.on(IPC_CHANNELS.PARALLEL_EXEC_DONE, doneHandler)

      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.PARALLEL_EXEC_STARTED, startedHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.PARALLEL_WAVE_UPDATE, waveHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.PARALLEL_EXEC_DONE, doneHandler)
      }
    },
  },

  task: {
    /**
     * 订阅轻量 Task 的全量清单更新（会话内存）。返回取消订阅函数。
     */
    subscribe: (
      callback: (payload: { sessionId: string; tasks: any[] }) => void
    ): (() => void) => {
      const handler = (_e: unknown, payload: any) => callback(payload)
      ipcRenderer.on(IPC_CHANNELS.TASK_UPDATED, handler)
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.TASK_UPDATED, handler)
      }
    },
  },

  logger: {
    info: (...args: any[]) => ipcRenderer.send('app:log', 'info', ...args),
    warn: (...args: any[]) => ipcRenderer.send('app:log', 'warn', ...args),
    error: (...args: any[]) => ipcRenderer.send('app:log', 'error', ...args),
    debug: (...args: any[]) => ipcRenderer.send('app:log', 'debug', ...args)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('preload: failed to expose API', error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}

export type WebAPI = typeof api
