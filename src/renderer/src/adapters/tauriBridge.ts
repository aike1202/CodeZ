import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { desktopApi } from '../shared/desktop/api'

// Compatibility layer implementing window.api interface over Tauri IPC commands
export const tauriBridge: any = {
  workspace: {
    openDirectory: () => desktopApi.workspace.openDirectory(),
    scanFileTree: (rootPath: string) => desktopApi.workspace.scanFileTree(rootPath),
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
      const mode = await invoke<string>('permission_mode_get', { rootPath });
      return mode === 'fullAccess' ? 'full-access' : 'auto';
    },
    setMode: async (rootPath: string, mode: string) => {
      const mappedMode = mode === 'full-access' ? 'fullAccess' : 'auto';
      const newMode = await invoke<string>('permission_mode_set', { rootPath, mode: mappedMode });
      return newMode === 'fullAccess' ? 'full-access' : 'auto';
    },
  },
  provider: {
    list: () => invoke('provider_get_all'),
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
  chat: {
    predictNextInput: async () => ({ predictions: [] }),
    getRuntimeStatus: async () => null,
    onRuntimeStatusChanged: () => () => {},
    steer: async () => null,
    interruptTool: async () => null,
    stream: (providerId: string, model: string, sessionId: string, input: any, callbacks: any) => {
      // Mock stream implementation for testing compile
      return {
        stop: () => {},
        started: Promise.resolve(),
      };
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
      const unlisten = listen('terminal-output', (event: any) => {
        if (active) callback(event.payload.id, event.payload.data);
      });
      return () => {
        active = false;
        unlisten.then((f) => f());
      };
    },
    onExit: (callback: any) => {
      let active = true;
      const unlisten = listen('terminal-exit', (event: any) => {
        if (active) callback(event.payload.id);
      });
      return () => {
        active = false;
        unlisten.then((f) => f());
      };
    },
  },
  task: {
    list: async () => [],
    get: async () => null,
    getByProject: async () => null,
    save: async () => {},
    delete: async () => null,
  },
  theme: {
    get: () => invoke('theme_get'),
    set: (source: string) => invoke('theme_set', { source }),
    onUpdated: (callback: any) => {
      let active = true;
      const unlisten = listen('desktop://theme-changed', (event: any) => {
        if (active) callback(event.payload);
      });
      return () => {
        active = false;
        unlisten.then((f) => f());
      };
    },
  },
  skill: {
    getAll: async () => [],
    toggle: async () => {},
    checkExternal: async () => ({ hasUpdates: false, totalCount: 0, sources: [] }),
    importExternal: async () => true,
    listExternal: async () => [],
    importSingle: async () => true,
    remove: async () => true,
  },
};
