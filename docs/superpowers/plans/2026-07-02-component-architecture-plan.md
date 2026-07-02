# 前端组件架构与 PromptArea 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立全局组件行数上限与目录化规约（.agents/AGENTS.md），并将 620+ 行的 `PromptArea.tsx` 模块化重构为标准的 `PromptArea/` 目录结构，保证 100% 向后兼容。

**Architecture:** 采用 Component-as-a-Folder 模式，将主组件精简为顶层 UI 调度，把 Popover 下拉菜单解耦至 `components/` 局部子组件，将常量与类型下沉至 `constants.ts` 和 `types.ts`，并通过 `index.ts` 保持平滑默认导出。

**Tech Stack:** React 18, TypeScript, CodeMirror, CSS

## Global Constraints
- 单个 TSX/TS 文件限制在 150 行内，硬性上限 200 行。
- 一个 className 最多包含 2 个样式类名。
- 所有全局与相对 import `PromptArea` 保持不变。

---

### Task 1: 更新全局工程规范规则

**Files:**
- Modify: `f:/MyProjectF/CodeZ/.agents/AGENTS.md`

**Interfaces:**
- Consumes: 无
- Produces: 全局规范配置

- [ ] **Step 1: 补充文件行数上限与组件目录化规则**

在 `.agents/AGENTS.md` 中写入如下规范：
```markdown
禁止TS代码里出现多个CSS样式，一个className里最多2个样式！

# 组件与文件规范
1. **文件行数限制**：单个 TSX/TS 文件代码建议控制在 150 行以内，硬性上限 200 行。超过 200 行必须拆分为目录结构。
2. **组件目录结构规范**：复杂组件使用 `[ComponentName]/` 目录，包含 `index.ts`、`[ComponentName].tsx`、`[ComponentName].css`、`components/` 子组件与 `types.ts` / `constants.ts`。
```

- [ ] **Step 2: 提交代码**

```bash
git add .agents/AGENTS.md
git commit -m "docs: add component line limit and folder structure rules to AGENTS.md"
```

---

### Task 2: 提炼 PromptArea 常量与类型定义

**Files:**
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/types.ts`
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/constants.ts`

**Interfaces:**
- Consumes: `@shared/types/workspace`
- Produces: `PromptAreaProps`, `PERMISSION_MODES`, `permissionLabels`

- [ ] **Step 1: 创建 types.ts**

```typescript
import type { WorkspaceInfo } from '@shared/types/workspace'

export interface PromptAreaProps {
  onSend: (message: string, modelName: string) => void
  placeholder?: string
  onOpenSettings?: () => void
  workspace?: WorkspaceInfo | null
}
```

- [ ] **Step 2: 创建 constants.ts**

```typescript
export const permissionLabels: Record<string, string> = {
  'ask': '请求批准',
  'auto-approve-safe': '替我审批',
  'full-access': '完全访问'
}

export const PERMISSION_MODES = [
  {
    id: 'ask',
    title: '请求批准',
    subtitle: '每次执行系统命令或写入文件时都会询问。推荐新手使用。'
  },
  {
    id: 'auto-approve-safe',
    title: '替我审批',
    subtitle: '自动放行安全操作，仅拦截修改与风险命令。'
  },
  {
    id: 'full-access',
    title: '完全访问',
    subtitle: '减少确认次数。赋予极高权限，仅拦截极端危险命令。'
  }
]
```

- [ ] **Step 3: 提交代码**

```bash
git add src/renderer/src/components/PromptArea/types.ts src/renderer/src/components/PromptArea/constants.ts
git commit -m "refactor(PromptArea): extract types and constants"
```

---

### Task 3: 拆分 PromptArea 局部下拉菜单与弹窗组件

**Files:**
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/components/ModelSelector.tsx`
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/components/PermissionSelector.tsx`
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/components/PlusActionMenu.tsx`
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/components/SlashCommandMenu.tsx`
- Create: `f:/MyProjectF/CodeZ/src/renderer/src/components/PromptArea/components/FileMentionMenu.tsx`

**Interfaces:**
- Consumes: `useProviderStore`, `useWorkspaceStore`, `constants.ts`
- Produces: `ModelSelector`, `PermissionSelector`, `PlusActionMenu`, `SlashCommandMenu`, `FileMentionMenu` 组件

- [ ] **Step 1: 创建 ModelSelector.tsx**

