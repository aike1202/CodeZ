### Task 15: PermissionManager 清理死引用 + 新增 Claude 名映射

**Files:**
- Modify: `src/main/services/PermissionManager.ts`
- Test: `src/tests/permission-manager-claude-names.test.ts`（新建；既有 `permission-manager.test.ts` 本任务不动，Task 16 再随旧工具删除一并收口）

**Interfaces:**
- Consumes: 既有 `PermissionManager` 单例（`checkToolPermission`/`createPermissionRequest`/`getCommandRisk`/`getCommandFromArgs`）。
- Produces: `checkToolPermission` 与 `createPermissionRequest` 行为更新（见下），无新导出。
- 映射规则（实现后）：
  - `allow`：`search, list_files, read_files, get_project_snapshot, fast_context`（既有）+ `Read, NotebookEdit, Glob, Grep, Skill, PushNotification, AskUserQuestion`（新增）。
  - `rollback_last_edit` → `ask`（既有）。
  - 写工具（workspace 内 `allow`、越界 `deny`）：`apply_patch, Edit, Write`（移除死引用 `write_to_file/replace_file_content/multi_replace_file_content`）。
  - 命令类（复用 `getCommandRisk`）：`run_command, Bash, PowerShell`（safe→allow，其余→ask）。
  - 默认 → `ask`。
- `createPermissionRequest`：命令类分支扩到 `run_command/Bash/PowerShell`；写工具分支改为 `apply_patch/Edit/Write`；死引用移除。

**说明：** `AskUserQuestion`→`allow`（不触发通用 permission 卡片；AgentRunner 在 Task 14 已专门拦截起 AskUser UI）。`Bash/PowerShell` 复用 `getCommandFromArgs`（已支持 `command` 字段）。本任务**保留** `read_files/apply_patch/run_command/search` 旧名映射，待 Task 16 删除旧工具时一并移除并改写 `permission-manager.test.ts`。

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/permission-manager-claude-names.test.ts
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { PermissionManager } from '../main/services/PermissionManager'

describe('PermissionManager — Claude 工具名映射', () => {
  const pm = PermissionManager.getInstance()
  const ws = path.resolve('/tmp/codez-ws')

  it('只读/无破坏工具 allow', () => {
    for (const name of ['Read', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'PushNotification', 'AskUserQuestion']) {
      expect(pm.checkToolPermission(name, {}, ws)).toBe('allow')
    }
  })

  it('Edit/Write：workspace 内 allow，越界 deny', () => {
    expect(pm.checkToolPermission('Edit', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
    expect(pm.checkToolPermission('Write', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('allow')
    expect(pm.checkToolPermission('Edit', { file_path: path.resolve('/tmp/outside.ts') }, ws)).toBe('deny')
    expect(pm.checkToolPermission('Write', { file_path: path.resolve('/tmp/outside.ts') }, ws)).toBe('deny')
  })

  it('Bash/PowerShell 复用 getCommandRisk', () => {
    expect(pm.checkToolPermission('Bash', { command: 'npm test' }, ws)).toBe('allow')
    expect(pm.checkToolPermission('Bash', { command: 'npm install' }, ws)).toBe('ask')
    expect(pm.checkToolPermission('Bash', { command: 'rm -rf dist' }, ws)).toBe('ask')
    expect(pm.checkToolPermission('PowerShell', { command: 'npm run typecheck' }, ws)).toBe('allow')
    expect(pm.checkToolPermission('PowerShell', { command: 'curl http://x' }, ws)).toBe('ask')
  })

  it('死引用已移除：write_to_file 不再走写工具分支（落入默认 ask）', () => {
    expect(pm.checkToolPermission('write_to_file', { file_path: path.join(ws, 'a.ts') }, ws)).toBe('ask')
    expect(pm.checkToolPermission('replace_file_content', {}, ws)).toBe('ask')
    expect(pm.checkToolPermission('multi_replace_file_content', {}, ws)).toBe('ask')
  })

  it('createPermissionRequest：Bash/PowerShell 计算 risk 与 description', () => {
    const r1 = pm.createPermissionRequest('Bash', { command: 'npm install' })
    expect(r1.risk).toBe('write')
    expect(r1.description).toContain('npm install')
    const r2 = pm.createPermissionRequest('Edit', { file_path: 'a.ts' })
    expect(r2.risk).toBe('write')
    expect(r2.description).toContain('a.ts')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/permission-manager-claude-names.test.ts`
Expected: FAIL（`Read` 等新名当前落入默认 `ask`，断言不通过）。

- [ ] **Step 3: Update checkToolPermission**

在 `src/main/services/PermissionManager.ts` 的 `checkToolPermission` 中：

3a. 将只读白名单行（`:47`）替换为：
```ts
    if (['search', 'list_files', 'read_files', 'get_project_snapshot', 'fast_context', 'Read', 'NotebookEdit', 'Glob', 'Grep', 'Skill', 'PushNotification', 'AskUserQuestion'].includes(toolName)) {
      return 'allow'
    }
```

3b. 将写工具列表行（`:56`）替换为（移除死引用、加 `Edit/Write`）：
```ts
    if (['apply_patch', 'Edit', 'Write'].includes(toolName)) {
```

3c. 将 `run_command` 分支扩到 `Bash/PowerShell`：
```ts
    if (['run_command', 'Bash', 'PowerShell'].includes(toolName)) {
      const risk = this.getCommandRisk(this.getCommandFromArgs(parsedArgs))
      if (risk === 'safe') return 'allow'
      return 'ask'
    }
```

- [ ] **Step 4: Update createPermissionRequest**

将 `createPermissionRequest` 中的两个分支替换为：
```ts
    if (toolName === 'run_command' || toolName === 'Bash' || toolName === 'PowerShell') {
      const cmd = this.getCommandFromArgs(parsedArgs)
      risk = this.getCommandRisk(cmd)
      description = `Execute command: ${cmd}`
    } else if (['apply_patch', 'Edit', 'Write'].includes(toolName)) {
      const targetPath = parsedArgs?.file_path || parsedArgs?.filePath || parsedArgs?.TargetFile || parsedArgs?.path || 'unknown path'
      risk = 'write'
      description = `Modify file: ${targetPath}`
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tests/permission-manager-claude-names.test.ts`
Expected: PASS（5 例全绿）。
Run: `npx vitest run src/tests/permission-manager.test.ts`
Expected: PASS（既有 5 例仍绿——旧名映射保留）。

- [ ] **Step 6: Commit**

```bash
git add src/main/services/PermissionManager.ts src/tests/permission-manager-claude-names.test.ts
git commit -m "feat(permissions): map Claude tool names, remove dead refs (write_to_file/replace_file_content/multi_replace_file_content)"
```
