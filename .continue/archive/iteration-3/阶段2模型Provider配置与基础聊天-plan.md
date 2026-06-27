# 📝 开发计划 - 阶段2：模型 Provider 配置与基础聊天

> 关联需求：阶段2模型Provider配置与基础聊天-requirements.md
> 迭代：iteration-3

---

## 整体技术与架构总览

本迭代在 Electron 主进程新增 Provider 配置管理、模型 API 流式调用两大服务，通过 IPC 暴露给渲染进程。前端新增 Provider 设置面板（侧边滑出）和 chatStore，替换 PromptArea 硬编码选择器与 App.tsx 中的 `setTimeout` 假响应。

```
┌─ Renderer Process ─────────────────────────────────────┐
│  App.tsx (chatStore 驱动)     SettingsPanel (侧边滑出)    │
│  PromptArea (真实 Provider/模型选择)                      │
├─ Preload (IPC bridge) ─────────────────────────────────┤
│  api.provider.*   api.chat.*   api.session.*            │
├─ Main Process ──────────────────────────────────────────┤
│  ProviderService          ChatService      SessionStore  │
│   - CRUD + safeStorage     - HTTP + SSE     - JSON 存储  │
│   - providers.json         - fetch stream   - sessions   │
│  ipc/provider.handlers   ipc/chat.handlers  ipc/session  │
└─────────────────────────────────────────────────────────┘
```

---

## 阶段与任务大纲

**目标**：替换 setTimeout 假响应，实现真实模型 API 流式聊天 + Provider 配置管理 + 会话持久化。

---

✅ 第一阶段 · Provider 配置后端

  ✅ 1、定义 Provider 共享类型
     - 极简说明：新建 `src/shared/types/provider.ts`（ProviderConfig, ProviderInfo, ModelInfo, ChatMessage 等），扩展 `src/shared/types/index.ts` 导出。
     - 详细设计：ProviderConfig（含加密字段 apiKeyRef + encryption）、ProviderInfo（脱敏展示）、ProviderFormData（新建/编辑表单）、ConnectionTestResult、ChatMessage（对齐 OpenAI 格式）、ChatStreamChunk/End。
     - 落点文件：`src/shared/types/provider.ts`、`src/shared/types/index.ts`

  ✅ 2、注册 IPC 通道常量
     - 极简说明：扩展 `src/shared/ipc/channels.ts`，添加 Provider CRUD、连接测试、聊天流式、Session 相关通道。
     - 详细设计：PROVIDER_LIST/ADD/UPDATE/REMOVE/TEST/SET_ACTIVE、CHAT_STREAM_START/CHUNK/END/ERROR、SESSION_LIST/SAVE/DELETE。
     - 落点文件：`src/shared/ipc/channels.ts`

  ✅ 3、实现 ProviderService（CRUD + 安全存储）
     - 极简说明：新建 `src/main/services/ProviderService.ts`，参照 `RecentProjectsStore` 模式（JSON 文件存储于 `userData/providers.json`）。API Key 使用 Electron `safeStorage` 加密存储，降级方案为 base64 混淆。
     - 详细设计：load/save 持久化、add/update/remove/setActive CRUD、encryptApiKey/decryptApiKey 加解密（safeStorage 优先，降级 base64）、testConnection 通过 `/v1/models` GET 请求测试、getApiKey 内部解密（不暴露给 renderer）。
     - 落点文件：`src/main/services/ProviderService.ts`

  ✅ 4、注册 Provider IPC handlers + 更新 preload
     - 极简说明：新建 `src/main/ipc/provider.handlers.ts`，在 `main/index.ts` 注册。更新 `preload/index.ts` 暴露 `api.provider.*`。更新 `env.d.ts` 类型声明。
     - 详细设计：ipcMain.handle 注册 list/add/update/remove/test/setActive；preload 用 contextBridge 暴露 provider 对象；env.d.ts 使用 declare global 声明类型（避免模块导入打破全局声明）。
     - 落点文件：`src/main/ipc/provider.handlers.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/src/env.d.ts`

---

✅ 第二阶段 · 模型 API 调用与流式推送

  ✅ 5、实现 ChatService（HTTP + SSE 流式解析）
     - 极简说明：新建 `src/main/services/ChatService.ts`。构建 OpenAI-compatible `/v1/chat/completions` 请求，`stream: true`，用 `fetch` 获取 `ReadableStream`，逐行解析 SSE `data:` 事件，提取 `delta.content`。通过回调方式 yield 每个 token。
     - 详细设计：streamChat(config, callbacks) 方法 —— POST 请求带 Authorization Bearer header，body 含 model/messages/stream/stream_options；用 response.body.getReader() 逐 chunk 读取，Split by newlines 解析 SSE data: 行，JSON.parse 提取 choices[0].delta.content；错误处理（401/403/404/429/网络错误）；AbortController 支持取消。
     - 落点文件：`src/main/services/ChatService.ts`

  ✅ 6、注册 Chat IPC handlers（流式推送通道）
     - 极简说明：新建 `src/main/ipc/chat.handlers.ts`。使用 `ipcMain.handle(CHAT_STREAM_START, ...)` 接收请求，通过 `event.sender.send(CHAT_STREAM_CHUNK, ...)` 推送流式数据。
     - 详细设计：CHAT_STREAM_START 返回 streamId，异步执行 ChatService.streamChat；通过 sender.send 推送 CHUNK/END/ERROR 事件；从 ProviderService 获取解密 API Key；获取 BrowserWindow 引用确保 webContents 有效。
     - 落点文件：`src/main/ipc/chat.handlers.ts`

  ✅ 7、更新 preload（聊天流式 API） + 类型
     - 极简说明：`preload/index.ts` 暴露 `api.chat.stream(providerId, model, messages, callbacks)`。更新 `env.d.ts`。
     - 详细设计：api.chat.stream 用 ipcRenderer 监听 CHUNK/END/ERROR 事件，回调 onChunk/onDone/onError；返回 cleanup 函数用于取消监听；发起 CHAT_STREAM_START invoke。
     - 落点文件：`src/preload/index.ts`、`src/renderer/src/env.d.ts`

