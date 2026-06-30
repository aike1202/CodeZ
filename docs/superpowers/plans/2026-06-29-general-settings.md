# General Settings UI & Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "常规" (General Settings) tab with a complete IPC-backed persistence layer and toggleable UI components.

**Architecture:** We will create a `SettingsService` in the Electron main process backed by `electron-store` for persistence, expose IPC handlers via preload, and manage the UI state via a Zustand `settingsStore`. The UI will use a new `Switch` component and follow a long-list card grouping.

**Tech Stack:** React, Zustand, Electron IPC, electron-store, TypeScript.

## Global Constraints

- Must follow existing codebase file structures (e.g., `src/shared`, `src/main/ipc`, `src/renderer/src/stores`).
- No placeholders (TBD, TODO). Provide complete code implementations in all steps.

---

### Task 1: Shared Types & IPC Channels

**Files:**
- Create: `src/shared/types/settings.ts`
- Modify: `src/shared/ipc/channels.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Produces: `GeneralSettings` type, IPC channels, and `window.api.settings` object.

- [ ] **Step 1: Create `src/shared/types/settings.ts`**

```typescript
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
  experienceOptimization: true
};
```

- [ ] **Step 2: Add IPC channels to `src/shared/ipc/channels.ts`**

*(Assuming channels.ts has a generic export object `IPC_CHANNELS`. Add the following keys if they don't exist, otherwise append them to the object.)*

```typescript
// Append these within the IPC_CHANNELS object:
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
```

- [ ] **Step 3: Update `src/preload/index.ts`**

Add the `settings` property inside the `api` object (around line 250, before the `skill` or `rules` section):

```typescript
  settings: {
    get: (): Promise<any> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    save: (settings: any): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings)
  },
```

---

### Task 2: Main Process Settings Service

**Files:**
- Create: `src/main/services/SettingsService.ts`
- Create: `src/main/ipc/settings.handlers.ts`
- Modify: `src/main/index.ts` (to call `registerSettingsIpc()`)

**Interfaces:**
- Consumes: `GeneralSettings`, `defaultSettings`, IPC channels.
- Produces: `SettingsService` class, `registerSettingsIpc` function.

- [ ] **Step 1: Create `src/main/services/SettingsService.ts`**

```typescript
import Store from 'electron-store'
import type { GeneralSettings } from '../../shared/types/settings'
import { defaultSettings } from '../../shared/types/settings'

export class SettingsService {
  private store: Store<{ settings: GeneralSettings }>

  constructor() {
    this.store = new Store<{ settings: GeneralSettings }>({
      name: 'user-settings',
      defaults: {
        settings: defaultSettings
      }
    })
  }

  public getSettings(): GeneralSettings {
    const data = this.store.get('settings') || defaultSettings
    return { ...defaultSettings, ...data }
  }

  public saveSettings(settings: Partial<GeneralSettings>): GeneralSettings {
    const current = this.getSettings()
    const updated = { ...current, ...settings }
    this.store.set('settings', updated)
    return updated
  }
}
```

- [ ] **Step 2: Create `src/main/ipc/settings.handlers.ts`**

```typescript
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SettingsService } from '../services/SettingsService'
import type { GeneralSettings } from '../../shared/types/settings'

let settingsService: SettingsService | null = null

export function getSettingsService(): SettingsService {
  if (!settingsService) {
    settingsService = new SettingsService()
  }
  return settingsService
}

export function registerSettingsIpc(): void {
  const svc = getSettingsService()

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (): Promise<GeneralSettings> => {
    return svc.getSettings()
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SAVE, async (_event, settings: Partial<GeneralSettings>): Promise<GeneralSettings> => {
    return svc.saveSettings(settings)
  })
}
```

- [ ] **Step 3: Register in `src/main/index.ts`**

Add the import and call it alongside other IPC registrations. *(The exact location depends on `src/main/index.ts`, typically inside `app.whenReady().then(...)`)*

```typescript
import { registerSettingsIpc } from './ipc/settings.handlers'

// Find the section where other register*Ipc() functions are called, and add:
registerSettingsIpc()
```

---

### Task 3: Renderer Zustand Store

**Files:**
- Create: `src/renderer/src/stores/settingsStore.ts`

**Interfaces:**
- Consumes: `window.api.settings`, `GeneralSettings`.
- Produces: `useSettingsStore` hook.

- [ ] **Step 1: Create `src/renderer/src/stores/settingsStore.ts`**

```typescript
import { create } from 'zustand'
import type { GeneralSettings } from '@shared/types/settings'

