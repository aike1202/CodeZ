# 大结果、Web 与通知

## 大工具结果

默认 Processor 限额：

```yaml
soft_chars: 50000
hard_bytes: 400000
batch_chars: 200000
preview_chars: 2000
error_chars: 10000
```

算法：

```text
truncate error text to error_chars
-> collect successful result char/byte sizes
-> mark any result over per-tool soft limit or hard byte limit
-> if batch > 200k, mark largest results until under budget
-> persist each marked result under workspace/session hashes
-> return 70/30 head-tail preview + opaque tool-result:// handle + sha256
```

`ToolResultRead` 只接受 opaque handle，不接受文件路径。读取时验证 handle、workspace hash、session hash、metadata、char/byte count 和 SHA-256，再按 Unicode chars 分页，默认 20k、最大 50k。

## WebSearch

WebSearch 从当前设置解析 enabled engines，执行 bounded search，统一 title/url/snippet/source/engine，并报告单引擎失败。allowed/blocked domains 使用 exact host 或 dot-boundary subdomain，不做字符串 contains 匹配。

## WebFetch 安全算法

```text
parse URL; only public HTTP/HTTPS
-> DNS resolve host
-> reject loopback/private/link-local/multicast/unspecified addresses
-> connect through SecureWebClient
-> on every redirect, repeat URL + DNS + public-address validation
-> enforce response/time/redirect/content bounds
-> parse HTML with structured parser
-> remove script/style/non-content elements
-> extract main content and convert to bounded Markdown
```

这防止模型通过 URL 访问 localhost、私网服务或用 redirect 做 SSRF。JavaScript-only 页面可能不完整，工具 description 已明确说明。

## PushNotification

只接受 1 行、无 Markdown、最多 200 chars 的 message和 status enum。运行时检查 OS permission，并按 session 维护 recent timestamps 做限流。成功仅表示 OS notification service 接受提交，不声称用户看到或点击。

## Deferred 共同点

Web/notification/notebook 初始不占 Provider schema tokens。ToolSearch 激活状态以 session + context scope 隔离，所以主会话激活 WebFetch 不会自动让 Explore 子 Agent获得它；而子 Agent allowlist 本身也会隐藏这些 deferred tools。
