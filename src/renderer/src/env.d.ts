/// <reference types="vite/client" />
/// <reference types="@electron-toolkit/preload" />

declare global {
  interface Window {
    api: {
      workspace: {
        openDirectory: () => Promise<string | null>
        scanFileTree: (rootPath: string) => Promise<any>
        readFile: (filePath: string, rootPath: string) => Promise<any>
        detectProject: (rootPath: string) => Promise<any>
        getRecentProjects: () => Promise<any>
        addRecentProject: (project: any) => Promise<void>
        removeRecentProject: (id: string) => Promise<void>
        openInEditor: (rootPath: string, editorId: string, exePath: string | null) => Promise<boolean>
        openInExplorer: (rootPath: string) => Promise<boolean>
        renameRecentProject: (id: string, newName: string) => Promise<void>
        detectInstalledEditors: () => Promise<Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }>>
      }
      provider: {
        list: () => Promise<any[]>
        add: (form: any) => Promise<any>
        update: (id: string, form: any) => Promise<any | null>
        remove: (id: string) => Promise<boolean>
        testConnection: (id: string) => Promise<{ success: boolean; message: string; models?: string[] }>
        setActive: (id: string) => Promise<void>
      }
      chat: {
        stream: (
          providerId: string,
          model: string,
          messages: any[],
          sessionId: string | null,
          callbacks: {
            onChunk: (delta: string, reasoningDelta?: string) => void
            onDone: (fullContent: string, stopReason?: string, txId?: string) => void
            onError: (error: string) => void
            onToolStart?: (toolCallId: string, name: string, args: string, thoughtSignature?: string) => void
            onToolEnd?: (toolCallId: string, result: string) => void
            onPermissionRequest?: (request: any) => void
          }
        ) => () => void
        acceptFile: (txId: string, filePath: string) => Promise<boolean>
        rejectFile: (txId: string, filePath: string) => Promise<boolean>
        getDiff: (txId: string) => Promise<Array<{ path: string; diff: string }>>
        respondToApproval: (requestId: string, approved: boolean) => Promise<void>
      }
      session: {
        list: () => Promise<any>
        save: (session: any) => Promise<void>
        delete: (sessionId: string) => Promise<void>
      }
      terminal: {
        start: (workspaceId: string, rootPath: string) => Promise<void>
        write: (workspaceId: string, text: string) => Promise<void>
        resize: (workspaceId: string, cols: number, rows: number) => Promise<void>
        kill: (workspaceId: string) => Promise<void>
        onOutput: (callback: (workspaceId: string, data: string) => void) => () => void
        onExit: (callback: (workspaceId: string) => void) => () => void
      }

      task: {
        list: (workspaceId: string) => Promise<any>
        get: (taskId: string) => Promise<any>
        getByProject: (workspaceId: string) => Promise<any>
        save: (task: any) => Promise<void>
        delete: (id: string) => Promise<any>
      }
      theme: {
        get: () => Promise<{ shouldUseDarkColors: boolean; themeSource: 'system' | 'light' | 'dark' }>
        set: (source: 'system' | 'light' | 'dark') => Promise<{ shouldUseDarkColors: boolean; themeSource: 'system' | 'light' | 'dark' }>
        onUpdated: (callback: (info: { shouldUseDarkColors: boolean; themeSource: 'system' | 'light' | 'dark' }) => void) => () => void
      }
      skill: {
        getAll: (workspaceRoot: string | null) => Promise<any[]>
        toggle: (workspaceRoot: string | null, id: string, enabled: boolean) => Promise<void>
        checkExternal: () => Promise<{ hasUpdates: boolean; totalCount: number; sources: { sourceName: string; count: number }[] }>
        importExternal: (sourceName?: string, customPath?: string, forceOverwrite?: boolean) => Promise<boolean>
      }
      rules: {
        getList: (workspaceRoot: string) => Promise<any[]>
        save: (rule: any, workspaceRoot: string) => Promise<boolean>
        delete: (rulePath: string) => Promise<boolean>
      }
    }
  }
}

export {}
