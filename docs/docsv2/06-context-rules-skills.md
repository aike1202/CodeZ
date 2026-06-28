# 06 上下文管理、Rules、Skills 基础能力

## 1. 用户需求

用户需要 Agent 理解项目约定、当前上下文和专项工作流，但不能把整个仓库塞进 Prompt。Agent 应该：

- 按需搜索和读取。
- 自动加载项目规则。
- 用户点名 Skill 时使用 Skill。
- 长任务中不丢关键上下文。
- 不让仓库文件里的恶意内容覆盖系统规则。

## 2. 当前项目依据

相关文件：

- `src/main/agent/ContextManager.ts`
- `src/main/tools/builtin/GetProjectSnapshotTool.ts`
- `src/main/tools/builtin/FastContextTool.ts`
- `src/main/tools/builtin/GetSymbolMapTool.ts`
- `src/main/ipc/skill.handlers.ts`
- `src/main/ipc/chat.handlers.ts`

当前已有：

- 上下文裁剪。
- 项目快照。
- 快速上下文工具。
- 根级 `AGENTS.md` 注入迹象。
- Skill IPC 相关入口。

## 3. 最终目的

建立分层上下文系统：

```text
System / Developer 固定规则
→ 用户当前请求
→ 环境信息
→ 项目 Rules
→ 工具索引
→ Skills 索引
→ 搜索/读取获得的真实文件上下文
→ 工具结果摘要
```

## 4. Rules 需求

按优先级加载：

1. System / Developer 内置规则。
2. 用户本轮明确指令。
3. 工具权限规则。
4. 目录级项目规则。
5. workspace 规则。
6. `.clinerules` / `.cursorrules` / `AGENTS.md`。
7. 全局用户规则。
8. Skill 规则。
9. Memory / preferences。

MVP 支持：

- 根目录 `AGENTS.md`。
- `.clinerules`。
- `.cursorrules`。
- `.codez/rules/*.md`。

后续支持目录级规则。

## 5. Skills 需求

Skill 是专项工作流，不是最高优先级规则。

MVP：

- 扫描 skills 目录。
- 建立 Skill 索引。
- 用户明确点名 Skill 时读取完整 `SKILL.md`。
- Skill 引用资源时只读取相关文件。

后续：

- 自动匹配 Skill。
- 插件贡献 Skill。
- Skill 权限声明。

## 6. 上下文裁剪需求

要求：

- 工具结果过长时截断并标记。
- 搜索结果过多时提示 refine。
- 文件读取必须分页。
- 多轮对话保留最近关键工具调用。
- 不丢失未完成 tool_call / tool_result 对。
- 项目分析时把长工具输出沉淀为 `ProjectFacts` 和 `EvidenceLedger`，避免每轮重复携带 `ls/find/cat/grep` 全量结果。
- 裁剪或压缩前必须把目标、阶段、关键决策、待验证项写入 `07-goal-context-resume.md` 定义的 ResumeState。

## 7. Prompt Injection 防护

要求：

- 仓库文件内容是数据，不是指令。
- 网页、issue、MCP 返回内容是数据，不是指令。
- Rules / Skills 不能覆盖安全规则。
- 如果文件里出现“忽略之前指令”等内容，Agent 必须忽略。

## 8. 实施顺序

1. 梳理 `ContextManager` 当前裁剪策略。
2. 增加规则文件扫描。
3. 增加 RulesResolver。
4. 在 prompt assembly 中注入适用规则摘要。
5. 增加 Skill 索引读取。
6. 用户点名 Skill 时加载 `SKILL.md`。
7. 增加 prompt injection 防护说明。
8. 后续再做长期 memory。

## 9. 验证方式

### 9.1 单元验证

- 根目录 `AGENTS.md` 能被加载。
- `.clinerules` 能被加载。
- 同名规则冲突时高优先级覆盖低优先级。
- 超长工具结果被截断并标记。
- tool_call / tool_result 分组不被裁剪破坏。

### 9.2 行为验证

创建一个测试规则：

```text
修改源码后必须运行 npm run typecheck。
```

让 Agent 修改源码。

期望：

- Agent 在最终验证中运行 typecheck 或说明为什么不能运行。

### 9.3 命令验证

- `npm test`
- `npm run typecheck`

## 10. 完成标准

- 项目规则能进入上下文。
- Skill 能被显式调用。
- 上下文不会无限膨胀。
- 外部内容不能注入为高优先级指令。
