# Claude Code Skill、计划与扩展工具

## `Skill`

Skill 工具按名字加载 skill/command 定义，把完整正文和参数展开成后续模型上下文。初始 skill listing 只提供目录；只有真正触发时才载入正文。这是 progressive disclosure，但大 skill 仍可能让请求 token 突增。

真实 Explore 日志显示载入一个大 skill 后，请求可达到 134,661 input tokens 加 18,944 cache-read tokens。CodeZ 应分别统计 skill catalog 与 loaded skill body，而不是只显示总 token。

## `DiscoverSkills` 与 `ToolSearch`

- `DiscoverSkillsTool` 负责搜索/发现可用 skill。
- `ToolSearchTool` 让延迟加载工具在需要时进入 catalog，避免一次性向模型发送所有 schema。

两者体现同一原则：目录轻量常驻，完整定义按需加载。

## 计划工具

- `EnterPlanMode` / `ExitPlanMode`：切换只读探索和计划提交协议。
- `VerifyPlanExecution`：把计划条目与实际修改/验证结果对齐。
- `BriefTool`：维护任务简报或 handoff。
- `EnterWorktree` / `ExitWorktree`：隔离实现工作区。

Plan 子 Agent 与 Plan mode 是两件事：前者是独立只读 Agent，后者是主会话状态。产品 UI 和 telemetry 不应把它们合并为一个计数。

## MCP 与 Web

`MCPTool`、资源列表/读取、认证工具把外部 server 能力动态加入 catalog；`WebFetch`、`WebSearch`、`WebBrowser` 分别覆盖抓取、搜索和交互浏览。它们的可用性受入口、网络策略、用户登录和 server 配置影响。

## 其他工具

AskUserQuestion、SendUserFile、ReviewArtifact、Config、LSP、NotebookEdit、Monitor、ScheduleCron 等都是独立能力，不应通过 Bash 模拟。专用工具的主要价值是结构化 schema、精确权限、可审计 UI 和可控结果大小，不只是调用更方便。
