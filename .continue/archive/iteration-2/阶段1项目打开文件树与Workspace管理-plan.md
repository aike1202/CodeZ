# 📝 开发计划 - 阶段1项目打开、文件树与Workspace管理

> 关联需求：`.continue/current/阶段1项目打开文件树与Workspace管理-requirements.md`
> 迭代：iteration-2
> 全局进度参阅：`.continue/index.md`
> 创建时间：2026-06-25
> 最后更新：2026-06-25

---

## 整体技术与架构总览

阶段 1 在阶段 0 的 Electron + React + TypeScript 骨架之上，建立 Workspace 管理能力。

核心架构变化：

```text
Main Process                          Renderer Process
┌──────────────────────┐              ┌─────────────────────────┐
│  WorkspaceService     │◄── IPC ───►│  useWorkspace() hook     │
│  ├─ scanFileTree()    │   preload   │  WelcomePage             │
│  ├─ readFileContent() │   bridge    │  WorkspacePage           │
│  ├─ detectProject()   │            │   ├─ FileTreePanel       │
│  ├─ getRecentProjects │            │   ├─ FilePreviewPanel    │
│  └─ validatePath()    │            │   └─ WorkspaceHeader     │
│                       │            │                          │
│  RecentProjectsStore  │            │  Zustand store           │
│  (JSON file)          │            │  (workspace state)       │
└──────────────────────┘              └─────────────────────────┘
```

关键设计决策：

| 决策 | 选择 | 原因 |
|---|---|---|
| IPC 模式 | `ipcMain.handle` + `ipcRenderer.invoke` | 异步请求-响应，类型安全 |
| 文件树结构 | 递归嵌套 `FileTreeNode`（前端渲染） | 适合 React 递归组件展示 |
| 忽略规则 | 硬编码默认列表 + `.gitignore` 可选 | 先跑通核心链路，再扩展 |
| 最近项目存储 | `app.getPath('userData')/recent-projects.json` | 不污染项目目录 |
| 状态管理 | Zustand | 轻量，适合管理 workspace/fileTree/selectedFile 状态 |
| 文件预览 | 纯文本读取，前端 `<pre>` 展示 | 阶段 1 不引入 Monaco |

---

## 阶段与任务大纲

**目标**：实现用户选择本地目录 → 扫描文件树 → 识别项目类型 → 展示文件树 → 点击预览文件 → 记录最近项目的完整链路。

> **状态说明**：✅ 已完成 | 🔄 正在执行 | ⏳ 待开始 | ❌ 阻塞

---

✅ 第一阶段 · 类型定义与 IPC 通道

  ✅ 1、扩展共享类型定义

     - 目标：在 `src/shared/types/` 中定义 Workspace、FileTreeNode、ProjectInfo 等核心类型，供 Main 和 Renderer 共用。
     - 结合工程需要实现的详细设计：
       - 新增 `src/shared/types/workspace.ts`：
         ```ts
         export interface WorkspaceInfo {
           id: string
           rootPath: string
           name: string
           projectType: string
           openedAt: string
         }

         export interface FileTreeNode {
           name: string
           path: string          // 相对 Workspace 根目录的路径
           type: 'file' | 'directory'
           children?: FileTreeNode[]
           size?: number
           extension?: string
         }

         export interface FileContent {
           path: string
           content: string
           truncated: boolean
           totalLines: number
         }

         export interface ProjectInfo {
           type: string           // 'nodejs' | 'python' | 'rust' | 'go' | 'java' | 'unknown'
           framework?: string     // 'react' | 'next' | 'vite' | undefined
           packageManager?: string // 'npm' | 'pnpm' | 'yarn' | undefined
         }
         ```
       - 更新 `src/shared/types/index.ts` 导出新类型；
       - 新增 `src/shared/constants/ignored.ts` 定义默认忽略列表。
     - 预计文件：
       - `src/shared/types/workspace.ts` — 新建
       - `src/shared/constants/ignored.ts` — 新建
       - `src/shared/types/index.ts` — 修改

  ✅ 2、定义 IPC 通道常量与参数类型

     - 目标：集中管理 IPC channel 名称和请求/响应类型，避免魔法字符串。
     - 结合工程需要实现的详细设计：
       - 新增 `src/shared/ipc/channels.ts`：
         ```ts
         export const IPC_CHANNELS = {
           OPEN_DIRECTORY: 'workspace:open-directory',
           SCAN_FILE_TREE: 'workspace:scan-file-tree',
           READ_FILE: 'workspace:read-file',
           DETECT_PROJECT: 'workspace:detect-project',
           GET_RECENT_PROJECTS: 'workspace:get-recent-projects',
           ADD_RECENT_PROJECT: 'workspace:add-recent-project',
         } as const
         ```
       - 新增 `src/shared/ipc/params.ts`，为每个 channel 定义入参/出参类型映射。
     - 预计文件：
       - `src/shared/ipc/channels.ts` — 新建
       - `src/shared/ipc/params.ts` — 新建

