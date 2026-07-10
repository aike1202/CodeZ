# CodeZ 跨平台权限系统设计

## 1. 目标

为 CodeZ 建立 Runtime 强制执行的统一权限系统，满足以下要求：

- 权限界面只保留“自动”和“完全访问”两档。
- 自动模式下，安全操作和工作区内普通创建、编辑、覆盖、构建、测试直接执行。
- 完全访问模式下，除极度危险操作外均直接执行。
- 极度危险操作在两种模式下都必须由用户明确批准。
- 同时支持 Windows、macOS 和 Linux。
- 能分析 Bash、PowerShell、Windows `cmd` 的组合语法和嵌套解释器，不能因字符串拼接绕过检查。
- 尽量降低安全命令被归为未知的比例，同时不把未知程序盲目判定为安全。
- 所有内置工具、MCP、插件和子 Agent 都经过同一个权限入口。

## 2. 非目标与安全边界

本设计不声称能够仅凭命令文本证明任意可执行程序没有副作用。未知二进制、被替换的脚本、运行时下载内容和动态生成代码都可能隐藏行为。

“覆盖所有命令和组合”的含义是：

1. 所有 shell 组合结构都必须被解析或显式标记为不透明结构。
2. 每个可见子命令、重定向、路径、网络目标和嵌套解释器都参与风险合并。
3. 无法证明的动态行为不能被静默当作安全命令。
4. 常见开发命令通过命令族策略、脚本展开和学习规则降低未知率。

第一阶段不实现操作系统级进程沙箱，但架构保留执行隔离接口，后续可增加 Windows Sandbox/AppContainer、macOS sandbox 和 Linux namespace/seccomp 等平台能力。

## 3. 竞品调研结论

### 3.1 Cline

Cline 的 Auto Approve 将命令分为安全命令和需要批准的命令，但官方文档说明该结论主要由模型提供的 `requires_approval` 标记决定。YOLO 模式会自动批准所有操作，包括破坏性命令。

可借鉴：

- 简洁的权限模式入口。
- 按工具类别展示自动批准能力。

不采用：

- 由发起命令的主模型自行决定命令是否安全。
- 完全关闭底层安全检查的 YOLO 行为。

资料：<https://github.com/cline/cline/blob/main/docs/features/auto-approve.mdx>

### 3.2 Hermes Agent

Hermes 使用跨平台危险模式、不可被 YOLO 绕过的 Hardline、辅助 LLM 智能审批、会话规则和永久规则。其规则覆盖根目录删除、块设备、关机重启、敏感配置、远程内容执行、编码执行和多种混淆形式。

可借鉴：

- 极危规则作为不可绕过的独立安全层。
- 对命令位置、包装命令、嵌套 shell、敏感路径和混淆形式建立绕过测试。
- 辅助审批器仅用于减少静态规则误报。
- 权限状态按会话隔离，避免并发审批错配。

需要调整：

- CodeZ 的 L4 默认行为是强制询问，而不是无条件禁止。
- 不以不断扩张的正则库作为主要解析器。

资料：<https://github.com/NousResearch/hermes-agent/blob/main/tools/approval.py>

### 3.3 MiMo Code

MiMo Code 使用 `allow`、`ask`、`deny` 规则体系，并在 shell 工具中通过 `web-tree-sitter` 加载 Bash 和 PowerShell WASM 语法。它遍历命令节点，检测外部目录、删除操作和危险 Git 子命令；删除操作使用独立的强制审批类型，不能被宽泛允许规则绕过。

可借鉴：

- WASM 语法树避免 Electron 原生模块的跨平台 ABI 问题。
- 从 AST 提取全部命令节点，而不是依赖字符串前缀。
- 外部目录和删除操作采用独立权限能力。
- 规则使用明确的优先级和可审计匹配结果。

需要增强：

- 增加 Windows `cmd` 组合语法。
- 扩展极危规则到系统、凭据、提权、远程执行和混淆执行。
- 增加命令族风险目录和未知命令辅助审批。

资料：

- <https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/bash.ts>
- <https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/skill/builtin/.bundle/mimocode/reference/permissions.md>

## 4. 权限模式

### 4.1 自动

