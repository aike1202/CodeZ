# 03 工具描述与 JSON Schema

## 工具来源

Codex 工具 catalog 由固定 core tools、Desktop app dynamic tools、MCP、plugins 和 collaboration mode 共同组成。`session_meta.dynamic_tools` 只保存动态 namespace，不代表完整 catalog。

当前观察到的分层见 [tools/README.md](../tools/README.md)：

- `exec` 受限 JavaScript 编排器。
- `exec_command`、`write_stdin`、`wait`。
- `apply_patch`。
- plan/goal 工具。
- collaboration Agent 工具。
- MCP resources 和 `codex_app` tools。

## 模型可见内容

模型获得 name、description 和 input schema。`exec` 还提供 `tools.*` 嵌套方法元数据及 `text/image/store/load` 辅助函数。App tools 可标记 `deferLoading`，避免所有大 schema 首轮常驻。

## Rollout 记录

真实日志保存 selected tool call、arguments、call id、output 和部分 lifecycle event，例如 `patch_apply_end` 的结构化 diff。它未必保存固定 core tools 的完整 outbound schema array。

## 不可推断内容

没有本地 Codex core tool 实现源码，不能宣称知道 `apply_patch` fuzzy matcher、sandbox 内核、shell parser 或输出截断算法。详情见 [runtime-evidence.md](../tools/runtime-evidence.md)。
