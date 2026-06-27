# 📝 开发计划 - 阶段 6：文件编辑与命令执行能力

> 关联需求：阶段6文件编辑与命令执行能力-requirements.md
> 迭代：iteration-7
> 全局进度参阅：.continue/index.md

## 整体技术与架构总览

本阶段旨在为 Agent 增加修改工作区文件和执行命令的能力，所有的修改操作将自动接入阶段 5 实现的事务管理服务 (`EditTransactionService`)，以保证修改过程的安全性与可逆性。架构分为三部分：

1. **全新文件编辑工具**：新增 `WriteToFileTool`（用于新建/覆盖写入文件）和 `ReplaceFileContentTool`（用于精确替换局部代码段）。
2. **命令执行工具**：新增 `RunCommandTool`，底层基于 Node.js 的 `child_process.exec`。
3. **集成与防守**：确保所有写文件操作前触发 `backupFile`；确保所有操作（文件路径、工作路径）都在当前 `workspaceRoot` 内，防止越权；处理超长终端输出的截断防越限问题。

## 阶段与任务大纲

**目标**：开发并注册 `write_to_file`、`replace_file_content` 和 `run_command` 三大高危能力工具，打通从修改到验证的闭环。

✅ 第一阶段 · 文件编辑能力实现
  ✅ 1、实现 `WriteToFileTool` 工具
     - 详细设计：
       - 落点文件：`src/main/tools/builtin/WriteToFileTool.ts`
       - 功能：接收 `targetFile`、`codeContent`、`overwrite` 参数。
       - 逻辑：验证 `targetFile` 必须位于 `workspaceRoot` 内；若文件已存在且未设置 `overwrite=true`，则报错；在修改前，如果 `context.transactionId` 和 `editTransactionService` 存在，调用 `backupFile` 记录备份；使用 `fs.mkdir` 递归创建目录，然后使用 `fs.writeFile` 写入文件内容。
  ✅ 2、实现 `ReplaceFileContentTool` 工具
     - 详细设计：
       - 落点文件：`src/main/tools/builtin/ReplaceFileContentTool.ts`
       - 功能：接收 `targetFile`、`targetContent`、`replacementContent` 参数。
       - 逻辑：验证路径安全；读取原文件内容，精准查找 `targetContent`；若找不到或存在多个匹配项（无法区分目标），则直接报错提示模型提供更精确的上下文。查找成功后，调用 `backupFile` 备份；替换内容并写回磁盘。

✅ 第二阶段 · 命令执行能力实现
  ✅ 3、实现 `RunCommandTool` 工具
     - 详细设计：
       - 落点文件：`src/main/tools/builtin/RunCommandTool.ts`
       - 功能：接收 `commandLine`、`cwd` 参数。
       - 逻辑：将 `cwd` 相对路径解析为绝对路径，确保其在 `workspaceRoot` 范围内；引入 `child_process` 模块；使用 `exec` 执行该命令；为防止挂起，设置默认 30s 超时时间 (`timeout` 参数)。捕获 stdout、stderr、exit code，拼接为友好字符串返回；若输出超过 5000 字符，进行首尾截断（借用之前逻辑或自行裁剪）。

✅ 第三阶段 · 工具集成与验证测试
  ✅ 4、在 `ToolManager` 注册新工具
     - 详细设计：
       - 落点文件：`src/main/tools/ToolManager.ts`
       - 逻辑：导入并实例化上述三个工具类，添加到 `builtinTools` 数组中。
  ✅ 5、编译与自动测试
     - 详细设计：运行 `npm run typecheck` 和 `npm run build`，确保类型和构建 100% 成功。编写或运行集成验证测试（TDD/手动验证）。

### 验收&测试点
  ✅ 1、写文件测试：调用 `write_to_file` 在工作区新建一个脚本，内容包含简单输出，确认事务备份是否产生，文件是否建立。
  ✅ 2、局部修改测试：调用 `replace_file_content` 替换文件中的特定函数名，确认内容生效，并且出现多个同名函数时不发生误替换。
  ✅ 3、命令执行与事务回滚测试：调用 `run_command` 执行该脚本；之后调用 `rollback_last_edit` 工具，验证新写的文件被安全移除/恢复。
  ✅ 4、边界安全测试：尝试读写 `../` 超出工作区的目录，断言抛出越权错误。

## 变更记录
| 时间 | 变更内容 | 调整原因 |
|------|----------|----------|
| 2026-06-26 12:10 | 初始创建计划 | 进入阶段 6 计划/任务拆解 |