面向日常开发的默认模式：

- L0 只读操作直接执行。
- L1 工作区内普通修改直接执行。
- L2 外部影响询问。
- L3 可恢复破坏询问。
- L4 极度危险强制询问。

### 4.2 完全访问

面向用户明确授权的低打扰模式：

- L0 至 L3 直接执行。
- 语法可解析、未命中 L4 的普通未知命令直接执行。
- L4 极度危险强制询问。
- 显式 `deny` 规则仍然生效。

### 4.3 保存范围

- 模式按工作区保存，不使用全局完全访问开关。
- 新工作区默认使用“自动”。
- UI 始终显示当前工作区模式。
- 切换到完全访问时明确提示“极度危险操作仍会被拦截”。

## 5. 风险等级

| 等级 | 含义 | 示例 | 自动 | 完全访问 |
| --- | --- | --- | --- | --- |
| L0 | 只读与状态查询 | `git status`、`git diff`、搜索、查看版本 | 直接执行 | 直接执行 |
| L1 | 工作区内普通修改 | Edit、Write、格式化、build、test、`git commit` | 直接执行 | 直接执行 |
| L2 | 外部影响 | 安装依赖、联网、`git push`、访问工作区外文件 | 询问 | 直接执行 |
| L3 | 可恢复破坏 | 删除构建目录、`git reset --hard`、`git clean`、停止普通容器 | 询问 | 直接执行 |
| L4 | 极度危险 | 系统删除、磁盘、提权、凭据、强推、隐藏执行 | 强制询问 | 强制询问 |

组合命令的最终等级取全部可达节点的最高等级。条件分支、循环和异常分支按所有可能分支合并，不根据模型声称的预期执行路径降低风险。

## 6. L4 极度危险定义

以下能力至少归为 L4：

### 6.1 不可恢复或大范围删除

- 递归删除文件系统根目录、系统目录或用户主目录。
- 删除当前工作区根目录或近似清空整个工作区。
- Windows 卷根目录、系统目录、用户配置目录的大范围删除。
- 通过 `find -delete`、`xargs rm`、PowerShell 管道等间接执行同等操作。

### 6.2 磁盘和设备

- `mkfs`、`fdisk`、`parted`、`diskpart clean`、格式化卷。
- `dd` 或重定向写入块设备、物理盘、卷设备。
- 修改引导记录、分区表或系统恢复区域。

### 6.3 提权和系统配置

- `sudo`、`su`、管理员提权或请求高完整性进程。
- 修改系统服务、启动项、账户、组、权限策略、防火墙或安全软件。
- 写入 `/etc`、macOS `/private/etc`、Windows 系统目录及等价路径。
- 修改 CodeZ 自身权限配置，使后续检查失效。

### 6.4 凭据和持久化

- 写入或批量读取 `.ssh`、`.aws`、`.npmrc`、`.pypirc`、`.netrc`、shell profile 等敏感位置。
- 读取凭据后通过网络发送。
- 安装登录项、计划任务、服务、注册表启动项或 shell 启动脚本。

### 6.5 隐藏或远程执行

- `curl | bash`、`wget | sh`、PowerShell 下载后执行。
- `Invoke-Expression`、`eval`、`source` 动态内容。
- PowerShell `-EncodedCommand`、Base64/十六进制解码后执行。
- 无法展开的 `bash -c`、`pwsh -Command`、`cmd /c`、解释器 `-e/-c` 动态代码。
- 本地脚本在分析后发生内容变化。

### 6.6 主机可用性和远端不可逆操作

- fork bomb、关机、重启、批量终止系统进程。
- `git push --force`、强制删除远端分支等不可轻易恢复的远端操作。
- 清空或删除无法确认环境属性的数据库。

## 7. 总体数据流

```text
Tool call
  -> PermissionManager
  -> PermissionContext snapshot
  -> Tool policy / Shell parser router
  -> Normalized operation graph
  -> Command family + Path impact + Critical guard
  -> Unknown fallback / Learned rules
  -> Highest-risk aggregation
  -> PermissionDecisionEngine
  -> allow / ask / deny
  -> pre-execution revalidation
  -> ToolExecutor
  -> PermissionAuditLog
```

