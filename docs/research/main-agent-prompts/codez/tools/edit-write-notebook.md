# Edit、Write 与 NotebookEdit

## 共同事务边界

三个写工具不直接 `fs::write` 后返回。共同路径是：

```text
resolve path
-> verify authorized WriteFile effect
-> require ToolFileServices
-> acquire mutation coordination/resource lock
-> verify current Read delivery/fingerprint when modifying existing content
-> prepare mutation transaction
-> snapshot current state and stage backup
-> compute complete new bytes in memory
-> write through trusted FileSystem port
-> verify/reconcile result
-> record successful mutation and refresh fingerprint
-> abort/reconcile backup on failure
```

`interrupt = Block` 表示进入关键写阶段后，不用普通 cancellation 在半事务中截断；目标是让 mutation 走完或完成回滚/对账。

## Edit 核心算法

```text
load current UTF-8 file
for each edit in the ordered edits array
  -> old_string must be non-empty
  -> count exact matches in the current intermediate content
  -> replace_all=false: require exactly one match
  -> replace_all=true: require at least one match and replace all
  -> update intermediate content
only after every edit validates
  -> stage backup and commit one file mutation
```

因此一个调用中的多项 edit 是有顺序的，后项针对前项后的中间文本。任一项不唯一/不存在时，不应留下部分替换。

## Write 核心算法

```text
resolve target
-> classify create or overwrite
-> for overwrite, require current delivered state
-> stage absent/file state backup
-> write complete UTF-8 content
-> record new digest and mutation history
```

Write 适合新文件或明确全量替换。它不会因为 schema 接受任意 string 就绕过路径、授权和 stale-state 检查。

## NotebookEdit 核心算法

NotebookEdit 是 Deferred 工具，必须先由 ToolSearch 激活。它：

```text
read and parse .ipynb as JSON object
-> validate cells array and bounded notebook
-> locate one cell by cell_id or cell_index
-> mode=replace: replace selected cell source, optionally cell_type
-> mode=insert: insert a newly validated cell at index
-> mode=delete: remove selected cell
-> preserve unrelated notebook metadata and cells
-> serialize structured JSON
-> commit through the same mutation transaction path
```

它不使用字符串替换修改 notebook。`new_source` 会按 notebook cell source 结构归一化，cell type 只能是 code/markdown/raw。

## 并发

三者都产生按 canonical path 的 write resource key，Scheduler 不能把写同一文件的调用放进同一并行 wave。Agent Executor 的 `allowedWriteFiles` 与这里的真实 path authorization 是不同层；当前 Durable Agent 根本不暴露这些写工具。
