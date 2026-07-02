# 10 大 UI 组件重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目中最庞大的 10 个 UI 组件拆解重构为标准的 `Component/` 目录结构，保证单文件行数 < 150 行，且 100% 类型安全与平滑兼容。

**Architecture:** Component-as-a-Folder 模式，入口为 `index.tsx`，将内联浮层与复杂列表块拆至 `components/` 子目录，将逻辑与按键监听抽离至 `hooks/`，类型沉淀至 `types.ts`。

**Tech Stack:** React 18, TypeScript, Tailwind/Vanilla CSS

## Global Constraints
- 每个 `.tsx` / `.ts` 文件不超过 150-200 行。
- 一个 className 最多 2 个样式类名。
- 保持外部 `import` 路径平滑无需修改。

---

### Task 1: 重构 Sidebar.tsx (517 行 -> Sidebar/ 目录)

**Files:**
- Create: `src/renderer/src/components/Sidebar/types.ts`
- Move: `src/renderer/src/components/Sidebar.css` -> `src/renderer/src/components/Sidebar/Sidebar.css`
- Create: `src/renderer/src/components/Sidebar/components/SessionItem.tsx`
- Create: `src/renderer/src/components/Sidebar/components/ProjectItem.tsx`
- Create: `src/renderer/src/components/Sidebar/components/ProjectMenuPopover.tsx`
- Create: `src/renderer/src/components/Sidebar/index.tsx`
- Remove: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: 提炼 types.ts**
- [ ] **Step 2: 拆分 SessionItem.tsx, ProjectItem.tsx, ProjectMenuPopover.tsx**
- [ ] **Step 3: 编写组装 index.tsx 核心组件并移除旧 Sidebar.tsx**
- [ ] **Step 4: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 2: 重构 TopBar.tsx (379 行 -> TopBar/ 目录)

**Files:**
- Create: `src/renderer/src/components/TopBar/types.ts`
- Move: `src/renderer/src/components/TopBar.css` -> `src/renderer/src/components/TopBar/TopBar.css`
- Create: `src/renderer/src/components/TopBar/components/ProjectSelector.tsx`
- Create: `src/renderer/src/components/TopBar/index.tsx`
- Remove: `src/renderer/src/components/TopBar.tsx`

- [ ] **Step 1: 提炼 types.ts 与 ProjectSelector.tsx**
- [ ] **Step 2: 编写 TopBar/index.tsx 并移除旧 TopBar.tsx**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 3: 重构 FilePreviewPanel.tsx (346 行 -> FilePreviewPanel/ 目录)

**Files:**
- Create: `src/renderer/src/components/FilePreviewPanel/types.ts`
- Move: `src/renderer/src/components/FilePreviewPanel.css` -> `src/renderer/src/components/FilePreviewPanel/FilePreviewPanel.css`
- Create: `src/renderer/src/components/FilePreviewPanel/components/FileContentRenderer.tsx`
- Create: `src/renderer/src/components/FilePreviewPanel/index.tsx`
- Remove: `src/renderer/src/components/FilePreviewPanel.tsx`

- [ ] **Step 1: 拆分 FileContentRenderer.tsx**
- [ ] **Step 2: 编写 FilePreviewPanel/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 4: 重构 SettingsGeneralTab.tsx (345 行 -> SettingsGeneralTab/ 目录)

**Files:**
- Create: `src/renderer/src/components/SettingsGeneralTab/types.ts`
- Move: `src/renderer/src/components/SettingsGeneralTab.css` -> `src/renderer/src/components/SettingsGeneralTab/SettingsGeneralTab.css`
- Create: `src/renderer/src/components/SettingsGeneralTab/components/ProviderConfigItem.tsx`
- Create: `src/renderer/src/components/SettingsGeneralTab/index.tsx`
- Remove: `src/renderer/src/components/SettingsGeneralTab.tsx`

- [ ] **Step 1: 拆分 ProviderConfigItem.tsx**
- [ ] **Step 2: 编写 SettingsGeneralTab/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 5: 重构 SettingsRulesTab.tsx (326 行 -> SettingsRulesTab/ 目录)