interface SettingsState {
  settings: GeneralSettings | null
  loading: boolean
  loadSettings: () => Promise<void>
  updateSettings: (newSettings: Partial<GeneralSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: true,
  
  loadSettings: async () => {
    set({ loading: true })
    try {
      const data = await window.api.settings.get()
      set({ settings: data, loading: false })
    } catch (error) {
      console.error('Failed to load settings:', error)
      set({ loading: false })
    }
  },

  updateSettings: async (newSettings: Partial<GeneralSettings>) => {
    const current = get().settings
    if (!current) return
    
    // Optimistic update
    const updated = { ...current, ...newSettings }
    set({ settings: updated })
    
    try {
      await window.api.settings.save(updated)
    } catch (error) {
      console.error('Failed to save settings:', error)
      // Revert on failure
      set({ settings: current })
    }
  }
}))
```

---

### Task 4: Switch UI Component

**Files:**
- Create: `src/renderer/src/components/ui/Switch.css`
- Create: `src/renderer/src/components/ui/Switch.tsx`

**Interfaces:**
- Produces: Reusable `<Switch checked onChange />` component.

- [ ] **Step 1: Create `src/renderer/src/components/ui/Switch.css`**

```css
.z-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}

.z-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.z-switch-slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background-color: var(--color-bg-secondary, #333);
  transition: .2s;
  border-radius: 20px;
}

.z-switch-slider:before {
  position: absolute;
  content: "";
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .2s;
  border-radius: 50%;
}

