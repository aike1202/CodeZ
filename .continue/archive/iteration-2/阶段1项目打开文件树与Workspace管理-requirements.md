# 📋 需求文档 - 阶段1项目打开、文件树与Workspace管理

> 迭代：iteration-2
> 创建时间：2026-06-25
> 最后更新：2026-06-25
> 存放位置：.continue/current/阶段1项目打开文件树与Workspace管理-requirements.md
> 参考文档：`docs/requirements/04-workspace-project.md`、`docs/requirements/15-development-phases.md`、`docs/requirements/13-architecture-storage.md`

---

## 需求概述

**一句话描述**：实现 Workspace 概念，使用户可以通过 Electron 对话框选择本地项目目录，应用能扫描并展示文件树、识别项目类型、记录最近打开项目，并支持点击文件预览内容。

**业务背景**：阶段 0 已经完成桌面应用骨架，现在需要让 MyAgent 真正具备"打开项目"的能力。Workspace 是 Agent Coding 的入口概念——Agent 的所有文件读写、搜索、命令执行都在 Workspace 范围内进行。阶段 1 的核心是把"打开项目的体验"做通。

**预期价值**：完成后用户可以打开本地项目、看到文件树、点击文件查看内容、看到最近打开项目。这将为后续的模型 Provider、Agent Runtime、工具调用提供 Workspace 基础。

---

## 功能需求

### 核心功能（必须实现）

- [ ] **F1-1**: 实现目录选择对话框与 Workspace 打开
  - 输入：用户点击"打开项目"按钮
  - 处理：通过 Electron IPC 调用 Main Process 的 `dialog.showOpenDialog`，选择本地目录
  - 输出：建立 Workspace 对象，切换到工作区视图

- [ ] **F1-2**: 实现 WorkspaceService 与 IPC 通信
  - 输入：Renderer 通过 IPC 请求 Workspace 操作
  - 处理：Main Process 中实现 WorkspaceService，负责路径校验、文件树扫描、项目识别、最近项目管理
  - 输出：通过 preload 暴露的类型安全 IPC API 返回结果

- [ ] **F1-3**: 实现文件树扫描与过滤
  - 输入：Workspace 根目录路径
  - 处理：递归扫描目录，过滤忽略项
  - 输出：结构化文件树数据，返回 Renderer 展示

- [ ] **F1-4**: 实现默认忽略规则
  - 输入：扫描过程中的目录/文件
  - 处理：默认排除 `node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`、`out`、`*.exe`、`*.dll`
  - 输出：仅展示有效项目文件

- [ ] **F1-5**: 实现项目类型识别
  - 输入：Workspace 根目录文件列表
  - 处理：检测 `package.json`、`tsconfig.json`、`vite.config.*`、`pyproject.toml`、`Cargo.toml`、`go.mod` 等
  - 输出：projectType、framework、packageManager

- [ ] **F1-6**: 实现文件内容预览
  - 输入：用户点击文件树中的文件
  - 处理：通过 IPC 读取文件内容，大文件和二进制文件做限制
  - 输出：在中间/右侧面板展示文件内容

- [ ] **F1-7**: 实现最近打开项目
  - 输入：用户每次打开项目的记录
  - 处理：保存到本地 JSON 或 Electron Store
  - 输出：欢迎页/启动页展示最近项目列表

- [ ] **F1-8**: 完善欢迎页到工作区的导航
  - 输入：应用启动
  - 处理：检测是否有最近项目，展示欢迎页或直接进入
  - 输出：用户在欢迎页选择"打开项目"或"最近项目"进入工作区

### 扩展功能（可选实现）

- [ ] **E1-1**: 读取 `.gitignore` 规则动态过滤
- [ ] **E1-2**: 文件树搜索/过滤输入框
- [ ] **E1-3**: 文件图标区分（按扩展名）
- [ ] **E1-4**: 工作区路径面包屑导航
- [ ] **E1-5**: 刷新文件树按钮

---

## 非功能需求

### 性能要求

- 中小型项目（< 5000 文件）文件树生成应在 3 秒内完成；
- 大文件预览 > 1 MB 应提示截断；
- 文件树渲染不阻塞 Electron 窗口交互。

### 兼容性要求

- 文件路径处理兼容 Windows 反斜杠和正斜杠；
- 路径校验必须防止访问 Workspace 外部文件；
- 二进制文件检测应通过扩展名和 magic bytes 判断。

### 安全要求