权限检查必须发生在 AgentRunner 调用工具执行体之前。MCP、插件和子 Agent 只能通过统一 ToolRouter 进入执行路径，不能直接调用执行器绕过权限层。

## 8. 组件边界

### 8.1 PermissionManager

职责：

- 接收工具名、参数、工作区和会话上下文。
- 调用对应分析服务。
- 返回结构化 `PermissionDecision`。
- 创建可供 UI 展示的审批请求。

它不直接维护大段命令规则，也不解析具体 shell 语法。

### 8.2 PermissionContext

一次授权判断使用不可变上下文快照：

- `workspaceRoot`
- `cwd`
- `platform`
- `shellKind`
- `sessionId`
- `agentId`
- `toolName`
- 用户选择的工作区模式
- 分析时文件、脚本和配置摘要

### 8.3 ShellAnalysisService

使用以下 WASM 依赖：

- `web-tree-sitter`
- `tree-sitter-bash`
- `tree-sitter-powershell`

Electron 构建必须将三个 WASM 文件作为应用资源打包。解析器在主进程中惰性加载并缓存。

### 8.4 CmdCommandParser

Windows `cmd` 解析器至少支持：

- `&`
- `&&`
- `||`
- `|`
- `>`、`>>`、`<`
- 括号分组
- `call`
- `cmd /c` 与 `cmd /k`
- `^` 转义和双引号边界

CodeZ 当前没有独立 CmdTool，但 PowerShell、Bash 或脚本可以启动 `cmd.exe`，因此必须递归分析其内部命令字符串。

### 8.5 NestedCommandExpander

负责展开：

- `bash/sh/zsh -c`
- `powershell/pwsh -Command`
- `cmd /c`
- 工作区内 `.sh`、`.ps1`、`.cmd`、`.bat` 脚本
- `package.json` 中的 npm、pnpm、yarn、bun scripts
- 可静态定位的 Python、Node 等工作区脚本入口

展开设置最大深度和循环检测。超过深度、内容动态生成、文件不可读或解释器参数无法确定时，生成不透明执行节点并按 L4 处理。

### 8.6 NormalizedOperationGraph

所有 shell 解析器输出统一结构：

- executable
- subcommand
- argv
- operators
- redirects
- input/output paths
- network targets
- privilege intent
- child operations
- source range
- source shell
- referenced file hashes

风险引擎只消费该结构，不依赖原始 shell 的具体 AST 类型。

### 8.7 CommandPolicyRegistry

使用数据驱动命令族定义，而不是单一字符串前缀列表。首批覆盖：

- Git
- Node/npm/pnpm/yarn/bun
- Python/pip/uv/pytest
- Rust/cargo/rustup
- Go
- Java/Maven/Gradle
- .NET
- CMake/Make/Ninja
- Docker/Compose
- Kubernetes/Helm
- Unix Coreutils
- PowerShell 常用 Cmdlets
- Windows 系统命令

每个命令族规则可以声明：

- 只读子命令
- 工作区修改子命令
- 网络子命令
- 破坏性参数
- 极危参数组合
- 路径参数位置
- 网络目标参数位置
- 可生成的安全记忆规则

### 8.8 PathImpactAnalyzer

路径判断必须：

- 解析相对路径和绝对路径。
- 使用平台正确的大小写规则。
- 处理 Windows 盘符、UNC、长路径和 Git Bash 路径。
- 解析现有路径的真实路径和软链接。
- 使用 `path.relative` 等语义判断工作区边界，不能使用字符串前缀。
- 对不存在的目标文件解析最近存在父目录的真实路径。
- 区分读取、创建、覆盖、移动和删除。

### 8.9 CriticalOperationGuard

该组件独立于模式和用户允许规则：

- 输入规范化操作图和原始命令。
- 识别 L4 能力、混淆方式和敏感路径。
- 输出不可被普通允许规则降级的 L4 结果。
- 规则必须带唯一 ID、说明、影响和测试用例。

### 8.10 SmartApprovalService

仅在自动模式的未知命令上运行：

