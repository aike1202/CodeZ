### Task 17: 渲染端工具名接线（Edit/Write/Read/Bash/Grep/Glob/NotebookEdit 渲染对齐）

**Files:**
- Modify: `src/renderer/src/utils/editDiffUtils.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLogUtils.ts`
- Modify: `src/renderer/src/components/chat/ExecutionLogDetail.tsx`
- Modify: `src/renderer/src/components/chat/ChatArea.tsx`
- Modify: `src/renderer/src/components/chat/PermissionApprovalWidget.tsx`
- Test: 手动验收（渲染端无单测；`npm run typecheck` + `npm run build` 通过即门槛）

**Interfaces:**
- Consumes: Task 16 已删除旧工具名；新工具的 args 形态：`Read{file_path,offset,limit}`、`Edit{file_path,old_string,new_string}`、`Write{file_path,content}`、`NotebookEdit{notebook_path,cell_id,...}`、`Bash/PowerShell{command,...}`、`Grep{pattern,...}`、`Glob{pattern,path}`。
- Produces: 渲染端把新名映射到既有渲染路径——`Edit/Write/NotebookEdit` 走编辑/ Accept-Reject 渲染（原 `apply_patch` 路径）、`Read` 走文件分析渲染（原 `read_files` 路径）、`Bash/PowerShell` 走命令终端渲染（原 `run_command` 路径）、`Grep` 走搜索渲染、`Glob` 走目录探索渲染。

**说明：** 旧名分支（`apply_patch/read_files/run_command/search/write_to_file/...`）随 Task 16 删除已不会再触发，本任务在其旁补新名分支即可，旧名分支可保留为死代码或一并移除（建议移除以净）。`Edit/Write` 返回 JSON `{changedFiles,diff,summary,fileHashAfter}`（Task 3/4），与原 `apply_patch` 同形，故 Accept/Reject 流只需扩工具名判定。

**预存 typecheck 基线（不在本计划范围）：** 截至本任务，`npm run typecheck` 有 7 个**先于本计划存在**的错误，均与本工具对齐无关：
- `ExecutionLog.tsx:146/153` — `FolderIcon/FileIcon` 未导入；
- `ExecutionLogDetail.tsx:46/58/154` — `<FolderIcon />` 缺 `folderName`；
- `ExecutionLogUtils.ts:51` — `FileIcon` createElement 缺必填 prop；
- `PromptArea.tsx:65` — `window.api.workspace.getAllPaths` 已从 preload 移除。
本任务**不修这些预存错误**（超出工具对齐范围），只做新名接线，并**不得引入新错误**。Task 17 完成后，typecheck 错误数应仍为 7（不增），且新接线代码本身类型干净。

- [ ] **Step 1: Extend editDiffUtils.ts**

1a. `getFilePathFromToolArgs` 加入 `file_path`（Edit/Write/NotebookEdit 用）：
```ts
function getFilePathFromToolArgs(args: string): string {
  const argsObj = parseArgs(args)
  return argsObj.file_path || argsObj.targetFile || argsObj.TargetFile || argsObj.filePath || argsObj.path || ''
}
```
（`notebook_path` 也归一：再加 `|| argsObj.notebook_path`。）

1b. `computeEditStats` 在 `apply_patch` 分支之后插入 Edit/Write 分支：
```ts
  } else if (toolName === 'Edit') {
    if (typeof argsObj.new_string === 'string') additions = `+${argsObj.new_string.split('\n').length}`
    if (typeof argsObj.old_string === 'string') deletions = `-${argsObj.old_string.split('\n').length}`
  } else if (toolName === 'Write') {
    if (typeof argsObj.content === 'string') additions = `+${argsObj.content.split('\n').length}`
  } else if (toolName === 'NotebookEdit') {
    if (typeof argsObj.new_source === 'string') additions = `+${argsObj.new_source.split('\n').length}`
  }
```

1c. `buildDiffEditInfo` 在 `apply_patch` 分支之后插入：
```ts
  if (toolName === 'Edit') {
    return { type: 'replace', targetContent: argsObj.old_string || '', replacementContent: argsObj.new_string || '' }
  }
  if (toolName === 'Write') {
    return { type: 'write', codeContent: argsObj.content || '' }
  }
  if (toolName === 'NotebookEdit') {
    return { type: 'replace', targetContent: '<notebook cell>', replacementContent: argsObj.new_source || '' }
  }
```

1d. `handleDiffClickForFile` 的工具名判定替换为：
```ts
    if (!['Edit', 'Write', 'NotebookEdit'].includes(t.name)) {
      return false
    }
```

- [ ] **Step 2: Extend ExecutionLogUtils.ts**

2a. `getToolTarget` 的 value 链（`:78-97`）开头加 `args.file_path ||` 与 `args.command ||`（供 Read/Edit/Write/Bash 取 target）：
```ts
  const value =
    args.file_path ||
    args.command ||
    args.DirectoryPath ||
    args.directoryPath ||
    ...（其余保持不变）
```

