# Grok Build 计划、Todo 与其他工具

## Plan mode

`enter_plan_mode` 返回 plan file 路径和动态工具名提示，默认路径是 session `PlanFilePath`，缺省时为 cwd 下 `.grok/plan.md`。Agent 在只读计划流程中把计划写入该文件。

`exit_plan_mode` 没有 plan content 输入。它从磁盘读取准确的 plan file，发送 `PlanModeExited` notification，并把同一内容返回模型。这样审批 UI 看到的内容与实际文件一致，避免“聊天里的计划”和“磁盘计划”分叉。实际 yes/no、反馈、context clear 和 mode transition 由客户端负责。

## Todo 与 Goal

- `todo` 保存或替换 session 任务清单，用于当前 run 的执行进度。
- `update_goal` 管理更持久的目标状态和预算语义。

它们与 `task` 子智能体是不同控制面：Todo/Goal 不应按条目自动创建同数量子 Agent。

## AskUserQuestion

提供结构化 question/options，而不是让模型用自由文本模拟 UI。是否阻塞和答案注入由 host 处理。

## LSP

用于诊断、符号、引用或其他语言服务器能力。专用 LSP 能避免通过 shell 猜测编译器输出，并提供结构化路径和范围。

## Monitor/Scheduler

Monitor 用于持续事件或命令输出流，Scheduler 用于延迟或计划动作。长命令用 Bash background；流式观察用 Monitor，避免 shell 中的 sleep/poll loop。

## Web 与媒体

`web_fetch`、`web_search`、`image_gen`、`image_edit`、`video_gen` 都是独立 capability。可用性取决于 host、网络和模型，子 Agent 的 capability mode/toolset 可能将它们移除。

## 工具依赖图

工具注册使用 `requires_expr()`：例如启用 background Bash 时必须同时存在 background-task action 和 kill action；Task 也要求查询与取消工具；ExitPlan 依赖 EnterPlan。CodeZ 可借鉴这种“能力依赖在注册期校验”的设计，避免模型看到无法闭环的半套工具。
