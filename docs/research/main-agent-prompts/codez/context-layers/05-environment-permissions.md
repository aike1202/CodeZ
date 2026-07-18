# 05 环境与权限

## 当前本机 Provider/模型

```yaml
provider_id: pv_019f6fae4e957b4292228e0bb32182eb
provider_name: Sub2Api
base_url: http://127.0.0.1:7070/v1
api_format: openai
model_id: m_1784285065604_bmdh
model_name: gpt-5.6-sol
context_window_tokens: 400000
supports_vision: true
thinking_enabled: true
thinking_mode: auto
thinking_effort: auto
permission_mode: full-access
```

凭据只通过 OS credential store 解析，不写入调研文档、Ledger 或 request fingerprint 输入。

## Environment 模块格式

```text
# Environment
- Primary working directory: F:\MyProjectF\CodeZ
- Platform: windows
- Shell: PowerShell (primary); Bash tool also available for POSIX scripts
- OS: windows
- Date: 2026-07-18
- Model: gpt-5.6-sol (m_1784285065604_bmdh)
- Context window: 400000 tokens
- Session: <session-id>
- API format: openai
- Permission mode: full-access
- Extended thinking: enabled
```

## 权限不是一条 Prompt

实际工具执行顺序为：

```text
normalize input
-> canonical name and schema validation
-> exposure check
-> effect planning
-> permission decision
-> resource scheduling
-> execute
-> large-result processing
-> journal
```

`full-access` 改变授权决策，但不会绕过 schema、workspace authority、Agent allowlist、Reviewer shell 白名单或文件事务一致性检查。

## PowerShell 授权事故的当前修正

当前 dirty change 为 `ToolHandler` 增加 `normalize_input()`，`PowerShellTool` 在权限分析前剥离以下旧前缀：

```text
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 > $null
```

因此模型应只传业务命令。此前把编码初始化与 `npm run typecheck` 等命令拼在一起，会使 shell parser 无法完整分类，从而触发 runtime-policy 授权提示或拒绝。
