import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC_CHANNELS } from '../shared/ipc/channels'
import type { ProviderFormData, ProviderInfo, ConnectionTestResult, ChatMessage } from '../shared/types/provider'
import type { SessionData } from '../shared/types/session'

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

  chat: {
    /**
     * 发起流式聊天请求，并接收 tool call 日志。
     */
    stream: (
      providerId: string,
      model: string,
      messages: ChatMessage[],
      sessionId: string | null,
      callbacks: {
        onChunk: (delta: string, reasoningDelta?: string) => void
        onDone: (fullContent: string, stopReason?: string, txId?: string) => void
        onError: (error: string) => void
        onToolStart?: (toolCallId: string, name: string, args: string, thoughtSignature?: string) => void
        onToolEnd?: (toolCallId: string, result: string) => void
        onPermissionRequest?: (request: any) => void
        onAskUserRequest?: (request: any) => void
      }
    ): (() => void) => {
      let activeStreamId: string | null = null

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
      const toolStartHandler = (_event: unknown, streamId: string, toolCallId: string, name: string, args: string, thoughtSignature?: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onToolStart?.(toolCallId, name, args, thoughtSignature)
      }
      const toolEndHandler = (_event: unknown, streamId: string, toolCallId: string, result: string) => {
        if (streamId !== activeStreamId) return
        callbacks.onToolEnd?.(toolCallId, result)
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
        if (activeStreamId) {
          ipcRenderer.invoke(IPC_CHANNELS.CHAT_STREAM_STOP, activeStreamId)
        }
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunkHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_END, endHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_ERROR, errorHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_START, toolStartHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_END, toolEndHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_APPROVAL, approvalHandler)
        ipcRenderer.removeListener(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, askUserHandler)
      }

      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, chunkHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_END, endHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_ERROR, errorHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_START, toolStartHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_END, toolEndHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_APPROVAL, approvalHandler)
      ipcRenderer.on(IPC_CHANNELS.CHAT_REQUEST_ASK_USER, askUserHandler)

      // 发起请求
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_STREAM_START, { providerId, model, messages, sessionId })
        .then((streamId) => {
          activeStreamId = streamId
        })
        .catch((err) => {
          cleanup()
          callbacks.onError(`IPC 错误: ${err}`)
        })

      return cleanup
    },

    acceptFile: (txId: string, filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_ACCEPT_FILE, txId, filePath),

    rejectFile: (txId: string, filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_REJECT_FILE, txId, filePath),

    getDiff: (txId: string): Promise<Array<{ path: string; diff: string }>> =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_DIFF, txId),
      
    respondToApproval: (requestId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_APPROVAL_RESPONSE}:${requestId}`, approved),

    respondAskUser: (requestId: string, answers: any): Promise<void> =>
      ipcRenderer.invoke(`${IPC_CHANNELS.CHAT_ASK_USER_RESPONSE}:${requestId}`, answers)
  },

  session: {
    list: (): Promise<SessionData[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),

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
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_IMPORT_EXTERNAL, sourceName, customPath, forceOverwrite)
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

  plan: {
    list: (workspaceRoot: string): Promise<any[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_LIST, workspaceRoot),
    load: (workspaceRoot: string, slug: string): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_LOAD, workspaceRoot, slug),
    getActive: (workspaceRoot: string): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET_ACTIVE, workspaceRoot),
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
