# 层级多智能体编排：人工测试与人工介入记录

> 创建日期：2026-07-19
> 对应设计：`2026-07-18-hierarchical-multi-agent-orchestration-feasibility-report.md`
> 用途：只记录无法通过确定性自动测试充分证明的真实场景，以及重复尝试后仍需人工介入的问题。

## 记录规则

- 能用 Fake Provider、虚拟时钟、临时 Git 仓库或故障注入稳定验证的行为，写自动测试，不放入本清单。
- 依赖真实 Provider 账户、真实限流、操作系统窗口交互、视觉流畅度或跨进程崩溃时机的场景，放入人工测试。
- 同一问题连续多次尝试仍无法解决时，在“人工介入问题”中记录尝试、证据、当前影响和建议恢复入口。
- 每项人工测试保留明确前置条件、操作、预期、证据和结果，不能只写“看起来正常”。

## 人工测试清单

### MT-01：真实 Provider 限流与重试风暴

- 前置条件：配置一个会返回真实 429/限流响应的 Provider 账户，并允许同时运行至少三个只读分身。
- 操作：同一 root 批量创建三个 Agent，让它们同时进入 Provider 请求；在服务端或账户侧触发限流，持续 3 至 5 分钟。
- 预期：Provider 级并发限制生效；退避不会形成同步重试风暴；其他 Provider 队列不被阻塞；预算和最终错误归属到正确 Agent。
- 证据：三个 Agent 的事件页、Provider 请求时间线、最终 usage/error code 截图与日志。
- 结果：待人工执行。

### MT-02：Provider/工具执行中的硬进程终止

- 前置条件：一个正在流式输出的子 Agent，以及一个拥有长时间 Shell 进程的隔离写 Agent。
- 操作：分别在 Provider stream 中途和工具进程运行中强制结束 CodeZ 进程，再重新启动应用。
- 预期：旧 attempt 收敛为 `interrupted`；危险外部 effect 不自动重放；残留进程被识别或终止；历史日志仍可分页查看。
- 证据：重启前后 attempt/state revision、进程列表、控制 ledger 和 UI 详情截图。
- 结果：待人工执行。

### MT-03：Worktree/集成阶段崩溃恢复

- 前置条件：可写子 Agent 已产生 patch；主工作区保持干净。
- 操作：分别在 worktree 创建后、临时三方合并中、manifest 标为 `integrating` 后以及主工作区 apply 后强制结束进程。
- 预期：patch 与 manifest 保留；`integrating` 状态不盲目重放并明确要求检查；合并冲突只留在临时 worktree；主工作区不会出现未报告的半应用结果。
- 证据：`agent-workspaces` 下的 lease/artifact、`git status`、重启后的错误码和 UI 状态。
- 结果：待人工执行。

### MT-04：多层 Agent 详情快速切换

- 前置条件：深度 2 的 Agent 树，至少三个 Agent 同时流式输出和调用工具。
- 操作：在主日志 marker、全部分身列表和不同详情页之间持续快速切换；折叠/打开右侧面板；切换会话后再返回。
- 预期：文本、reasoning、工具和结果不串流；事件按 attempt sequence 去重；旧 state revision 不覆盖新状态；Agent 不因页面切换而停止。
- 证据：屏幕录像、各 Agent 最终 ledger 与页面内容对照。
- 结果：待人工执行。

### MT-05：流式执行中向子 Agent 发消息

- 前置条件：子 Agent 正在进行多个 Provider/tool 回合。
- 操作：从详情页连续发送两条补充信息，其中一条在 Provider 正在流式输出时发送。
- 预期：当前请求不被篡改；消息在下一个安全点按 sequence 投影；只消费一次；等待消息状态会重新入队。
- 证据：邮箱 JSONL、attempt cursor、详情事件时间线和模型后续回答。
- 结果：待人工执行。

### MT-06：并发 Agent 权限请求

- 前置条件：至少两个 Agent 同时触发真实权限确认。
- 操作：交错批准、拒绝和关闭请求，确认来源 Agent、task 和 workspace 信息。
- 预期：批准不会授予兄弟 Agent；拒绝只影响对应 tool call；停止 Agent 后待处理请求收敛；弹窗来源清晰。
- 证据：权限 UI 截图、audit log 和各 Agent 终态。
- 结果：待人工执行。

### MT-07：长日志与 renderer 内存

- 前置条件：持续运行 1 小时以上、产生大量 delta/tool 事件的 Agent。
- 操作：持续观察全部分身列表与详情页，反复加载历史，每隔 10 分钟记录 renderer 内存和交互延迟。
- 预期：详情缓存保持有界；历史按页读取；列表滚动和输入无明显掉帧；关闭面板不影响后台执行。
- 证据：任务管理器内存曲线、性能录制和最终事件数量。
- 结果：待人工执行。

### MT-08：桌面视觉与窄宽布局

