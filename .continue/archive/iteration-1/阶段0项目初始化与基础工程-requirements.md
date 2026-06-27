# 📋 需求文档 - 阶段0项目初始化与基础工程

> 迭代：iteration-1
> 创建时间：2026-06-25
> 最后更新：2026-06-25
> 存放位置：.continue/current/阶段0项目初始化与基础工程-requirements.md
> 参考文档：`docs/requirements/15-development-phases.md`、`docs/requirements/02-technical-stack.md`

---

## 需求概述

**一句话描述**：搭建 Electron + TypeScript + React 桌面应用基础工程，使 MyAgent 可以启动桌面窗口，并具备基础开发、类型检查、单元测试和构建能力。

**业务背景**：MyAgent 的长期目标是成为类似 Codex 桌面端、Claude Code 桌面端的 Agent Coding 工具。要实现后续的项目打开、模型接入、Agent Runtime、工具调用、代码修改和命令验证，必须先建立稳定的 Electron 桌面工程基础。

**预期价值**：完成阶段 0 后，项目将具备一个可启动、可开发、可测试、可构建的最小桌面应用骨架，为后续 Workspace 管理、模型 Provider、Agent Runtime 和 Tool System 提供工程基础。

---

## 功能需求

### 核心功能（必须实现）

- [ ] **F0-1**: 初始化项目包管理和基础配置
  - 输入：空项目目录 `F:\MyProjectF\MyAgent`
  - 处理：创建 `package.json`、TypeScript 配置、Vite 配置、Electron 相关配置和基础目录结构
  - 输出：一个可以安装依赖、运行脚本的 Node.js/TypeScript 项目

- [ ] **F0-2**: 配置 Electron 主进程
  - 输入：Electron 主进程入口代码
  - 处理：创建桌面窗口，加载开发服务器或生产构建后的前端页面
  - 输出：运行开发命令后可以打开 Electron 桌面窗口

- [ ] **F0-3**: 配置 React 渲染进程
  - 输入：React 应用入口、基础页面组件、样式文件
  - 处理：通过 Vite 启动 React 页面，并在 Electron 窗口中展示
  - 输出：窗口内展示 MyAgent 欢迎页

- [ ] **F0-4**: 配置 TypeScript 类型检查
  - 输入：主进程、预加载脚本、渲染进程 TypeScript 源码
  - 处理：配置 TS 编译选项和类型检查脚本
  - 输出：可运行 `npm run typecheck` 检查类型错误

- [ ] **F0-5**: 配置基础测试能力
  - 输入：Vitest 配置和至少一个示例测试
  - 处理：运行测试脚本
  - 输出：`npm run test` 可以执行并通过示例测试

- [ ] **F0-6**: 配置基础构建能力
  - 输入：Electron、Vite、TypeScript 构建配置
  - 处理：执行构建脚本，生成主进程和渲染进程构建产物
  - 输出：`npm run build` 可以成功完成基础构建

- [ ] **F0-7**: 建立推荐目录结构
  - 输入：阶段 0 基础工程需求
  - 处理：创建 `src/main`、`src/preload`、`src/renderer`、`src/shared`、`src/tests` 等目录
  - 输出：后续阶段可以在清晰目录结构中继续开发

### 扩展功能（可选实现）

- [ ] **E0-1**: 配置 ESLint 和 Prettier
- [ ] **E0-2**: 配置 Tailwind CSS 基础样式能力
- [ ] **E0-3**: 配置 electron-builder 或 Electron Forge 的初始打包配置
- [ ] **E0-4**: 添加基础应用图标占位资源
- [ ] **E0-5**: 添加 React Testing Library 组件测试示例

---

## 非功能需求

### 性能要求

- 应用开发模式启动后，应能在合理时间内打开窗口；目标冷启动小于 5 秒，学校项目阶段可接受稍长但不能明显卡死。
- React 页面渲染不应阻塞 Electron 主进程。
- 阶段 0 不引入大型运行时能力，避免基础工程过重。

### 兼容性要求

- 优先支持 Windows 10/11；
- Node.js 建议使用 18+ 或 20+；
- 开发环境以 Git Bash / PowerShell / CMD 均可运行为目标；
- 第一阶段不强制支持 macOS/Linux，但配置不应刻意绑定 Windows 专属能力。

