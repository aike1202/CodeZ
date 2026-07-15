# Rust Shell parser 语料差异 spike

> 状态：通过，需迁移兼容 adapter 与原生 PowerShell fallback
>
> 日期：2026-07-16

## 目的

用确定性、脱敏的 Bash/PowerShell 权限语料比较当前 `ShellAnalysisService` 与 Rust tree-sitter 同版本 grammar，识别语法有效性、command 提取和 dynamic 标记差异。Spike 不替换生产权限判断。

## 输入与生成

- 共享语料：`src/tests/fixtures/permission-shell-corpus.json`
- Rust 分析器：`crates/codez-platform/examples/shell_parser_spike.rs`
- 差异生成器：`scripts/tauri/generate-shell-parser-diff.ts`
- 逐条报告：`docs/migration/generated/shell-parser-diff.json`

运行：

```powershell
npm.cmd run analyze:rust-shell-parser
```

生成器先运行固定版本 Rust example，再用当前 TypeScript parser 分析同一语料，最后比较 expected validity、syntax validity、normalized executable 顺序和 dynamic flags。报告无时间戳，重复生成应保持字节稳定。

## 语料范围

29 条语料来自现有 parser/权限测试所覆盖的结构，不包含用户会话或真实路径：

- PowerShell script block、pipeline、native long option/terminator、comma argument list、静态/动态 invocation、Cargo failure guard、Maven/Gradle wrapper、复杂 AST fallback、危险删除和非法输入。
- Bash compound/pipeline、环境赋值、Windows drive path、Maven/Gradle wrapper、command substitution、dynamic wrapper、here-document、redirect、危险删除和非法输入。

## 结果

| 指标 | 结果 |
| --- | --- |
| 语料总数 | 29 |
| 当前 TypeScript 对预期有效性 | 29/29 |
| 裸 Rust 完全一致 | 18/29 |
| Bash 完全一致 | 12/13 |
| PowerShell 完全一致 | 6/16 |
| Rust 预期有效性不一致 | 10 |
| syntax validity 差异 | 10 |
| executable 顺序差异 | 4 |
| dynamic flag 差异 | 4 |

差异分类：

- Bash 的唯一 syntax 差异是赋值后的 Windows `F:/...` 路径；当前实现通过等长替换 drive colon 规避 grammar 误报。
- PowerShell 9 条合法命令被裸 grammar 误报，集中在 native `--`、failure guard、comma argument list、复杂 hashtable/script block 和 wrapper options。
- PowerShell 原生 AST fallback 能恢复复杂合法命令，并提供比错误恢复 tree 更完整的 command 列表。
- 非法未闭合 quote 在两端都保持 invalid，但错误恢复 operation/dynamic 结构不能作为权限放行依据。

## 结论

固定 `tree-sitter 0.25.10`、`tree-sitter-bash 0.25.0` 和 `tree-sitter-powershell 0.25.10` 作为 Phase 5 起点。Rust 迁移必须移植当前等长 masks 和 native PowerShell AST fallback；裸 grammar 不满足权限等价性。

解析失败继续进入安全的 `unparsed/dynamic` 路径。差异报告只证明 parser 兼容边界，不证明 command policy、nested expansion、path impact 或 critical guard 已迁移。

## 验证边界

- 本轮只需要编译 Rust example、运行确定性差异生成器和 TypeScript 类型检查，不新增额外 Vitest 套件。
- 语料不执行任何 shell 命令，只解析字符串。
- 当前报告未覆盖 `cmd.exe` parser；现有 `CmdCommandParser` 迁移属于 Phase 5 权限实现。
- 真实历史 corpus analyzer 仍可用于本地研究，但其输入不进入版本库或生成报告。