---

✅ 第二阶段 · Main Process 核心服务

  ✅ 3、实现 WorkspaceService 核心逻辑

     - 目标：在 Main Process 中实现文件树扫描、路径校验、项目检测、文件读取。
     - 结合工程需要实现的详细设计：
       - 新建 `src/main/services/WorkspaceService.ts`；
       - 主要方法：
         - `validatePath(rootPath: string): string` — 路径校验，normalize 并确保是绝对路径；
         - `scanFileTree(rootPath: string): Promise<FileTreeNode[]>` — 递归扫描目录，返回树形结构；
           - 使用 `fs.promises.readdir` + `fs.promises.stat`；
           - 跳过忽略列表中的目录/文件；
           - 目录在前、文件在后，按名称排序；
           - 第一阶段先只扫描一层？不，需求要求完整树，但可以做简单的全量扫描（本项目文件量级小）。
         - `readFileContent(filePath: string): Promise<FileContent>` — 读取文本文件；
           - 检查路径在 Workspace 内；
           - 通过扩展名和 magic bytes 判断二进制，拒绝读取并提示；
           - 超过 1 MB 截断到前 1000 行；
           - 超过 5 MB 拒绝完整读取；
         - `detectProjectType(rootPath: string): Promise<ProjectInfo>` — 检测项目类型；
           - 检查 `package.json` → nodejs；
           - 检查 `tsconfig.json` → typescript；
           - 检查 `vite.config.*` → vite；
           - 检查 `next.config.*` → next；
           - 检查 `pyproject.toml` / `requirements.txt` → python；
           - 检查 `Cargo.toml` → rust；
           - 检查 `go.mod` → go；
           - 检查 `pom.xml` → java-maven；
           - 检查 `build.gradle` → java-gradle；
           - 未匹配 → unknown。
       - 所有公共方法必须校验文件路径是否在 rootPath 内。
     - 预计文件：
       - `src/main/services/WorkspaceService.ts` — 新建

  ✅ 4、实现 RecentProjectsStore

     - 目标：持久化最近打开的项目列表。
     - 结合工程需要实现的详细设计：
       - 新建 `src/main/services/RecentProjectsStore.ts`；
       - 存储路径使用 `app.getPath('userData')` + `/recent-projects.json`；
       - 数据格式：`{ projects: WorkspaceInfo[] }`，最多保留 10 条；
       - 方法：
         - `getAll(): WorkspaceInfo[]`
         - `add(project: WorkspaceInfo): void` — 去重、前置、裁剪；
         - `remove(id: string): void`
       - 读写使用 `fs.promises`，启动时加载缓存，避免每次读磁盘。
     - 预计文件：
       - `src/main/services/RecentProjectsStore.ts` — 新建

  ✅ 5、注册 IPC 处理器

     - 目标：在 Main Process 中注册 `ipcMain.handle`，将 WorkspaceService 和 RecentProjectsStore 的方法暴露给 Renderer。
     - 结合工程需要实现的详细设计：
       - 新建 `src/main/ipc/workspace.handlers.ts`；
       - 使用 `IPC_CHANNELS` 常量注册 channel；
       - 每个 handler 内进行参数校验；
       - 错误时返回标准化错误对象而非 throw；
       - 在 `src/main/index.ts` 中 `app.whenReady()` 之后调用注册函数；
       - 使用 `electron.app` 的 `getPath` 获取 userData 目录。
     - 预计文件：
       - `src/main/ipc/workspace.handlers.ts` — 新建
       - `src/main/index.ts` — 修改（引入 handler 注册）

---

