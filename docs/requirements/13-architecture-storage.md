# 13. 系统架构与数据存储

> 模块：高层架构、进程通信、Agent Runtime 结构、本地存储

---

## 1. 高层架构

```text
Electron Desktop App
├── Renderer Process
│   ├── React UI
│   ├── Chat Panel
│   ├── File Tree
│   ├── Diff Viewer
│   ├── Settings UI
│   ├── Terminal Output Panel
│   ├── Skill Manager UI              # 最后阶段扩展
│   └── MCP Server Manager UI         # 最后阶段扩展
│
├── Main Process
│   ├── Window Manager
│   ├── IPC Router
│   ├── File System Service
│   ├── Command Service
│   ├── Secure Storage Service
│   ├── Workspace Service
│   ├── Skill File Service            # 最后阶段扩展
│   └── MCP Process Service           # 最后阶段扩展
│
├── Agent Runtime
│   ├── Agent Loop
│   ├── Planner
│   ├── Tool Manager
│   ├── Context Builder
│   ├── Memory Manager
│   ├── Verification Manager
│   ├── Permission Manager
│   ├── Skill Manager                 # 最后阶段扩展
│   └── MCP Manager                   # 最后阶段扩展
│
├── Model Layer
│   ├── Provider Adapter Interface
│   ├── OpenAI-Compatible Provider
│   ├── DeepSeek Provider
│   ├── Qwen Provider
│   ├── GLM Provider
│   └── Ollama Provider
│
├── Extension Layer                   # 最后阶段扩展
│   ├── Built-in Skills
│   ├── User Skills
│   ├── MCP Servers
│   └── External Tool Adapters
│
└── Local Storage
    ├── settings
    ├── sessions
    ├── tasks
    ├── skills
    ├── mcp-servers
    ├── project memory
    └── logs
```

---

## 2. 进程通信需求

Renderer 不能直接访问 Node 文件系统。所有敏感操作必须通过 Electron IPC 调用 Main Process。

要求：

- IPC 接口必须有类型定义；
- IPC 参数必须校验；
- IPC 必须检查 Workspace 边界；
- Renderer 不能直接拿到 API Key 明文，除非用户编辑时临时展示；
- Main Process 负责执行文件和命令操作。

---

## 3. 推荐目录结构

```text
my-agent/
├── docs/
│   └── requirements/
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── ipc/
│   │   ├── services/
│   │   │   ├── WorkspaceService.ts
│   │   │   ├── FileSystemService.ts
│   │   │   ├── CommandService.ts
│   │   │   ├── SecureStorageService.ts
│   │   │   ├── SkillFileService.ts          # 最后阶段扩展
│   │   │   └── McpProcessService.ts         # 最后阶段扩展
│   │   └── windows/
│   ├── preload/
│   │   └── index.ts
│   ├── renderer/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   ├── components/
│   │   ├── stores/
│   │   └── styles/
│   ├── agent/
│   │   ├── core/
│   │   ├── tools/
│   │   ├── models/
│   │   ├── memory/
│   │   ├── verifier/
│   │   └── extensions/                      # 最后阶段扩展
│   │       ├── skills/
│   │       └── mcp/
│   ├── shared/
│   │   ├── types/
│   │   ├── schemas/
│   │   └── constants/
│   └── tests/
├── package.json
├── tsconfig.json
├── vite.config.ts
└── electron-builder.yml
```

---

## 4. 配置数据

配置数据包含：

- 应用设置；
- 模型配置；
- 用户偏好；
- 最近打开项目。

建议使用：

- SQLite；或
- Electron Store + safeStorage；或
- JSON 配置 + 加密字段。

---

## 5. 会话数据

会话数据包含：

- 消息列表；
- 工具调用；
- 命令输出；
- diff；
- 任务状态；
- 验证结果。

---

## 6. 项目记忆数据

项目记忆可以保存在项目内 `.agent` 目录，也可以保存在全局应用目录。建议支持用户选择。

项目内保存的优点：

- 跟随项目；
- 便于版本管理，可选；
- Agent 下次打开项目更容易恢复。

项目内保存的风险：

- 可能误提交；
- 可能包含敏感摘要；
- 需要加入 `.gitignore`。
