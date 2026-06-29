# 📋 需求文档 - 动态上下文管理与 ResumeState 自动触发

> 迭代：第二轮优化
> 创建时间：2026-06-29 17:48
> 最后更新：2026-06-29 17:48
> 存放位置：.continue/current/CodeZ_v2第二轮优化-动态上下文管理-requirements.md
> 状态：✅ 已全面实装并闭环

## 需求背景

### 现状问题

在第一轮优化的人工验收测试（T09）中发现，当前的上下文管理存在两个核心缺陷：

1. **上下文裁剪策略过于粗糙**：`ContextManager.trimMessages()` 使用固定的消息条数上限（硬编码 40 条），完全没有考虑不同大模型的实际 Token 上下文窗口大小。
   - Gemini 2.5 Pro（100 万 tokens）：40 条消息可能只用了上下文的 1%，严重浪费。
   - 本地小模型（8K tokens）：40 条消息可能早已超限，导致 API 报错崩溃。

2. **`update_resume_state` 工具形同虚设**：虽然工具后端代码完好（T09 连通性验证通过），但在真实开发场景中，没有任何机制会触发它：
   - 用户不会主动说"帮我存个档"。
   - System Prompt 中没有指令引导大模型自觉调用。
   - 框架层没有在裁剪发生时自动注入存档提醒。
   - 结果：上下文被静默裁剪后，大模型"无感失忆"，前面的目标、文件读取、排查记录全部丢失。

### 预期价值

- Agent 能根据所选模型的实际上下文窗口大小，**智能动态地**决定何时裁剪、裁剪多少。
- 裁剪发生前，框架**自动触发** `update_resume_state`，让大模型先浓缩保存关键记忆再删旧消息。
- 最终效果：即使在超长任务（50+ 轮工具调用）中，Agent 也能保持方向感，不会忘了自己在干什么。

---

## 功能需求

### F1：基于 Token 的动态上下文裁剪

**现状**：`ContextManager` 使用固定 `maxTotalMessages = 40` 和 `maxToolOutputChars = 3000`。

**目标**：根据当前模型的上下文窗口大小动态计算裁剪阈值。

#### 详细设计要点

1. **模型上下文窗口声明**
   - 在 Provider 配置（`ProviderConfig`）中新增 `contextWindow` 字段（单位：tokens）。
   - 常见预设值：
     - `gemini-2.5-pro`: 1,000,000
     - `claude-sonnet-4`: 200,000
     - `gpt-4o`: 128,000
     - `deepseek-v3`: 64,000
     - 本地模型默认: 8,000

2. **Token 估算**
   - 简单方案：`字符数 / 4` 近似估算（适用于英文为主的代码场景）。
   - 进阶方案：接入 `tiktoken` 或类似库做精确计算。
   - 需要对每条消息（system / user / assistant / tool）分别估算。

3. **动态裁剪阈值**
   - 当总估算 Token 数达到上下文窗口的 **75%** 时，开始裁剪。
   - 裁剪目标：削减到窗口的 **60%** 以下，留出足够余量给模型的输出。
   - 工具输出截断长度也应动态调整（大窗口模型可以保留更多工具输出）。

4. **`trimMessages` 签名变更**
   ```typescript
   static trimMessages(
     messages: ChatMessage[],
     contextWindowTokens: number,  // 新增：模型的上下文窗口大小
     options?: TrimOptions
   ): { messages: ChatMessage[], trimmed: boolean, trimmedCount: number }
   ```
   - 返回值改为对象，包含 `trimmed` 标志和 `trimmedCount`，供 AgentRunner 判断是否需要触发存档。

---

### F2：上下文裁剪时自动触发 ResumeState 存档

**现状**：裁剪静默发生，大模型不知情，`update_resume_state` 无人调用。

**目标**：当裁剪确实发生时，框架自动注入提醒消息，引导大模型存档。

#### 详细设计要点

1. **AgentRunner 中的触发逻辑**
   ```
   // 伪代码
   const trimResult = ContextManager.trimMessages(allMessages, contextWindow)
   allMessages = trimResult.messages

   if (trimResult.trimmed) {
     // 在消息队列中注入一条系统提示
     allMessages.push({
       role: 'system',
       content: `⚠️ 上下文裁剪通知：刚才有 ${trimResult.trimmedCount} 条旧消息被移除。
       请你在下一步操作前，先调用 update_resume_state 工具保存当前的任务进度、
       已完成的步骤和下一步计划，防止关键信息丢失。`
     })
   }
   ```

2. **System Prompt 中的常驻指令**
   在 `chat.handlers.ts` 注入的系统提示中，追加一条规则：
   ```
   【CONTEXT MANAGEMENT】
   When you receive a context trimming notification, you MUST immediately call
   "update_resume_state" to save your current goal, completed steps, pending steps,
   and files you've touched. This is critical for maintaining task continuity.
   ```

---

### F3：步数上限挂起前自动存档

**现状**：达到 `MAX_LOOPS` 时直接挂起，不保存任何状态。

**目标**：在挂起前由框架层强制调用 `update_resume_state`。

#### 详细设计要点

1. 在 `AgentRunner.ts` 的步数上限检测逻辑中（第 225 行附近），当检测到 `loopCount >= MAX_LOOPS - 2` 时（提前 2 步），注入一条系统提示要求存档。
2. 或者更可靠的方式：直接在框架层调用 `UpdateResumeStateTool.execute()`，不依赖大模型的主动性。

---

## 非功能需求

- **向后兼容**：如果 Provider 配置中没有 `contextWindow` 字段，使用保守的默认值（如 32,000 tokens），行为退化到当前的固定裁剪逻辑，不影响已有功能。
- **性能**：Token 估算必须足够快（< 5ms），不能拖慢每一轮 Agent 循环。
- **可观测性**：裁剪事件应在终端日志中输出，方便开发调试。

---

## 涉及文件（预估）

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/agent/ContextManager.ts` | 修改 | 核心裁剪逻辑改为基于 Token 动态计算 |
| `src/main/agent/AgentRunner.ts` | 修改 | 裁剪后注入系统提示、步数上限前触发存档 |
| `src/main/ipc/chat.handlers.ts` | 修改 | System Prompt 追加上下文管理指令 |
| `src/shared/types/provider.ts` | 修改 | `ProviderConfig` 新增 `contextWindow` 字段 |
| `src/renderer/.../ProviderSettings` | 修改 | UI 中增加上下文窗口大小配置项 |
| `src/main/services/chat/types.ts` | 修改 | `ChatRequestConfig` 透传 `contextWindow` |

---

## 验收标准

- [x] **AC1**：使用 100 万上下文模型时，Agent 能维持远超 40 条消息的完整对话历史。
- [x] **AC2**：使用 8K 上下文模型时，Agent 不会因 Token超限崩溃。
- [x] **AC3**：当裁剪发生时，Agent 在下一轮自动调用 `update_resume_state`。
- [x] **AC4**：用户说"继续"后，Agent 能从 ResumeState 恢复之前的任务方向。
- [x] **AC5**：达到步数上限挂起前，ResumeState 已被保存。

---

## 优先级与排期

**优先级**：高（直接影响长程任务的可靠性）
**前置依赖**：第一轮优化人工验收测试全部完成
**建议排期**：第二轮优化的第一个迭代任务
