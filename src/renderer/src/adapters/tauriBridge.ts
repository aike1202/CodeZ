import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { desktopApi } from '../shared/desktop/api'
import { defaultSettings, defaultWebSearchSettings } from '@shared/types/settings'

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
    getMode: async (rootPath: string) => {
      try {
        const mode = await invoke<string>('permission_mode_get', { rootPath });
        return mode === 'fullAccess' ? 'full-access' : 'auto';
      } catch { return 'auto'; }
    },
    setMode: async (rootPath: string, mode: string) => {
      try {
        const mappedMode = mode === 'full-access' ? 'fullAccess' : 'auto';
        const newMode = await invoke<string>('permission_mode_set', { rootPath, mode: mappedMode });
        return newMode === 'fullAccess' ? 'full-access' : 'auto';
      } catch { return mode; }
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
    predictNextInput: async () => ({ predictions: [] }),
    getRuntimeStatus: async (sessionId: string) => ({
      sessionId,
      status: 'idle',
      totalTokens: 0,
      activePlugins: []
    }),
    onRuntimeStatusChanged: () => () => {},
    steer: async () => null,
    interruptTool: async () => ({ ok: false }),
    stream: (_providerId: string, _model: string, _sessionId: string, _input: any, callbacks: any) => {
      // Tauri streaming not yet wired — immediately signal done so UI doesn't hang
      setTimeout(() => callbacks.onError?.('Chat streaming is not yet available in Tauri mode.'), 100);
      return { stop: () => {}, started: Promise.resolve() };
    },
    compact: async () => null,
    acceptFile: async () => true,
    rejectFile: async () => true,
    getDiff: async () => [],
    respondToApproval: async () => {},
    respondAskUser: async () => {},
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
        if (active) callback(event.payload.id, event.payload.data);
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
    checkExternal: async () => invoke('skill_check_external'),
    importExternal: async () => invoke('skill_import_external'),
    listExternal: async () => invoke('skill_list_external'),
    importSingle: async (sourceName: string, dirName: string) => invoke('skill_import_single', { sourceName, dirName }),
    remove: async (id: string) => invoke('skill_remove', { id }),
  },
  rules: {
    getList: async (workspaces?: any[]) => invoke('rules_get_list', { workspaces: workspaces || [] }),
    save: async (rule: any, workspaceRoot: string) => invoke('rules_save', { rule, workspaceRoot }),
    delete: async (rulePath: string) => invoke('rules_delete', { rulePath }),
    rename: async (oldPath: string, newFilename: string, workspaceRoot: string, scope: string) => invoke('rules_rename', { oldPath, newFilename, workspaceRoot, scope }),
  },
  mcp: {
    list: async () => invoke('mcp_list'),
    saveUser: async (servers: Record<string, unknown>) => invoke('mcp_save_user', { servers }),
    setEnabled: async (name: string, enabled: boolean) => invoke('mcp_set_enabled', { name, enabled }),
    getCatalog: async (name: string) => invoke('mcp_get_catalog', { name }),
    reconnect: async (name: string) => invoke('mcp_reconnect', { name }),
    authorize: async (name: string) => invoke('mcp_authorize', { name }),
    logout: async (name: string) => invoke('mcp_logout', { name }),
    trustProject: async (fingerprint: string) => invoke('mcp_trust_project', { fingerprint }),
    listSecretKeys: async () => invoke('mcp_list_secret_keys'),
    setSecret: async (key: string, value: string) => invoke('mcp_set_secret', { key, value }),
    deleteSecret: async (key: string) => invoke('mcp_delete_secret', { key }),
    onChanged: (callback: (statuses: any[]) => void) => {
      let active = true;
      const unlisten = listen('mcp:status-changed', (event: any) => {
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
