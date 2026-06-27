# 📝 开发计划 - 阶段 3：基础 Agent Loop 与只读工具调用

> 关联需求：阶段3开发需求-requirements.md
> 迭代：iteration-4
> 创建时间：2026-06-25 22:35
> 最后更新：2026-06-26 00:25

## 技术方案
在现在的 `ChatService` 基础上，封装并引入真正的 Agent Runner 闭环和 Function/Tool Call 能力。
工具运行是在 `main` 主进程沙盒中进行（利用 node.js fs 模块和隔离，确保无法跳出被选中的 Workspace 根目录），然后 `AgentRunner` 会在与 OpenAI API 通信时附加上当前应用具备的可选 `tools`。如果 LLM 决定调用某个 tool（如读取 `package.json`），它会返回 `tool_calls`。此时 `AgentRunner` 会拦截返回，执行对应的 node.js function，并将执行结果组装成新的 messsages （role: 'tool'）发送给 LLM 取回最终解释，实现多轮连续读取。

同时需要对前台开放 IPC 返回正在运行中的工具事件日志，以告知用户。 

## 架构设计
- **Tool 接口抽象 (`src/main/tools/Tool.ts`)**：提供标准的 `name`，`description`，`parameters_schema` 属性，和 `execute(args, context)` 异步方法。
- **Core 内置 Tools (`src/main/tools/builtin/`)**: `ListFilesTool`, `ReadFileTool`, `SearchTextTool`。依赖传入的 `workspaceRoot` 确保安全限制。
- **ToolManager (`src/main/tools/ToolManager.ts`)**：注册和分发调用。
- **AgentRunner (`src/main/agent/AgentRunner.ts`)**：负责对大模型发请多轮 Tool 迭代请求的封装，它依赖既有的 `ChatService`，并需要一个 EventEmiiter 或 callback 通知进程进度（例如: `tool_start`, `tool_end`）。 
- **前端显示 (`src/renderer/src/components/chat/ToolCallLog.tsx`) 或挂载在 `PromptArea`**: 当收到 `CHAT_STREAM_TOOL_START` 和 `CHAT_STREAM_TOOL_END` 就在前端显示。

## 任务拆解
| 任务ID | 任务描述 | 状态 | 复杂度 | 预计文件 | 完成时间 |
|--------|----------|------|--------|----------|----------|
| T1 | 制定大模型 Tool 参数类型接口 & `Tool` 基础声明抽象 | ✅ 已完成 | 低 | `src/shared/types/provider.ts`, `src/main/tools/Tool.ts` | 2026-06-25 22:42 |
| T2 | 实现三个只读工具 `list_files`, `read_file`, `search_text` | ✅ 已完成 | 中 | `src/main/tools/builtin/*.ts`, `src/main/tools/ToolManager.ts` | 2026-06-25 22:42 |
| T3 | 改造 `ChatService` 支持 `tools`，封装全新的 `AgentRunner` 用于处理 Tool 调用闭环逻辑 | ✅ 已完成 | 高 | `src/main/services/ChatService.ts`, `src/main/agent/AgentRunner.ts` | 2026-06-25 22:42 |
| T4 | 主进程 IPC 与前端状态通讯拓展，通知前台 Tool 执行的情况 | ✅ 已完成 | 中 | `src/shared/ipc/channels.ts`, `src/main/ipc/chat.handlers.ts`, 前端 store/hooks | 2026-06-25 22:42 |
| T5 | 前端界面组件支持渲染 Tool Call 工作进度日志面板 | ✅ 已完成 | 中 | `src/renderer/src/components/chat/*`, `App.tsx` | 2026-06-25 22:42 |
| T6 | 移除前端模拟 Agent 状态，将对话框工具调用记录接入真实 `CHAT_STREAM_TOOL_START/END` IPC 事件 | ✅ 已完成 | 中 | `src/renderer/src/App.tsx`, `src/renderer/src/stores/chatStore.ts`, `src/renderer/src/components/chat/ToolCallLog.tsx`, `src/preload/index.ts` | 2026-06-25 23:58 |
| T7 | 优化真实 Tool Call 展示：紧凑汇总、按真实顺序排序、支持折叠，并使用人类友好动作文案 | ✅ 已完成 | 中 | `src/renderer/src/components/chat/ToolCallLog.tsx`, `src/renderer/src/stores/chatStore.ts`, `src/renderer/src/App.tsx` | 2026-06-26 00:03 |
| T8 | 将最终回复前的执行记录整合为整体折叠面板，批量折叅读取/命令/编辑记录，编辑详情展示每个文件增删行数 | ✅ 已完成 | 中 | `src/renderer/src/components/chat/ExecutionLog.tsx`, `src/renderer/src/components/chat/ThinkingBlock.tsx`, `src/renderer/src/App.tsx` | 2026-06-26 00:14 |
| T9 | 建立按真实事件顺序渲染的执行时间线，将思考片段与其后的工具调用交替展示，最后保留完成汇总 | ✅ 已完成 | 高 | `src/renderer/src/stores/chatStore.ts`, `src/renderer/src/components/chat/ExecutionLog.tsx`, `src/renderer/src/App.tsx` | 2026-06-26 00:25 |

## 步骤状态
| 阶段 | 状态 | 开始时间 | 完成时间 |
|------|------|----------|----------|
| 需求分析 | ✅ 已完成 | 22:30 | 22:32 |
| 计划/设计 | ✅ 已完成 | 22:32 | 22:35 |
| 实现 | ✅ 已完成 | 22:35 | 22:42 |
| 编译验证 | ✅ 已完成 | 22:42 | 2026-06-25 23:50 |
| 测试 | ✅ 已完成 | 23:48 | 2026-06-25 23:49 |
| 完成 | ✅ 已完成 | 23:50 | 2026-06-25 23:50 |

## 依赖关系
T2 依赖 T1
T3 依赖 T2
T4，T5 依赖 T3
T1 为阻塞主干链路第一任务。

## 风险点
- 流式解析中的 tool call 返回可能是断断续续的 chunk (对于某些模型如 OpenAI，tool call 返回是被 stream delta 分包的，而非一整块)，`ChatService` 流解析功能需强化，以确保可以将工具调用的参数成功聚合并转换为 JSON。
- 搜索文件的正则可能性能较差或崩溃，需要进行超时或安全限制，建议初期仅仅返回简单关键词文本搜索即可。
- 文件树和读取可能会爆 Token 导致模型无响应，返回的文本必须强硬截断。

## 完成报告

- **完成时间**：2026-06-25 23:50
- **任务完成**：9/9（100%）
- **实现结果**：已完成基础 Agent Loop、只读工具注册/执行、Tool Call 流式聚合、主进程 IPC 事件转发，以及前端真实工具调用日志展示；已移除对话中的模拟 Agent 状态注入。最终回复前的执行记录已整合为整体折叠面板，并新增 `executionTimeline` 以按真实发生顺序串联思考片段与工具调用：思考片段连续合并，遇到工具调用后开启新的时间线节点，后续思考重新开段；完成后顶部展示最终执行汇总。
- **验证结果**：
  - `npm run typecheck` 通过（0 errors，2026-06-26 00:25）
  - `npm run build` 通过（2026-06-26 00:25）
  - `npm test` 通过（2 test files，10 tests，2026-06-26 00:25）
- **下一步建议**：进入阶段 4 前，建议手动运行桌面应用并用真实 OpenAI-compatible/Ollama Provider 验收：读取 `package.json`、搜索 `WorkspaceService`、阻止工作区外路径读取。