2b. `buildUnifiedTimeline` 内 `if (tc.name === 'read_files')` 块（`:245`）之前插入 Read 分支：
```ts
      if (tc.name === 'Read') {
        const argsObj = parseArgs(tc.args)
        const fp = argsObj.file_path || ''
        const offset = argsObj.offset
        const limit = argsObj.limit
        let targetText = fp || '文件'
        if (typeof offset === 'number') targetText += ` #L${offset}${typeof limit === 'number' ? `-${offset + limit - 1}` : '-'}`
        list.push({
          id: tc.id, type: 'tool', timestamp: tc.startedAt, status: tc.status,
          verb: tc.status === 'running' ? 'Analyzing' : 'Analyzed',
          target: targetText, realPath: fp, fileName: fp ? fp.split(/[/\\]/).pop() : undefined,
          args: tc.args, detail: tc.result, duration, toolName: tc.name
        })
      } else if (tc.name === 'read_files') {
```
（即把原 `if (tc.name === 'read_files')` 改为 `else if`，原块体不动。）

2c. 编辑工具判定（`:282`）替换为：
```ts
        if (['Edit', 'Write', 'NotebookEdit'].includes(tc.name)) {
          const { additions, deletions } = computeEditStats(tc.name, tc.args)
          list.push({
            id: tc.id, type: 'edit', timestamp: tc.startedAt, status: tc.status,
            verb: tc.status === 'running'
              ? (tc.name === 'Write' ? 'Creating' : 'Editing')
              : (tc.name === 'Write' ? 'Created' : 'Edited'),
            target, realPath: target, additions, deletions,
            fileName: target.split(/[/\\]/).pop(), detail: tc.result, args: tc.args, toolName: tc.name
          })
          return
        }
```

2d. 动词判定（`:332-342`）替换为（加 Grep/Glob/Bash/PowerShell/Read/NotebookEdit）：
```ts
        let verbDisplay: UnifiedTimelineItem['verb'] = 'Executed'
        if (tc.name === 'Grep' || tc.name === 'search') {
          verbDisplay = tc.status === 'running' ? 'Searching' : 'Searched'
        } else if (tc.name === 'Glob' || tc.name === 'list_files' || tc.name === 'list_dir') {
          verbDisplay = tc.status === 'running' ? 'Exploring' : 'Explored'
        } else if (tc.name === 'Bash' || tc.name === 'PowerShell' || tc.name === 'run_command') {
          verbDisplay = 'Terminal'
        } else if (tc.name === 'Read' || tc.name === 'read_files' || tc.name === 'get_project_snapshot' || tc.name === 'fast_context') {
          verbDisplay = tc.status === 'running' ? 'Analyzing' : 'Analyzed'
        } else {
          verbDisplay = tc.status === 'running' ? 'Executing' : 'Executed'
        }
```

2e. 命令 target/类型（`:358` 与 `:372`）替换为：
```ts
        if (tc.name === 'Bash' || tc.name === 'PowerShell' || tc.name === 'run_command') {
          try {
            const cmdArgs = JSON.parse(tc.args)
            targetDisplay = cmdArgs.command || cmdArgs.commandLine || target
          } catch { /* keep original target */ }
        }
```
```ts
          type: (tc.name === 'Bash' || tc.name === 'PowerShell' || tc.name === 'run_command') ? 'command' : 'tool',
```

- [ ] **Step 3: Extend ExecutionLogDetail.tsx**

3a. `read_files` 判定（`:68`）替换为兼容 Read 的单 file_path：
```ts
    if (item.toolName === 'read_files' || item.toolName === 'Read') {
      const argsObj = parseArgs(item.args || '')
      const filePaths = Array.isArray(argsObj.filePaths)
        ? argsObj.filePaths
        : (argsObj.file_path ? [argsObj.file_path] : [])
```
（其下逻辑不动。）

3b. `search` 判定（`:170`）与 `run_command` 判定（`:224`）扩新名：
```ts
    if (item.toolName === 'search' || item.toolName === 'Grep' || item.verb === 'Searched') {
```
```ts
    if (item.toolName === 'run_command' || item.toolName === 'Bash' || item.toolName === 'PowerShell' || item.verb === 'Terminal') {
```
（Grep 结果为纯文本，`parsedSearch.matches` 不存在时自动回退文本渲染，符合预期。）

- [ ] **Step 4: Extend ChatArea.tsx**

读取 `src/renderer/src/components/chat/ChatArea.tsx:40` 上下文（`extractMessageEdits` 内 `tc.name === 'apply_patch'` 判定），将该判定替换为：
```ts
              ['Edit', 'Write', 'NotebookEdit'].includes(tc.name)
```
并确保该处提取文件路径时读取 `tc.args` 中的 `file_path`（若原逻辑只读 `filePath/targetFile`，补 `file_path`）。

- [ ] **Step 5: Extend PermissionApprovalWidget.tsx**

5a. 编辑工具判定（`:99`）替换为：
```ts
            if (['Edit', 'Write', 'NotebookEdit'].includes(request.toolName)) {
```
5b. 在 diff 计算块内（`apply_patch` 分支之后）加 Edit/Write 分支：
```ts
              } else if (request.toolName === 'Edit') {
                additions = argsObj.new_string ? String(argsObj.new_string).split('\n').length : 0
                deletions = argsObj.old_string ? String(argsObj.old_string).split('\n').length : 0
              } else if (request.toolName === 'Write') {
                additions = argsObj.content ? String(argsObj.content).split('\n').length : 0
              } else if (request.toolName === 'NotebookEdit') {
                additions = argsObj.new_source ? String(argsObj.new_source).split('\n').length : 0
              }
```

- [ ] **Step 6: typecheck + build**

Run: `npm run typecheck`
Expected: 错误数 ≤ 7（预存基线，见上节"预存 typecheck 基线"），且**本任务新接线的代码不引入新错误**。具体：`ExecutionLog.tsx`/`PromptArea.tsx`/`ExecutionLogDetail.tsx`/`ExecutionLogUtils.ts` 之外的文件零错误；这四个文件中的错误须是预存的那 7 条，不得新增。
Run: `npm run build`
Expected: 构建成功（vite 构建不因类型错误阻断；渲染端类型/导入完整）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(renderer): wire new tool names (Read/Edit/Write/NotebookEdit/Bash/PowerShell/Grep/Glob) to existing render paths"
```
