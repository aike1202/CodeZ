# 06 Skills、Agent 与 MCP 目录

## Skills

CodeZ `SkillsService` 扫描：

```text
resources/builtin-skills
C:\Users\asus\.codez\skills
F:\MyProjectF\CodeZ\.skills
```

它不扫描 `.agents/skills`。因此仓库里的 `.agents/skills/rust-best-practices` 可被当前 Codex 环境发现，但不会进入 CodeZ 自己的 Skill catalog。

System Prompt 只列 name、ID 和 description。完整 Skill body 在 `Skill`/`ActivateSkill` 成功后作为 tool result 和 `skill_state_updated` ledger event 进入历史；active 状态跨 turn、compaction、failure 和 restart 持久化。

## 当前 Durable Agent

```text
Explore
Reviewer
```

注册表含 description、whenToUse、whenNotToUse、costHint、maxLoops 和 outputSpec，但 `SubAgentsModule` 固定关闭，所以这些目录信息当前不进主 Prompt。主 Agent 只从 `spawn_agent` schema 得知 role enum。

## 遗留 Electron Agent

```text
Explore
Reviewer
ExecutionPlanner
Executor
```

这些定义使用 TypeScript `SubAgentManager` 和 `submit_result` 输出契约，单独记录在 `subagents/legacy-electron/`。不能据此宣称当前 Tauri 主链支持 Planner/Executor。

## MCP

当前本机配置：

```json
{
  "mcpServers": {
    "bing-search": {
      "args": ["-y", "bing-cn-mcp"],
      "command": "npx",
      "disabled": true
    }
  }
}
```

Rust `McpRuntimeManager` 已实现连接生命周期、OAuth、catalog、resources、prompts、tool call、订阅、限额、redaction 和 shutdown。可是 `ChatToolRuntime::builtin_catalog` 没有接收 MCP descriptors，也没有在每轮请求中合并 MCP catalog。因此当前主 Agent 的 Provider tools 中没有 `mcp__...`，System Prompt 也没有 MCP 目录。
