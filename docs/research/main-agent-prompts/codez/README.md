# CodeZ 主 Agent 与上下文档案

## 证据边界

本目录分析 `F:\MyProjectF\CodeZ` 在以下工作树快照中的行为：

```yaml
revision: f76537bb6d4f7b066f4a6519e44fff1c9833b533
branch: codex/test_rs
snapshot_date: 2026-07-18
worktree: dirty
runtime_generation: Tauri/Rust primary path with legacy Electron/TypeScript sources retained
```

当前工作树已有用户修改，因此这里记录的是“revision + dirty working tree”，不是该 commit 的纯净源码。调研没有修改 Rust/TypeScript 运行时代码。

## 直接结论

1. 当前 Tauri 主链的 System Prompt 由 Rust `PromptPipeline` 动态装配，不存在单一静态 prompt 文件。
2. 当前可运行的 Durable Agent 只有 `Explore` 和 `Reviewer`。Electron 旧实现中的 `ExecutionPlanner`、`Executor` 仍在源码里，但不属于当前 Provider 主链。
3. 子 Agent 的 System Prompt 是“完整主 Prompt + role addendum”，不是一个很短的独立模板。
4. 真实会话 `1784299678287_8eao9s` 一次派发了 3 个 Explore。框架没有“一次必须派 4 个”的规则；当前并发上限是 8 个 active attempts。
5. Explore 的触发规则确实发生了漂移：主 Prompt 的委派门控只识别旧工具名 `SubAgentRunner`/`DelegateTasks`，实际工具叫 `spawn_agent`，所以 `# Subagents` 段不会出现。
6. `SubAgentsModule` 固定关闭，Explore/Reviewer 注册表里的 `whenToUse`、`whenNotToUse`、成本和输出契约也不会进入主 Prompt。
7. 4 个 deferred tools 存在于工具曝光计划中，但 `ChatPromptAssembler` 把 `deferred_tools` 硬编码成空数组，因此 System Prompt 看不到它们，只能从 `ToolSearch` 描述猜测。
8. MCP 有独立的连接、目录、资源和调用运行时，但当前 `ChatToolRuntime` 只组装 built-in catalog，没有把 MCP 工具合并进 Provider tools。

## 目录

```text
codez/
|-- README.md
|-- main-agent-prompt.md
|-- assembly-map.md
|-- sources.json
|-- context-layers/
|-- subagents/
|   `-- legacy-electron/
|-- tools/
`-- context-requests/
```

`main-agent-prompt.md` 直接保存一份展开后的完整代表性正文。`context-requests/` 直接嵌入 system、messages 和 tools，不使用 `content_ref` 替代正文。

## 证据等级

| 等级 | 在本目录中的含义 |
|---|---|
| A | 本机 CodeZ ledger、snapshot、Agent runtime 或结构化日志中的逐字记录 |
| B | 当前工作树源码中的逐字模板、schema 或确定性装配逻辑 |
| C | 真实日志与当前源码共同重建；真实发生过，但 outbound body 未被完整保存 |
| D | 为说明协议而构造的源码驱动模拟 |

## 最值得先修的产品问题

主 Agent 当前只看到 `spawn_agent` 的 schema：`Start a durable Explore or Reviewer Agent`。它看不到注册表中“直接 Glob/Grep/Read 能回答时不要派 Explore”“答案已在父上下文时不要派”“文件数量不是委派理由”等约束。这会系统性提高 Explore 的误触发概率。

建议先统一工具命名门控，让 `WorkerDelegationModule` 识别 `spawn_agent`；随后启用一个真正从 Agent registry 渲染的目录模块。不要把并发上限、角色描述和触发策略分别硬编码在三个位置。
