# Windows safeStorage compatibility spike

> 状态：Windows sentinel 验证通过
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

## 限制

- Windows 成功不能推断 macOS Keychain 或 Linux Secret Service 的 Chromium safe storage 格式兼容。
- `windows-dpapi` 当前仅作为 target-specific dev dependency 用于 spike，不代表生产 CredentialStore 已选型。
- 生产迁移仍需使用脱敏的真实格式副本验证 Provider、MCP 和 OAuth 三种封装，并覆盖损坏密文与错误用户上下文。
