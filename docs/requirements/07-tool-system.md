# 07. 工具调用系统

> 模块：文件工具、搜索工具、写入工具、命令工具、Git 工具

---

## 1. 工具系统目标

模型不能直接操作用户电脑，所有本地能力都必须通过工具系统提供。工具系统需要做到：

- 能被 Agent 调用；
- 参数可校验；
- 权限可控制；
- 结果可记录；
- 错误可解释；
- 可扩展新工具。

---

## 2. 工具基础结构

建议工具接口：

```ts
interface Tool<TArgs = unknown, TResult = unknown> {
  name: string
  description: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  parametersSchema: unknown
  execute(args: TArgs, context: ToolExecutionContext): Promise<TResult>
}
```

---

## 3. 文件读取工具

### 功能编号

F12

工具名建议：`read_file`

### 要求

- 只能读取当前 Workspace 内文件；
- 需要处理大文件截断；
- 需要返回行号；
- 需要识别二进制文件并拒绝读取；
- 需要记录读取日志；
- 敏感文件默认禁止读取或需要用户确认。

---

## 4. 文件列表工具

### 功能编号

F13

工具名建议：`list_files`

### 要求

- 支持按目录列出；
- 支持 glob 匹配；
- 支持忽略 `.gitignore`；
- 支持限制返回数量；
- 返回文件类型、大小、更新时间等基础信息，可选。

---

## 5. 文本搜索工具

### 功能编号

F14

工具名建议：`search_text`

### 要求

- 支持关键词搜索；
- 支持正则搜索；
- 支持限定文件类型；
- 支持返回上下文行；
- 支持结果数量限制；
- 默认跳过二进制文件、依赖目录和构建产物。

---

## 6. 文件写入工具

### 功能编号

F15

工具名建议：`write_file`

### 要求

- 默认不直接覆盖用户文件；
- 写入前生成 diff；
- 用户确认后应用；
- 对新文件写入可单独确认；
- 写入后记录变更；
- 应用前检查文件是否被外部修改。

---

## 7. 精确编辑工具

### 功能编号

F16

工具名建议：`edit_file`

### 要求

- 支持基于 old/new 字符串替换；
- 支持 patch/diff 应用；
- 编辑失败时返回明确原因；
- 避免整文件重写造成无关变更；
- 必须保留文件换行风格；
- old_string 必须唯一，避免误替换。

---

## 8. 命令执行工具

### 功能编号

F17

工具名建议：`run_command`

### 要求

- 默认工作目录为 Workspace 根目录；
- 命令执行前展示命令和目的；
- 用户确认后执行；
- 支持超时；
- 支持终止命令；
- 捕获 stdout/stderr；
- 高风险命令需要额外确认。

高风险命令包括但不限于：

- 删除目录或大量文件；
- 格式化磁盘；
- 修改系统配置；
- 向远程推送；
- 安装全局依赖；
- 执行未知远程脚本。

---

## 9. Git 工具

### 功能编号

F18

工具名建议：

- `git_status`；
- `git_diff`；
- `git_branch`；
- `git_log`。

### 要求

- 支持查看状态；
- 支持查看 diff；
- 默认不自动 commit；
- 默认不自动 push；
- commit 和 push 必须用户主动确认；
- Git 工具必须在 Workspace 内运行。

---

## 10. 工具调用日志

每一次工具调用都需要记录：

- toolName；
- args，敏感字段脱敏；
- startTime；
- endTime；
- status；
- result 摘要；
- error；
- permissionDecision，可选。
