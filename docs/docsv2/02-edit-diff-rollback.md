# 02 编辑事务、Patch、Diff、回滚

## 1. 用户需求

用户需要 Agent 修改代码时可控、可审查、可恢复。不能出现：

- 全量覆盖长文件导致误删。
- 修改了哪些文件不清楚。
- 用户已有改动被覆盖。
- 工具失败却假装成功。
- 回滚只能靠手动 Git 操作。

## 2. 当前项目依据

当前已有基础：

- `src/main/services/EditTransactionService.ts`
- `src/main/tools/builtin/WriteToFileTool.ts`
- `src/main/tools/builtin/ReplaceFileContentTool.ts`
- `src/main/tools/builtin/RollbackLastEditTool.ts`
- `src/main/ipc/chat.handlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/stores/chatStore.ts`

现状优势：

- 已有 transaction 概念。
- 写入前可备份文件。
- 可按文件 commit / rollback。
- Agent 出错时可回滚事务。

现状缺口：

- 缺少统一 Patch 主路径。
- 缺少结构化 Diff 模型。
- 缺少 hunk 级接受 / 拒绝。
- 缺少写入前 stale hash 校验。
- 工具结果不够结构化。

## 3. 最终目的

建立完整编辑工作流：

```text
读取文件并记录 hash
→ 生成 Patch
→ 预览 Diff
→ 应用 Patch
→ 事务记录变更
→ 用户可接受 / 拒绝
→ 验证通过后提交事务状态
```

## 4. 需求拆解

### 4.1 Patch 主路径

新增或强化 `apply_patch`：

```ts
type ApplyPatchInput = {
  patch: string
  expectedHashByPath?: Record<string, string>
}

type ApplyPatchOutput = {
  changedFiles: string[]
  diff: string
  summary: string
}
```

要求：

- 修改已有源码文件优先使用 Patch。
- Patch 上下文不匹配必须失败。
- 失败提示 Agent 重新读取相关范围。
- 删除文件不默认允许。

### 4.2 Diff 模型

建立结构化 Diff 数据：

```ts
type FileDiff = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  hunks: DiffHunk[]
}

type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}
```

### 4.3 用户已有改动保护

需求：

- 写入前记录 `sha256`。
- 应用 Patch 时校验 hash。
- 如果文件已变化，拒绝写入并要求重新读取。
- 不自动清理未跟踪文件。
- 不自动 reset / checkout / clean。

### 4.4 回滚体验

需求：

- 保留当前文件级回滚能力。
- 后续支持 hunk 级回滚。
- UI 能展示本轮修改文件列表。
- Agent 可调用 `rollback_last_edit`，用户也可手动拒绝。

## 5. 实施顺序

1. 梳理 `EditTransactionService` 当前事务状态结构。
2. 给写入工具增加结构化变更输出。
3. 新增 Patch 解析 / 应用服务，或先用安全字符串替换实现最小 Patch。
4. 生成 Diff 数据并通过 IPC 发给 renderer。
5. Renderer 展示文件级 Diff。
6. 接入 accept / reject 文件操作。
7. 增加 stale hash 校验。
8. 后续再做 hunk 级接受 / 拒绝。

## 6. 验证方式

### 6.1 单元验证

- 新文件创建后 rollback 会删除该文件。
- 已有文件修改后 rollback 会恢复原内容。
- commit 后 rollback 不再影响该文件。
- hash 不匹配时写入失败。
- Patch 上下文不匹配时返回 recoverable error。

### 6.2 行为验证

给 Agent 一个任务：

```text
把某个测试文件中的字符串 A 改成 B。
```

期望：

1. Agent 读取文件。
2. 生成最小 Patch。
3. 工具返回 changedFiles 和 diff。
4. UI 能看到文件变更。
5. 用户拒绝后文件恢复。

### 6.3 命令验证

- `npm test`
- `npm run typecheck`

## 7. 完成标准

- 修改已有代码不再依赖全量覆盖。
- 每次写入都有事务记录。
- 用户能看见变更并拒绝。
- 失败时能恢复到修改前状态。
