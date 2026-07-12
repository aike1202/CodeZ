# Claude Code 上下文管理源码调研报告

> 调研日期：2026-07-12
> 源码目录：`F:\MyProjectF\Claude-Code`
> 源码提交：`b78dd22a091b717c8938ab98c736bc04825a8ee8`
> 包版本：`999.0.0-restored`

## 1. 结论摘要

Claude Code 的上下文管理不是“上下文到几十 K 就压缩”，而是分层处理：

1. 每次请求只投影最后一个 compact boundary 之后的消息。
2. 对完全相同且文件未变化的 Read 范围做去重，返回短 stub，而不是再次返回文件全文。
3. Read 自身限制单次读取规模；其他超大工具结果可落盘并只把预览送入模型。
4. 部分构建还会通过 microcompact、API context editing、session memory 等机制回收旧工具结果。
5. 传统 auto-compact 默认在非常接近模型上下文上限时才触发。
6. 完整压缩不是只生成一段摘要；它还重注入最近文件、已调用技能、计划、计划模式、异步 Agent 状态、动态工具定义和 SessionStart hook 结果。
7. 完整 transcript 继续保存在 JSONL 中，模型视图和 UI/磁盘历史是分离的。

对于 1M 上下文，传统 auto-compact 的触发点通常约为 `967K-979K`，取决于是否启用了 8K 输出槽位上限。因而“先持续增长到几百 K，再接近上限压缩”符合 Claude Code 主线设计。

## 2. 调研边界与可信度

该仓库不是 Anthropic 的原始开发仓库，而是从 source maps 恢复的源码树：

- `package.json` 明确标记版本为 `999.0.0-restored`。
- `AGENTS.md` 要求将其视为 reconstructed source tree。
- `src/services/contextCollapse/` 是空实现。
- `src/services/compact/reactiveCompact.ts` 是空实现。
- `microCompact.ts` 动态引用的 `cachedMicrocompact.js` 没有对应恢复源码。

因此，本报告将结论分为三类：

- **可验证主线**：源码完整、默认配置明确。
- **灰度/内部路径**：受 `feature()`、`USER_TYPE` 或 GrowthBook 开关控制。
- **不可完整审计路径**：接口存在，但恢复源码为空或缺失。

不能仅凭函数名推断所有 Claude Code 外部版本都启用了内部实验功能。

## 3. 请求前上下文处理管线

模型请求前的核心顺序位于 `src/query.ts`：

```text
完整 REPL / transcript 历史
        |
        v
取最后 compact boundary 之后的消息
        |
        v
单轮工具结果预算与磁盘预览替换（灰度）
        |
        v
History Snip（编译开关）
        |
        v
Microcompact（时间/缓存编辑，按构建与开关决定）
        |
        v
Context Collapse（恢复源码为空，不可审计）
        |
        v
Auto-compact 阈值判断
        |
        v
规范化消息并调用模型
```

源码证据：

- `getMessagesAfterCompactBoundary()`：`F:\MyProjectF\Claude-Code\src\query.ts:365`
- 单轮工具结果预算先于 microcompact：`F:\MyProjectF\Claude-Code\src\query.ts:369`
- microcompact 先于 auto-compact：`F:\MyProjectF\Claude-Code\src\query.ts:412`
- auto-compact 调用：`F:\MyProjectF\Claude-Code\src\query.ts:454`
- boundary 投影实现：`F:\MyProjectF\Claude-Code\src\utils\messages.ts:4643`

关键设计是：**磁盘 transcript 保留完整历史，模型请求只使用投影视图**。压缩不会要求把原始 JSONL 物理删除。

## 4. Token 计量模型

### 4.1 Provider usage 是主基准

Claude Code 不把每一轮 API input token 累加，因为那会重复计算历史。阈值判断使用：

```text
最后一次真实 API 响应的：
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
+ output_tokens
+ 最后响应之后新增消息的估算值
```

实现位于：

- `getTokenCountFromUsage()`：`F:\MyProjectF\Claude-Code\src\utils\tokens.ts:46`
- `tokenCountWithEstimation()`：`F:\MyProjectF\Claude-Code\src\utils\tokens.ts:226`

