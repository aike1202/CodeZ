# 03. 核心概念

> 模块：Workspace、Agent Session、Task、Tool、Permission、Diff 等基础概念定义

---

## 1. Workspace

Workspace 指用户通过桌面应用打开的本地代码项目目录。

一个 Workspace 包含：

- 项目根目录；
- 文件树；
- Git 状态；
- 项目配置文件；
- Agent 任务历史；
- 项目记忆；
- 本地索引。

Workspace 是 Agent 读写文件、运行命令和构建上下文的边界。默认情况下，Agent 不能访问 Workspace 之外的文件。

---

## 2. Agent Session

Agent Session 指用户与 Agent 围绕某个任务或连续上下文进行的一段对话。

一个 Session 包含：

- 用户输入；
- Agent 回复；
- 模型调用记录；
- 工具调用记录；
- 文件读写记录；
- 命令执行记录；
- 任务计划；
- diff 结果；
- 验证结果。

Session 的作用是支持上下文连续对话、任务追踪和后续恢复。

---

## 3. Task

Task 指用户希望 Agent 完成的一个明确开发目标，例如：

- “给登录接口添加 JWT 验证”；
- “修复构建错误”；
- “帮我生成 README”；
- “添加一个设置页面”；
- “把项目从 JavaScript 改成 TypeScript”。

每个 Task 需要具备：

- 目标描述；
- 当前状态；
- 子任务列表；
- 涉及文件；
- 验收条件；
- 执行日志。

Task 状态建议包括：

- pending；
- planning；
- waiting_permission；
- running；
- waiting_diff_approval；
- verifying；
- completed；
- failed；
- cancelled。

---

## 4. Tool

Tool 是 Agent 可以调用的能力。模型本身不能直接操作用户电脑，必须通过工具系统间接完成读文件、搜索、编辑和命令执行。

典型工具包括：

- `read_file`；
- `write_file`；
- `edit_file`；
- `list_files`；
- `search_text`；
- `run_command`；
- `git_status`；
- `git_diff`。

工具必须具备：

- 名称；
- 描述；
- 参数 schema；
- 权限等级；
- 执行函数；
- 返回结构；
- 错误处理。

---

## 5. Permission

Permission 是用户对 Agent 操作的授权机制。

所有高风险操作必须由用户确认，例如：

- 写入文件；
- 删除文件；
- 执行命令；
- 访问网络；
- 安装依赖；
- Git commit；
- Git push。

Permission 的目标是保证用户始终控制 Agent 对本地项目和系统的影响。

---

## 6. Diff

Diff 是 Agent 对文件的修改建议。系统应当优先以 diff 形式展示变更，用户确认后才写入最终文件。

Diff 应支持：

- 按文件查看；
- side-by-side 查看；
- inline 查看；
- 单文件接受；
- 全部接受；
- 单文件拒绝；
- 全部拒绝；
- 复制 diff。

---

## 7. Verification

Verification 指 Agent 完成修改后的验证环节，包括：

- TypeScript 类型检查；
- 单元测试；
- lint；
- build；
- 运行用户指定命令；
- 读取错误日志并修复。

没有验证结果的任务不能算作高质量完成。
