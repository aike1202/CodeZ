# 01 基础 System Prompt

## 内容

完整源码驱动快照见 [main-agent-prompt.md](../main-agent-prompt.md)，装配函数和顺序见 [assembly-map.md](../assembly-map.md)。默认 `getSystemPrompt()` 不是单个字符串，而是由 intro、任务行为、工具使用、语气、输出效率和动态 session sections 组成的 `string[]`。

## 选择优先级

```text
overrideSystemPrompt
-> coordinator prompt
-> main-thread custom agent prompt
-> --system-prompt
-> default getSystemPrompt()
-> optional --append-system-prompt
```

`overrideSystemPrompt` 替换全部其他内容；coordinator/custom/proactive/simple 等模式会改变基座，不能把默认快照当作所有 Claude Code 请求的固定 system。

## 缓存边界

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 是客户端缓存标记，发送前不作为普通文本保留。它把稳定前缀与 session guidance、memory、环境、语言、MCP 等动态后缀分开，降低每轮变化对 prompt cache 的影响。

## 证据限制

选定 2.1.197 transcript 没有 system 原文。此层证据为恢复源码 B，加上首轮 48,257 input tokens 对隐藏输入规模的旁证 C；不能声称与 2.1.197 字节级一致。