它还处理并行工具调用导致的 assistant message 分片：同一个 API response 的多个 assistant 记录共享 message ID，计量时回退到最早的同 ID 分片，避免漏算中间插入的 tool results。

### 4.2 `/context` 的数据口径

`/context` 先应用 compact boundary 和 microcompact 投影，再按 system prompt、memory、tools、skills、messages 等类别统计；总数优先使用最近一次 Provider usage，而不是类别估算值。

证据：

- `/context` 复用模型请求投影：`F:\MyProjectF\Claude-Code\src\commands\context\context-noninteractive.ts:17`
- Provider usage 覆盖估算总数：`F:\MyProjectF\Claude-Code\src\utils\analyzeContext.ts:1161`

这避免了 UI 显示值与真正发送给 Provider 的 token 数长期漂移。

## 5. Auto-compact 阈值

### 5.1 公式

源码使用以下公式：

```text
summaryReserve = min(modelMaxOutputTokens, 20_000)
effectiveWindow = contextWindow - summaryReserve
autoCompactThreshold = effectiveWindow - 13_000
```

证据：

- 摘要输出最多预留 20K：`F:\MyProjectF\Claude-Code\src\services\compact\autoCompact.ts:28`
- 有效窗口计算：`F:\MyProjectF\Claude-Code\src\services\compact\autoCompact.ts:33`
- auto-compact 再保留 13K：`F:\MyProjectF\Claude-Code\src\services\compact\autoCompact.ts:62`
- 默认启用 auto-compact：`F:\MyProjectF\Claude-Code\src\utils\config.ts:594`

### 5.2 典型阈值

| 上下文窗口 | 输出槽位策略 | 有效窗口 | Auto-compact 阈值 |
|---:|---:|---:|---:|
| 200K | 默认输出 32K，摘要预留封顶 20K | 180K | 167K |
| 200K | 灰度 8K 输出槽位上限 | 192K | 179K |
| 1M | 默认输出 32K，摘要预留封顶 20K | 980K | 967K |
| 1M | 灰度 8K 输出槽位上限 | 992K | 979K |

1M 窗口识别逻辑位于 `F:\MyProjectF\Claude-Code\src\utils\context.ts:51`。它支持：

- 模型名 `[1m]` 显式后缀。
- model capability 声明的 `max_input_tokens`。
- `context-1m-2025-08-07` beta header。
- Sonnet 1M 实验配置。

因此，对 1M 模型而言，60K、100K 或 300K 都不应触发传统完整 auto-compact。它们只可能触发更轻量的工具结果回收或灰度策略。

### 5.3 失败保护

Auto-compact 连续失败三次后会熔断，避免 prompt-too-long 场景持续发起无效压缩请求：

- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`
- 位置：`F:\MyProjectF\Claude-Code\src\services\compact\autoCompact.ts:70`

## 6. Read 文件管理

### 6.1 单次读取边界

默认 Read 边界：

- 工具提示要求模型默认最多读取 2,000 行，但执行层在未传 `limit` 时并不强制这个行数上限。
- 文件总大小默认上限 256 KB。
- 单次输出默认最多 25K tokens。
- 超限时返回错误，要求使用 `offset` / `limit` 或先搜索。

证据：

- 2,000 行提示：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\prompt.ts:10`
- 读取限制：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\limits.ts:1`
- Read 自身声明 `maxResultSizeChars: Infinity`，因为它用 token 限额自约束：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:342`

### 6.2 精确范围去重

Claude Code 会记录每个文件最近一次 Read 的：

- 规范化绝对路径
- 文件 mtime
- offset
- limit
- 内容

如果下一次 Read 满足以下全部条件，就返回短 stub：

1. 同一路径。
2. 完全相同的 offset 和 limit。
3. 文件 mtime 未变化。
4. 上一次记录确实来自 Read，而不是 Edit/Write。
5. 不是 partial view。

stub 内容是：

```text
File unchanged since last read. The content from the earlier Read tool_result
in this conversation is still current - refer to that instead of re-reading.
```

证据：

