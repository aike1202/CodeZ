# 05 验证闭环：测试、构建、诊断、自修复

## 1. 用户需求

用户需要 Agent 不只是“改了代码”，而是能证明改动有效。最终回复必须区分：

- 已完成。
- 已验证。
- 验证失败。
- 未验证。
- 失败是否由本次修改引起。

## 2. 当前项目依据

项目脚本：

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run dev`
- `npm run package`

相关文件：

- `package.json`
- `src/main/tools/builtin/RunCommandTool.ts`
- `src/tests/chat-service.test.ts`
- `src/tests/project-analysis-service.test.ts`
- `src/tests/workspace-service.test.ts`
- `src/tests/smoke.test.ts`

当前已有命令执行工具，但缺少专门的验证策略。

## 3. 最终目的

建立验证闭环：

```text
代码修改完成
→ 选择最小相关验证
→ 执行验证命令
→ 解析失败输出
→ 判断是否本次修改导致
→ 必要时修复
→ 再次验证
→ 最终报告
```

## 4. 验证优先级

推荐顺序：

1. 最相关单元测试。
2. 相关模块测试。
3. `npm run typecheck`。
4. `npm test`。
5. `npm run build`。
6. UI 相关任务再启动应用手动验证。

不要每次都直接跑最重命令。

## 5. 需求拆解

### 5.1 验证命令识别

Runtime 应能从 `package.json` 获取脚本：

- test
- typecheck
- build
- dev
- package

### 5.2 验证推荐

根据变更文件推荐命令：

| 变更类型 | 推荐验证 |
| --- | --- |
| `src/main/tools/*` | 相关工具测试 + `npm test` |
| `src/main/agent/*` | AgentRunner 测试 + `npm test` |
| `src/main/services/chat/*` | chat-service 测试 + typecheck |
| `src/renderer/*` | typecheck + 必要时 dev 手动验证 |
| docs only | 不必跑完整构建，除非用户要求 |

### 5.3 失败诊断

验证失败时 Agent 必须：

- 读取真实错误输出。
- 判断是否和本次改动有关。
- 如果相关，继续修复。
- 如果不相关，在最终回复中说明既有问题。
- 不允许验证失败仍说完成。

### 5.5 Shell 平台兼容

验证命令必须考虑平台差异：

- Windows PowerShell 可能因 ExecutionPolicy 拦截 `npm.ps1`。
- Windows 可优先尝试 `npm.cmd`。
- Git Bash / PowerShell / cmd 的语法不同，不应混用。
- `tree`、`head`、`grep`、`find` 等 Unix 工具不保证存在。
- 有专用工具时，不应通过 shell 搜索或读取文件。

命令失败时需要区分：

- 项目测试失败。
- 命令不存在。
- shell 语法不兼容。
- 权限策略阻止。
- 超时。

## 6. 实施顺序

1. 新增验证策略模块或在 AgentRunner 中先实现最小策略。
2. 读取 `package.json` scripts。
3. 根据 changedFiles 推荐命令。
4. 将验证结果结构化。
5. 增加 shell 平台兼容检测和命令替代策略。
6. 失败输出截断但保留关键错误。
7. 最终回复模板加入验证状态。
8. 增加测试覆盖验证推荐逻辑。

## 7. 验证方式

### 7.1 单元验证

- 修改 docs 时推荐“不需要跑完整构建”。
- 修改 `src/main/services/chat` 时推荐 `npm test` 或相关测试。
- 修改 renderer 时推荐 typecheck。
- 命令失败时返回结构化错误。
- Windows 上 `npm.ps1` 被策略阻止时，能识别为平台执行问题并建议 `npm.cmd` 或兼容 shell。

### 7.2 行为验证

让 Agent 修改一个测试可覆盖的小逻辑。

期望：

1. Agent 修改代码。
2. Agent 运行相关测试。
3. 测试失败时继续修。
4. 测试通过后最终回复说明验证命令。

### 7.3 命令验证

- `npm test`
- `npm run typecheck`
- `npm run build`，必要时运行。

## 8. 完成标准

- Agent 不再只修改不验证。
- 验证失败不会被忽略。
- 最终回复可信。
- 用户能清楚看到“是否验证过”。
