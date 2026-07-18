# Codex 请求上下文样例

Codex rollout 会把 base instructions、developer/user 消息、world state、turn context、工具调用和输出按 JSONL 保存。样例对个人路径和无关技能目录做了脱敏或内容引用，但所有逻辑层和原始记录位置均保留。

`01-real-rollout-sanitized.md` 是真实首轮上下文，不是模拟 API body。文件使用协议中立的 normalized envelope 展示顺序，因为 rollout 内部记录结构不等同于公开 Responses API 请求结构。

九层来源、developer/runtime 内容和可见性见 [context-layers](../context-layers/README.md)。
