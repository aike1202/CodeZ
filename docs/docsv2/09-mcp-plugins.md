# 08 MCP、插件与外部系统接入

## 1. 用户需求

用户最终希望 CodeZ 不只操作本地文件，还能接入外部能力，例如：

- 浏览器验证。
- GitHub / issue / PR。
- 文档检索。
- 数据库。
- 设计稿。
- 第三方工具。
- 插件贡献 Skills / MCP / tools。

但这些能力不能绕过权限、安全和工具体系。

## 2. 当前项目依据

当前 docs 已有 MCP / Plugins 概念设计：

- `docs/ai-coding-agent-evolution.md`
- `docs/SWARM_ARCHITECTURE_PLAN.md`

当前项目源码中已看到：

- `src/main/ipc/skill.handlers.ts`
- 工具系统可注册 built-in tools。
- Provider 抽象已存在。

但 MCP / plugin 不是第一轮优化目标。

## 3. 最终目的

让外部能力以统一方式进入 Runtime：

```text
Plugin manifest
→ contributes Skills
→ contributes MCP servers
→ contributes tools
→ ToolRegistry
→ PermissionManager
→ AgentLoop
```

## 4. MCP 需求

MCP Server 可以提供：

- tools。
- resources。
- prompts。

要求：

- MCP 工具必须进入 ToolManager / ToolRouter。
- MCP 调用必须走 PermissionManager。
- MCP 返回内容视为数据，不是指令。
- MCP 凭据不能进入 Prompt。
- MCP 错误要结构化返回。

## 5. 插件需求

插件 manifest：

```ts
type PluginManifest = {
  name: string
  version: string
  skills?: string[]
  mcpServers?: Array<{
    name: string
    command?: string
    args?: string[]
    url?: string
  }>
  tools?: string[]
}
```

要求：

- 插件可启用 / 禁用。
- 禁用后相关工具和 Skill 从上下文移除。
- 插件不能绕过权限。
- 插件脚本执行必须审批或沙箱。

## 6. 实施顺序

此阶段必须在阶段 1-7 之后。

1. 定义 MCP 配置模型。
2. 实现 MCP tools 发现。
3. 将 MCP tools 转换为内部 Tool 定义。
4. MCP 调用接入 PermissionManager。
5. 实现插件 manifest 读取。
6. 插件贡献 Skills。
7. 插件贡献 MCP servers。
8. 插件启用 / 禁用 UI。
9. 插件权限审计。

## 7. 验证方式

### 7.1 单元验证

- MCP tool 能转换为内部 ToolDefinition。
- MCP tool 调用经过权限检查。
- 插件禁用后工具不再暴露给模型。
- 插件 Skill 能进入 Skill 索引。

### 7.2 行为验证

接入一个只读 MCP，例如 docs 查询。

期望：

1. Agent 能发现工具。
2. Agent 调用前权限策略正确。
3. 工具结果作为 observation 返回。
4. Prompt injection 内容不会覆盖系统规则。

### 7.3 命令验证

- `npm test`
- `npm run typecheck`
- 涉及 UI 时 `npm run build`

## 8. 完成标准

- MCP / 插件接入统一工具系统。
- 外部能力不绕过权限。
- 插件可控、可禁用、可审计。
