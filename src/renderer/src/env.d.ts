/// <reference types="vite/client" />
/// <reference types="@electron-toolkit/preload" />

import type {
  McpListPayload,
  McpServerCatalog,
  McpServerConfig,
  McpServerStatus,
} from './components/SettingsMcpTab/types'

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
      permission: {
        getMode: (rootPath: string) => Promise<import('@shared/types/permission').PermissionMode>
        setMode: (
          rootPath: string,
          mode: import('@shared/types/permission').PermissionMode
        ) => Promise<import('@shared/types/permission').PermissionMode>
      }
      provider: {
        list: () => Promise<any[]>
        add: (form: any) => Promise<any>
        update: (id: string, form: any) => Promise<any | null>
        remove: (id: string) => Promise<boolean>
        testConnection: (id: string) => Promise<{ success: boolean; message: string; models?: string[] }>
        setActive: (id: string) => Promise<void>
      }
      attachment: {
        importDraft: (input: {
          name: string
          declaredMimeType: string
          bytes: Uint8Array
        }) => Promise<import('@shared/types/attachment').DraftImageAttachment>
        promoteDrafts: (
          sessionId: string,
          attachments: import('@shared/types/attachment').ComposerImageAttachment[]
        ) => Promise<import('@shared/types/attachment').ImageAttachment[]>
        rollbackPromotion: (sessionId: string, attachmentIds: string[]) => Promise<void>
        discardDrafts: (draftIds: string[]) => Promise<void>
        readPreview: (
          attachment: import('@shared/types/attachment').ComposerImageAttachment,
          variant: 'thumbnail' | 'original'
        ) => Promise<import('@shared/types/attachment').AttachmentPreviewBytes>
      }
      chat: {
        predictNextInput: (
          request: import('@shared/types/promptPrediction').PromptPredictionRequest
        ) => Promise<import('@shared/types/promptPrediction').PromptPredictionResponse>
        getRuntimeStatus: (
          sessionId: string
        ) => Promise<import('@shared/types/subagent').SessionRuntimeStatus>
        onRuntimeStatusChanged: (
          callback: (
            payload: import('@shared/types/subagent').SessionRuntimeStatusChanged
          ) => void
        ) => () => void
        steer: (
          sessionId: string,
          input: import('@shared/types/queuedPrompt').ChatSteerInput
        ) => Promise<import('@shared/types/queuedPrompt').ChatSteerResult>
        interruptTool: (toolCallId: string) => Promise<{
          ok: boolean
          status?: 'running' | 'completed' | 'failed' | 'interrupted'
          taskId?: string
          error?: string
        }>
        stream: (
          providerId: string,
          model: string,
          sessionId: string,
          input: import('@shared/types/context').StreamRequestV2['input'],
          callbacks: {
            onChunk: (delta: string, reasoningDelta?: string) => void
            onDone: (fullContent: string, stopReason?: string, txId?: string) => void
            onError: (error: string) => void
            onSteerConsumed?: (
              input: import('@shared/types/queuedPrompt').ChatSteerInput
            ) => void
            onToolStart?: (
              toolCallId: string,
              name: string,
              args: string,
              thoughtSignature?: string,
              batch?: import('../../shared/types/toolExecution').ToolBatchMeta
            ) => void
            onToolEnd?: (toolCallId: string, result: string) => void
            onPermissionRequest?: (request: any) => void
            onAskUserRequest?: (
              request: import('./shared/desktop/generated/contracts').ChatAskUserRequest
            ) => void
            onContextBudget?: (snapshot: import('@shared/types/context').ContextBudgetSnapshot) => void
            onCompactionStarted?: (payload: any) => void
            onCompactionCompleted?: (payload: any) => void
            onCompactionFailed?: (payload: any) => void
          }
        ) => {
          stop: () => void
          started: Promise<void>
        }
        compact: (sessionId: string, instructions?: string) => Promise<any>
        acceptFile: (txId: string, filePath: string) => Promise<boolean>
        rejectFile: (txId: string, filePath: string) => Promise<boolean>
        getDiff: (txId: string) => Promise<Array<{ path: string; diff: string }>>
        respondToApproval: (
          requestId: string,
          response: import('@shared/types/permission').PermissionApprovalResponse
        ) => Promise<void>
        respondAskUser: (
          requestId: string,
          answers: import('./shared/desktop/generated/contracts').ChatAskUserAnswer[]
        ) => Promise<void>
      }
      session: {
        list: () => Promise<any>
        get: (sessionId: string) => Promise<any | null>
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
        checkExternal: (workspaceRoot?: string | null) => Promise<{ hasUpdates: boolean; totalCount: number; sources: { sourceName: string; count: number }[] }>
        importExternal: (sourceName?: string, customPath?: string, forceOverwrite?: boolean, workspaceRoot?: string | null) => Promise<boolean>
        listExternal: (workspaceRoot?: string | null) => Promise<import('@shared/types/skill').ExternalSkillGroup[]>
        importSingle: (sourceName: string, dirName: string, workspaceRoot?: string | null) => Promise<boolean>
        remove: (workspaceRoot: string | null, id: string) => Promise<boolean>
      }
      rules: {
        getList: (workspaces: any[]) => Promise<any[]>
        save: (rule: any, workspaceRoot: string) => Promise<boolean>
        delete: (rulePath: string) => Promise<boolean>
        rename: (oldPath: string, newFilename: string, workspaceRoot: string, scope: string) => Promise<boolean>
      }
      settings: {
        get: () => Promise<any>
        save: (settings: any) => Promise<boolean>
      }
      mcp: {
        list: () => Promise<McpListPayload>
        saveUser: (servers: Record<string, McpServerConfig>) => Promise<McpListPayload>
        setEnabled: (name: string, enabled: boolean) => Promise<McpListPayload>
        getCatalog: (name: string) => Promise<McpServerCatalog>
        reconnect: (name: string) => Promise<void>
        authorize: (name: string) => Promise<void>
        logout: (name: string) => Promise<void>
        trustProject: (fingerprint: string) => Promise<void>
        listSecretKeys: () => Promise<string[]>
        setSecret: (key: string, value: string) => Promise<string[]>
        deleteSecret: (key: string) => Promise<string[]>
        onChanged: (callback: (statuses: McpServerStatus[]) => void) => () => void
      }
      subAgent: {
        list: () => Promise<import('@shared/types/subagent').SubAgentInfo[]>
        toggle: (type: string, enabled: boolean) => Promise<void>
        getDetail: (type: string) => Promise<import('@shared/types/subagent').SubAgentDetail | null>
        setModel: (
          type: string,
          selections: import('@shared/types/subagent').SubAgentModelSelection[]
        ) => Promise<void>
      }
      logger: {
        info: (...args: any[]) => void
        warn: (...args: any[]) => void
        error: (...args: any[]) => void
        debug: (...args: any[]) => void
      }
    }
  }
}

export {}
