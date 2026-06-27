# 📋 需求文档 - 项目基础 UI 组件化与样式优化

> 迭代：iteration-11
> 创建时间：2026-06-27
> 最后更新：2026-06-27
> 存放位置：.continue/current/项目基础UI组件化与样式优化-requirements.md

## 需求概述

**一句话描述**：
通过把项目内频繁使用的基础 `button`、`input`、`select` 等 HTML 元素抽取并重构为统一的高级 UI 组件，减少页面代码冗余以节省 AI 开发时的 Token 消耗，并结合样式优化提升系统的可维护性与设计美感。

**业务背景**：
当前前端代码（如 `App.tsx`、`SettingsPanel.tsx`、`TopBar.tsx`、`PromptArea.tsx` 等）中充斥着大量的原生 `<button>` 和 `<input>` 元素，它们携带着极长且高频重复的 Tailwind 样式类（如 `px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors border`）。
这带来两个主要痛点：
1. **Token 消耗巨大**：每次修改页面时，大模型都需要重复阅读和输出这些极长的冗余 class 属性，极大消耗了上下文的 Token。
2. **样式难维护**：当我们需要微调系统的整体设计风格（例如按钮圆角、主色调、输入框激活框线）时，必须全量搜索替换多处代码，极易产生遗漏或不一致。

**预期价值**：
1. **降低 Token 占用**：通过引入 `<Button variant="primary">保存</Button>` 等简洁形式，预计可将核心 UI 文件的代码字符体积减少 10% - 20%，直接节省开发过程中的 Token。
2. **便于样式维护**：所有核心 UI 的变体样式（Primary、Secondary、Ghost、Icon、Active 状态）在同一个基础组件内集中控制。
3. **提升设计规范性**：统一项目的主色调、圆角（如统一使用 `--radius-md` / `--radius-lg`）、阴影以及过渡微动画，使页面视觉效果更加 premium 和精致。

---

## 功能需求

### 核心功能（必须实现）

- [ ] **F1**: **UI 基础组件库开发 (Base UI Components)**
  - 处理：在 `src/renderer/src/components/ui`（或 `common`）目录下，创建统一的基础组件：
    - `Button.tsx`：支持不同变体（`primary`、`secondary`、`ghost`、`icon`）、加载状态（`loading`）、尺寸（`sm`、`md`、`lg`）和前置/后置图标。
    - `Input.tsx`：支持前置/后置图标、禁用状态、错误状态。
    - `Select.tsx`：支持统一的下拉选择，封装下拉箭头的样式。
  - 输出：通用、强类型、开箱即用的 UI 组件集。

- [ ] **F2**: **样式设计系统收敛 (CSS Theme System)**
  - 处理：基于项目现有的 `styles.css`，完善 CSS 变量和 Tailwind 配置。在 `styles.css` 中提取出通用的过渡过渡属性和基础按钮、输入框规范，在公共组件中复用。
  - 输出：在公共组件中调用系统预设类，或者在组件内部统一处理，避免零散 of 硬编码颜色和大小。

- [ ] **F3**: **项目全量重构替换 (Global Code Refactoring)**
  - 处理：将核心组件和页面中的原生 `button`、`input`、`select` 进行安全重构替换。
    - 主要文件：`src/renderer/src/App.tsx`、`src/renderer/src/components/SettingsPanel.tsx`、`src/renderer/src/components/TopBar.tsx`、`src/renderer/src/components/PromptArea.tsx`、`src/renderer/src/components/modals/ProjectMemoryModal.tsx` 等。
  - 输出：重构后的代码干净整洁，样式完全保留且更易于维护。

---

## 非功能需求

### 性能与打包要求
- UI 组件必须是极轻量级的，避免引入臃肿的第三方库（如全量 shadcn 或 antd），坚持轻量化 Vanilla/Tailwind CSS 编写。
- 引入的组件不得改变原有的布局流和交互逻辑，重构前后 UI 展现无偏差或仅有质感上的微调提升。

### 兼容性
- 完美支持已已有深色模式 (`.dark`)。

---

## 验收标准

### 功能验收
- [ ] **AC1**: 项目内全局搜索 `<button`，除了基础组件定义和少数极特定场景外，大部分已被 `<Button` 替代；样式、交互效果（hover、active、disabled、loading）完全正常。
- [ ] **AC2**: 在设置面板、TopBar 全局搜索、项目记忆模态框中输入内容、点击保存，功能和原有逻辑丝毫不差。
- [ ] **AC3**: 运行 `npm run typecheck`，没有任何 TypeScript 编译报错。
- [ ] **AC4**: 运行 `npm run build`，打包能够顺利成功。
