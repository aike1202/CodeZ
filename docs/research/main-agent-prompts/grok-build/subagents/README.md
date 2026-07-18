# Grok Build 子智能体提示词

## 结论

Grok Build 的子智能体不是把主 Agent system prompt 原样复制一份。当前真实派发路径至少包含以下层：

```text
system:
  subagent_prompt.md 共享模板
  + built-in/custom AgentDefinition.prompt_body
  + 可选 role_instructions（渲染进 <role-instructions>）

conversation items:
  可选 persona instructions（独立 <system-reminder>）
  + AGENTS.md user reminder
  + 子任务 user prompt

request side channel:
  最终工具 descriptions 与 JSON Schema
```

共享模板负责工具调用、项目规则、环境和输出格式；`general-purpose`、`explore`、`plan` 的内置正文来自各自 `AgentDefinition.prompt_body`，在共享模板渲染完成后用两个换行追加。自定义 role 的 `role_prompt` 才进入 `<role-instructions>`。当前子会话创建调用把 `persona_instructions` 参数传为 `None`，实际 persona 正文由 `handle_request.rs` 插入独立 `<system-reminder>`。工具名使用 `${{ tools.by_kind.* }}` 延迟绑定，因此同一模板可以适配工具改名和不同 toolset。

## 文件

- `shared-system-prompt.md`：共享子智能体 system 模板源码全文及装配顺序。
- `main-agent-task-tool.md`：主 Agent 看到的动态 `task` 工具描述和完整输入契约。
- `general-purpose.md`：通用子智能体的源码正文，以及固定参数下直接可读的完整展开 system prompt。
- `explore.md`：只读 Explore 的源码正文，以及固定参数下直接可读的完整展开 system prompt。
- `plan.md`：只读规划 Agent 的源码正文，以及固定参数下直接可读的完整展开 system prompt。

README 不再把模板片段称为“完整提示词”。三个 Agent 文件均直接保存完整展开正文，不要求读者通过链接自行拼接。

## 内置类型

| 类型 | 目的 | 默认工具面 | 是否可写 |
|---|---|---|---:|
| `general-purpose` | 多步任务、跨文件研究和实现 | 全部工具 | 是，取决于 capability |
| `explore` | 快速代码库定位 | Read、List、Search | 否 |
| `plan` | 探索后生成实施计划 | Read、List、Search、Web、Plan | 否 |

用户定义 Agent 可以进入同一个动态目录。`capability_mode`、Agent 定义自身工具集和父会话允许的工具会共同决定最终能力，不能只看表中的 built-in 描述。

## 运行时边界

- `MAX_SUBAGENT_DEPTH = 1`：根会话是 0，子会话是 1，子会话不能继续派发。
- `run_in_background` 默认 `true`，返回 `subagent_id` 后由 `get_task_output` 获取结果。
- `resume_from` 只接受同一父 session、已完成且同类型的子智能体；恢复原 transcript、tool state 和模型，但重新渲染 system prompt/tool config。
- `cwd` 与 `isolation="worktree"` 互斥。
- 明确传 `model` 只应出现在用户直接要求时；恢复时忽略 model override。
- `task` 工具描述仍告知父 Agent“子智能体收到压缩版项目说明”，但当前 `PromptContext::agents_md_user_reminder()` 实现和测试会把完整 AGENTS.md block 同样交给主、子会话。这是模型提示与执行实现的版本漂移；为了跨版本可靠，关键构建或测试规则仍应复制进委派 brief。

源码版本：`8adf9013a0929e5c7f1d4e849492d2387837a28d`。