.z-switch input:checked + .z-switch-slider {
  background-color: var(--color-primary, #007bff);
}

.z-switch input:focus + .z-switch-slider {
  box-shadow: 0 0 1px var(--color-primary, #007bff);
}

.z-switch input:checked + .z-switch-slider:before {
  transform: translateX(16px);
}

.z-switch.disabled .z-switch-slider {
  cursor: not-allowed;
  opacity: 0.5;
}
```

- [ ] **Step 2: Create `src/renderer/src/components/ui/Switch.tsx`**

```tsx
import React from 'react'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export default function Switch({ checked, onChange, disabled, className = '' }: SwitchProps): React.ReactElement {
  return (
    <label className={`z-switch ${disabled ? 'disabled' : ''} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="z-switch-slider"></span>
    </label>
  )
}
```

---

### Task 5: SettingsGeneralTab Implementation

**Files:**
- Create: `src/renderer/src/components/SettingsGeneralTab.css`
- Create: `src/renderer/src/components/SettingsGeneralTab.tsx`

**Interfaces:**
- Consumes: `useSettingsStore`, `Switch`, `Input`, `Select`, `Card`, `Stack`, `Flex`.
- Produces: Main "常规" component layout.

- [ ] **Step 1: Create `src/renderer/src/components/SettingsGeneralTab.css`**

```css
.settings-general-wrapper {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
  color: var(--color-text-primary);
}

.settings-general-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 24px;
}

.settings-general-card {
  background: var(--color-bg-secondary, #1e1e1e);
  border-radius: 8px;
  border: 1px solid var(--color-border, #333);
  padding: 0;
  margin-bottom: 24px;
  overflow: hidden;
}

.settings-general-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border, #333);
}

.settings-general-row:last-child {
  border-bottom: none;
}

.settings-general-label {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
}

.settings-general-desc {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.settings-general-control {
  min-width: 150px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
```

- [ ] **Step 2: Create `src/renderer/src/components/SettingsGeneralTab.tsx`**

```tsx
import React, { useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import Switch from './ui/Switch'
import Select from './ui/Select'
import Input from './ui/Input'
import Button from './ui/Button'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import './SettingsGeneralTab.css'

export default function SettingsGeneralTab(): React.ReactElement {
  const { settings, loading, loadSettings, updateSettings } = useSettingsStore()

  useEffect(() => {
    loadSettings()
  }, [])

  if (loading || !settings) {
    return <div className="settings-general-wrapper">加载中...</div>
  }

  const handleUpdate = (key: keyof typeof settings, value: any) => {
    updateSettings({ [key]: value })
  }

  return (
    <div className="settings-general-wrapper">
      <h2 className="settings-general-title">常规设置</h2>

      {/* 1. 外观与显示 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">界面主题</div>
            <div className="settings-general-desc">切换应用界面使用的主题外观。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.appTheme} onChange={(e) => handleUpdate('appTheme', e.target.value)}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">界面语言</div>
            <div className="settings-general-desc">选择应用 UI 的显示语言。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.language} onChange={(e) => handleUpdate('language', e.target.value)}>
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">代码编辑器主题</div>
            <div className="settings-general-desc">设置代码预览区的高亮主题。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.editorTheme} onChange={(e) => handleUpdate('editorTheme', e.target.value)}>
              <option value="github">Github (Light)</option>
              <option value="dracula">Dracula (Dark)</option>
              <option value="material">Material (Dark)</option>
              <option value="xcode">Xcode (Light)</option>
              <option value="eclipse">Eclipse (Light)</option>
            </Select>
          </div>
        </div>
      </div>

      {/* 2. 终端与网络 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">继承系统终端 Profile</div>
            <div className="settings-general-desc">启动内置终端时尽量继承登录 shell 环境。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.inheritTerminalProfile} onChange={(val) => handleUpdate('inheritTerminalProfile', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">终端字体</div>
            <div className="settings-general-desc">留空时自动继承，例如 MesloLGS NF。</div>
          </div>
          <div className="settings-general-control">
            <Input 
              placeholder="例如: MesloLGS NF" 
              value={settings.terminalFont} 
              onChange={(e) => handleUpdate('terminalFont', e.target.value)} 
            />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">HTTP 代理</div>
            <div className="settings-general-desc">留空直连，修改后需重启应用生效。</div>
          </div>
          <div className="settings-general-control">
            <Input 
              placeholder="http://127.0.0.1:7890" 
              value={settings.httpProxy} 
              onChange={(e) => handleUpdate('httpProxy', e.target.value)} 
            />
          </div>
        </div>
      </div>

      {/* 3. 系统与通知 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">任务通知</div>
            <div className="settings-general-desc">任务完成、失败或需要确认时发送桌面通知。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.taskNotifications} onChange={(val) => handleUpdate('taskNotifications', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">关闭窗口时隐藏到托盘</div>
            <div className="settings-general-desc">点击关闭按钮时隐藏窗口，托盘中的退出仍会完全退出应用。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.hideToTrayOnClose} onChange={(val) => handleUpdate('hideToTrayOnClose', val)} />
          </div>
        </div>
      </div>

      {/* 4. 交互与偏好 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">交互行为</div>
            <div className="settings-general-desc">在运行时将后续操作加入队列，或引导至下一轮。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.interactionBehavior} onChange={(e) => handleUpdate('interactionBehavior', e.target.value)}>
              <option value="queue">队列</option>
              <option value="immediate">立即执行</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">显示思考过程</div>
            <div className="settings-general-desc">在消息流中展示模型思考内容。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.showThinkingProcess} onChange={(val) => handleUpdate('showThinkingProcess', val)} />
          </div>
        </div>
      </div>

      {/* 5. 数据与存储 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">自动归档旧任务</div>
            <div className="settings-general-desc">定时扫描最近打开过的工作区，自动归档任务。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.autoArchiveTasks} onChange={(val) => handleUpdate('autoArchiveTasks', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">数据存储路径</div>
            <div className="settings-general-desc">应用数据的根目录。修改后会搬运数据。</div>
          </div>
          <div className="settings-general-control" style={{ gap: '8px' }}>
             <Input disabled value={settings.dataStoragePath || '默认路径'} />
             <Button type="default" size="sm" onClick={() => alert('暂未实现更改路径功能')}>更改</Button>
          </div>
        </div>
      </div>

    </div>
  )
}
```

---

### Task 6: Integration in SettingsPage

**Files:**
- Modify: `src/renderer/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `SettingsGeneralTab`

- [ ] **Step 1: Import and Render `SettingsGeneralTab`**

```tsx
import SettingsGeneralTab from '../components/SettingsGeneralTab'

// Inside renderMainAreaContent() of SettingsPage.tsx:
// Replace the fallback for 'general' with SettingsGeneralTab
if (activeGlobalMenu === 'general') {
  return <SettingsGeneralTab />
}
```

*(End of Plan)*