- 去重判断：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\FileReadTool.ts:523`
- stub 常量：`F:\MyProjectF\Claude-Code\src\tools\FileReadTool\prompt.ts:7`

源码注释披露，同文件碰撞约占 Read 调用的 18%。该优化重点减少重复 prompt cache creation，而不仅是减少磁盘 I/O。第三方构建默认开启该去重，但 GrowthBook 的 `tengu_read_dedup_killswitch` 可以关闭它。

### 6.3 去重能力的边界

`readFileState` 是“每个路径一个最新状态”，不是多区间索引。因此：

- `A 范围 -> A 范围`：可以去重。
- `A 范围 -> B 范围 -> A 范围`：通常不能去重，因为 B 覆盖了该路径的最新记录。
- `整文件 -> 局部范围 -> 整文件`：通常会再次返回整文件。
- 文件 mtime 变化：必须重新读取。
- Edit/Write 后状态的 offset 为 undefined，避免错误引用编辑前内容。

所以 Claude Code 也不保证“同一文件整个会话只读一次”；它保证的是“同一版本、同一精确范围的连续重复读取不再次塞入全文”。

## 7. 工具结果分层回收

### 7.1 单个大工具结果落盘

除 Read 外，工具结果默认超过 50K chars 时可写入 session 的 `tool-results` 目录，模型只收到：

- 文件路径
- 原始大小
- 前 2,000 bytes 预览

关键常量：

- 单工具默认阈值 50K chars。
- 理论最大单工具结果 100K tokens，约 400 KB。
- 预览 2,000 bytes。

证据：

- `F:\MyProjectF\Claude-Code\src\constants\toolLimits.ts:13`
- `F:\MyProjectF\Claude-Code\src\utils\toolResultStorage.ts:108`
- 落盘实现：`F:\MyProjectF\Claude-Code\src\utils\toolResultStorage.ts:137`

Read 不参与该落盘机制，因为“把 Read 输出保存到文件，再让模型用 Read 读取”会形成循环；Read 依靠自身 25K token 限额。

### 7.2 单轮并行工具结果总预算

源码还设计了单个 API user message 内工具结果总量的 200K chars 上限。超过后优先把最大的 fresh tool results 落盘，直到回到预算内。

该路径具备两个重要特征：

- 决策按 tool_use_id 冻结，后续轮次重放完全相同的 preview，保持 prompt cache 前缀稳定。
- replacement 决策写入 transcript，resume 时重建。

但是该功能由 `tengu_hawthorn_steeple` 控制，源码默认值为 false，不能认定所有外部版本都启用：

- gate：`F:\MyProjectF\Claude-Code\src\utils\toolResultStorage.ts:447`
- 200K 默认值：`F:\MyProjectF\Claude-Code\src\constants\toolLimits.ts:49`
- 执行逻辑：`F:\MyProjectF\Claude-Code\src\utils\toolResultStorage.ts:769`

### 7.3 Microcompact

`microCompact.ts` 将以下工具视为可清理结果：Read、Shell、Grep、Glob、WebSearch、WebFetch、Edit、Write。

可见路径包括：

- 时间型：长时间空闲后，清除旧工具结果，仅保留最近 N 个；默认配置是关闭、60 分钟、保留 5 个。
- Cached microcompact：通过 server cache editing 删除旧 tool result，不直接修改本地消息。
- API context editing：默认示例为 180K 触发、目标保留 40K，但工具结果清理分支受 `USER_TYPE === 'ant'` 和环境开关控制。

证据：

- compactable tools：`F:\MyProjectF\Claude-Code\src\services\compact\microCompact.ts:40`
- 外部构建无 cached MC 时退回 auto-compact：`F:\MyProjectF\Claude-Code\src\services\compact\microCompact.ts:288`
- 时间型默认关闭：`F:\MyProjectF\Claude-Code\src\services\compact\timeBasedMCConfig.ts:31`
- API context editing 的 180K/40K：`F:\MyProjectF\Claude-Code\src\services\compact\apiMicrocompact.ts:14`

恢复源码缺少 `cachedMicrocompact` 实现，因此只能确认它的接入和状态协议，不能完整审计删除选择算法。

### 7.4 潜在一致性风险

Read dedup stub 假设“早期完整 Read tool result 仍在模型上下文中”。而 microcompact 可能清除旧 Read 结果。完整 compact 专门识别 dedup stub，并重新注入真实文件内容；但时间型/cached microcompact 与 `readFileState` 的同步在恢复源码中没有完整可见实现。

因此需要注意：

- 完整 compact 路径对此有明确补偿。
- 时间型 microcompact 默认关闭，风险不影响默认配置。
- cached microcompact 的关键模块缺失，不能确认是否另有补偿。

## 8. 完整 Compaction

### 8.1 Summary 不是自由发挥

传统 compact 使用专门模型调用，强制禁止工具调用，并要求摘要覆盖：

- 用户的主要请求和意图
- 技术概念
- 已读取、修改、创建的文件与代码片段
- 错误和修复
- 问题解决过程
- 全部非工具用户消息
- 待办任务
- 当前工作
- 与最近工作直接相关的下一步

位置：`F:\MyProjectF\Claude-Code\src\services\compact\prompt.ts:61`。

如果 compact 请求本身 prompt-too-long，会按完整 API round 从最旧头部开始截断并重试，而不是直接放弃：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:462`。

