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
  CHAT_REQUEST_APPROVAL: 'chat:request-approval',
  CHAT_APPROVAL_RESPONSE: 'chat:approval-response',
  CHAT_GET_DIFF: 'chat:get-diff',
  
  // Tool Logs
  CHAT_STREAM_TOOL_START: 'chat:stream:tool-start',
  CHAT_STREAM_TOOL_END: 'chat:stream:tool-end',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',


  // Tasks
  TASK_GET_BY_PROJECT: 'task:get-by-project',
  TASK_SAVE: 'task:save',
  TASK_DELETE: 'task:delete',

  // Theme
  THEME_GET: 'theme:get',
  THEME_SET: 'theme:set',

  // Skills
  SKILL_GET_ALL: 'skill:get-all',
  SKILL_TOGGLE: 'skill:toggle',
  SKILL_CHECK_EXTERNAL: 'skill:check-external',
  SKILL_IMPORT_EXTERNAL: 'skill:import-external',

  // Rules
  RULES_GET_LIST: 'rules:get-list',
  RULES_SAVE: 'rules:save',
  RULES_DELETE: 'rules:delete'
} as const
