export interface GeneralSettings {
  // Appearance
  appTheme: 'system' | 'light' | 'dark';
  language: 'zh-CN' | 'en-US';
  editorTheme: string;
  
  // Terminal
  inheritTerminalProfile: boolean;
  terminalFont: string;
  terminalShell: 'auto' | 'bash' | 'cmd' | 'powershell';
  httpProxy: string;
  
  // Notifications
  taskNotifications: boolean;
  notificationSounds: boolean;
  hideToTrayOnClose: boolean;
  
  // Interaction
  interactionBehavior: 'queue' | 'immediate';
  showThinkingProcess: boolean;
  showTodoCards: boolean;
  
  // Storage
  autoArchiveTasks: boolean;
  archiveRetentionDays: number;
  dataStoragePath: string;
  experienceOptimization: boolean;
  // Security
  workspaceMode: 'ask' | 'auto-approve-safe' | 'full-access';

  // SubAgents — 被禁用的子智能体 type 列表（不在列表中即为启用）
  disabledSubAgents: string[];
}

export const defaultSettings: GeneralSettings = {
  appTheme: 'system',
  language: 'zh-CN',
  editorTheme: 'github',
  inheritTerminalProfile: true,
  terminalFont: '',
  terminalShell: 'auto',
  httpProxy: '',
  taskNotifications: true,
  notificationSounds: true,
  hideToTrayOnClose: false,
  interactionBehavior: 'queue',
  showThinkingProcess: true,
  showTodoCards: true,
  autoArchiveTasks: false,
  archiveRetentionDays: 7,
  dataStoragePath: '',
  experienceOptimization: true,
  workspaceMode: 'auto-approve-safe',
  disabledSubAgents: []
};
