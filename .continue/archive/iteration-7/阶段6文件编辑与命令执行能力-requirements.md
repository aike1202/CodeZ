# 📋 需求文档 - 阶段 6：文件编辑与命令执行能力

> 迭代：iteration-7
> 创建时间：2026-06-26 12:09
> 最后更新：2026-06-26 12:09
> 存放位置：.continue/current/阶段6文件编辑与命令执行能力-requirements.md

## 需求概述

**一句话描述**：为 Agent 赋予跨文件代码写入/修改工具，以及在终端执行项目验证命令的能力，彻底打通 Agent 从“阅读理解”到“动手修改、运行验证”的闭环。

**业务背景**：
在完成前面的基础构建、上下文优化以及事务回滚机制后，Agent 目前仍然只有“读”的权限。没有真正去写代码、跑测试的能力。参考项目的最初规划，我们需要实现写文件、局部编辑以及执行诸如 `npm run typecheck` 等命令的工具。

**预期价值**：
使 Agent 成为全功能的智能编码助手。Agent 不再仅仅能回答问题，而是能够直接把代码写入工作区，甚至能够帮用户运行测试并根据报错信息自我修复（Self-Correction Loop）。

## 功能需求

### 核心功能（必须实现）

- [ ] **F1: `write_to_file` 工具**
  - 输入：`targetFile`（文件路径）、`codeContent`（新文件内容）、`overwrite`（是否覆盖已有文件）。
  - 处理：若文件所在目录不存在则自动递归创建；在修改前调用上一阶段完成的 `EditTransactionService.backupFile` 做备份以支持回滚；将 `codeContent` 写入目标文件。
  - 输出：操作成功提示信息，或写操作失败时的错误详情。
  
- [ ] **F2: `replace_file_content` 工具（局部编辑）**
  - 输入：`targetFile`、`targetContent`（要被替换的原代码精确片段）、`replacementContent`（新代码段）。
  - 处理：通过精准匹配原代码片段来实现替换（支持解决缩进匹配问题）；在修改前调用 `EditTransactionService.backupFile` 做备份；如果找不到目标文本或者有多处重复则报错。
  - 输出：替换成功的确认信息。

- [ ] **F3: `run_command` 工具（终端命令执行）**
  - 输入：`commandLine`（要运行的命令，如 `npm test`）、`cwd`（工作目录）。
  - 处理：通过 `child_process.exec` 或 `spawn` 在对应的项目目录中执行命令。对于长时命令能够设置超时限制。
  - 输出：返回命令的 `stdout`、`stderr` 和 `exit_code` 给 Agent，供其判断执行是否成功。

### 扩展功能（可选实现）

- [ ] **E1: 命令执行的安全管控**
  - 对风险较高的命令（如 `rm -rf` 等）做基本拦截提示。
- [ ] **E2: Diff 预览机制（UI 层）**
  - 后续可以为 UI 面板补充 Diff 的可视化预览机制，让用户可以在接受前明确看到做了哪些变更（本阶段可先由工具直接执行，将审查重点放在事务回滚上）。

## 非功能需求

### 兼容性要求
- 文件路径处理必须兼容 Windows (`\`) 和 macOS/Linux (`/`)。
- 命令执行在 Windows 下要兼容 `cmd.exe` 或 `powershell` 的行为，在 Mac/Linux 下使用 `bash`。

### 安全要求
- **写操作的边界限制**：`write_to_file` 和 `replace_file_content` 必须严格限制在当前 `Workspace` 根目录内部，禁止向系统其他位置写入文件（防越权操作）。
- **工具权限（后续扩展）**：后续可加上“执行命令前需用户在界面上点击确认”的强行拦截逻辑。

## 验收标准

### 功能验收
- [ ] **AC1**: Agent 可以通过 `write_to_file` 工具成功在项目中创建一个新的 `.ts` 或 `.tsx` 文件。
- [ ] **AC2**: Agent 可以通过 `replace_file_content` 成功定位并修改现有文件中的某个类或函数的逻辑。
- [ ] **AC3**: Agent 可以调用 `run_command` 执行 `npm run typecheck`，并在遇到 TypeScript 报错时，读取 `stderr` 知道哪里出错了。
- [ ] **AC4**: 所有的写操作在调用前，都成功在 `userData/backup` 里生成了事务备份；调用 `rollback_last_edit` 能够精准撤销这批操作。

### 质量验收
- [ ] **Q1**: `npm run typecheck` 与 `npm run build` 成功。
- [ ] **Q2**: 新增的工具能够被大模型正确解析并稳定调用。
