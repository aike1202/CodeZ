### Task 18: 回归 + 最终验收

**Files:**
- 无新代码；本任务为全量验证与手动验收。

**Interfaces:**
- Consumes: Task 1-17 全部产物。
- Produces: 全绿 CI（`npm test` / `npm run typecheck` / `npm run build`）+ spec §11/§12 验收记录。

- [ ] **Step 1: 全量自动化**

Run: `npm test`
Expected: 全绿（含 18 个任务新增/改写的全部测试）。
Run: `npm run typecheck`
Expected: 错误数 ≤ 7（预存基线，与本计划无关的 `ExecutionLog.tsx`/`PromptArea.tsx`/`ExecutionLogDetail.tsx`/`ExecutionLogUtils.ts` 中 7 条先存错误）；**本计划新增/修改的文件零类型错误**。若错误数 >7，说明本计划引入了新错误，须定位修复。
Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 2: spec §12 回归清单逐条核对**

逐条确认（每条标注"通过/命令/证据"）：

- [ ] **`@file` 预读**：`grep -n "systemInstruction\|@file" src/main/ipc/chat.handlers.ts` 确认 `@file` 注入逻辑未变；Read 指纹表与 `@file` 共用 `ReadFingerprintStore`（Task 1/2）。
- [ ] **verification 闭环**：`src/main/agent/AgentRunner.ts` 的 `filesModifiedInSession` 在 `Edit/Write` 被选时置 true（Task 16 Step 3a）；拦截文案 `:435` 已更新为新名。
- [ ] **resume-state**：`update_resume_state` 未动；新工具未引入新 resume 字段（`grep -n "resumeState" src/main/tools/builtin/` 应仅命中 `UpdateResumeStateTool`）。
- [ ] **edit-transaction / rollback**：`EditTransactionService` 未改；Edit/Write/NotebookEdit 均调 `backupFile`（Task 3/4/7）；`rollback_last_edit` 仍按 `transactionId` 覆盖新工具写入。
- [ ] **permission ask 闭环**：`Bash/PowerShell` 复用 `getCommandRisk`（Task 15）；`permission-manager.test.ts` + `permission-manager-claude-names.test.ts` 全绿。
- [ ] **approval IPC**：`CHAT_REQUEST_APPROVAL/CHAT_APPROVAL_RESPONSE` 未被 AskUser 挤占（Task 14 新增独立 channel `CHAT_REQUEST_ASK_USER`）；两个 Widget 独立渲染（ChatArea auditArea 各自条件块）。
- [ ] **三 provider 映射**：`GeminiProvider/AnthropicProvider/OpenAIProvider` 未改；新工具经 `getToolDefinitions()` 自动翻译（`grep -n "functionDeclarations\|input_schema" src/main/services/chat/` 无新特例）。
- [ ] **system prompt 双重声明**：`<available_tools>` 由 `getAllTools()` 自动生成含新名；`<skills_instructions>` 文案已改 `Read`（Task 16 Step 4）。
- [ ] **上下文裁剪**：`ContextManager.truncateToolOutput` 未改；Read/Grep/Glob 返回纯文本可被安全截断。
- [ ] **保留 5 工具**：`grep -n "list_files\|get_project_snapshot\|fast_context\|rollback_last_edit\|update_resume_state" src/main/tools/ToolManager.ts` 五者仍在注册列表且 schema/类未改。

- [ ] **Step 3: spec §11 每工具验收抽查**

按 spec §11 逐工具抽 1–2 条断言已在对应任务单测覆盖（见各 task 文件 Step 1）。重点复核：
- Read 去重三态（首次/Wasted/改后）→ `read-tool.test.ts`。
- Edit 唯一/不唯一/未先 Read/剥前缀 → `edit-tool.test.ts`。
- Write 新建/覆盖须先 Read/越界 → `write-tool.test.ts`。
- NotebookEdit replace/insert/delete/未命中 → `notebook-edit-tool.test.ts`。
- Glob ripgrep+回退 → `glob-tool.test.ts`；Grep 三模式+ripgrep 缺失报错 → `grep-tool.test.ts`。
- Bash/PowerShell 前台/timeout/background/工作目录持久 → `bash-tool.test.ts`/`powershell-tool.test.ts`。
- AskUserQuestion 1-4 问/2-4 选项/拦截 → `ask-user-question-tool.test.ts`。
- PushNotification sent 回灌 → `push-notification-tool.test.ts`。
- Skill 命中/未命中列清单 → `skill-tool.test.ts`。

- [ ] **Step 4: 手动验收（spec §10）**

启动应用 `npm run dev`，在真实会话中验证：
1. **`@file` 不再 cat fallback**：prompt 用 `@src/main/tools/Tool.ts`，模型随后显式调 `Read` 同文件 → 应命中 `Wasted call — file unchanged...`（指纹互锁）。
2. **AskUserQuestion 流程**：触发模型调 `AskUserQuestion`（1 问 2 选项）→ 渲染端 `AskUserQuestionWidget` 显示 2 选项 + Other → 选一项 → 流程继续，`tool_result` 为结构化 answers。
3. **PowerShell 5.1**：模型调 `PowerShell` 跑 `Write-Output hi` → 返回 `hi`；调 `npm test` → 正常。
4. **后台跨轮**：`Bash` `run_in_background:true` 跑 `sleep 3` → 立即返回 pid/stdoutFile；下一轮仍可引用 pid。
5. **Accept/Reject**：`Edit` 修改文件 → 渲染端出现 Accept/Reject 卡片（editDiffUtils 已认 `Edit`）→ Reject 后 `rollback_last_edit` 恢复。

- [ ] **Step 5: 最终提交（若 Step 4 有微调）**

```bash
git add -A
git commit -m "test: regression + acceptance for Claude tool alignment (§11/§12)"
```

- [ ] **Step 6: 收尾确认**

- `git log --oneline` 应见 Task 1-17 各自 commit。
- `npm test` 最终全绿。
- 在本 plan 主索引 `docs/superpowers/plans/2026-06-30-claude-tool-alignment.md` 勾选完成状态。
