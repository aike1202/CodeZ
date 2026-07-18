# Codex Tool Rollout 证据与限制

## Rollout 可保存

- `session_meta`：版本、cwd、model provider、base instructions、dynamic tools、context window。
- `response_item`：assistant message、reasoning summary、custom/function tool call 和 tool output。
- `event_msg`：token count、command/patch 生命周期、Agent status。
- 子线程 metadata：parent、depth、path、nickname、role。

真实 `apply_patch` 还会生成 `patch_apply_end`，包含每文件结构化 unified diff。

## Rollout 未必保存

- 固定 core tools 的完整 JSON schema；`dynamic_tools` 只覆盖动态 namespace。
- OpenAI 内部 shell sandbox、patch parser、输出截断等源码算法。
- 加密 reasoning 或加密 spawn payload 的明文。
- 所有服务端 cache block 和 prompt prefix 细节。

## 研究规则

```text
观察到调用 != 获得实现源码
看到 description != 证明 runtime enforcement
dynamic_tools != 完整 tool catalog
子线程 task name != built-in agent role
```

因此 Codex 工具文档的可信层级是：真实调用/结果为 A，公开手册为 A/B，当前会话 schema 是 runtime contract 快照；内部核心算法一律标记 unavailable。
