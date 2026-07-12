export const IPC_CHANNELS = {
  // Workspace
  OPEN_DIRECTORY: 'workspace:open-directory',
  SCAN_FILE_TREE: 'workspace:scan-file-tree',
  READ_FILE: 'workspace:read-file',
  GET_ALL_PATHS: 'workspace:get-all-paths',
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

  // Managed image attachments
  ATTACHMENT_IMPORT_DRAFT: 'attachment:import-draft',
  ATTACHMENT_PROMOTE_DRAFTS: 'attachment:promote-drafts',
  ATTACHMENT_ROLLBACK_PROMOTION: 'attachment:rollback-promotion',
  ATTACHMENT_DISCARD_DRAFTS: 'attachment:discard-drafts',
  ATTACHMENT_READ_PREVIEW: 'attachment:read-preview',

  // Chat/Agent (stream)
  CHAT_STREAM_START: 'chat:stream:start',
  CHAT_STREAM_CHUNK: 'chat:stream:chunk',
  CHAT_STREAM_END: 'chat:stream:end',
  CHAT_STREAM_ERROR: 'chat:stream:error',
  CHAT_STREAM_STOP: 'chat:stream:stop',
  CHAT_STREAM_STEER: 'chat:stream:steer',
  CHAT_STREAM_STEER_CONSUMED: 'chat:stream:steer-consumed',
  CHAT_RUNTIME_STATUS: 'chat:runtime:status',
  CHAT_RUNTIME_STATUS_CHANGED: 'chat:runtime:status-changed',
  CHAT_PREDICT_NEXT_INPUT: 'chat:predict-next-input',
  CHAT_COMPACT_START: 'chat:compact:start',
  CHAT_CONTEXT_BUDGET_UPDATED: 'chat:context-budget-updated',
  CHAT_COMPACTION_STARTED: 'chat:compaction-started',
  CHAT_COMPACTION_COMPLETED: 'chat:compaction-completed',
  CHAT_COMPACTION_FAILED: 'chat:compaction-failed',
  CHAT_HISTORY_RECOVERED: 'chat:history-recovered',
  CHAT_ACCEPT_FILE: 'chat:accept-file',
  CHAT_REJECT_FILE: 'chat:reject-file',
  CHAT_REQUEST_APPROVAL: 'chat:request-approval',
  CHAT_APPROVAL_RESPONSE: 'chat:approval-response',
  CHAT_REQUEST_ASK_USER: 'chat:request-ask-user',
  CHAT_ASK_USER_RESPONSE: 'chat:ask-user-response',
  CHAT_GET_DIFF: 'chat:get-diff',
  CHAT_REVERT_MESSAGES: 'chat:revert-messages',
  CHAT_PREVIEW_REVERT_MESSAGES: 'chat:preview-revert-messages',
  
  // Tool Logs
  CHAT_STREAM_TOOL_START: 'chat:stream:tool-start',
  CHAT_STREAM_TOOL_END: 'chat:stream:tool-end',

  // SubAgent Logs (scoped to a sub-agent invocation, keyed by subAgentId)
  CHAT_STREAM_SUBAGENT_START: 'chat:stream:subagent:start',
  CHAT_STREAM_SUBAGENT_END: 'chat:stream:subagent:end',
  CHAT_STREAM_SUBAGENT_CHUNK: 'chat:stream:subagent:chunk',
  CHAT_STREAM_SUBAGENT_TOOL_START: 'chat:stream:subagent:tool-start',
  CHAT_STREAM_SUBAGENT_TOOL_END: 'chat:stream:subagent:tool-end',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',


  // Plan
  PLAN_STATE_CHANGED: 'plan:state-changed',
  PLAN_APPROVE: 'plan:approve',
  PLAN_REJECT: 'plan:reject',
  PLAN_LIST: 'plan:list',
  PLAN_LOAD: 'plan:load',
  PLAN_GET_ACTIVE: 'plan:get-active',
  PLAN_ENTER_REQUEST: 'plan:enter-request',
  PLAN_ENTER_RESPONSE: 'plan:enter-response',
  PLAN_SUBAGENT_PROGRESS: 'plan:subagent-progress',
  PLAN_LINKED: 'plan:linked',

  // Parallel plan execution
  PARALLEL_EXEC_STARTED: 'parallel:exec-started',
  PARALLEL_WAVE_UPDATE: 'parallel:wave-update',
  PARALLEL_EXEC_DONE: 'parallel:exec-done',
  EXECUTION_EVENT: 'execution:event',

  // Task (轻量待办，仅会话内存)
  TASK_UPDATED: 'task:updated',

  // Theme
  THEME_GET: 'theme:get',
  THEME_SET: 'theme:set',

  // Skills
  SKILL_GET_ALL: 'skill:get-all',
  SKILL_TOGGLE: 'skill:toggle',
  SKILL_CHECK_EXTERNAL: 'skill:check-external',
  SKILL_IMPORT_EXTERNAL: 'skill:import-external',
  SKILL_LIST_EXTERNAL: 'skill:list-external',
  SKILL_IMPORT_SINGLE: 'skill:import-single',
  SKILL_DELETE: 'skill:delete',

  // Rules
  RULES_GET_LIST: 'rules:get-list',
  RULES_SAVE: 'rules:save',
  RULES_DELETE: 'rules:delete',
  RULES_RENAME: 'rules:rename',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',

  // MCP
  MCP_LIST: 'mcp:list',
  MCP_SAVE_USER: 'mcp:save-user',
  MCP_RECONNECT: 'mcp:reconnect',
  MCP_AUTHORIZE: 'mcp:authorize',
  MCP_LOGOUT: 'mcp:logout',
  MCP_TRUST_PROJECT: 'mcp:trust-project',
  MCP_SECRET_KEYS: 'mcp:secret-keys',
  MCP_SECRET_SET: 'mcp:secret-set',
  MCP_SECRET_DELETE: 'mcp:secret-delete',
  MCP_CHANGED: 'mcp:changed',

  // Permissions
  PERMISSION_MODE_GET: 'permission:mode:get',
  PERMISSION_MODE_SET: 'permission:mode:set',

  // SubAgents
  SUBAGENT_LIST: 'subagent:list',
  SUBAGENT_TOGGLE: 'subagent:toggle',
  SUBAGENT_GET_DETAIL: 'subagent:get-detail'
} as const
