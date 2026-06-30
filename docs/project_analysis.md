# CodeZ 项目全面分析报告

## 1. 项目整体定位与现状 (Documentation)
CodeZ 是一个基于大语言模型 API 的桌面端 Agent Coding 工具（Electron + React + TypeScript + Vite）。
根据 `README.md` 与 `docsv2/00-current-state-and-scope.md` 的记录，项目当前处于**阶段 0 (项目初始化与基础工程)** 的尾声或过渡阶段。
目前已具备：
- **Agent 核心基础**：包含 AgentRunner（执行循环）、ContextManager（上下文裁剪）。
- **多模型支持**：支持 Anthropic, OpenAI, Gemini Provider。
- **底层工具系统**：实现了文件搜索、读取、写入、替换、命令执行及回滚（Rollback）等十几个基础工具。
- **UI 与通讯**：实现了 Chat IPC 机制，以及基于 Zustand 的前端状态管理（chatStore, workspaceStore），并完成了 UI 的初步模块化（Sidebar, ChatArea, FilePreviewPanel）。

## 2. 代码架构与 UI 界面分析 (Code & UI)
### 2.1 主进程 (Main Process - Node.js)
- 核心目录：`src/main/agent`, `src/main/tools`, `src/main/services`, `src/main/ipc`。
- 现状：当前工具（Tool）粒度较细（例如 `SearchTextTool`, `SearchCodeTool`, `ReadFileTool` 等）。从 `docsv2` 的规划来看，这在实际使用中会导致 LLM 心智负担较重，容易选错工具，或滥用 shell 工具进行文件检索。

### 2.2 渲染进程 (Renderer Process - React)
- **App 结构**：采用标准 IDE 布局，左侧 `Sidebar`，顶部 `TopBar`，中间主工作区 `ChatArea`，右侧（可折叠）`FilePreviewPanel`，底部终端。
- **UI 完成度**：
  - 最近已完成了 `ChatArea` 的抽取与 `App.tsx` 的极简化 (`task.md` 阶段五、六已完成)。
  - 聊天列表支持基本的消息展示（包含了工具调用日志 `ExecutionLog` / `ToolCallLog`）。
  - 右侧文件与 Diff 预览面板实现了基本功能。
- **待完善交互**：根据此前对话的开发记录，**在输入框 (PromptArea) 中混排显示调用的技能以及 `@` 选择文件**的功能属于刚开发或待打磨的阶段。

## 3. 功能欠缺与下一步优化方向 (Missing Features & Next Steps)
结合 `docsv2` 目录中的深度规划以及代码现状，当前项目主要有以下几个层面的功能欠缺和急需优化的点：

### 3.1 工具系统的收敛与重构 (高优先级)
当前系统工具过于零散。需要按 `docsv2/01-tool-system.md` 规划，将其收敛为四大核心：
- **`search`**：整合文件名、文本、正则、符号及模糊搜索。
- **`read_files`**：整合单文件、多文件、范围读取，严格控制 Token 预算。
- **`apply_patch`**：**极度缺失**。当前主要依赖全量写入或正则替换，亟需引入基于标准 Patch / 结构化 Diff 的修改路径，降低写坏代码的风险。
- **`shell`**：限制在测试、构建阶段，禁止或减少 LLM 滥用 grep/cat 等系统命令。

### 3.2 权限与安全机制 (Permission & Safety)
- **缺少统一权限层**：Shell 命令执行、文件删除、网络请求等高危操作目前缺乏分级的权限拦截。需要建立统一的用户审批机制。

### 3.3 自动化验证闭环 (Verification Loop)
- **缺乏独立的自修复闭环**：目前虽然有 `run_command`，但尚未建立起“代码修改 -> 自动运行测试/编译 -> 提取错误 -> Agent 自动修复”的稳定自动循环。

### 3.4 交互层 (UI/UX)
- **代码 Diff 审查 (Code Review)**：目前的 Diff 展示相对原始，缺乏行内 (Inline) 交互或左右双栏 (Split) 详细代码审查机制。
- **Prompt 输入区增强**：全面打磨对话输入框的 `@ 文件引用` 和 `/ 技能调用` 提及功能及混合渲染。

### 3.5 长期演进 (Swarm, MCP, Memory)
*（第一轮优化暂不涉及，但属于长远缺失）*
- Swarm 架构（多 Agent 并发与任务分发）。
- MCP（Model Context Protocol）插件生态接入。
- 长期项目记忆（向量数据库）与会话状态快照恢复。

---
**总结**：UI 层面的基础框架已基本成型。**下一步最关键的动作应当是向主进程进军：重构并收敛 Agent 的工具系统（特别是实现 `apply_patch` 和统一 `search` / `read_files`）**。这是提升单 Agent 编码成功率的核心基石，在底层能力稳定后再向外扩展 Swarm 与 MCP。
