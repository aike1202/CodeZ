# Claude Code `Grep`

来源：`src/tools/GrepTool/prompt.ts`、`GrepTool.ts`。

## 输入 schema

| 字段 | 语义 |
|---|---|
| `pattern` | ripgrep 正则 |
| `path` | 文件或目录，默认 cwd |
| `glob` | 文件 glob 过滤 |
| `type` | ripgrep 文件类型 |
| `output_mode` | `content`、`files_with_matches`、`count`；默认 files |
| `-B` / `-A` / `-C` | 前/后/双向上下文行 |
| `-n` | content 模式是否显示行号 |
| `-i` | 忽略大小写 |
| `multiline` | 启用跨行匹配 |
| `head_limit` | 返回前 N 项；默认 250，显式 0 表示不限 |
| `offset` | 跳过前 N 项，用于分页 |

## 执行方式

工具构造 ripgrep 参数，而不是调用 shell 拼字符串。它处理路径、glob/type、上下文和输出模式，并排除常见 VCS 目录。专用工具能把搜索权限和输出格式稳定下来，因此 prompt 明确要求不要通过 Bash 运行 `grep`/`rg`。

## 模式语义

- `files_with_matches`：默认，只返回文件路径，最节省上下文。
- `content`：返回匹配行及可选上下文。
- `count`：按文件返回计数。

`offset + head_limit` 构成结果分页。默认 250 是模型可见输出预算，不等于 ripgrep 的底层总匹配数量。

## 大结果处理

当结果文本超过约 20,000 字符时，完整输出会持久化到 tool-results 文件，模型收到截断预览和路径。这个设计把“可审计完整结果”和“本轮上下文预算”分开，适合 CodeZ 借鉴。

## 与 Explore 的边界

当前工具描述建议开放式、需要多轮的搜索使用 Agent。更严格的 Explore prompt 又规定简单定向查询直接使用 Glob/Grep，预计超过约 3 次查询或简单搜索不足时才升级。决定是否委派的门槛应由主 Agent policy 负责，不能只靠 Grep 工具的一句描述。
