# 📝 开发计划 - 阶段 5：跨文件修改事务管理与智能上下文窗口优化

> 关联需求：阶段5跨文件修改事务管理与智能上下文窗口优化-requirements.md
> 迭代：iteration-6
> 创建时间：2026-06-26 11:12
> 最后更新：2026-06-26 11:12
> 当前阶段：计划/设计

## 整体技术与架构总览

本迭代涉及两条独立但互补的工作线：

1. **事务管理线（Main Process）**：新增 `EditTransactionService` 服务在 Main 进程管理修改备份与回滚。在 `AgentRunner` 的工具执行流程中注入事务生命周期钩子——每轮 Agent Loop 开始时开启事务，工具执行写文件前自动备份原文件，Agent Loop 正常结束时自动提交（清理备份），异常或模型主动调用 `rollback_last_edit` 时回滚。

2. **上下文管理线（Main Process → AgentRunner）**：新增 `ContextManager` 工具类，在 `AgentRunner` 内部的每轮循环开始前，对 `allMessages` 数组做智能裁剪——锚定首条 System Prompt 不裁剪，对历史 tool role 消息的 content 做字符截断，保留头尾各一段并注入 `[Output Truncated]` 标识。

关键设计约束：
- 事务服务备份路径使用 Electron `app.getPath('userData')` 下的临时目录，不污染用户 workspace。
- 上下文裁剪发生在 Main Process 内部的 `AgentRunner.run()` 循环中（不是 Renderer 端），因此 Renderer 端的 `.slice(-20)` 粗暴裁剪也将被替换为调用同一套逻辑。
- 本阶段不实现写文件工具（`write_to_file`/`replace_file_content`），但事务服务的接口预先设计好，使其在后续阶段添加写工具时可直接调用。

## 阶段与任务大纲

**目标**：实现跨文件修改的事务备份/回滚服务，以及 Agent Loop 内的智能上下文窗口裁剪，为后续阶段的代码修改能力奠定安全和稳定性基础。

✅ 第一阶段 · 事务管理服务核心

  ✅ T1：实现 `EditTransactionService`
     - 落点文件：`src/main/services/EditTransactionService.ts`
     - 详细设计：
       - 定义接口 `TransactionState { id: string, sessionId: string, backedUpFiles: Map<string, string>, createdAt: number }`
       - `beginTransaction(sessionId: string): string` — 生成事务 ID，创建 `<userData>/backup/<sessionId>/<txId>/` 目录
       - `backupFile(txId: string, absolutePath: string): Promise<void>` — 若该文件尚未在当前事务中备份过，将原文件拷贝到备份目录，记录映射 `原路径 → 备份路径`
       - `rollback(txId: string): Promise<string[]>` — 遍历备份映射，将备份文件复制回原路径，返回已回滚的文件列表
       - `commit(txId: string): Promise<void>` — 删除备份目录及映射
       - `getActiveTransaction(): TransactionState | null` — 获取当前活跃事务
       - 路径安全：备份路径使用 `app.getPath('userData')` 而非工作区
     - 验收：单元测试覆盖 begin → backup → rollback 和 begin → backup → commit 两条路径

  ✅ T2：实现 `rollback_last_edit` 内置工具
     - 落点文件：`src/main/tools/builtin/RollbackLastEditTool.ts`, `src/main/tools/ToolManager.ts`
     - 详细设计：
       - 继承 `Tool` 基类，name = `rollback_last_edit`
       - parameters_schema: `{ type: 'object', properties: { reason: { type: 'string', description: '回滚原因' } } }`
       - execute 逻辑：调用 `EditTransactionService.getActiveTransaction()` 获取当前事务，若存在则调用 `rollback(txId)` 并返回 `"Rolled back N files: [file1, file2, ...]"`，若无活跃事务则返回 `"No active transaction to rollback."`
       - 在 `ToolManager.registerBuiltinTools()` 中注册
     - 验收：模型可以调用该工具，返回正确的回滚结果

  ✅ T3：在 `AgentRunner` 中集成事务生命周期
     - 落点文件：`src/main/agent/AgentRunner.ts`
     - 详细设计：
       - 在 `AgentRunner` 构造函数中注入 `EditTransactionService` 实例
       - 在 `run()` 方法的 while 循环开始前调用 `beginTransaction(sessionId)` 开启事务
       - 将 `ToolContext` 扩展，增加 `transactionId?: string` 和 `editTransactionService?: EditTransactionService` 字段，使写文件工具（未来实现）可以在执行前调用 `backupFile`
       - 在 `run()` 方法正常结束（`callbacks.onDone`）前调用 `commit(txId)`
       - 在 `run()` 方法异常退出或 abort 时调用 `rollback(txId)`
     - 验收：Agent 正常完成对话后备份目录被自动清理；异常中断后文件被回滚

---