**Files:**
- Create: `src/renderer/src/components/SettingsRulesTab/types.ts`
- Move: `src/renderer/src/components/SettingsRulesTab.css` -> `src/renderer/src/components/SettingsRulesTab/SettingsRulesTab.css`
- Create: `src/renderer/src/components/SettingsRulesTab/components/RuleEditorModal.tsx`
- Create: `src/renderer/src/components/SettingsRulesTab/index.tsx`
- Remove: `src/renderer/src/components/SettingsRulesTab.tsx`

- [ ] **Step 1: 拆分 RuleEditorModal.tsx**
- [ ] **Step 2: 编写 SettingsRulesTab/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 6: 重构 ChatArea.tsx (322 行 -> ChatArea/ 目录)

**Files:**
- Create: `src/renderer/src/components/chat/ChatArea/types.ts`
- Create: `src/renderer/src/components/chat/ChatArea/components/ChatMessageList.tsx`
- Create: `src/renderer/src/components/chat/ChatArea/index.tsx`
- Remove: `src/renderer/src/components/chat/ChatArea.tsx`

- [ ] **Step 1: 拆分 ChatMessageList.tsx**
- [ ] **Step 2: 编写 ChatArea/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 7: 重构 ExecutionLog.tsx (431 行 -> ExecutionLog/ 目录)

**Files:**
- Create: `src/renderer/src/components/chat/ExecutionLog/types.ts`
- Move: `src/renderer/src/components/chat/ExecutionLog.css` -> `src/renderer/src/components/chat/ExecutionLog/ExecutionLog.css`
- Create: `src/renderer/src/components/chat/ExecutionLog/components/ExecutionLogHeader.tsx`
- Create: `src/renderer/src/components/chat/ExecutionLog/components/LogItemList.tsx`
- Create: `src/renderer/src/components/chat/ExecutionLog/index.tsx`
- Remove: `src/renderer/src/components/chat/ExecutionLog.tsx`

- [ ] **Step 1: 拆分 LogItemList.tsx 与 ExecutionLogHeader.tsx**
- [ ] **Step 2: 编写 ExecutionLog/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 8: 重构 ExecutionLogDetail.tsx (317 行 -> ExecutionLogDetail/ 目录)

**Files:**
- Create: `src/renderer/src/components/chat/ExecutionLogDetail/types.ts`
- Create: `src/renderer/src/components/chat/ExecutionLogDetail/components/LogCodeViewer.tsx`
- Create: `src/renderer/src/components/chat/ExecutionLogDetail/index.tsx`
- Remove: `src/renderer/src/components/chat/ExecutionLogDetail.tsx`

- [ ] **Step 1: 拆分 LogCodeViewer.tsx**
- [ ] **Step 2: 编写 ExecutionLogDetail/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 9: 重构 TerminalPanel.tsx (392 行 -> TerminalPanel/ 目录)

**Files:**
- Create: `src/renderer/src/components/chat/TerminalPanel/types.ts`
- Move: `src/renderer/src/components/chat/TerminalPanel.css` -> `src/renderer/src/components/chat/TerminalPanel/TerminalPanel.css`
- Create: `src/renderer/src/components/chat/TerminalPanel/components/TerminalControls.tsx`
- Create: `src/renderer/src/components/chat/TerminalPanel/index.tsx`
- Remove: `src/renderer/src/components/chat/TerminalPanel.tsx`

- [ ] **Step 1: 拆分 TerminalControls.tsx**
- [ ] **Step 2: 编写 TerminalPanel/index.tsx 并移除旧文件**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**

---

### Task 10: 重构 App.tsx (485 行 -> App/ 目录)

**Files:**
- Create: `src/renderer/src/App/hooks/useAppShortcuts.ts`
- Create: `src/renderer/src/App/index.tsx`
- Remove: `src/renderer/src/App.tsx`

- [ ] **Step 1: 抽取 useAppShortcuts.ts**
- [ ] **Step 2: 重构 App/index.tsx**
- [ ] **Step 3: 运行 `npx tsc --noEmit` 校验并提交**
