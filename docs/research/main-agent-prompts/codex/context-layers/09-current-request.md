# 09 当前用户请求与首条 Prefix

## 选定真实请求

```json
{ "role": "user", "content": "了解这个项目" }
```

在它之前，Codex 已注入 developer layers 和一条独立 `environment_context` user message。因此模型看到的不是孤立五个汉字。

## Codex 的 Prefix 形式

Codex 没有把所有内容包成 Grok `<user_query>` 的固定单字符串。近似顺序是：

```text
developer permissions/app/skills/plugins
developer collaboration policies
user environment_context
world/turn state
user actual request
```

当前请求仍必须单独保存，不能把 environment context 与用户原话合并后称为 raw user input。

## 最新消息规则

用户在执行期间追加的新消息可能替换、扩展或询问状态。主 Agent应以最新消息判断 intent，同时保留前序未完成要求；steering event 和接收时间应进入日志。