- 所有文件读取必须约束在 Workspace 根目录内；
- 不能通过 `../` 绕过 Workspace 边界；
- Renderer 不直接访问 Node 文件系统，所有文件操作通过 IPC；
- 敏感文件（`.env`、`*.pem`、`*.key`）默认不读取，或在预览时提示。

### 可维护性要求

- WorkspaceService 应作为 Main Process 的服务模块，不耦合 UI；
- IPC 通道应集中定义类型，便于后续扩展；
- 文件树数据类型应清晰定义，后续 Agent 工具调用可复用；
- 项目识别逻辑应可扩展（新增语言/框架只需加配置）。

---

## 约束条件

### 技术栈限制

- Main Process 文件操作使用 Node.js `fs` 模块；
- IPC 通信使用 Electron `ipcMain`/`ipcRenderer` + preload `contextBridge`；
- 文件树 UI 使用 React 组件；
- 最近项目存储使用本地 JSON 文件或 `electron-store`。

### 时间限制

- 当前为需求分析阶段，不进入实现；
- 用户说"继续"后进入计划/任务拆解；
- 阶段 1 完成后必须能打开真实项目并展示文件树。

### 其他约束

- 不接入模型 API；
- 不实现 Agent Runtime；
- 不实现代码修改或 diff；
- 不实现命令执行；
- 不实现 Skills/MCP；
- 文件树不要求支持拖拽、右键菜单或 Git 状态（后续阶段扩展）。

---

## 验收标准

### 功能验收

- [ ] **AC1-1**: 用户可以从欢迎页点击"打开项目"，选择本地目录
- [ ] **AC1-2**: 选择目录后进入工作区界面，左侧展示文件树
- [ ] **AC1-3**: `node_modules`、`.git`、`dist`、`build`、`out` 默认不展示
- [ ] **AC1-4**: 点击文本文件可以在右侧查看内容
- [ ] **AC1-5**: 点击二进制文件（如图片、exe）时提示不支持预览
- [ ] **AC1-6**: 应用可以识别至少 Node.js 项目类型
- [ ] **AC1-7**: 重启应用后欢迎页显示最近打开项目
- [ ] **AC1-8**: 所有文件路径访问限制在 Workspace 内
- [ ] **AC1-9**: 文件树支持展开/折叠目录

### 性能验收

- [ ] **P1-1**: 打开中型项目（如本项目 my-agent）文件树生成无明显延迟
- [ ] **P1-2**: 大文件预览（> 1 MB）时提示截断，不卡死界面

### 质量验收

- [ ] **Q1-1**: `npm run typecheck` 通过
- [ ] **Q1-2**: `npm run test` 包含 WorkspaceService 和文件树过滤的单元测试
- [ ] **Q1-3**: `npm run build` 构建成功
- [ ] **Q1-4**: IPC 接口有类型定义，参数经过校验

---

## 相关资源

### 参考文档

- `docs/requirements/04-workspace-project.md` - Workspace 与项目管理需求
- `docs/requirements/13-architecture-storage.md` - 系统架构（Main Process IPC 层）
- `docs/requirements/15-development-phases.md` - 分阶段开发计划（阶段 1）

### 依赖服务

阶段 1 不依赖外部模型 API 或云服务。所有能力在本地完成。

### 示例命令

```bash
npm run dev
npm run typecheck
npm run test
npm run build
```

---

## 当前项目技术现状

阶段 0 已完成的现有基础：

- Electron + React + TypeScript 工程骨架
- `electron-vite` 构建配置
- Main Process 入口（`src/main/index.ts`）
- Preload 基础占位（`src/preload/index.ts`）
- React 欢迎页（`src/renderer/src/App.tsx`）
- 共享常量/类型（`src/shared/`）
- Vitest 测试框架

阶段 1 需要在此基础上增加：

- `src/main/services/WorkspaceService.ts` — 新建
- `src/preload/index.ts` — 扩展 IPC API
- `src/renderer/src/` — 新增工作区页面、文件树组件、文件预览组件
- `src/shared/types/` — 扩展 Workspace 相关类型

---

## 需求澄清记录

| 问题 | 回答 | 确认时间 |
|---|---|---|
| 是否接入模型 API？ | 否，阶段 1 只做 Workspace | 2026-06-25 |
| 文件树要支持 Git 状态吗？ | 否，后续阶段扩展 | 2026-06-25 |
| 文件修改能力？ | 否，阶段 5 才做 | 2026-06-25 |
| 最近项目存储方式？ | 本地 JSON 文件或 electron-store | 2026-06-25 |
| 文件树是否支持右键菜单？ | 否，先做基础展开/折叠和点击 | 2026-06-25 |
