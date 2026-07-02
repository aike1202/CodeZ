# 大文件 UI 组件重构与目录化设计方案

## 1. 目标与背景

为了彻底消除大文件堆积问题，提升前端代码的可维护性、可读性与可测试性，现按最新的工程规范（单文件上限 150-200 行，复杂组件强制 `[ComponentName]/` 目录化），对项目中最庞大的 10 个 UI 组件进行模块化重构。

---

## 2. 重构目标组件清单

| 原组件文件 | 现有行数 | 重构目标目录 | 主要解耦拆分子组件 / Hooks |
| :--- | :--- | :--- | :--- |
| **Sidebar.tsx** | 517 行 | `components/Sidebar/` | `ProjectItem.tsx`, `SessionItem.tsx`, `ProjectMenuPopover.tsx`, `SidebarFooter.tsx` |
| **TopBar.tsx** | 379 行 | `components/TopBar/` | `ProjectSelector.tsx`, `TopBarActions.tsx` |
| **FilePreviewPanel.tsx** | 346 行 | `components/FilePreviewPanel/` | `FileContentRenderer.tsx`, `FilePreviewToolbar.tsx` |
| **SettingsGeneralTab.tsx** | 345 行 | `components/SettingsGeneralTab/` | `ProviderSettingsSection.tsx`, `GeneralSettingsSection.tsx` |
| **SettingsRulesTab.tsx** | 326 行 | `components/SettingsRulesTab/` | `RuleEditorModal.tsx`, `RuleListItem.tsx` |
| **ChatArea.tsx** | 322 行 | `components/chat/ChatArea/` | `ChatMessageList.tsx`, `ChatAreaHeader.tsx` |
| **ExecutionLog.tsx** | 431 行 | `components/chat/ExecutionLog/` | `ExecutionLogHeader.tsx`, `LogItemList.tsx`, `useExecutionLog.ts` |
| **ExecutionLogDetail.tsx** | 317 行 | `components/chat/ExecutionLogDetail/` | `LogCodeViewer.tsx`, `LogMetaDetails.tsx` |
| **TerminalPanel.tsx** | 392 行 | `components/chat/TerminalPanel/` | `TerminalControls.tsx`, `useTerminal.ts` |
| **App.tsx** | 485 行 | `src/App/` 或组件抽离 | `useAppShortcuts.ts`, `AppLayout.tsx` |

---

## 3. 核心解耦原则与接口兼容

1. **入口文件文件规范**：
   * 采用 `index.tsx` 作为组件入口文件（或 `index.ts` 导出），确保外部 `import Sidebar from './components/Sidebar'` 无须做任何路径修正。
2. **状态与 Props 传输**：
   * 抽离 `types.ts` 保存组件与子组件的 Props 接口定义。
   * 私有子组件收纳于 `components/` 子目录，私有逻辑 Hook 收纳于 `hooks/` 子目录。
3. **行数约束**：
   * 重构后每个子文件代码量严格控制在 **150 行** 以内。
4. **编译与类型验证**：
   * 每完成一个组件重构，必须通过 `npx tsc --noEmit` 静态类型校验。
