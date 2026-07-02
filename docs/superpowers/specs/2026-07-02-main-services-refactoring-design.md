# 主进程与服务层重构设计方案 (Main Process & Services Refactoring Design)

## 1. 重构背景与目标

当前 Electron 主进程核心层中，部分核心服务与 IPC Handler 文件体积过大：
1. `src/main/agent/AgentRunner.ts` (684 行) — Agent 执行引擎主逻辑
2. `src/main/services/ProjectAnalysisService.ts` (641 行) — 项目分析与符号提取服务
3. `src/main/ipc/workspace.handlers.ts` (415 行) — 工作区与文件系统的 IPC 句柄

为了提升主进程可读性、模块化与单元测试便利性，本项目计划对其进行模块化解耦与拆分。

### 核心设计原则
1. **100% API 兼容**：主进程类、服务单例与 IPC Channel 注册函数保持完全一致，不影响 Renderer 进程与 App 启动流。
2. **单一职责原则**：每个拆分后的子模块只关注具体的子任务（如错误处理、缓存管理、特定 IPC 类型的处理器等）。
3. **文件行数约束**：每个子文件代码行数建议控制在 150 行以内，硬性上限 200 行。

---

## 2. 详细拆分架构设计

### 2.1 `AgentRunner` 拆分 (`src/main/agent/AgentRunner/`)

将原 `AgentRunner.ts` 改造为目录结构：

```text
src/main/agent/AgentRunner/
├── index.ts                  # 主 AgentRunner 类 (保持单例与对外实例调用无缝兼容)
├── types.ts                  # AgentRunnerCallbacks, AgentRunConfig 接口定义
├── agentErrorHandler.ts      # 工具错误识别与恢复建议逻辑 (isToolErrorResult, buildToolError)
└── planRunnerHelper.ts       # SubAgent / Plan Mode 状态联动与回调扩展
```

### 2.2 `ProjectAnalysisService` 拆分 (`src/main/services/ProjectAnalysisService/`)

将原 `ProjectAnalysisService.ts` 改造为目录结构：

```text
src/main/services/ProjectAnalysisService/
├── index.ts                  # 组合并导出 ProjectAnalysisService 服务类
├── types.ts                  # 集中声明 ProjectSnapshot, SymbolMapResult 等分析接口
├── snapshotCache.ts          # 快照 Hash 校验与磁盘 JSON 缓存持久化
├── codeSearcher.ts           # 代码正则与关键字全局检索逻辑 (searchCode)
└── symbolExtractor.ts        # TypeScript / JavaScript 符号树提取逻辑 (getSymbolMap)
```

### 2.3 `workspace.handlers` 拆分 (`src/main/ipc/workspace.handlers/`)

将原 `workspace.handlers.ts` 改造为目录结构：

```text
src/main/ipc/workspace.handlers/
├── index.ts                  # 统一 registerWorkspaceHandlers 注册入口
├── fileOpsHandlers.ts        # 文件/目录读取、保存、删除与重命名 IPC Handler
└── projectAnalysisHandlers.ts # 快照获取、代码检索、符号地图与 RecentProjects IPC Handler
```

---

## 3. 验证与测试计划

1. **静态编译校验**：使用 `npx tsc --noEmit` 验证主进程代码类型是否正确。
2. **打包验证与 Dev 运行**：运行 `npm run dev` 确保 Electron 主进程无异常崩溃，Agent 会话交互、项目分析与文件读写均正常运行。
