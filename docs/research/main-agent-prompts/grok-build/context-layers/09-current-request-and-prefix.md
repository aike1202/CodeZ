# 09 首条 User Prefix 与当前请求

## 定义

“首条 user prefix”是 host 在用户原始问题之前自动构造的 user-role 文本。它不是用户输入，也不是基础 system prompt。

## Minimal Prefix 全文

```text
<user_info>
OS Version: {os}
Shell: {shell}
Workspace Path: {cwd}
Today's date: {today}
Note: Prefer using relative paths over absolute paths as tool call args when possible.
</user_info>
```

## Full Prefix

Full 版本在 user_info 后追加可选 Git 或 Jujutsu 快照：

```text
<git_status>
This is the git status at the start of the conversation. Note that this status
is a snapshot in time, and will not update during the conversation.
{status}
</git_status>
```

VCS 查询失败、超时或没有仓库时省略该 block。

## 当前用户请求

原始文本由 `user_query()` 包装：

```text
<user_query>
{user_message}
</user_query>
```

所以第一条实际 user content 通常是：

```text
<user_info>...</user_info>
<git_status>...</git_status>
<user_query>用户真正输入的问题</user_query>
```

Project rules、skills、MCP 和 terminal information 可由更高层 custom template/reminder 扩展，但不属于 minimal `construct_user_message()` 固定正文。
