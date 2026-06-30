### Task 16: 注册新 11 工具 + 删除旧 4 工具 + 收口引用与测试

**Files:**
- Modify: `src/main/tools/ToolManager.ts`（注册新工具、移除旧导入）
- Delete: `src/main/tools/builtin/ReadFilesTool.ts`、`SearchTool.ts`、`ApplyPatchTool.ts`、`RunCommandTool.ts`
- Modify: `src/main/agent/AgentRunner.ts`（verification 名表 `:375`、`run_command` 分支 `:377`、文案 `:435`、`buildToolError` 正则 `:40`）
- Modify: `src/main/ipc/chat.handlers.ts`（`<skills_instructions>` 文案 `read_files`→`Read` 等提示文本）
- Modify: `src/main/services/PermissionManager.ts`（移除旧名映射 `read_files/search/apply_patch/run_command`）
- Delete: `src/tests/search-read-tools.test.ts`、`src/tests/apply-patch-tool.test.ts`（覆盖由 read/grep/glob/edit/write 工具测试替代）
- Modify: `src/tests/permission-manager.test.ts`（旧名断言改新名）
- Modify: `src/tests/verification-strategy-service.test.ts`（路径字符串 `ApplyPatchTool.ts`→`EditTool.ts`）

**Interfaces:**
- Consumes: Task 1-15 全部新工具类。
- Produces: `ToolManager.registerBuiltinTools` 注册 16 个工具（5 保留 + 11 新）；旧 4 类删除；main 进程所有旧名引用收口。

**说明：** 用户决议"意义相同的就完全使用新的老的就删除"。本任务删除 `read_files/apply_patch/run_command/search` 四个旧工具，旧名从 PermissionManager 与 AgentRunner verification 一并移除。`list_files/get_project_snapshot/fast_context/rollback_last_edit/update_resume_state` 保留不动。渲染端工具名特化渲染在 Task 17 收口。

- [ ] **Step 1: Update ToolManager**

将 `src/main/tools/ToolManager.ts` 顶部导入替换为：
```ts
import { Tool } from './Tool'
import { ListFilesTool } from './builtin/ListFilesTool'
import { ReadTool } from './builtin/ReadTool'
import { EditTool } from './builtin/EditTool'
import { WriteTool } from './builtin/WriteTool'
import { NotebookEditTool } from './builtin/NotebookEditTool'
import { GlobTool } from './builtin/GlobTool'
import { GrepTool } from './builtin/GrepTool'
import { BashTool } from './builtin/BashTool'
import { PowerShellTool } from './builtin/PowerShellTool'
import { AskUserQuestionTool } from './builtin/AskUserQuestionTool'
import { PushNotificationTool } from './builtin/PushNotificationTool'
import { SkillTool } from './builtin/SkillTool'
import { GetProjectSnapshotTool } from './builtin/GetProjectSnapshotTool'
import { RollbackLastEditTool } from './builtin/RollbackLastEditTool'
import { UpdateResumeStateTool } from './builtin/UpdateResumeStateTool'
import { FastContextTool } from './builtin/FastContextTool'
import type { ToolDefinition } from '../../shared/types/provider'
```
将 `registerBuiltinTools` 内 `builtinTools` 数组替换为：
```ts
    const builtinTools = [
      new ListFilesTool(),
      new ReadTool(),
      new EditTool(),
      new WriteTool(),
      new NotebookEditTool(),
      new GlobTool(),
      new GrepTool(),
      new BashTool(),
      new PowerShellTool(),
      new AskUserQuestionTool(),
      new PushNotificationTool(),
      new SkillTool(),
      new GetProjectSnapshotTool(),
      new RollbackLastEditTool(),
      new UpdateResumeStateTool(),
      new FastContextTool()
    ]
```

- [ ] **Step 2: Delete old tool files**

Run:
```bash
git rm src/main/tools/builtin/ReadFilesTool.ts src/main/tools/builtin/SearchTool.ts src/main/tools/builtin/ApplyPatchTool.ts src/main/tools/builtin/RunCommandTool.ts
```

- [ ] **Step 3: Update AgentRunner verification + 文案**

在 `src/main/agent/AgentRunner.ts`：

3a. verification 名表（`:375`）替换为：
```ts
                if (['Edit', 'Write'].includes(tr.name)) {
                  filesModifiedInSession = true
                } else if (tr.name === 'Bash' || tr.name === 'PowerShell') {
```
其下 `cmdStr` 取值行（`:379`）替换为：
```ts
                    const cmdStr = cmdArgs.command || cmdArgs.commandLine || ''
```

3b. verification 拦截文案（`:435`）替换为：
```ts
              content: `⚠️ 验证闭环拦截：你最后一次运行的验证命令 (${lastVerificationResult.command}) 未成功通过。作为负责任的 AI，你必须修复这些错误并重新验证，在验证通过之前绝对不能声称任务已完成。请继续使用相关工具（如 Read, Edit, Write, Bash 等）进行排查和修复。`
```

3c. `buildToolError` 正则（`:40`）替换为（加 `must read` 覆盖 Edit/Write 的"须先 Read"错误）：
```ts
  const recoverable = /hash mismatch|not found|not unique|expectedhash|re-read|read_files|must read/i.test(resultMessage)
```

- [ ] **Step 4: Update chat.handlers prompt text**