### 8.2 压缩后消息顺序

压缩后模型视图按固定顺序重建：

```text
compact boundary
summary messages
保留的最近消息（可选路径）
attachments
SessionStart hook results
```

实现：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:330`。

后续每次请求从最后一个 compact boundary 开始切片，早期 transcript 仍留在磁盘和 UI scrollback 中。

### 8.3 压缩后显式恢复的状态

传统 compact 不仅保存摘要，还显式恢复：

| 状态 | 恢复策略 |
|---|---|
| 最近读取文件 | 最多 5 个；每文件最多 5K tokens；总预算 50K |
| 已调用技能 | 每技能最多 5K；总预算 25K；最近调用优先 |
| 当前计划 | 注入 plan file reference |
| Plan mode | 重注入完整模式提醒 |
| 异步 Agent | 注入运行中或未领取结果的状态 |
| Deferred tools | 重注入压缩前已发现工具集合 |
| MCP instructions | 重新计算并注入 delta |
| CLAUDE.md / hooks | 执行 `SessionStart(compact)` |

证据：

- 文件与技能预算：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:122`
- 文件恢复：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:1415`
- 技能恢复：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:1488`
- 状态装配：`F:\MyProjectF\Claude-Code\src\services\compact\compact.ts:517`

最近文件恢复是避免 compact 后立即重复 Read 的核心。它会读取最新磁盘版本，而不是盲目复制旧 tool result。

## 9. 技能与 Resume 的持久性

Claude Code 维护独立的 `invokedSkills` Map，键包含 agentId 和 skillName，值包含路径、正文和调用时间：

- 状态定义：`F:\MyProjectF\Claude-Code\src\bootstrap\state.ts:178`
- 添加：`F:\MyProjectF\Claude-Code\src\bootstrap\state.ts:1510`
- 查询：`F:\MyProjectF\Claude-Code\src\bootstrap\state.ts:1526`

Post-compact cleanup 刻意不清除 invoked skills，以便多次压缩后继续注入：

- `F:\MyProjectF\Claude-Code\src\services\compact\postCompactCleanup.ts:17`

恢复会话时，又会从 `invoked_skills` attachment 重建进程内 Map，防止 resume 后再次 compact 时丢失：

- `F:\MyProjectF\Claude-Code\src\utils\conversationRecovery.ts:382`

这说明 Claude Code 把“技能已调用状态”视为独立的运行状态，而不是期待模型从旧工具历史自行回忆。

## 10. Session Memory Compaction

源码包含一条灰度路径：后台持续提取 session memory，在 auto-compact 时优先用它替代重新总结整段会话。

默认提取配置：

- 上下文到 10K tokens 后初始化。
- 上下文每增长 5K tokens 可再次更新。
- 每 3 个工具调用检查更新。
- session memory 总体目标上限约 12K tokens。

Compact 时保留的 recent tail：

- 至少 10K tokens。
- 至少 5 条含文本消息。
- 最多 40K tokens。
- 不允许切断 tool_use/tool_result 配对或同 ID thinking 分片。

证据：

