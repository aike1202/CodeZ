# 前端组件架构优化与大文件重构设计方案

## 1. 背景与目标

当前项目前端代码中，存在部分超大单文件组件（如 `PromptArea.tsx` 达 600 多行），由于缺乏层级拆分与文件行数限制规范，后续功能开发容易不断向单文件塞入代码。

本方案旨在：
1. **统一组件目录化规范（Component-as-a-Folder）**：将复杂组件重构为独立目录，拆分主组件、局部子组件、Hook 与常量类型。
2. **重构 PromptArea 示范组件**：将 `PromptArea.tsx` 彻底重构拆分，保持 100% 向后兼容。
3. **沉淀全局工程规范**：更新 `.agents/AGENTS.md`，约束 AI 与团队开发时的单文件行数上限与拆分规则。

---

## 2. 核心规约与工程标准

### 2.1 行数与拆分阈值
* **建议行数**：单个 `.tsx` 或 `.ts` 文件建议控制在 **150 行以内**。
* **硬性阈值**：单个文件超过 **200 行** 时，**严禁继续在该文件追加逻辑**，必须提炼独立子组件或 Hook。

### 2.2 组件目录结构标准
所有包含 2 个及以上子功能模块或超过 150 行的组件，一律升级为目录：

```text
src/renderer/src/components/[ComponentName]/
├── index.ts                    # 统一导出入口 (export { default } from './[ComponentName]')
├── [ComponentName].tsx         # 核心容器组件（布局拼装、顶层 Props、控制在 150 行内）
├── [ComponentName].css         # 组件专属样式
├── types.ts                    # 局部类型定义
├── constants.ts                # 局部常量/配置列表
├── components/                 # 局部专用子组件目录
│   ├── SubComponentA.tsx
│   └── SubComponentB.tsx
└── hooks/                      # 局部专用 Hook 目录
    └── useFeatureLogic.ts
```

### 2.3 样式规约
继承项目原有硬性规则：`禁止 TS 代码里出现多个 CSS 样式，一个 className 里最多 2 个样式！`

---

## 3. 复杂组件拆分范例与规范模板

### 3.1 通用组件目录结构规范

任何复杂组件重构时，均应遵循如下通用的目录与模块拆解结构：

```text
src/renderer/src/components/[ComponentName]/
├── index.ts                    # 统一导出入口：保持无缝兼容调用
├── [ComponentName].tsx         # 顶层组装组件（仅保留核心状态流向与 UI 布局拼装，建议 < 150 行）
├── [ComponentName].css         # 组件专属样式文件
├── types.ts                    # 局部类型与接口定义 (Props / State / Event 接口)
├── constants.ts                # 局部配置与常量数据 (枚举 / 下拉菜单配置 / 初始值)
├── components/                 # 局部专用子组件（按 UI 单元划分独立模块）
│   ├── SubFeatureA.tsx         # 独立 UI 功能模块 A
│   ├── SubFeatureB.tsx         # 独立 UI 功能模块 B
│   └── ...
└── hooks/                      # 状态与副作用逻辑隔离（复杂交互、底层监听、编辑器扩展）
    └── use[Feature]Logic.ts    # 自定义逻辑 Hook
```

### 3.2 实例映射：PromptArea 重构方案

以原 `src/renderer/src/components/PromptArea.tsx` (627 行) 为示范，具体映射拆解如下：

* **`index.ts`**：导出 `PromptArea`，保证现有 `import PromptArea from './components/PromptArea'` **完全无缝兼容**。
* **`PromptArea.tsx`**：核心组装容器 (控制在约 120 行)。
* **`PromptArea.css`**：移动主样式文件至目录内。
* **`types.ts` & `constants.ts`**：抽取 `PromptAreaProps`、`PERMISSION_MODES` 等类型与配置。
* **`components/`**：
  * `ModelSelector.tsx`：AI 模型切换下拉框与 Popover。
  * `PermissionSelector.tsx`：权限模式切换下拉框。
  * `PlusActionMenu.tsx`："+" 号附加操作下拉菜单。
  * `SlashCommandMenu.tsx`：斜杠指令 (`/`) 匹配弹窗菜单。
  * `FileMentionMenu.tsx`：文件/目录 (`@`) 补全下拉菜单。
* **`hooks/`**：
  * `usePromptEditor.ts`：CodeMirror 扩展挂载、按键监听与文本处理 Hook。

### 3.3 向后兼容性保证
通过在 `[ComponentName]/index.ts` 中写入 `export { default } from './[ComponentName]'`，全工程中所有引用该组件的代码 **无需修改任何 import 路径**。

---

## 4. 全局规范配置更新计划

在 `.agents/AGENTS.md` 中增加以下约束条款：

```markdown
# 架构与组件拆分规范

1. **单文件行数上限**：单个 TSX/TS 文件建议控制在 150 行以内，绝对禁止超过 200 行。
2. **组件目录化规约**：
   - 当组件逻辑或 UI 结构变复杂时，必须使用目录形式（如 `components/PromptArea/`）。
   - 主组件只做顶层组装与调度；局部子组件放 `components/`，状态/副作用逻辑放 `hooks/`。
3. **保持无缝导出**：组件目录必须包含 `index.ts` 并默认导出主组件，确保引用路径简洁且兼容。
4. **样式限制**：禁止 TS 代码里出现多个 CSS 样式，一个 className 里最多 2 个样式！
```

---

## 5. 验证与测试计划

1. **构建与类型检查**：运行 `npm run dev` 确保项目编译无类型错误、无路径引用丢失。
2. **功能交互验证**：
   - 验证 PromptArea 的消息发送、停止生成功能。
   - 验证模型切换下拉菜单与权限模式切换下拉框。
   - 验证斜杠指令 (`/`) 与文件引用 (`@`) 的弹窗选择功能。
