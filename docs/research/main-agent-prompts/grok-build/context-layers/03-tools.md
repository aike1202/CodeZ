# 03 工具描述与 JSON Schema

`ToolBridge::tool_definitions()` 从 finalized ToolRegistry 取得最终 name、description 和 JSON schema，作为独立 tools array 发送。System template 只通过 `tools.by_kind.*` 引用当前显示名称。

## Finalization 影响

- Tool kind/name remapping。
- `requires_expr()` 能力依赖。
- Params 改写 schema/description，例如 background 开关和 timeout。
- behavior contract version，例如 `legacy-0.4.10`。
- Agent capability mode 和 parent-dependent toolset 过滤。

完整工具清单与源码算法见 [tools/README.md](../tools/README.md)，包括 Read、SearchReplace、Grep、ListDir、Shell、Task、Plan、Todo、Web 和媒体工具。

## 模型与运行时

模型可见 schema 不等于全部内部字段：例如 Grep `output_mode` 可在 wire 反序列化但从当前 JSON schema 隐藏；server-injected task id 不向模型暴露。记录系统需要同时保存 exported schema 和 internal accepted input。
