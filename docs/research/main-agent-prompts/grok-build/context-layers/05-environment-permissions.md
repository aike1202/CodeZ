# 05 环境与权限

## 环境

环境主要位于第一条 user prefix：OS、shell、workspace display path、当地日期和可选 Git/Jujutsu status。Remote workspace 可通过 `UserInfoOverride` 提供另一组值。

VCS 状态计算有 2 秒 timeout；失败或非仓库时整个 status block 省略。状态明确标注为会话开始快照，不会自动随每次修改更新。

## 权限/Capability

Grok 的工具层声明 `ToolScope::Read/Write`、`is_read_only`、requires dependencies 和 Agent `capability_mode`。Host 还可提供 filesystem/network/managed deny globs、sandbox 和 worktree isolation。

例如 Grep 将 `DenyReadGlobs` 追加为最后的 excludes；SearchReplace 拒绝 current contract 下的 gitignored 文件；Task 根据 capability 和 parent type 重新选择 child toolset。

## 可见性

环境 prefix 对模型可见；permission manager 的完整匹配状态未必作为文本可见。日志必须保存 effective capability、rule decision、执行是否开始和 output projection。
