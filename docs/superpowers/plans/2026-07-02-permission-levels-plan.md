# Permission Levels & Interactive Approval Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement workspace-specific permission levels (ask, auto-approve safe, full access) and a smart approval widget with global/session whitelisting.

**Architecture:** Extend `WorkspaceInfo` to support a `permissionMode` field. Create a `PermissionRuleStore` to handle wildcard whitelisting. Update `PermissionManager` to check both the workspace mode and the rule storage prior to returning `ask/deny/allow`. Expose rule addition via IPC. Finally, update `PromptArea.tsx` to surface the workspace mode, and intercept commands via a smart approval widget that presents different matching scopes.

**Tech Stack:** React, Electron IPC, Zustand, Node fs

## Global Constraints

- Must retain existing security boundaries (path traversal outside workspace should still lead to deny in permission manager).
- Do not introduce large new CSS frameworks. Stick to existing custom CSS or inline properties.
- Only safe/read commands are auto-approved in auto-approve-safe mode, everything else hits the widget or whitelist.

---

### Task 1: Update Workspace Configuration Types

**Files:**
- Modify: `src/shared/types/workspace.ts`
- Modify: `src/renderer/src/stores/workspaceStore.ts`

**Interfaces:**
- Produces: `PermissionMode` type, updated `WorkspaceInfo`, and a setter in the store.

- [ ] **Step 1: Update type definition**

```typescript
// Add to src/shared/types/workspace.ts
export type PermissionMode = 'ask' | 'auto-approve-safe' | 'full-access';
```

Then add `permissionMode` to `WorkspaceInfo`:

```typescript
export interface WorkspaceInfo {
  id: string
  rootPath: string
  name: string
  projectType: string
  openedAt: string
  permissionMode?: PermissionMode
}
```

- [ ] **Step 2: Add setter in WorkspaceStore**

In `src/renderer/src/stores/workspaceStore.ts`, add the setter to the interface (or define it in the create function depending on how the store is structured):

```typescript
  setPermissionMode: async (mode: 'ask' | 'auto-approve-safe' | 'full-access') => {
    set((state: any) => {
      if (!state.currentWorkspace) return state
      const updated = { ...state.currentWorkspace, permissionMode: mode }
      // Assuming updateWorkspaceData exists, call it asynchronously
      if ((window.api as any)?.workspace?.updateWorkspaceData) {
        (window.api as any).workspace.updateWorkspaceData(updated)
      }
      return { currentWorkspace: updated }
    })
  },
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/workspace.ts src/renderer/src/stores/workspaceStore.ts
git commit -m "feat: add permission mode support to workspace configuration"
```

### Task 2: Create PermissionRuleStore

**Files:**
- Create: `src/main/services/PermissionRuleStore.ts`

**Interfaces:**
- Produces: `PermissionRuleStore.getInstance()`, `addRule(rule, scope)`, `isCommandWhitelisted(command)`

- [ ] **Step 1: Write the PermissionRuleStore**

```typescript
// Create src/main/services/PermissionRuleStore.ts
import * as path from 'path'
import { app } from 'electron'
import * as fs from 'fs/promises'

export class PermissionRuleStore {
  private globalRules: string[] = []
  private sessionRules: string[] = []
  private globalConfigPath: string

  private static instance: PermissionRuleStore
  public static getInstance(): PermissionRuleStore {
    if (!PermissionRuleStore.instance) {
      PermissionRuleStore.instance = new PermissionRuleStore()
    }
    return PermissionRuleStore.instance
  }

  private constructor() {
    this.globalConfigPath = path.join(app.getPath('userData'), 'global-permissions.json')
    this.load()
  }

  private async load() {
    try {
      const data = await fs.readFile(this.globalConfigPath, 'utf8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed.globalRules)) {
        this.globalRules = parsed.globalRules
      }
    } catch (e) {
      this.globalRules = []
    }
  }

  async addRule(rule: string, scope: 'session' | 'global') {
    if (scope === 'session') {
      if (!this.sessionRules.includes(rule)) this.sessionRules.push(rule)
    } else {
      if (!this.globalRules.includes(rule)) {
        this.globalRules.push(rule)
        await fs.writeFile(this.globalConfigPath, JSON.stringify({ globalRules: this.globalRules }, null, 2))
      }
    }
  }

  isCommandWhitelisted(command: string): boolean {
    const check = (rules: string[]) => {
      return rules.some(rule => {
        if (rule.endsWith('*')) {
          const prefix = rule.slice(0, -1).trim()
          return command.startsWith(prefix) || command === prefix
        }
        return command === rule
      })
    }
    return check(this.sessionRules) || check(this.globalRules)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/services/PermissionRuleStore.ts
git commit -m "feat: implement permission rule store for whitelisting commands"
```