---

✅ 第三阶段 · Provider 配置 UI

  ✅ 8、创建 providerStore（Zustand）
     - 极简说明：新建 `src/renderer/src/stores/providerStore.ts`。状态：providers[], activeProviderId, loading。Actions：loadProviders, addProvider, updateProvider, removeProvider, testConnection, setActiveProvider。
     - 详细设计：create Zustand store，loadProviders 从 window.api.provider.list 加载并设置默认 active；add/update/remove 调用 IPC 并同步更新本地状态；testConnection 直接调用 IPC 返回结果。
     - 落点文件：`src/renderer/src/stores/providerStore.ts`

  ✅ 9、改造 PromptArea Provider/模型选择器
     - 极简说明：移除硬编码"自定义 高"。从 providerStore 读取 providers 列表。Provider 下拉可选，支持自定义模型名输入。
     - 详细设计：useProviderStore 读取 providers 和 activeProviderId；下拉菜单显示所有 Provider（带活跃标记）；选中 Provider 时下方可输入自定义模型名；⚙ 按钮打开设置面板；无 Provider 时显示"未配置模型"。
     - 落点文件：`src/renderer/src/components/PromptArea.tsx`

  ✅ 10、创建设置面板（Provider 管理侧边滑出）
     - 极简说明：新建 `src/renderer/src/components/SettingsPanel.tsx`。右侧滑出面板，Provider 列表 + 新增/编辑表单 + 测试连接 + 删除。
     - 详细设计：fixed inset-0 + 遮罩 + 420px 右侧面板；Provider 卡片显示名称/URL/Key脱敏/默认模型/活跃标记；编辑模式复用 ProviderForm 子组件；测试连接按钮触发 testConnection 并显示结果（成功绿色/失败红色）；API Key 输入框支持显示/隐藏切换。
     - 落点文件：`src/renderer/src/components/SettingsPanel.tsx`

---

✅ 第四阶段 · 真实聊天接入 + 会话持久化

  ✅ 11、创建 chatStore + 迁移 App.tsx 状态
     - 极简说明：新建 `src/renderer/src/stores/chatStore.ts`。将会话和消息状态从 App.tsx 迁移到 Zustand store。
     - 详细设计：ChatMessage（id/role/content/streaming）、ChatSession（id/projectId/summary/messages）；actions: loadSessions/createSession/selectSession/addUserMessage/startStreamingReply/appendStreamChunk/finishStreaming/setStreamCleanup/persistCurrentSession；流式消息通过 appendStreamChunk 逐步追加，streaming: true 时显示光标动画。
     - 落点文件：`src/renderer/src/stores/chatStore.ts`

  ✅ 12、改造 App.tsx 接入真实流式聊天
     - 极简说明：`handleSendMessage` 不再用 `setTimeout` 假响应。改为调用 `window.api.chat.stream()`，监听 chunk 事件追加到当前助手消息。
     - 详细设计：检查 activeProvider → 无 Provider 时降级为模拟逐字提示"请先配置模型"；构建 system prompt（含项目名和类型）；消息历史限制 20 条上下文；调用 api.chat.stream 传入 onChunk/onDone/onError；onError 在消息末尾追加 ❌ 错误提示；流式完成后 persistCurrentSession。
     - 落点文件：`src/renderer/src/App.tsx`

  ✅ 13、实现会话持久化（Session 存储到文件）
     - 极简说明：Main Process 新增 `SessionStore`（JSON 文件存储），通过 IPC 读写会话。
     - 详细设计：SessionStore（userData/sessions.json），load/save/delete；Session IPC handlers 注册 list/save/delete；chatStore.persistCurrentSession 调用 window.api.session.save；loadSessions 在 App 初始化时调用。
     - 落点文件：`src/main/services/SessionStore.ts`、`src/main/ipc/session.handlers.ts`

---

### 验收&测试

  ✅ 1、Provider CRUD 功能测试
     - 验证方式：手动在设置面板新增/编辑/删除 Provider。
     - 预期：操作后列表即时更新；重启后配置保持。

  ✅ 2、连接测试功能
     - 验证方式：手动填写有效/无效 API Key → 点击测试连接。
     - 预期：有效返回"连接成功"；无效返回错误原因。

  ✅ 3、流式聊天端到端
     - 验证方式：配置真实 API → 输入消息 → 观察聊天区。
     - 预期：消息逐 token 显示，不卡顿。

  ✅ 4、会话持久化
     - 验证方式：聊天后关闭应用 → 重新启动。
     - 预期：侧边栏显示历史会话。

  ✅ 5、编译与测试
     - 验证方式：`npm run typecheck && npm run test && npm run build`。
     - 预期：全部通过。✅ 10/10 tests passed，typecheck 0 errors，build 成功。

---

## 变更记录
| 时间 | 变更内容 | 调整原因 |
|------|----------|----------|
| 2026-06-25 | 初始规划 | 启动 iteration-3 |
| 2026-06-25 | 全部 13 任务完成，编译+测试通过 | 实现阶段完成 |
