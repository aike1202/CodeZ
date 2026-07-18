# Codex `apply_patch`

## 当前可见输入

`apply_patch` 接收一段专用 patch 文本：

```diff
*** Begin Patch
*** Update File: path/to/file
@@
-old
+new
*** Add File: path/to/new
+content
*** Delete File: path/to/old
*** End Patch
```

基础指令要求手工文件编辑使用 `apply_patch`，不要用 shell `cat`/重定向写文件。格式化或批量机械改写可以使用专用 formatter。

## 真实 rollout 证据

本机子线程 rollout 保存了：

- `custom_tool_call(name="exec")`
- `exec` 输入中的 `tools.apply_patch(patch)`
- `patch_apply_end` 事件
- success、stdout/stderr
- 每个文件的 unified diff 和 change type

因此 patch 的审计信息比普通 shell 写入更完整，宿主可以直接构建 diff UI。

## 能确认与不能确认

能确认：patch parser 校验 hunk、应用成功后返回修改文件列表，rollout 记录结构化 diff。

不能从当前证据确认：内部 fuzzy matching 算法、文件 mtime/CAS 策略、换行归一化细节、最大 patch 大小和所有错误恢复规则。没有源码时不应把 GNU patch、git apply 或其他实现细节写成事实。

## 与 Read 的关系

Codex prompt 建议先理解代码再编辑，但当前工具 schema 没有可见字段证明某文件已被 Read。并发 Agent 共享 filesystem 时，父 Agent 必须靠任务分区、工作树隔离或重新读取 diff 避免覆盖，不能依赖工具自动解决所有写冲突。
