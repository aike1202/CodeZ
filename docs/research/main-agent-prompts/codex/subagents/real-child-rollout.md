# Codex 真实子线程 Rollout 证据

证据等级：A，本机真实 rollout，已脱敏概述。

样本：

```text
C:\Users\asus\.codex\sessions\2026\07\17\
rollout-2026-07-17T14-36-19-019f6eca-384b-7c21-991c-31cd664493c7.jsonl
```

## `session_meta` 关键字段

```json
{
  "thread_source": "subagent",
  "forked_from_id": "[PARENT_THREAD]",
  "parent_thread_id": "[PARENT_THREAD]",
  "source": {
    "subagent": {
      "thread_spawn": {
        "depth": 1,
        "agent_path": "/root/frontend_lint",
        "agent_nickname": "Turing",
        "agent_role": null
      }
    }
  },
  "cli_version": "0.145.0-alpha.18"
}
```

## Prompt 观察

子线程保存了完整 `base_instructions`，与父会话使用相同的通用 Codex 基座。子角色差异主要由额外 developer 层、spawn brief、工具目录和 runtime metadata 形成，而不是替换整个基础人格。

该样本的 `agent_role` 为 `null`，不能称为真实 `explorer` 或 `worker` profile。它只能证明“命名任务子线程”的完整运行方式。

## 上下文与工具

子线程有自己的 assistant/tool/result 序列、token 累计和命令输出。文件系统与父线程共享，因此并行编辑会直接冲突。真实记录也显示子线程可以调用统一 `exec` 工具，再由 `exec` 编排 `exec_command`、`apply_patch` 等底层操作。

## 结论

Codex 的子 Agent 是完整的独立 rollout，不是父 Agent 内部的一次普通函数调用。主上下文只应接收最终摘要和关键证据；直接拼回完整子 rollout 会失去这种隔离的主要价值。