### 安全要求

- Electron Renderer 不直接启用不必要的 Node.js 能力；
- 初始窗口配置应为后续安全 IPC 架构预留空间；
- 不在阶段 0 引入真实 API Key、远程模型调用或命令执行能力；
- 不实现任何自动删除、自动写入用户项目、远程发布等高风险功能。

### 可维护性要求

- 主进程、预加载脚本、渲染进程、共享类型目录分离；
- 脚本命名清晰：`dev`、`typecheck`、`test`、`build`；
- 代码使用 TypeScript；
- 文件结构要为后续 Agent Runtime、Tool System、Model Provider 预留扩展位置。

---

## 约束条件

### 技术栈限制

- 桌面容器：Electron；
- 前端：React；
- 语言：TypeScript；
- 构建工具：Vite；
- 测试：Vitest；
- 包管理器：优先使用 npm，后续可根据需要切换 pnpm。

### 时间限制

- 当前只生成需求分析文档，不进入实现；
- 用户说“继续”后进入计划/任务拆解阶段；
- 阶段 0 实现完成后必须可以运行测试和构建命令。

### 其他约束

- 当前仓库不是 Git 仓库，阶段 0 不要求 Git 操作；
- 不要求接入模型 API；
- 不要求实现 Agent Runtime；
- 不要求实现文件读写工具；
- 不要求实现打包安装包，只要求基础构建，打包能力可选。

---

## 验收标准

### 功能验收

- [ ] **AC0-1**: 项目根目录存在 `package.json`，并定义 `dev`、`typecheck`、`test`、`build` 脚本
- [ ] **AC0-2**: `npm install` 可以安装项目依赖
- [ ] **AC0-3**: `npm run dev` 可以启动 Electron 桌面窗口
- [ ] **AC0-4**: 桌面窗口显示 MyAgent 应用名称和欢迎页
- [ ] **AC0-5**: 项目包含 Electron 主进程入口
- [ ] **AC0-6**: 项目包含 React 渲染进程入口
- [ ] **AC0-7**: 项目包含 TypeScript 配置文件
- [ ] **AC0-8**: 项目包含基础目录结构，为后续阶段预留扩展空间

### 性能验收

- [ ] **P0-1**: 开发模式启动后窗口不会长期白屏
- [ ] **P0-2**: 基础欢迎页交互无明显卡顿

### 质量验收

- [ ] **Q0-1**: `npm run typecheck` 通过
- [ ] **Q0-2**: `npm run test` 至少运行一个示例测试并通过
- [ ] **Q0-3**: `npm run build` 可以生成基础构建产物
- [ ] **Q0-4**: 主进程和渲染进程代码均使用 TypeScript
- [ ] **Q0-5**: 初始代码结构清晰，便于阶段 1 继续扩展 Workspace 管理能力

---

## 相关资源

### 参考文档

- `docs/desktop-agent-coding-requirements.md` - 需求文档总入口
- `docs/requirements/02-technical-stack.md` - 技术选型
- `docs/requirements/13-architecture-storage.md` - 系统架构与数据存储
- `docs/requirements/15-development-phases.md` - 分阶段开发计划与验收

### 依赖服务

阶段 0 不依赖外部模型 API 或云服务。

### 示例命令

```bash
npm install
npm run dev
npm run typecheck
npm run test
npm run build
```

---

## 需求澄清记录

| 问题 | 回答 | 确认时间 |
|---|---|---|
| 是否自训练模型？ | 不自训练模型，后续通过 API 接入不同厂商 | 2026-06-25 |
| 应用形态是什么？ | 桌面端 Agent Coding 工具，类似 Codex 桌面端、Claude Code 桌面端 | 2026-06-25 |
| 技术栈是什么？ | Electron + TypeScript + React | 2026-06-25 |
| Skills 和 MCP 放在哪个阶段？ | 放到最后阶段，核心 Agent Coding 闭环稳定后再做 | 2026-06-25 |
| 当前要生成什么？ | 按 continue-develop 工作流先生成第一阶段需求分析 | 2026-06-25 |