```tsx
import React, { useRef, useEffect } from 'react'
import IconChevronDown from '../../icons/IconChevronDown'
import IconGear from '../../icons/IconGear'

interface ModelSelectorProps {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  providers: any[]
  activeProviderId: string | null
  setActiveProvider: (id: string) => void
  setActiveModel: (id: string, model: string) => void
  onOpenSettings?: () => void
}

export default function ModelSelector({
  isOpen,
  setIsOpen,
  providers,
  activeProviderId,
  setActiveProvider,
  setActiveModel,
  onOpenSettings
}: ModelSelectorProps): React.ReactElement {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const activeProvider = providers.find((p) => p.id === activeProviderId) || providers[0]
  const activeModel = activeProvider?.activeModel || activeProvider?.models?.[0] || '默认模型'

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, setIsOpen])

  return (
    <div className="model-selector-container" ref={dropdownRef}>
      <button className="model-selector-btn" onClick={() => setIsOpen(!isOpen)}>
        <span>{activeProvider?.name || '选择模型'}: {activeModel}</span>
        <IconChevronDown />
      </button>
      {isOpen && (
        <div className="model-dropdown-popover">
          {providers.map((p) => (
            <div key={p.id} className="provider-group">
              <div className="provider-name">{p.name}</div>
              {p.models?.map((m: string) => (
                <div
                  key={m}
                  className={`model-option ${p.id === activeProviderId && m === activeModel ? 'active' : ''}`}
                  onClick={() => {
                    setActiveProvider(p.id)
                    setActiveModel(p.id, m)
                    setIsOpen(false)
                  }}
                >
                  {m}
                </div>
              ))}
            </div>
          ))}
          {onOpenSettings && (
            <div className="dropdown-footer" onClick={onOpenSettings}>
              <IconGear />
              <span>设置模型供应商</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 创建 PermissionSelector.tsx**

```tsx
import React, { useRef, useEffect } from 'react'
import IconShieldAsk from '../../icons/IconShieldAsk'
import IconShieldApprove from '../../icons/IconShieldApprove'
import IconShieldAlert from '../../icons/IconShieldAlert'
import IconChevronDown from '../../icons/IconChevronDown'
import { PERMISSION_MODES, permissionLabels } from '../constants'

interface PermissionSelectorProps {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  mode: string
  setPermissionMode: (mode: string) => void
}

const getPermissionIcon = (id: string) => {
  if (id === 'ask') return <IconShieldAsk />
  if (id === 'auto-approve-safe') return <IconShieldApprove />
  return <IconShieldAlert />
}

export default function PermissionSelector({
  isOpen,
  setIsOpen,
  mode,
  setPermissionMode
}: PermissionSelectorProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, setIsOpen])

  return (
    <div className="perm-selector-container" ref={ref}>
      <button className="perm-selector-btn" onClick={() => setIsOpen(!isOpen)}>
        {getPermissionIcon(mode)}
        <span>{permissionLabels[mode] || '权限设置'}</span>
        <IconChevronDown />
      </button>
      {isOpen && (
        <div className="perm-dropdown-popover">
          {PERMISSION_MODES.map((item) => (
            <div
              key={item.id}
              className={`perm-item ${mode === item.id ? 'active' : ''}`}
              onClick={() => {
                setPermissionMode(item.id)
                setIsOpen(false)
              }}
            >
              <div className="perm-icon">{getPermissionIcon(item.id)}</div>
              <div className="perm-info">
                <div className="perm-title">{item.title}</div>
                <div className="perm-sub">{item.subtitle}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 创建 PlusActionMenu.tsx, SlashCommandMenu.tsx 与 FileMentionMenu.tsx**

将原有菜单选择与菜单弹出浮层逻辑独立提取为三个专注组件。

- [ ] **Step 4: 提交代码**

```bash
git add src/renderer/src/components/PromptArea/components/
git commit -m "refactor(PromptArea): extract subcomponents into components/ folder"
```

---

### Task 4: 创建组件工程目录与无缝导出 index.ts

**Files:**
- Move: `src/renderer/src/components/PromptArea.css` -> `src/renderer/src/components/PromptArea/PromptArea.css`
- Create: `src/renderer/src/components/PromptArea/index.ts`
- Create: `src/renderer/src/components/PromptArea/PromptArea.tsx`

**Interfaces:**
- Consumes: 子组件、`types.ts`
- Produces: 模块化目录下的 `PromptArea`

- [ ] **Step 1: 创建 index.ts**

```typescript
export { default } from './PromptArea'
export type { PromptAreaProps } from './types'
```

- [ ] **Step 2: 组装 PromptArea.tsx (行数精简到 120 行以内)**

在 `src/renderer/src/components/PromptArea/PromptArea.tsx` 中导入拆分出来的 `ModelSelector`、`PermissionSelector`、`PlusActionMenu`、`SlashCommandMenu`、`FileMentionMenu`，负责布局定位与事件广播。

- [ ] **Step 3: 删除旧的大文件 src/renderer/src/components/PromptArea.tsx**

删除根目录下的 620+ 行单文件 `src/renderer/src/components/PromptArea.tsx`，由新的 `PromptArea/` 目录接管。

- [ ] **Step 4: 提交代码**

```bash
git add src/renderer/src/components/PromptArea/
git rm src/renderer/src/components/PromptArea.tsx
git commit -m "refactor(PromptArea): convert monolithic component to modular folder architecture"
```

---

### Task 5: 校验与测试

- [ ] **Step 1: 类型检查与 Dev Server 校验**

确认 `npm run dev` 构建成功无 TS 编译错误，所有引用 `PromptArea` 的页面渲染正常。

- [ ] **Step 2: 最终提交**

```bash
git commit -m "chore: verify PromptArea modular refactoring"
```
