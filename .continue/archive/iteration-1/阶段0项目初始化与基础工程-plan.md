# 📝 开发计划 - 阶段0项目初始化与基础工程

> 关联需求：`.continue/current/阶段0项目初始化与基础工程-requirements.md`
> 迭代：iteration-1
> 全局进度参阅：`.continue/index.md`
> 创建时间：2026-06-25
> 最后更新：2026-06-25

---

## 整体技术与架构总览

本迭代目标是搭建 MyAgent 桌面端应用的基础工程骨架。项目采用 Electron + React + TypeScript，使用 `electron-vite` 统一管理 Electron 主进程、preload 脚本和 React 渲染进程的开发与构建流程。

阶段 0 不实现模型 API、Agent Runtime、Workspace 管理、工具调用或文件读写能力，只完成后续开发所需的基础工程能力：

- Electron 桌面窗口可启动；
- React 页面可在 Electron 窗口内渲染；
- TypeScript 类型检查可运行；
- Vitest 示例测试可运行；
- 基础构建可运行；
- 目录结构为后续阶段预留扩展空间。

推荐基础架构：

```text
my-agent/
├── src/
│   ├── main/          # Electron 主进程
│   ├── preload/       # Electron preload，后续暴露安全 IPC API
│   ├── renderer/      # React 渲染进程
│   ├── shared/        # 主进程/渲染进程共享类型与常量
│   └── tests/         # 基础测试
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

技术选型：

| 能力 | 选型 | 原因 |
|---|---|---|
| 桌面容器 | Electron | 符合桌面端 Agent Coding 工具目标 |
| 前端 | React | 适合构建聊天、文件树、diff、设置等复杂 UI |
| 语言 | TypeScript | 统一主进程、preload、渲染进程类型体系 |
| 构建 | electron-vite + Vite | 降低 Electron + React 开发配置复杂度 |
| 测试 | Vitest | 与 Vite/TypeScript 生态一致，轻量快速 |
| 样式 | 普通 CSS 起步 | 阶段 0 优先可运行，Tailwind 可在后续引入 |

---

## 阶段与任务大纲

**目标**：完成 Electron + TypeScript + React 基础工程初始化，使项目具备 `dev`、`typecheck`、`test`、`build` 四类基础能力。

> **状态说明**：
> - ✅ 已完成
> - 🔄 正在执行
> - ⏳ 待开始
> - ❌ 阻塞

---

✅ 第一阶段 · 基础包管理与工程配置

  ✅ 1、初始化 npm 项目与核心依赖

     - 目标：创建 `package.json`，配置项目基本信息、运行脚本和必要依赖。
     - 结合工程需要实现的详细设计：
       - 项目名称建议使用 `my-agent`；
       - 设置 `private: true`，避免误发布；
       - 配置基础脚本：
         - `dev`: 启动 Electron 开发模式；
         - `typecheck`: 执行 TypeScript 类型检查；
         - `test`: 执行 Vitest 测试；
         - `build`: 执行 TypeScript 检查和 Electron/Vite 构建；
       - 运行依赖至少包含：
         - `@electron-toolkit/preload`，用于 preload 安全桥接基础能力；
         - `@electron-toolkit/utils`，用于 Electron 常用工具函数；
         - `react`；
         - `react-dom`；
       - 开发依赖至少包含：
         - `electron`；
         - `electron-vite`；
         - `typescript`；
         - `vite`；
         - `@vitejs/plugin-react`；
         - `vitest`；
         - `@types/node`；
         - `@types/react`；
         - `@types/react-dom`。
     - 预计文件：
       - `package.json`

  ✅ 2、配置 TypeScript、electron-vite 和 Vitest

     - 目标：建立主进程、preload、渲染进程都可使用的 TypeScript 和构建配置。
     - 结合工程需要实现的详细设计：
       - 创建根 `tsconfig.json`，统一 TypeScript 严格检查策略；
       - 配置 `electron.vite.config.ts`：
         - main：Electron 主进程构建入口；
         - preload：preload 脚本构建入口；
         - renderer：React 渲染进程入口，root 指向 `src/renderer`；
       - 配置 `vitest.config.ts`：
         - 使用 Node 环境即可满足阶段 0 示例测试；
         - 后续组件测试再扩展 jsdom 和 React Testing Library。
     - 预计文件：
       - `tsconfig.json`
       - `electron.vite.config.ts`
       - `vitest.config.ts`

---

✅ 第二阶段 · Electron 主进程与 preload 基础能力

  ✅ 3、实现 Electron 主进程入口

     - 目标：创建 Electron BrowserWindow，并在开发模式加载 Vite dev server，在生产构建后加载本地 HTML。
     - 结合工程需要实现的详细设计：
       - 在 `src/main/index.ts` 中创建 `createWindow` 函数；
       - 使用 `BrowserWindow` 创建窗口；
       - 设置基础窗口尺寸，例如 1200x800；
       - 使用 `preload` 指向构建后的 preload 文件；
       - 设置安全相关默认项：
         - `contextIsolation: true`；
         - `nodeIntegration: false`；
         - `sandbox: false` 或按 electron-vite 默认能力处理，后续阶段再收紧；
       - 监听 `app.whenReady()` 创建窗口；
       - 处理 macOS `activate`，为后续跨平台预留；
       - 非 macOS 平台所有窗口关闭后退出应用；
       - 开发环境可打开 DevTools，可选。
     - 预计文件：
       - `src/main/index.ts`

  ✅ 4、实现 preload 安全桥接占位

     - 目标：建立 Renderer 与 Main Process 之间未来安全通信的入口，但阶段 0 不暴露高风险 API。
     - 结合工程需要实现的详细设计：
       - 在 `src/preload/index.ts` 中使用 `contextBridge` 暴露最小 API；
       - 暴露内容可以仅包含应用基础信息，例如：
         - `platform`；
         - `versions`；
       - 不暴露文件系统、命令执行、模型 API Key 等能力；
       - 为 TypeScript 声明 renderer 侧 `window.api` 类型。
     - 预计文件：
       - `src/preload/index.ts`
       - `src/renderer/src/vite-env.d.ts` 或 `src/shared/types/global.d.ts`

---

✅ 第三阶段 · React 渲染进程与欢迎页

  ✅ 5、创建 React 应用入口和欢迎页

     - 目标：让 Electron 窗口内显示 MyAgent 欢迎页，证明主进程与渲染进程链路打通。
     - 结合工程需要实现的详细设计：
       - 在 `src/renderer/index.html` 创建渲染进程 HTML 入口；
       - 在 `src/renderer/src/main.tsx` 挂载 React；
       - 在 `src/renderer/src/App.tsx` 实现基础欢迎页；
       - 欢迎页显示：
         - 应用名称：MyAgent；
         - 副标题：Agent Coding Desktop；
         - 当前阶段：阶段 0 · 项目初始化与基础工程；
         - 后续能力预告：Workspace、Model Provider、Agent Runtime、Tool System；
       - 样式使用 `src/renderer/src/styles.css`，保持简洁清晰。
     - 预计文件：
       - `src/renderer/index.html`
       - `src/renderer/src/main.tsx`
       - `src/renderer/src/App.tsx`
       - `src/renderer/src/styles.css`

  ✅ 6、建立共享常量和基础类型

     - 目标：为后续阶段预留主进程、渲染进程、Agent Runtime 可共享的类型与常量目录。
     - 结合工程需要实现的详细设计：
       - 创建 `src/shared/constants/app.ts`，定义应用名称、版本展示名等基础常量；
       - 创建 `src/shared/types/index.ts`，预留共享类型导出；
       - React 欢迎页优先引用共享常量，验证路径和类型配置正常。
     - 预计文件：
       - `src/shared/constants/app.ts`
       - `src/shared/types/index.ts`

---

✅ 第四阶段 · 测试、构建与文档补充

  ✅ 7、添加基础测试用例

     - 目标：确保 `npm run test` 至少可以运行一个示例测试并通过。
     - 结合工程需要实现的详细设计：
       - 创建 `src/tests/smoke.test.ts`；
       - 测试共享常量，例如 `APP_NAME` 是否等于 `MyAgent`；
       - 不在阶段 0 引入复杂组件测试，避免额外依赖；
       - 确保测试脚本使用 `vitest run`，便于 CI 或后续自动验证。
     - 预计文件：
       - `src/tests/smoke.test.ts`

  ✅ 8、补充基础 README 和运行说明

     - 目标：让项目具备基础使用说明，方便后续阶段和学校展示。
     - 结合工程需要实现的详细设计：
       - 创建或更新 `README.md`；
       - 说明项目名称、技术栈、当前阶段；
       - 列出常用命令：
         - `npm install`；
         - `npm run dev`；
         - `npm run typecheck`；
         - `npm run test`；
         - `npm run build`；
       - 标注当前阶段暂不包含模型 API、Agent Runtime、工具调用和 MCP/Skills。
     - 预计文件：
       - `README.md`

---

## 验收&测试点

  ✅ 1、依赖安装验证

     - 验证方式：
       ```bash
       npm install
       ```
     - 预期结果：依赖安装完成，生成 `node_modules` 和 lock 文件，无阻塞性错误。

  ✅ 2、开发模式启动验证

     - 验证方式：
       ```bash
       npm run dev
       ```
     - 预期结果：Electron 桌面窗口启动，窗口内显示 MyAgent 欢迎页。

  ✅ 3、类型检查验证

     - 验证方式：
       ```bash
       npm run typecheck
       ```
     - 预期结果：TypeScript 类型检查通过，无类型错误。

  ✅ 4、单元测试验证

     - 验证方式：
       ```bash
       npm run test
       ```
     - 预期结果：Vitest 能运行至少一个示例测试，并全部通过。

  ✅ 5、构建验证

     - 验证方式：
       ```bash
       npm run build
       ```
     - 预期结果：Electron 主进程、preload、React 渲染进程构建成功，生成基础构建产物。

  ✅ 6、代码结构验收

     - 验证方式：人工检查目录结构。
     - 预期结果：存在 `src/main`、`src/preload`、`src/renderer`、`src/shared`、`src/tests`，结构满足后续阶段扩展要求。

---

## 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| Electron 与 Vite 配置复杂 | 可能导致 dev/build 无法运行 | 使用 `electron-vite` 降低配置复杂度 |
| Windows Shell 环境差异 | 环境变量写法可能不兼容 | 避免自定义复杂环境变量，优先使用 electron-vite 脚本 |
| 阶段 0 引入过多高级能力 | 拖慢基础工程落地 | 暂不接入模型 API、Agent Runtime、MCP、Skills |
| 测试依赖过重 | 增加安装和维护成本 | 阶段 0 只做 Vitest smoke test |
| Electron 安全配置不足 | 后续可能有安全隐患 | 阶段 0 先启用 `contextIsolation`，后续 IPC 阶段继续加强 |

---

## 变更记录

| 时间 | 变更内容 | 调整原因 |
|---|---|---|
| 2026-06-25 | 创建阶段 0 计划/任务拆解 | 用户输入”继续”，从需求分析进入计划/任务拆解阶段 |
| 2026-06-25 | 完成全部 8 个任务实现 | 实现完成，typecheck/test/build 全部通过 |