✅ 第三阶段 · Preload 安全桥接扩展

  ✅ 6、扩展 preload 暴露 Workspace IPC API

     - 目标：通过 `contextBridge` 向 Renderer 暴露类型安全的 Workspace 操作 API。
     - 结合工程需要实现的详细设计：
       - 修改 `src/preload/index.ts`，在现有 `api` 对象上扩展：
         ```ts
         const api = {
           workspace: {
             openDirectory: (): Promise<string | null> =>
               ipcRenderer.invoke(IPC_CHANNELS.OPEN_DIRECTORY),
             scanFileTree: (rootPath: string): Promise<FileTreeNode[]> =>
               ipcRenderer.invoke(IPC_CHANNELS.SCAN_FILE_TREE, rootPath),
             readFile: (filePath: string): Promise<FileContent> =>
               ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, filePath),
             detectProject: (rootPath: string): Promise<ProjectInfo> =>
               ipcRenderer.invoke(IPC_CHANNELS.DETECT_PROJECT, rootPath),
             getRecentProjects: (): Promise<WorkspaceInfo[]> =>
               ipcRenderer.invoke(IPC_CHANNELS.GET_RECENT_PROJECTS),
             addRecentProject: (p: WorkspaceInfo): Promise<void> =>
               ipcRenderer.invoke(IPC_CHANNELS.ADD_RECENT_PROJECT, p),
           }
         }
         ```
       - 更新 `src/renderer/src/env.d.ts` 中 Window 类型声明，加入 `api.workspace` 类型。
     - 预计文件：
       - `src/preload/index.ts` — 修改
       - `src/renderer/src/env.d.ts` — 修改

---

✅ 第四阶段 · React UI 实现

  ✅ 7、重构欢迎页：打开项目 + 最近项目

     - 目标：欢迎页增加"打开项目"按钮和"最近项目"列表。
     - 结合工程需要实现的详细设计：
       - 修改 `src/renderer/src/App.tsx`，将欢迎页逻辑提取为 `WelcomePage` 组件；
       - `WelcomePage`：
         - 加载时调用 `window.api.workspace.getRecentProjects()`；
         - 展示"打开项目"按钮，点击调用 `window.api.workspace.openDirectory()`；
         - 展示最近项目列表，点击直接打开；
         - 没有最近项目时显示引导文案；
         - 打开项目后切换到 `WorkspacePage`。
       - App 顶层用状态管理当前视图：`'welcome' | 'workspace'`；
       - 使用 Zustand 创建 `workspaceStore` 管理 workspace 全局状态。
     - 预计文件：
       - `src/renderer/src/App.tsx` — 修改
       - `src/renderer/src/pages/WelcomePage.tsx` — 新建
       - `src/renderer/src/stores/workspaceStore.ts` — 新建

  ✅ 8、创建工作区页面布局

     - 目标：实现左侧文件树 + 右侧文件预览的主工作区布局。
     - 结合工程需要实现的详细设计：
       - 新建 `src/renderer/src/pages/WorkspacePage.tsx`：
         - 布局：左侧 280px 文件树面板 + 右侧自适应文件预览面板；
         - 顶部显示 Workspace 名称和项目类型标签；
         - 打开后自动调用 `scanFileTree` 和 `detectProject`；
         - 状态管理全部通过 `workspaceStore`。
       - 新建 `src/renderer/src/components/FileTreePanel.tsx`：文件树容器组件；
       - 新建 `src/renderer/src/components/FilePreviewPanel.tsx`：文件预览容器组件。
     - 预计文件：
       - `src/renderer/src/pages/WorkspacePage.tsx` — 新建
       - `src/renderer/src/components/FileTreePanel.tsx` — 新建
       - `src/renderer/src/components/FilePreviewPanel.tsx` — 新建

  ✅ 9、实现文件树 React 组件

     - 目标：渲染递归文件树，支持展开/折叠、点击选中、区分文件和目录。
     - 结合工程需要实现的详细设计：
       - 新建 `src/renderer/src/components/FileTree.tsx`（递归组件）：
         - 接收 `FileTreeNode[]` 和当前展开状态；
         - 目录：默认折叠，点击展开/折叠，前面显示 `▸`/`▾` 图标；
         - 文件：点击选中并触发 `onSelectFile(path)`；
         - 使用 CSS 缩进表示层级；
         - 当前选中文件高亮；
         - 性能优化：只在用户展开时才渲染子节点（惰性渲染），阶段 1 可先不做，直接全量渲染。
       - 样式写到 `src/renderer/src/styles.css` 或独立 `FileTree.css`。
     - 预计文件：
       - `src/renderer/src/components/FileTree.tsx` — 新建

  ✅ 10、实现文件预览组件

     - 目标：点击文件后右侧展示文件内容。
     - 结合工程需要实现的详细设计：
       - 修改 `src/renderer/src/components/FilePreviewPanel.tsx`：
         - 未选中文件时显示"请在左侧选择文件"；
         - 选中文件后调用 `window.api.workspace.readFile(filePath)`；
         - 展示文件路径、总行数、截断提示；
         - 内容区域用 `<pre>` 标签展示，保留缩进和换行；
         - 二进制文件展示拒绝原因；
         - 大文件截断后提示"已截断，仅显示前 N 行"；
         - 加载中显示 loading 状态。
     - 预计文件：
       - `src/renderer/src/components/FilePreviewPanel.tsx` — 修改