### Task 3: Integrate Rules and Modes into PermissionManager

**Files:**
- Modify: `src/main/services/PermissionManager.ts`
- Modify: `src/main/ipc/workspace.handlers.ts`

**Interfaces:**
- Consumes: `PermissionRuleStore`
- Produces: `checkToolPermission` signature changes, IPC handler `permissions:addRule`

- [ ] **Step 1: Update PermissionManager signature & logic**

Modify `src/main/services/PermissionManager.ts`. Update `checkToolPermission` to accept a 4th argument `workspaceMode` defaulting to `'auto-approve-safe'`.

```typescript
import { PermissionRuleStore } from './PermissionRuleStore'

// update `checkToolPermission` signature:
  public checkToolPermission(toolName: string, parsedArgs: any, workspaceRoot: string, workspaceMode: 'ask' | 'auto-approve-safe' | 'full-access' = 'auto-approve-safe'): 'allow' | 'ask' | 'deny' {
    if (workspaceMode === 'full-access') {
       return 'allow'
    }

    if (['list_files', 'get_project_snapshot', 'fast_context', 'update_resume_state', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'PushNotification', 'AskUserQuestion'].includes(toolName)) {
      return 'allow'
    }

    if (toolName === 'rollback_last_edit') {
      return 'ask'
    }

    if (['Edit', 'Write'].includes(toolName)) {
      let targetPath = parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.file_path || parsedArgs?.path
      if (targetPath) {
        if (!path.isAbsolute(targetPath)) {
          targetPath = path.resolve(workspaceRoot, targetPath)
        }
        const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase()
        const normalizedRoot = workspaceRoot.replace(/\\/g, '/').toLowerCase()
        if (!normalizedTarget.startsWith(normalizedRoot)) {
          return 'deny'
        }
      }
      return workspaceMode === 'ask' ? 'ask' : 'allow'
    }

    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const command = this.getCommandFromArgs(parsedArgs)
      
      if (PermissionRuleStore.getInstance().isCommandWhitelisted(command)) {
        return 'allow'
      }

      if (workspaceMode === 'ask') return 'ask'

      const risk = this.getCommandRisk(command)
      if (risk === 'safe') return 'allow'
      return 'ask'
    }

    return 'ask'
  }
```

- [ ] **Step 2: Expose Rule Storage in IPC**

In `src/main/ipc/workspace.handlers.ts`:

```typescript
import { PermissionRuleStore } from '../services/PermissionRuleStore'

// Inside registerWorkspaceIpc:
ipcMain.handle('permissions:addRule', async (_, rule: string, scope: 'session' | 'global') => {
  await PermissionRuleStore.getInstance().addRule(rule, scope)
})
```

- [ ] **Step 3: Commit**

```bash
git add src/main/services/PermissionManager.ts src/main/ipc/workspace.handlers.ts
git commit -m "feat: integrate rules and permission modes into PermissionManager with IPC"
```

### Task 4: UI Refactoring - Permission Mode Dropdown

**Files:**
- Modify: `src/renderer/src/components/PromptArea.tsx`

**Interfaces:**
- Consumes: `useWorkspaceStore` `permissionMode`

- [ ] **Step 1: Replace Approval Button with Dropdown**

In `src/renderer/src/components/PromptArea.tsx`, state and map required:

```typescript
const permissionLabels: Record<string, string> = {
  'ask': '请求批准',
  'auto-approve-safe': '替我审批',
  'full-access': '完全访问'
}
```