- 前置条件：运行真实 Tauri 桌面应用，准备空列表、运行中、已完成、失败、深度 2 和长标题数据。
- 操作：将右侧面板拖到最小/最大宽度，检查明暗主题、标签溢出、列表、事件轨迹、输入区和主日志 marker。
- 预期：文本不重叠或越界；按钮图标和 tooltip 清晰；状态颜色可区分但不依赖颜色单独表达；键盘焦点可见。
- 证据：两种主题、至少三种面板宽度的截图。
- 结果：待人工执行。当前纯浏览器视觉检查未完成，原因见 HI-01。

### MT-09：Windows junction/reparse point 工作区越界

- 前置条件：真实 Windows NTFS 工作区；准备一个 scope 内目录、一个 scope 外目录，并具备创建目录 junction 或其他 reparse point 的权限。
- 操作：分别创建“scope 内 junction 指向 scope 外”和“scope 外 junction 指向 scope 内”的路径；通过真实 Agent 的 Read、Grep、Edit 和文件产物流程访问这些路径，并覆盖路径大小写变化。
- 预期：规范化后的目标只要越出授权 scope 就被拒绝；合法目标不被误拒；拒绝不会产生文件改动或泄露 scope 外内容。Shell 命令自身的内部读取不属于本项可证明范围，见 HI-03。
- 证据：junction/reparse point 信息、Agent 工具请求与结构化拒绝、目标目录前后哈希和 UI 错误记录。
- 结果：待人工执行。Unix symlink 和平台大小写语义已有确定性自动测试，Windows reparse point 仍需真实 NTFS 验证。

## 人工介入问题

### HI-01：内置浏览器测试宿主受用户目录 ESM 配置影响

- 状态：环境限制，不是已确认的产品缺陷。
- 现象：浏览器控制内核位于用户临时目录，继承 `C:\Users\asus\package.json` 的 `"type": "module"`，其 CommonJS 启动脚本因 `require is not defined in ES module scope` 在页面加载前退出。
- 已完成：renderer typecheck 通过；Vite renderer 使用 `http://localhost:27183/`；没有改动或移除用户目录配置。
- 影响：本轮无法用内置浏览器生成可信的视觉截图或执行点击检查，MT-08 需在真实 Tauri 窗口人工完成。
- 恢复入口：修复浏览器测试宿主对父目录 `package.json` 的继承方式，或在不修改用户配置的隔离目录启动控制内核后，重新执行 MT-08。

### HI-02：Provider 成本没有权威上游数据源

- 状态：需要产品/Provider 接入层设计，不应由运行时猜测价格。
- 现象：`ProviderTokenUsage` 只提供 input/output/reasoning/total token，当前 Provider 与模型配置也没有带币种、价格版本或请求实际成本；因此 `providerCostMicros` 只能保持 `0`。
- 已完成：成本预算、持久化、前后端契约和详情页展示通路已经接通；多轮审计确认现有响应中没有可权威换算的价格来源，没有写死易过期价格表。
- 影响：UI 可展示该维度，但在接入成本数据前始终为 `$0`，Provider 成本预算不能作为真实硬限制，token、工具、命令和墙钟预算不受影响。
- 恢复入口：优先接入 Provider 返回的实际计费字段；若只能本地估算，需要新增带币种和版本的模型价格目录，并明确缓存 token、reasoning token、批处理等计价规则后再写入 `providerCostMicros`。

### HI-03：Shell 命令内部文件读取缺少可观测性

- 状态：底层进程遥测限制，不适合通过解析命令字符串补数。
- 现象：运行时能权威统计 Read、Grep、Glob 等工具返回的 `ReadFile` effect，也能统计 Shell 命令墙钟时间；但 PowerShell/Bash/cargo/node 等进程在命令内部读取了哪些文件，当前进程接口不会上报。
- 已完成：工具层读取按成功 effect 计数；Shell 的累计 `elapsedMs` 已按 `taskId` 转为增量，避免 wait 轮询重复扣费。没有用正则猜测命令或用测试脚本伪造文件访问清单。
- 影响：`filesRead` 是“可观测工具读取数”，不是操作系统级文件打开次数；大量通过 Shell 完成的读取会被低估，写入隔离和 scope 权限仍由既有工作区/权限边界负责。
- 恢复入口：若产品需要 OS 级精确计数，应为受管进程增加平台文件访问审计或沙箱遥测；否则应在契约/UI 中把该指标正式命名为 tool-observed file reads。

## 自动验证边界

以下能力必须优先由自动测试证明，不得因并发场景复杂而降级为人工测试：

- spawn 幂等、状态 CAS、终态竞争和事件 revision 单调性。
- 调度并发上限、公平性、等待释放 Provider permit 和 missed wakeup 防线。
- 邮箱持久化、cursor 重放、ack 幂等、ACL 和大消息 artifact 投影。
- scope/permission 交集、最大深度、fan-out、root 总量和预算预留。
- stale writer 冲突、worktree fail-closed、固定基线和 merge 冲突不污染主工作区。
- 崩溃恢复状态判定、危险外部 effect 不盲目重放和残留进程归属。
- UI 事件按 `agent_id + attempt_id + sequence` 路由、去重以及旧 revision 丢弃。