---

✅ 第五阶段 · 样式、测试与集成

  ✅ 11、完善样式与交互细节

     - 目标：统一暗色主题风格，确保工作区 UI 美观可用。
     - 结合工程需要实现的详细设计：
       - 更新 `src/renderer/src/styles.css` 增加：
         - 工作区布局（flex 水平分栏）；
         - 文件树样式（缩进、hover、选中高亮、图标颜色）；
         - 文件预览面板样式（monospace 字体、行号区域、截断提示）；
         - 最近项目列表样式；
         - 按钮样式（主按钮、次按钮）。
       - 整体保持阶段 0 的暗色主题（`#0d1117` 背景）。
       - 响应式：窗口缩小时文件树最小 200px。
     - 预计文件：
       - `src/renderer/src/styles.css` — 修改

  ✅ 12、添加单元测试

     - 目标：为 WorkspaceService 核心逻辑和文件树过滤编写测试。
     - 结合工程需要实现的详细设计：
       - 新建 `src/tests/workspace-service.test.ts`：
         - 测试路径校验：正常路径、带 `..` 的路径、Workspace 外路径；
         - 测试文件树扫描：准备临时测试目录，验证扫描结果；
         - 测试忽略规则：node_modules 不出现、out 不出现；
         - 测试项目检测：创建临时 `package.json`，验证检测为 nodejs；
         - 测试二进制检测：准备测试用例，验证 magic bytes 判断。
       - 测试使用 `fs` 临时目录（`os.tmpdir`）或项目内 `__test_fixtures__`。
     - 预计文件：
       - `src/tests/workspace-service.test.ts` — 新建

---

## 验收&测试点

  ✅ 1、类型检查验证
     - 验证方式：
       ```bash
       npm run typecheck
       ```
     - 预期结果：TypeScript 类型检查通过。

  ✅ 2、单元测试验证
     - 验证方式：
       ```bash
       npm run test
       ```
     - 预期结果：原有 smoke test 4 个 + 新增 workspace 6 个 = 全部 10 个通过。

  ✅ 3、构建验证
     - 验证方式：
       ```bash
       npm run build
       ```
     - 预期结果：主进程、preload、渲染进程均构建成功。

  ✅ 4、打开项目手动验收
     - 验证方式：启动 `npm run dev`，点击"打开项目"，选择 `F:\MyProjectF\MyAgent`。
     - 预期结果：
       - 左侧展示文件树；
       - `node_modules`、`.git`、`out`、`dist` 不出现；
       - 项目类型检测为 Node.js/TypeScript；
       - 点击 `package.json` 可以查看内容；
       - 点击 `src/main/index.ts` 可以查看 TypeScript 代码。

  ✅ 5、最近项目验收
     - 验证方式：关闭应用，重新启动。
     - 预期结果：欢迎页展示"my-agent"在最近项目列表中；点击可以直接打开。

  ✅ 6、安全边界验收
     - 验证方式：尝试通过 IPC 读取 Workspace 外文件（如 `C:\Windows\System32\drivers\etc\hosts`）。
     - 预期结果：WorkspaceService 拒绝请求并返回错误。

---

## 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 大项目扫描性能 | 文件树生成慢 | 设置文件数量上限（5000），超过提示；后续可改增量加载 |
| Windows 路径编码 | `..` 校验被 Unicode 绕过 | 使用 `path.resolve` + `path.normalize` + startsWith 三重校验 |
| 二进制检测不足 | 部分文件被误读导致崩溃 | 先用扩展名白名单 + 前 256 字节 magic bytes 检测 |
| preload API 类型未正确暴露 | Renderer 调用报错 | 在 `env.d.ts` 中精准声明类型，IPC channel 用常量避免拼写错误 |
| 最近项目文件损坏 | 启动失败 | JSON 读取用 try-catch，损坏时重置为空列表 |

---

## 变更记录

| 时间 | 变更内容 | 调整原因 |
|---|---|---|
| 2026-06-25 | 创建阶段 1 计划/任务拆解 | 用户输入"继续"，从需求分析进入计划/任务拆解阶段 |
| 2026-06-25 | 完成全部 12 个任务实现 | 实现完成，typecheck/test/build 全部通过，新增 zustand 依赖 |