Add component state:
```typescript
const [permDropdownOpen, setPermDropdownOpen] = useState(false)
const workspace = useWorkspaceStore((s: any) => s.currentWorkspace)
const setPermissionMode = useWorkspaceStore((s: any) => s.setPermissionMode)
const mode = workspace?.permissionMode || 'auto-approve-safe'
```

Replace the static `IconMore...请求批准` button:
```tsx
<div className="relative">
  <Button 
    variant="ghost" 
    size="none" 
    className="prompt-approve-btn"
    onClick={() => setPermDropdownOpen(!permDropdownOpen)}
  >
    <IconMore /> {permissionLabels[mode]} <IconChevronDown />
  </Button>
  
  {permDropdownOpen && (
    <>
      <div className="fixed inset-0 z-[40]" onClick={() => setPermDropdownOpen(false)}></div>
      <Card variant="default" className="prompt-dropdown-card" style={{left: 0}}>
         <div className="prompt-dropdown-header">权限级别</div>
         {(['ask', 'auto-approve-safe', 'full-access'] as const).map(m => (
           <Flex
             key={m}
             align="center"
             justify="between"
             className={`prompt-dropdown-provider ${mode === m ? 'is-active' : ''}`}
             onClick={() => { setPermissionMode(m); setPermDropdownOpen(false) }}
           >
             <span>{permissionLabels[m]}</span>
             {mode === m && <span className="prompt-check-mark">✓</span>}
           </Flex>
         ))}
      </Card>
    </>
  )}
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/PromptArea.tsx
git commit -m "feat: add permission mode selection dropdown to prompt area"
```

### Task 5: Smart Approval Widget UI

**Files:**
- Modify: `src/renderer/src/components/chat/PermissionApprovalWidget.tsx` (Assuming this handles the intercept. If it handles generic tools, we build specific logic for Bash/PowerShell).

**Interfaces:**
- Consumes: `ipcRenderer.invoke('permissions:addRule')`

- [ ] **Step 1: Build the options generator and rendering logic**

In the Approval widget (where the command/approval is prompted):

```tsx
import React, { useState, useMemo } from 'react'

function generateCommandOptions(cmd: string = '') {
   const options = [{ label: `精确匹配: ${cmd}`, rule: cmd }]
   const parts = cmd.trim().split(/\s+/)
   if (parts.length > 2) {
      options.push({ label: `子命令: ${parts[0]} ${parts[1]} *`, rule: `${parts[0]} ${parts[1]} *`})
   }
   if (parts.length > 1) {
      options.push({ label: `全部: ${parts[0]} *`, rule: `${parts[0]} *` })
   }
   return options
}

// Inside the component that accepts the intercepted `command`:
const cmdOptions = useMemo(() => generateCommandOptions(command), [command])
const [selectedRule, setSelectedRule] = useState(cmdOptions[0]?.rule || '')
const [selectedScope, setSelectedScope] = useState<'once'|'session'|'global'>('once')

// Render Radios for rules
<div className="flex flex-col gap-2 mt-2">
  {cmdOptions.map(opt => (
    <label key={opt.rule} className="flex items-center gap-2 cursor-pointer">
       <input type="radio" checked={selectedRule === opt.rule} onChange={() => setSelectedRule(opt.rule)}/> 
       {opt.label}
    </label>
  ))}
  
  <select 
    value={selectedScope} 
    onChange={e => setSelectedScope(e.target.value as any)} 
    className="mt-2 p-1 border rounded w-fit text-sm bg-transparent"
  >
    <option value="once">仅限本次</option>
    <option value="session">本会话放行</option>
    <option value="global">全局始终放行</option>
  </select>
</div>

// On Approve:
const handleApprove = async () => {
   if (selectedScope !== 'once' && selectedRule) {
      try {
        await window.api.invoke('permissions:addRule', selectedRule, selectedScope)
      } catch (e) {
        console.error("Rule add error", e)
      }
   }
   // Call your original onApprove callback
   onApprove() 
}
```

*Note: Ensure `window.api.invoke` corresponds to your Electron preload script's `ipcRenderer.invoke`. If it's exposed under a different namespace, adjust accordingly.*

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/chat/PermissionApprovalWidget.tsx
git commit -m "feat: implement smart approval widget with scope and wildcard options"
```
