# ADR 0004: Rust Shell parser 与兼容策略

> 状态：Accepted
>
> 日期：2026-07-16

## 背景

Phase 0 要求用现有 Bash/PowerShell 权限语料验证 Rust tree-sitter。Shell 解析结果直接影响危险命令识别、路径影响分析和审批，不能因为迁移到 Rust 而把合法命令误判为不可解析，也不能因错误恢复节点不同而漏掉高风险操作。

当前 TypeScript 实现不是裸 grammar：它对 PowerShell native option、参数列表、scoped package 等 grammar quirks 做等长掩码，对 Bash Windows drive path 做等长掩码，并在 PowerShell grammar 报错时调用原生 PowerShell AST 验证和提取 command。

## 决策

Phase 5 固定以下同版本 Rust parser 依赖作为迁移起点：

- `tree-sitter 0.25.10`
- `tree-sitter-bash 0.25.0`
- `tree-sitter-powershell 0.25.10`

这些版本与当前 JavaScript/WASM parser 版本一致，但禁止直接使用裸 grammar 结果替代 `ShellAnalysisService`。Rust 实现必须同时迁移：

- PowerShell quirks 等长掩码，包括 native long option/terminator、cmdlet comma argument list 和 scoped package。
- Bash Windows drive path 等长掩码，保持 node byte range 可映射回原命令。
- PowerShell 原生 AST fallback；Windows 使用系统 PowerShell，其他平台仅在可信 `pwsh` 可用时启用。
- command node 提取、argv normalization、环境赋值剥离、静态 invocation operator 和 dynamic wrapper 检测。
- parser timeout、输出上限、缓存上限、进程 owner 和退出清理。
- 解析失败或动态结果的安全默认，绝不因 parser 不可用而绕过 hardline、路径或副作用检查。

tree-sitter 依赖在 Phase 0 仅作为 `codez-platform` dev dependency；Phase 5 生产实现应位于权限/平台边界确定的 crate，提升依赖前需重新检查架构方向。

## 证据

共享脱敏语料共 29 条，当前 TypeScript parser 对预期有效性为 29/29：

- 裸 Rust parser 完全一致 18/29。
- Bash 12/13 完全一致；唯一差异是 Windows drive path，需要现有等长 mask。
- PowerShell 6/16 完全一致；9 条合法命令被裸 grammar 误报语法错误。
- 另 1 条非法 PowerShell 命令的有效性一致，但错误恢复 operation/dynamic 形状不同。
- 总计 10 条 syntax validity 差异、4 条 executable 差异和 4 条 dynamic flag 差异。

详细逐条结果位于 `docs/migration/generated/shell-parser-diff.json`，生成方法和限制见 `docs/migration/spikes/rust-shell-parser.md`。

## 后果

- 采用 Rust tree-sitter 可复用当前 grammar 语义和字节范围，但兼容 adapter 是安全必需项，不是可选优化。
- 不能通过升级到未验证的 grammar 版本猜测修复；任何升级都必须重新生成差异报告并运行危险命令语料。
- 原生 PowerShell fallback 是 Windows 准确性依赖，Phase 5 必须为其定义超时、输出上限、缓存和失败分类。
- macOS/Linux 缺少 `pwsh` 时，复杂 PowerShell 输入保持 `unparsed/dynamic` 安全状态，不伪装为成功解析。
- 本 ADR 关闭 parser 选型风险，不代表 Phase 5 权限迁移已经完成。
