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
  AttachmentPreviewBytes,
  ComposerImageAttachment,
  DraftImageAttachment,
  SessionImageAttachment,
  ProviderInfo,
  ProviderFormData,
  ConnectionTestResult,
} from './generated/contracts'
import type {
  LedgerAppendRequest,
  LedgerEvent,
  SessionRuntimeSnapshot
} from '@shared/types/context'
import { normalizeDesktopError } from './errors'

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args)
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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

export interface DesktopApi {
  system: {
    health(): Promise<HealthResponse>
    probe(): Promise<Array<DesktopEvent<SystemProbeEvent>>>
  }
  window: {
    control(action: WindowAction): Promise<void>
    openExternal(target: string): Promise<void>
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
  attachment: {
    importDraft(name: string, declaredMimeType?: string, bytes?: number[] | Uint8Array): Promise<DraftImageAttachment>
    promoteDrafts(sessionId: string, attachments: ComposerImageAttachment[]): Promise<SessionImageAttachment[]>
    discardDrafts(draftIds: string[]): Promise<void>
    readPreview(attachment: ComposerImageAttachment, variant: string): Promise<AttachmentPreviewBytes>
    deleteSession(sessionId: string): Promise<void>
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
}

export const desktopApi: DesktopApi = {
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
    control: (action) => command('window_control', { action }),
    openExternal: (target) => command('open_external', { target })
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
      const unlisten = listen<ThemeInfo>('desktop://theme-changed', (event) => {
        if (!disposed) callback(event.payload)
      })
      return () => {
        disposed = true
        void unlisten.then((dispose) => dispose()).catch(() => undefined)
      }
    }
  },
  attachment: {
    importDraft: (name, declaredMimeType, bytes) => command('attachment_import_draft', { name, declaredMimeType, bytes: Array.from(bytes || []) }),
    promoteDrafts: (sessionId, attachments) => command('attachment_promote_drafts', { sessionId, attachments }),
    discardDrafts: (draftIds) => command('attachment_discard_drafts', { draftIds }),
    readPreview: (attachment, variant) => command('attachment_read_preview', { attachment, variant }),
    deleteSession: (sessionId) => command('attachment_delete_session', { sessionId })
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
  context: {
    ledgerAppendEvent: async (sessionId, event) => command('ledger_append_event', { sessionId, event }),
    ledgerGetSnapshot: async (sessionId) => command('ledger_get_snapshot', { sessionId }),
  }
}
