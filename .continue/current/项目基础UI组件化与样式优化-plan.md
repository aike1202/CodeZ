# 📝 开发计划 - 项目基础 UI 组件化与样式优化

> 关联需求：项目基础UI组件化与样式优化-requirements.md
> 迭代：iteration-11
> 全局进度参阅：.continue/index.md

## 整体技术与架构总览

本阶段的主轴是 **前端基础 UI 组件的组件化抽取与重构，以及公共样式系统的规范化收敛**。
主要技术路线为：
1. **新建组件目录**：在 `src/renderer/src/components/ui/` 创建 `Button.tsx`、`Input.tsx`、`Select.tsx`，以支持全局的 UI 复用。
2. **规范化 CSS Token**：在 `src/renderer/src/styles.css` 中，如果需要，可以提取出通用的 UI 过渡动画与基础样式，使得组件化时能够一并复用，减少页面行内样式。
3. **分批次安全重构**：优先重构简单且集中的组件（如 `ProjectMemoryModal`、`TopBar`、`PromptArea`），最后重构逻辑复杂的 `SettingsPanel` 和 `App.tsx`，每一步重构均通过 TypeScript 类型检查，确保系统没有 regressions。

---

## 阶段与任务大纲

### ✅ 第一阶段 · 基础 UI 组件实现 (Base UI Development)

- ✅ **[任务 T1] 开发 `Button.tsx` 组件**
  - **详细设计**：
    - 新建文件 [Button.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/ui/Button.tsx)。
    - 支持以下 Props：
      ```typescript
      export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
        variant?: 'primary' | 'secondary' | 'ghost' | 'icon' | 'dark' | 'danger'
        size?: 'sm' | 'md' | 'lg' | 'none'
        loading?: boolean
        icon?: React.ReactNode
      }
      ```
    - 样式映射：
      - `base`: `inline-flex items-center justify-center font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 cursor-pointer`
      - `variant`:
        - `primary`: `bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-sm`
        - `secondary`: `bg-bg-hover text-text-main border border-border hover:bg-bg-active rounded-lg`
        - `ghost`: `text-text-muted hover:text-text-main hover:bg-bg-hover rounded`
        - `icon`: `p-1 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-200/50`
        - `dark`: `bg-text-main text-bg-app border border-transparent hover:opacity-90 rounded-lg`
        - `danger`: `text-red-600 hover:bg-red-50 rounded-lg`
      - `size`:
        - `sm`: `px-3 py-1.5 text-xs`
        - `md`: `px-4 py-2 text-[13px]`
        - `lg`: `px-5 py-2.5 text-sm`
        - `none`: `p-0` (专门用于非标准大小按钮的自由包裹)

- ✅ **[任务 T2] 开发 `Input.tsx` 组件**
  - **详细设计**：
    - 新建文件 [Input.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/ui/Input.tsx)。
    - 支持以下 Props：
      ```typescript
      export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
        variant?: 'default' | 'borderless'
        icon?: React.ReactNode
        error?: string
      }
      ```
    - 样式映射：
      - `default`: `w-full text-sm bg-bg-input border border-border rounded-lg px-4 py-2.5 text-text-main outline-none focus:border-border-active transition-colors`
      - `borderless`: `w-full bg-transparent text-text-main outline-none` (用于模型列表等嵌入式极简输入框)

- ✅ **[任务 T3] 开发 `Select.tsx` 组件**
  - **详细设计**：
    - 新建文件 [Select.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/ui/Select.tsx)。
    - 支持原生 `SelectHTMLAttributes`，隐藏原生下拉三角并集成统一设计的下拉箭头。
    - 样式映射：
      - `default`: `w-full text-sm bg-bg-input border border-border rounded-lg px-4 pr-10 py-2.5 text-text-main outline-none focus:border-border-active transition-colors appearance-none`

---

### ✅ 第二阶段 · 公共样式优化与收敛 (Styles Optimization)

- ✅ **[任务 T4] 微调 `styles.css` 样式文件**
  - **详细设计**：
    - 在 [styles.css](file:///f:/MyProjectF/MyAgent/src/renderer/src/styles.css) 中完善圆角、过渡以及输入框的微动画。
    - 确认基础设计令牌 (`@theme`) 能够提供支持，并且确保组件能完美适配深色模式 (`.dark`)。

---

### ✅ 第三阶段 · 全局重构与替换 (Global Code Migration)

- ✅ **[任务 T5] 重构 `ProjectMemoryModal.tsx` & `TopBar.tsx` & `PromptArea.tsx`**
  - **详细设计**：
    - 替换 [ProjectMemoryModal.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/modals/ProjectMemoryModal.tsx) 中的原生取消/保存按钮和 API 输入框为新组件。
    - 替换 [TopBar.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/TopBar.tsx) 里的全局搜索 `<input>` 以及顶部操作 `<button>` 元素。
    - 替换 [PromptArea.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/PromptArea.tsx) 里的发送、设置图标等按钮为新组件。

- ✅ **[任务 T6] 重构 `SettingsPanel.tsx` & `App.tsx`**
  - **详细设计**：
    - 替换 [SettingsPanel.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/components/SettingsPanel.tsx) 里的各类文本输入框、协议选择 `<select>`，以及模型列表里的 `borderless` 输入框。
    - 替换 [App.tsx](file:///f:/MyProjectF/MyAgent/src/renderer/src/App.tsx) 右侧预览面板、Diff 查看器中的各种原生 `<button>` 及交互按钮。

---

## 验收&测试点

### 自动化测试与检查
- 运行 `npm run typecheck` 确认 0 TS Errors。
- 运行 `npm run build` 确保前端构建打包顺利，无任何 Webpack/Vite 或 css 语法报错。

### 手动功能点校验
- **保存 Provider 配置**：在 Settings 页面，验证新建和修改 Provider，保存按钮的 loading 状态与 disabled 判定是否一切照常。
- **项目记忆模态框**：打开 Project Memory，修改并保存架构、技术栈，验证是否正确存盘。
- **TopBar 搜索与控制**：全局搜索框应能正常聚焦，终端切换和模态框打开应均工作完好。
