# Windows safeStorage compatibility spike

> 状态：Windows sentinel 验证通过，migration-only reader 与 fail-closed 凭据重录/重启链路已落地；真实旧安装升级/回退验收未完成
>
> 日期：2026-07-15

## 目的

验证 Electron `safeStorage.encryptString` 在 Windows 当前用户上下文产生的字节，能否由 Rust 通过 user-scoped DPAPI 直接解密。Spike 只使用固定 sentinel，不读取 `providers.json`、`mcp-secrets.secure`、`mcp-oauth.secure` 或任何真实密钥。

## 方法

1. `scripts/tauri/safe-storage-probe-electron.cjs` 在隔离的临时 userData 中使用 Electron 加密固定 sentinel，并将 Base64 密文写入临时文件。
2. `codez-storage` example 读取临时 `Local State`，通过 `windows-dpapi` 的安全 wrapper 解开 `os_crypt.encrypted_key`。
3. 对 `v10` envelope 使用 Local State 主密钥执行 AES-256-GCM 解密。
4. 只比较解密结果是否等于固定 sentinel；报告不记录真实密钥或用户密文，临时目录执行后删除。

## 结果

2026-07-15 在 Windows x64、同一用户上下文中验证通过：

1. Electron 密文不是裸 DPAPI blob；直接调用 `CryptUnprotectData` 返回 `ERROR_INVALID_DATA`。
2. 密文 envelope 以 ASCII `v10` 开头，布局为 `v10 + 12-byte nonce + ciphertext + 16-byte authentication tag`。
3. 隔离 userData 的 `Local State` 包含 Base64 `os_crypt.encrypted_key`，解码后以 `DPAPI` 为前缀。
4. Rust 去除 `DPAPI` 前缀并用当前用户 DPAPI 解开 256-bit 主密钥，再以 AES-256-GCM 解开 `v10` envelope，得到原始 sentinel。
5. 整个过程未读取或输出真实 Provider/MCP/OAuth 密钥，临时密文和隔离 userData 已删除。

Windows 迁移实现因此采用专用只读 legacy reader：读取旧 CodeZ `Local State` 与 Base64 密文，完成 DPAPI + AES-256-GCM 解密后立即写入新的 OS CredentialStore。legacy reader 不进入日常凭据 API，不用于新密钥加密。若 Local State 缺失、DPAPI 用户上下文不匹配、envelope 未知或 GCM 认证失败，则保留非敏感配置并标记 `requires_reentry`。

该 reader 现已实现在 `codez-storage` 的 migration 边界，并启用 AES 临时 key material 清零。Provider、MCP secret 与 MCP OAuth 只从 manifest 对应的已验证备份读取；迁移报告仅包含数据族、稳定凭据 ID、状态与原因码。Base64/明文 Provider 不进入新凭据库，OS 凭据库故障会中止并允许幂等重试。

这仍不是可交付的首次启动迁移。composition 在 repositories 构造前运行 migration coordinator；遇到 `AwaitingCredentials` 时只注册 fail-closed `MigrationRecoveryState`，不会注册正常 `AppState`。该状态现在通过 typed status/submit/restart command 与 React recovery screen 展示已映射的 credential ID 和脱敏原因：输入只会写入 OS credential store，coordinator 随后重新验证并 activation；只有结果为 `ReadyToRestart` 才能请求应用重启。无映射 ID、取消、校验失败或尚未完成的条目都不能打开正常应用功能。

这条链路证明 `requires_reentry` 可以被安全恢复和显式重启，但不证明真实用户升级已完成。仍须在真实旧安装副本上验证升级、失败重试、回退、已有 `~/.codez` 内容与 staging 的不相交性，以及完整桌面 E2E；完成前不得把数据或密钥迁移称为端到端验收通过。

## 限制

- Windows 成功不能推断 macOS Keychain 或 Linux Secret Service 的 Chromium safe storage 格式兼容。
- `windows-dpapi`、`aes-gcm` 和 `base64` 已提升为 Windows production dependency，但只服务 migration-only reader；日常凭据仍由 `CredentialStore` 的平台 keyring adapter 负责。
- 自动化测试已覆盖 Provider、MCP 和 OAuth 三种封装、损坏聚合 JSON、错误 AES key、缺失 Local State、备份篡改、报告脱敏、幂等重试，以及 recovery boundary 的凭据长度/状态约束；Phase 9 仍需用真实旧安装数据副本执行同用户升级演练和回退演练。
