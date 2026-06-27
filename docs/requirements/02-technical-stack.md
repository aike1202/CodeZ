# 02. 技术选型

> 模块：开发语言、桌面容器、前端框架、模型接入、测试工具和部署形态

---

## 1. 总体技术栈

| 层级 | 技术选型 | 说明 |
|---|---|---|
| 桌面容器 | Electron | 负责跨平台桌面应用、主进程、窗口、系统能力 |
| UI 前端 | React | 构建聊天界面、文件树、diff 面板、设置页 |
| 语言 | TypeScript | 主语言，统一前端、主进程和 Agent Runtime 类型体系 |
| 构建工具 | Vite | React 前端开发与打包 |
| Electron 构建 | electron-builder 或 Electron Forge | 打包 Windows/macOS/Linux 应用 |
| 状态管理 | Zustand / Redux Toolkit | 管理会话、任务、模型配置、UI 状态 |
| 样式 | Tailwind CSS | 快速构建一致 UI |
| UI 组件 | shadcn/ui 或自定义组件 | 对话、按钮、弹窗、表单、Tabs、面板 |
| 模型 API | OpenAI-compatible SDK + 各厂商适配器 | 支持不同模型厂商 |
| 本地存储 | SQLite / JSON 文件 | 存储设置、会话、任务、项目记忆 |
| 文件搜索 | fast-glob / ripgrep | 搜索项目文件和代码内容 |
| 命令执行 | Node child_process / execa | 运行测试、构建、项目命令 |
| diff | diff / jsdiff / monaco diff editor | 展示代码变更 |
| 编辑器组件 | Monaco Editor | 代码预览、diff 查看、文件查看 |
| 日志 | electron-log / pino | 本地运行日志和错误记录 |
| 测试 | Vitest + React Testing Library + Playwright | 单元测试、组件测试、E2E 测试 |

---

## 2. 主语言要求

主语言使用：

```text
TypeScript
```

选择 TypeScript 的原因：

- Electron 主进程适合 Node.js/TypeScript；
- React 前端天然适配 TypeScript；
- Agent 工具层需要大量结构化类型定义；
- 模型工具调用参数适合使用 TypeScript + Zod 校验；
- 未来可扩展 VS Code 插件，仍然使用 TypeScript；
- 降低跨语言通信成本。

---

## 3. 模型接入策略

本项目不训练模型，通过 API 接入模型厂商。

必须支持统一抽象：

```ts
interface ModelProvider {
  id: string
  name: string
  listModels(): Promise<ModelInfo[]>
  chat(request: ChatRequest): Promise<ChatResponse>
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>
}
```

第一阶段建议支持：

1. OpenAI-compatible API；
2. DeepSeek；
3. Qwen / 阿里云百炼；
4. GLM / 智谱；
5. Ollama 本地模型，可选；
6. Claude，可选，取决于 API 可用性。

---

## 4. 系统部署形态

本项目采用本地桌面应用形态：

```text
用户电脑
├── Electron Desktop App
│   ├── Renderer Process: React UI
│   ├── Main Process: 文件系统、Shell、窗口管理
│   └── Agent Runtime: 任务规划、工具调用、上下文管理
├── Local Project Workspace
├── Local Config / Database
└── Remote LLM Provider API
```

默认情况下，代码文件保存在用户本地。只有被 Agent 上下文选中的必要片段会发送给模型 API。应用需要清楚提示用户：调用远程模型时，相关代码和提示词可能发送到第三方服务。

---

## 5. 技术选型原则

1. 第一版优先可运行、可演示、可验证；
2. 优先使用 TypeScript 统一工程；
3. Agent Runtime 与 UI 解耦，未来可以复用到 CLI 或 VS Code 插件；
4. 模型厂商通过 Provider Adapter 解耦；
5. 高风险能力必须放在 Main Process，并通过 IPC 受控调用；
6. 本地存储优先简单可靠，后续再升级复杂索引或向量数据库。