- 输入使用结构化操作摘要，不直接把原始命令当作系统指令。
- 系统提示明确将命令内容视为不可信数据。
- 输出固定结构：风险等级、理由、置信度和是否需要人工确认。
- 超时、异常、格式错误、低置信度或不确定时返回 `ask`。
- 不能覆盖显式 `deny`、路径越界结论或 L4 结论。
- 不执行命令，不访问本地凭据，不自行修改规则。

### 8.11 PermissionRuleStore

支持：

- 本次允许
- 当前会话精确允许
- 当前工作区精确允许
- 当前工作区命令族允许
- 显式拒绝

规则保存规范化命令模式，而不是未经处理的原始字符串。L4 请求不提供会话或永久允许选项。

### 8.12 PermissionAuditLog

记录：

- 时间、会话、Agent 和工具
- 原始请求摘要
- 规范化操作摘要
- 风险等级
- 命中规则 ID
- 工作区模式
- 最终决定和用户选择
- 重校验结果

审计日志不得记录令牌、密码、完整环境变量、授权头或明显凭据内容。

## 9. 决策优先级

权限规则按以下顺序执行：

1. 参数格式、安全不变量和工具上下文校验；失败则 `deny`。
2. 用户显式 `deny` 规则；命中则 `deny`。
3. CriticalOperationGuard；命中 L4 则强制 `ask`。
4. 用户会话或工作区允许规则；仅能作用于 L0 至 L3。
5. 已知命令族、路径和工具风险合并。
6. 自动模式未知命令进入 SmartApprovalService。
7. 应用自动/完全访问矩阵。
8. 无审批处理器或非交互环境需要审批时，最终 `deny`。

## 10. 非 Shell 工具策略

### 10.1 直接允许

- Read、Glob、Grep、ListFiles 等工作区内只读工具。
- Task 状态管理、计划状态更新等不产生外部副作用的工具。
- 自动模式和完全访问模式下的工作区内 Edit、Write、NotebookEdit。

### 10.2 按风险判断

- 工作区外读写：L2。
- 删除或回滚：根据范围为 L3 或 L4。
- WebSearch、WebFetch：L2；完全访问直接执行。
- PushNotification、打开外部程序：根据目标和内容至少 L2。
- MCP 和插件：根据声明的能力、实际参数和路径重新判断，不能只信任插件元数据。
- SubAgentRunner：创建本身可允许，但子 Agent 的每次实际工具调用必须重新授权。

## 11. 用户界面

### 11.1 模式菜单

删除“请求批准”，只显示：

- 自动：工作区内读取、编辑、构建与测试直接执行；联网、外部目录、删除及风险操作询问。
- 完全访问：除极度危险操作外全部自动执行；系统级、不可逆或隐藏执行仍需确认。

### 11.2 普通风险审批

L2/L3 审批卡展示：

- 命令或工具动作
- 风险原因
- 影响路径、网络或远端资源
- 拒绝
- 仅本次允许
- 本会话允许精确规则
- 当前工作区始终允许

### 11.3 极危审批

L4 审批卡使用明确的红色极危样式，展示：

- 完整可见命令
- 命中的 L4 规则
- 可能影响
- 拒绝
- 仅本次允许

L4 不展示“本会话允许”或“永久允许”。

## 12. 并发与审批生命周期

- 每个请求使用不可预测且唯一的 `requestId`。
- 审批以 `requestId + sessionId + agentId` 绑定。
- 并行 Agent 的请求相互隔离。
- UI 响应只能解决对应请求，不能使用“最近请求”推断。
- 请求超时、会话关闭、Agent 取消或应用退出时自动拒绝。
- 同一操作的批量批准只能用于 L2/L3，不能覆盖 L4。

## 13. TOCTOU 防护

在执行前重新校验：

- 被展开的脚本文件摘要。
- `package.json` scripts 摘要。
- 权限配置摘要。
- 目标路径的真实父路径和软链接状态。
- 当前工作目录。

任一关键摘要发生变化时，旧决定失效，重新执行完整分析。审批 UI 必须显示重新分析后的内容。

## 14. 错误处理

