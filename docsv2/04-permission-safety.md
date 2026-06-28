# 04 权限、安全边界与 Shell 风险控制

## 1. 用户需求

用户需要 Agent 可以执行本地任务，但不能越权或破坏项目。尤其是：

- 不能写 workspace 外文件。
- 不能随意删除文件。
- 不能随意安装依赖。
- 不能随意联网。
- 不能执行危险 Git 操作。
- MCP / 插件不能绕过权限系统。

## 2. 当前项目依据

相关文件：

- `src/main/tools/builtin/RunCommandTool.ts`
- `src/main/tools/builtin/WriteToFileTool.ts`
- `src/main/tools/builtin/ReplaceFileContentTool.ts`
- `src/main/tools/Tool.ts`
- `src/main/tools/ToolManager.ts`
- `src/main/ipc/chat.handlers.ts`
- `src/main/services/WorkspaceService.ts`

当前已有：

- workspaceRoot 路径限制。
- shell cwd 限制。
- shell timeout。
- 部分输出限制。

主要缺口：

- 缺少统一 PermissionManager。
- 缺少命令 allow / ask / deny 分类。
- 缺少高风险操作审批 UI。
- 缺少审计日志。

## 3. 最终目的

建立 Runtime 级权限系统：

```text
Tool call
→ ToolRouter
→ PermissionManager
→ allow / ask / deny
→ ToolExecutor
→ AuditLog
```

## 4. 权限策略

| 行为 | 默认策略 |
| --- | --- |
| 搜索 workspace | allow |
| 读取普通文件 | allow |
| 写 workspace 内文件 | ask 或 allow，取决于用户模式 |
| 覆盖已有文件 | ask 或 hash 校验 |
| 删除文件 | ask |
| 写 workspace 外文件 | deny |
| `npm test`, `npm run typecheck`, `npm run build` | allow |
| 安装依赖 | ask |
| 网络命令 | ask |
| `git status`, `git diff`, `git log` | allow |
| `git reset`, `git clean`, `git checkout --`, force push | ask / deny，必须明确说明风险 |
| 打开外部应用 | ask |
| MCP 外部写操作 | ask |

## 5. 命令分类

建议给 Shell 命令分类：

```ts
type CommandRisk = 'safe' | 'write' | 'network' | 'destructive' | 'unknown'
```

示例：

- safe：`npm test`, `npm run typecheck`, `git status`
- write：`npm install`, `npm run package`
- network：`curl`, `wget`, package manager install
- destructive：`rm`, `del`, `git reset --hard`, `git clean`, `rmdir`
- unknown：无法分类的命令

## 6. 实施顺序

1. 新增 `PermissionManager`。
2. 为每个 Tool 增加风险元信息。
3. 给 `RunCommandTool` 增加命令分类。
4. 在 ToolManager 或 AgentRunner 执行工具前统一检查权限。
5. IPC 增加 approval request / response。
6. Renderer 展示审批卡片。
7. 记录权限决策日志。
8. 后续 MCP / 插件接入同一权限层。

## 7. 验证方式

### 7.1 单元验证

- workspace 外写入被拒绝。
- `npm test` 默认允许。
- `npm install` 需要确认。
- `git status` 默认允许。
- `git reset --hard` 默认拒绝或必须确认。
- 未知命令默认 ask。

### 7.2 行为验证

让 Agent 尝试执行：

```text
删除 dist-app 并重新安装依赖
```

期望：

- 删除操作被拦截。
- 安装依赖需要确认。
- Agent 不能直接执行高风险命令。

### 7.3 命令验证

- `npm test`
- `npm run typecheck`

## 8. 完成标准

- 所有工具调用都经过权限层。
- 高风险操作有用户可见审批。
- 权限不是 Prompt 约束，而是 Runtime 强制。
- 后续 MCP / 插件可复用同一权限系统。
