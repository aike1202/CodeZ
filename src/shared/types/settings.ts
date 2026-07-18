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

  // WebSearch — 联网搜索配置
  webSearch: WebSearchSettings;
}

export interface WebSearchSettings {
  /** 总开关，默认 true */
  enabled: boolean;
  /** 各引擎启用状态 */
  engines: {
    baidu: boolean;       // 国内，直连，默认 true
    juejin: boolean;      // 国内，直连，默认 true
    csdn: boolean;        // 国内，直连，默认 true
  };
  /** 用户自定义排除的站点域名（结果级过滤），默认 [] */
  blockedDomains: string[];
  /** 单次搜索返回结果上限，默认 10 */
  maxResults: number;
}

export const defaultWebSearchSettings: WebSearchSettings = {
  enabled: true,
  engines: {
    baidu: true,
    juejin: true,
    csdn: true
  },
  blockedDomains: [],
  maxResults: 10
};

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
  webSearch: defaultWebSearchSettings
};