- Bash/PowerShell/cmd 解析失败：自动模式询问；完全访问在存在动态或隐藏执行可能时按 L4 询问。
- 辅助审批超时、异常或低置信度：自动模式询问。
- 路径无法规范化或软链接状态不稳定：写入和删除操作询问或拒绝，不能默认工作区内安全。
- 权限配置损坏：忽略损坏的允许规则，回退到工作区默认自动模式，并记录审计事件。
- WASM 加载失败：shell 命令不得静默绕过分析；自动模式询问，完全访问仍运行 CriticalOperationGuard 的保守文本检查。
- 无审批 UI、非交互任务或审批通道异常：需要审批的操作拒绝执行。

## 15. 测试策略

### 15.1 解析器单元测试

- Bash：管道、列表、条件、循环、子 shell、命令替换、进程替换、重定向、heredoc、函数。
- PowerShell：pipeline、pipeline chain、scriptblock、call operator、变量、重定向、`Invoke-Expression`、`Start-Process`。
- cmd：`&`、`&&`、`||`、管道、重定向、括号、`call`、转义和嵌套 `cmd /c`。
- 引号、空白、换行、Unicode、大小写和编码变形。

### 15.2 风险规则测试

- 每条命令族规则至少包含允许、升级和绕过用例。
- 每条 L4 规则至少包含直接、组合、包装、引用和混淆用例。
- 引入 Hermes 和 MiMo Code 的公开绕过测试语料。
- 对解析器和规则执行属性测试与模糊测试。

### 15.3 路径测试

- Windows 盘符、UNC、长路径、大小写和 Git Bash 路径。
- macOS `/private` 镜像路径。
- Linux/macOS 软链接和 `..` 路径。
- 不存在目标文件的父目录解析。
- 工作区同名前缀目录不能被误判为工作区内部。

### 15.4 决策矩阵测试

- L0/L1 在两种模式下直接执行。
- L2/L3 在自动模式询问、完全访问直接执行。
- L4 在两种模式下强制询问。
- L4 不能被会话规则、工作区规则或完全访问覆盖。
- 显式拒绝在两种模式下生效。

### 15.5 集成测试

- AgentRunner 所有工具调用都经过 PermissionManager。
- MCP、插件和子 Agent 不能绕过权限层。
- 并发审批不会错配。
- 审批取消、超时和应用退出安全失败。
- 脚本或路径在授权后变化时重新分析。

### 15.6 打包测试

- Windows 安装包成功加载 Bash/PowerShell WASM。
- macOS 应用成功加载 Bash/PowerShell WASM。
- Linux AppImage 成功加载 Bash/PowerShell WASM。
- 打包后的资源路径不依赖开发目录或 `node_modules` 布局。

## 16. 完成标准

- UI 只存在“自动”和“完全访问”两档。
- 自动模式下工作区内普通编辑、创建、构建和测试无需审批。
- 完全访问模式下 L0 至 L3 无需审批。
- L4 测试语料 100% 触发强制审批。
- 常用开发命令基准语料至少 95% 不落入未知分类。
- 所有组合命令按全部可达子节点的最高风险决策。
- 所有内置工具、MCP、插件和子 Agent 使用统一权限入口。
- Windows、macOS、Linux 打包产物均能加载语法解析资源。
- 审计日志能够解释每次允许、询问和拒绝的原因。

## 17. 当前代码迁移原则

当前工作区中的 `PermissionManager` 处于“所有工具均询问”的过渡状态，旧的 CommandAnalyzer 和 PermissionRuleStore 已在未提交改动中删除。本设计实施时：

- 不整体恢复旧字符串前缀分析器。
- 保留 AgentRunner 已形成的统一授权入口。
- 将 PermissionManager 收敛为门面，并新增独立权限子模块。
- 先建立解析、风险和决策测试，再连接 UI 和持久规则。
- 不修改与权限系统无关的现有未提交改动。

## 18. 设计自检

- 无待定项或占位符。
- 两档模式与风险矩阵一致。
- L4 在所有入口和规则优先级中均不可被静默绕过。
- 跨平台解析、路径、打包和编码要求均已覆盖。
- “减少未知命令”与“未知不盲目判安全”之间的边界明确。
- 范围聚焦于权限判断、审批、规则和审计，不包含操作系统沙箱实现。