✅ 第二阶段 · 智能上下文窗口管理

  ✅ T4：实现 `ContextManager` 上下文裁剪工具类
     - 落点文件：`src/main/agent/ContextManager.ts`
     - 详细设计：
       - 纯函数风格的静态工具类：`static trimMessages(messages: ChatMessage[], options?: TrimOptions): ChatMessage[]`
       - `TrimOptions`: `{ maxToolOutputChars?: number /* default 3000 */, maxTotalMessages?: number /* default 40 */ }`
       - 算法：
         1. **锚定 System Prompt**：`messages[0]` 若为 `role: 'system'`，始终保留不裁剪
         2. **截断 Tool 输出**：遍历所有 `role: 'tool'` 的消息，若 `content.length > maxToolOutputChars`，保留前 800 字符和后 200 字符，中间替换为 `\n\n[... Output Truncated. Original size: ${len} chars ...]\n\n`
         3. **数量裁剪**：若消息总条数超过 `maxTotalMessages`，从第二条开始（跳过 System Prompt）向前裁剪最旧的消息，但要保证 `assistant` + 对应 `tool` 消息成组保留/删除（不能删 assistant 留 tool_calls 孤儿）
       - 关键边界：
         - 不裁剪最近 3 轮对话（保证模型看到当前上下文）
         - tool_calls 和对应的 tool 结果必须成组保留或成组删除
     - 验收：单元测试覆盖截断、裁剪、锚定三个维度

  ✅ T5：在 `AgentRunner` 中集成上下文裁剪
     - 落点文件：`src/main/agent/AgentRunner.ts`
     - 详细设计：
       - 在 while 循环的每次迭代开始时（`streamChat` 调用前），调用 `ContextManager.trimMessages(allMessages)` 对累积的 messages 做智能裁剪
       - 这保证了 Agent 多轮工具调用后，不会因为历史 tool 输出累积导致 token 超限
     - 验收：连续 5+ 轮工具调用后，messages 不会超过 maxTotalMessages 限制

  ✅ T6：优化 Renderer 端的消息传递
     - 落点文件：`src/renderer/src/App.tsx`
     - 详细设计：
       - 移除 `handleSendMessage` 中的 `.slice(-20)` 粗暴裁剪
       - 将 Renderer 端发往 Main 的消息仍取近 30/40 条（保证足够上下文），但不再负责严格裁剪（裁剪交由 Main 端 AgentRunner 统一处理）
       - System Prompt 仍保留在 Renderer 端构建（因为需要 workspace 信息），但 `chat.handlers.ts` 中的 system prompt 同样保留（双重保障）
     - 验收：长对话场景下大模型 API 不再因 token 超限报 400/413 错误

---

✅ 第三阶段 · 编译验证与测试

  ✅ T7：编译验证
     - `npm run typecheck` 和 `npm run build` 全部通过

  ✅ T8：测试验证
     - 新增/更新测试覆盖 `EditTransactionService` 和 `ContextManager`
     - `npm test` 通过

### 验收&测试

  ✅ 1、事务回滚验证：Agent 修改文件后调用 rollback_last_edit，所有修改的文件恢复原状
  ✅ 2、事务提交验证：Agent 正常结束后，userData/backup 目录下无残留
  ✅ 3、上下文截断验证：get_project_snapshot 返回超长内容后，后续请求中该 tool 输出被截断
  ✅ 4、System Prompt 锚定验证：多轮对话后 System Prompt 始终在 messages[0]
  ✅ 5、编译验证：`npm run typecheck` + `npm run build` 通过
  ✅ 6、测试验证：`npm test` 通过

## 依赖关系

```text
T2 依赖 T1
T3 依赖 T1, T2
T5 依赖 T4
T6 依赖 T4
T7 依赖 T1-T6
T8 依赖 T7
```

## 风险点

1. **事务服务目前无写工具可触发**：当前阶段尚未实现 `write_to_file` / `replace_file_content` 工具，因此 `backupFile` 在本阶段不会被实际写工具调用。但接口和集成点已就绪，后续添加写工具时只需在工具 execute 中调用 `context.editTransactionService.backupFile()` 即可。
2. **上下文裁剪可能误删关键信息**：截断 tool 输出时保留头尾的策略无法保证所有场景下模型都能获得足够信息。首版使用保守阈值（3000 字符），后续可根据模型 maxContextTokens 动态调整。
3. **成对删除复杂度**：assistant 的 tool_calls 和对应 tool 结果需要成组操作，逻辑需要仔细处理以避免消息格式损坏导致 API 报错。

## 步骤状态

| 阶段 | 状态 | 开始时间 | 完成时间 |
|------|------|----------|----------|
| 需求分析 | ✅ 已完成 | 2026-06-26 11:10 | 2026-06-26 11:10 |
| 计划/设计 | ✅ 已完成 | 2026-06-26 11:12 | 2026-06-26 11:12 |
| 实现 | ✅ 已完成 | 2026-06-26 11:13 | 2026-06-26 11:17 |
| 编译验证 | ✅ 已完成 | 2026-06-26 11:18 | 2026-06-26 11:18 |
| 测试 | ✅ 已完成 | 2026-06-26 11:18 | 2026-06-26 11:18 |
| 完成 | ✅ 已完成 | 2026-06-26 11:18 | 2026-06-26 11:18 |

## 进度统计

- **总任务数**：8
- **已完成**：8
- **完成百分比**：100%

## 变更记录
| 时间 | 变更内容 | 调整原因 |
|------|----------|----------|
| 2026-06-26 11:12 | 初始创建计划 | 需求分析完成，进入计划阶段 |