在 `src/main/ipc/chat.handlers.ts` 中，将 `<skills_instructions>` 块的提示文本（`:128`）替换为：
```ts
        systemPrompt += 'IMPORTANT: Before using a skill, you MUST use the "Read" tool to read the markdown file at its path to understand the detailed instructions.\n\n'
```
随后在该文件内搜索其余 prompt 文本中的 `read_files`/`apply_patch`/`run_command` 字样并替换为 `Read`/`Edit`(或 `Write`)/`Bash`（仅 systemPrompt 字符串，不动逻辑）。`@file` 预读注入逻辑保持不变（regression §12）。

- [ ] **Step 5: Remove old-name mappings from PermissionManager**

在 `src/main/services/PermissionManager.ts`：
- 只读白名单移除 `'search'`、`'read_files'`：
```ts
    if (['list_files', 'get_project_snapshot', 'fast_context', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'PushNotification', 'AskUserQuestion'].includes(toolName)) {
      return 'allow'
    }
```
- 写工具列表移除 `'apply_patch'`：
```ts
    if (['Edit', 'Write'].includes(toolName)) {
```
- 命令分支移除 `'run_command'`：
```ts
    if (toolName === 'Bash' || toolName === 'PowerShell') {
```
- `createPermissionRequest` 命令分支与写分支同步移除 `run_command`/`apply_patch`：
```ts
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const cmd = this.getCommandFromArgs(parsedArgs)
      risk = this.getCommandRisk(cmd)
      description = `Execute command: ${cmd}`
    } else if (['Edit', 'Write'].includes(toolName)) {
      const targetPath = parsedArgs?.file_path || parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.path || 'unknown path'
      risk = 'write'
      description = `Modify file: ${targetPath}`
    }
```

- [ ] **Step 6: Rewrite permission-manager.test.ts**

将 `src/tests/permission-manager.test.ts` 整体替换为：
```ts
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'

describe('PermissionManager', () => {
  const pm = PermissionManager.getInstance()
  const workspaceRoot = path.resolve('/tmp/codez-workspace')

  it('应正确识别安全验证命令', () => {
    expect(pm.getCommandRisk('npm test')).toBe('safe')
    expect(pm.getCommandRisk('npm run test')).toBe('safe')
    expect(pm.getCommandRisk('npm run typecheck')).toBe('safe')
    expect(pm.getCommandRisk('npm run build')).toBe('safe')
    expect(pm.getCommandRisk('git status')).toBe('safe')
    expect(pm.getCommandRisk('git diff -- src/main.ts')).toBe('safe')
  })

  it('应正确识别写入、网络和破坏性命令', () => {
    expect(pm.getCommandRisk('npm install')).toBe('write')
    expect(pm.getCommandRisk('npm i lodash')).toBe('write')
    expect(pm.getCommandRisk('yarn add react')).toBe('write')
    expect(pm.getCommandRisk('pnpm add react')).toBe('write')
    expect(pm.getCommandRisk('curl https://example.com')).toBe('network')
    expect(pm.getCommandRisk('wget https://example.com/file')).toBe('network')
    expect(pm.getCommandRisk('rm -rf dist')).toBe('destructive')
    expect(pm.getCommandRisk('git reset --hard HEAD')).toBe('destructive')
    expect(pm.getCommandRisk('git clean -fd')).toBe('destructive')
  })

  it('Bash 支持 command 参数名', () => {
    expect(pm.checkToolPermission('Bash', { command: 'npm test' }, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('Bash', { command: 'npm install' }, workspaceRoot)).toBe('ask')
    expect(pm.checkToolPermission('PowerShell', { command: 'git status' }, workspaceRoot)).toBe('allow')
  })

  it('只读工具应 allow，rollback 和写入工具应 allow(边界内)', () => {
    expect(pm.checkToolPermission('Read', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('Glob', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('get_project_snapshot', {}, workspaceRoot)).toBe('allow')
    expect(pm.checkToolPermission('rollback_last_edit', {}, workspaceRoot)).toBe('ask')
    expect(pm.checkToolPermission('Edit', { file_path: 'src/main.ts' }, workspaceRoot)).toBe('allow')
  })

  it('写入 workspace 外路径应 deny', () => {
    const outsidePath = path.resolve('/tmp/outside.txt')
    expect(pm.checkToolPermission('Edit', { file_path: outsidePath }, workspaceRoot)).toBe('deny')
    expect(pm.checkToolPermission('Write', { file_path: outsidePath }, workspaceRoot)).toBe('deny')
  })
})
```

- [ ] **Step 7: Delete obsolete test files + fix path string**

```bash
git rm src/tests/search-read-tools.test.ts src/tests/apply-patch-tool.test.ts
```
在 `src/tests/verification-strategy-service.test.ts` 中，将路径字符串 `'src/main/tools/builtin/ApplyPatchTool.ts'` 替换为 `'src/main/tools/builtin/EditTool.ts'`。

- [ ] **Step 8: typecheck + full test**

Run: `npm run typecheck`
Expected: 无错误（确认无残留旧导入）。
Run: `npm test`
Expected: 全绿（含新工具测试 + 改写后的 permission-manager 测试；旧名测试已删/改）。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(tools): register 11 Claude tools, delete legacy read_files/apply_patch/run_command/search, retire old names"
```