- 提取配置：`F:\MyProjectF\Claude-Code\src\services\SessionMemory\sessionMemoryUtils.ts:31`
- compact tail 配置：`F:\MyProjectF\Claude-Code\src\services\compact\sessionMemoryCompact.ts:56`
- API 协议完整性调整：`F:\MyProjectF\Claude-Code\src\services\compact\sessionMemoryCompact.ts:188`

该路径默认由 `tengu_session_memory` 和 `tengu_sm_compact` 双开关控制，默认 false：`F:\MyProjectF\Claude-Code\src\services\compact\sessionMemoryCompact.ts:403`。它不能作为所有外部版本的既定行为。

## 11. Claude Code 是否会重复阅读文件

答案是：会，但它尽量把无意义重复转化成 stub。

合理重复包括：

- 文件已经变化。
- offset/limit 不同。
- 前一次只读了局部范围。
- compact 后该文件未进入最近 5 个恢复文件。
- 旧工具结果已被压缩或不可见。
- 新任务需要前一次未保留的细节。

可避免重复包括：

- 同一文件、同一精确范围、mtime 未变化的连续重复 Read。
- compact 后最近活跃文件的立即重读。

Claude Code 解决的不是“禁止重复调用 Read”，而是三个更具体的问题：

1. 不要重复把同一文件范围全文塞入 prompt。
2. 不要在 compact 后立刻失去最近工作文件。
3. 不要让去重、resume 和 prompt cache 使用不同的历史视图。

## 12. 对上下文增长策略的判断

对于 1M 模型，合理策略不是在 60K 或 100K 做完整 summary compact。更接近 Claude Code 的策略是：

1. 允许真实上下文继续增长到数百 K。
2. 对单次异常大的工具结果设置上限或落盘预览。
3. 对完全相同 Read 范围做版本化 stub 去重。
4. 仅在可证明旧工具结果已经无继续价值时做 microcompact。
5. 在约 967K-979K 附近做完整 compact。
6. 完整 compact 后重注入最近文件、技能、计划和运行状态。

过早完整压缩会带来：

- 文件细节丢失，导致重新 Read。
- 技能和计划状态漂移。
- 摘要模型产生事实压缩误差。
- prompt cache 前缀失效。
- 长任务频繁经历“压缩 -> 重读 -> 再增长”。

但“完全不回收工具结果”也不合理，因为日志、搜索结果和旧 Read 会在每轮重复计费。Claude Code 的核心不是单一阈值，而是**轻量回收与完整压缩分离**。

## 13. 可借鉴到 CodeZ 的设计原则

后续 CodeZ 优化应优先借鉴以下原则，而不是直接复制所有内部实验：

1. **Provider usage 为权威口径**：用最近一次实际 input usage 加新增消息估算，避免累加 API 历史。
2. **压缩阈值随模型窗口变化**：1M 模型不应沿用面向 128K/200K 的固定绝对阈值。
3. **Read 去重必须带版本和范围**：至少记录 path、hash/mtime、offset、limit 和结果可见性。
4. **去重状态必须与模型可见历史一致**：如果旧 Read result 已清理，不能返回“请参考旧结果”的空 stub。
5. **大输出外置而非无条件丢弃**：保留完整结果路径和稳定 preview。
6. **完整压缩后恢复工作集**：最近文件、技能、计划、未完成任务和运行状态都应是结构化 attachment。
7. **磁盘历史与模型视图分离**：ledger 可保留完整审计数据，模型只消费 boundary 后的投影视图。
8. **灰度机制可观测**：每次 prune、microcompact、compact 都记录触发原因、删除 token、保留集合和恢复集合。

## 14. 最终判断

Claude Code 的主设计不是“记住读过哪些文件，所以永远不再读”，也不是“上下文始终控制在 100K 以下”。它采用的是：

```text
大窗口持续增长
+ 精确范围 Read 去重
+ 大工具结果外置
+ 可选的旧工具结果回收
+ 接近窗口上限才完整压缩
+ 压缩后结构化恢复工作集
```

在 1M 上下文下，数百 K 的持续增长是正常状态。真正需要优化的是无意义重复内容、不可恢复裁剪和压缩后状态丢失，而不是追求一个始终很低的 token 数字。
