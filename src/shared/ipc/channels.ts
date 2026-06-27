export const IPC_CHANNELS = {
  // Workspace
  OPEN_DIRECTORY: 'workspace:open-directory',
  SCAN_FILE_TREE: 'workspace:scan-file-tree',
  READ_FILE: 'workspace:read-file',
  DETECT_PROJECT: 'workspace:detect-project',
  GET_RECENT_PROJECTS: 'workspace:get-recent-projects',
  ADD_RECENT_PROJECT: 'workspace:add-recent-project',
  REMOVE_RECENT_PROJECT: 'workspace:remove-recent-project',

  // Provider
  PROVIDER_LIST: 'provider:list',
  PROVIDER_ADD: 'provider:add',
  PROVIDER_UPDATE: 'provider:update',
  PROVIDER_REMOVE: 'provider:remove',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_SET_ACTIVE: 'provider:set-active',

  // Chat/Agent (stream)
  CHAT_STREAM_START: 'chat:stream:start',
  CHAT_STREAM_CHUNK: 'chat:stream:chunk',
  CHAT_STREAM_END: 'chat:stream:end',
  CHAT_STREAM_ERROR: 'chat:stream:error',
  CHAT_STREAM_STOP: 'chat:stream:stop',
  CHAT_ACCEPT_FILE: 'chat:accept-file',
  CHAT_REJECT_FILE: 'chat:reject-file',
  
  // Tool Logs
  CHAT_STREAM_TOOL_START: 'chat:stream:tool-start',
  CHAT_STREAM_TOOL_END: 'chat:stream:tool-end',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',

  // Project Memory
  PROJECT_MEMORY_GET: 'project-memory:get',
  PROJECT_MEMORY_LIST: 'project-memory:list',
  PROJECT_MEMORY_CREATE: 'project-memory:create',
  PROJECT_MEMORY_SAVE: 'project-memory:save',
  PROJECT_MEMORY_DELETE: 'project-memory:delete',

  // Tasks
  TASK_GET_BY_PROJECT: 'task:get-by-project',
  TASK_SAVE: 'task:save',
  TASK_DELETE: 'task:delete'
} as const
