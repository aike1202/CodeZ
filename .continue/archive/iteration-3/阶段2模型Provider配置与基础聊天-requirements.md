# 📋 需求文档 - 阶段2：模型 Provider 配置与基础聊天

> 迭代：iteration-3
> 创建时间：2026-06-25 17:30
> 最后更新：2026-06-25 17:30
> 存放位置：.continue/current/阶段2模型Provider配置与基础聊天-requirements.md

---

## 需求概述

**一句话描述**：实现多模型 API 配置管理和基础流式聊天能力，替换当前 `setTimeout` 假响应，使用户可以配置 API Key、选择模型、与模型进行真实流式对话。

**业务背景**：当前应用已具备项目打开和文件管理能力（阶段 1），但聊天区仍使用硬编码的 `setTimeout` 模拟响应。阶段 2 需要接入真实模型 API，使 Agent 能够真正"思考"和"回答"，这是整个 Agent Coding 工具的核心能力基础。

**预期价值**：
- 用户可配置自己的模型 API，灵活选择不同厂商
- 聊天区具备真实流式响应，不再是假数据
- 为后续 Agent Loop、工具调用、代码修改等高级能力打下基础

---

## 功能需求

### 核心功能（必须实现）

- [ ] **F1**: Provider 配置管理
  - 输入：Provider 名称、API Base URL、API Key、默认模型
  - 处理：新增/编辑/删除 Provider 配置，持久化到本地存储（JSON 文件）
  - 输出：已保存的 Provider 列表

- [ ] **F2**: API Key 安全处理
  - 输入：用户输入的 API Key 明文
  - 处理：存储时使用 Electron `safeStorage` 加密（或至少不存明文）；UI 中脱敏显示（`sk-****xxxx`）
  - 输出：脱敏后的 Key 展示；日志中不出现 Key 明文

- [ ] **F3**: 连接测试
  - 输入：已配置的 Provider
  - 处理：用短 prompt 发起测试请求，设置短超时（15s）
  - 输出：成功/失败状态 + 错误原因（鉴权失败/网络错误/模型不存在等）

- [ ] **F4**: 模型列表获取
  - 输入：已连接的 Provider
  - 处理：通过 `/v1/models` 端点获取可用模型列表
  - 输出：模型名列表供用户选择

- [ ] **F5**: 流式聊天
  - 输入：用户消息 + 当前会话上下文
  - 处理：构建 OpenAI-compatible Chat Completions 请求（含 `stream: true`），通过 SSE 逐 token 解析
  - 输出：流式渲染到聊天界面，每条消息包含 role（user/agent）和 content

- [ ] **F6**: 会话消息持久化
  - 输入：聊天消息列表
  - 处理：将当前会话消息保存到本地 JSON 文件（按 projectId + sessionId 组织）
  - 输出：刷新后可恢复历史会话

- [ ] **F7**: Provider 与模型选择 UI
  - 输入：已配置的 Provider 列表
  - 处理：PromptArea 底部提供 Provider/模型下拉选择器，从持久化配置读取
  - 输出：选中的 Provider 和模型名显示在输入区

### 扩展功能（可选实现）

- [ ] **E1**: 多 Provider 类型（Ollama 本地、DeepSeek 等，先只做 OpenAI-compatible）
- [ ] **E2**: 请求重试（失败自动重试 1 次）
- [ ] **E3**: Token 用量统计展示
- [ ] **E4**: 请求超时配置（用户可设置）

---

## 非功能需求

### 性能要求
- 流式响应首个 token 延迟 < 3s（取决于 API）
- UI 渲染不因流式更新卡顿（每 16ms 最多更新一次）
- 会话加载（含 100 条消息）< 500ms

### 兼容性要求
- 平台：Windows 10/11（当前）；macOS 备兼容
- 向后兼容：不影响阶段 1 的项目打开、文件树功能
- OpenAI API 格式兼容：支持任意 OpenAI-compatible 端点（Ollama、vLLM、DeepSeek 等只要兼容格式即可）

### 安全要求
- API Key 不得在日志中明文出现
- IPC 通信中传递 API Key 时使用加密引用
- UI 中默认脱敏显示 Key
- 本地存储的 Key 使用 Electron `safeStorage`（降级方案：base64 混淆 + 文件权限警告）

---

## 约束条件

### 技术栈限制
- 主语言：TypeScript
- 框架：Electron + React（现有）
- HTTP 客户端：Node `fetch`（Node 18+ 内置）或 `undici`
- 本地存储：JSON 文件（`app.getPath('userData')/providers.json`、`sessions/`）
- 不使用外部数据库（本阶段不需要 SQLite）

### 时间限制
- 本迭代范围为阶段 2 全部核心功能（F1-F7）

### 其他约束
- 模型请求从 Main Process 发起（不经过 Renderer Process 直接调用网络，避免 CSP 限制）
- 流式数据通过 IPC 逐 chunk 推送到 Renderer Process
- Provider 配置的 Provider 抽象接口设计必须具备扩展性，后续接入非 OpenAI 格式 Provider 时只需新增 Adapter
- 当前不考虑用户系统和多租户

---

## 验收标准

### 功能验收
- [ ] **AC1**: 打开设置面板 → 新增一个 OpenAI-compatible Provider → 填写 Base URL + API Key + 模型名 → 保存 → Provider 出现在列表中
- [ ] **AC2**: 点击"测试连接" → API Key 正确时显示"连接成功"
- [ ] **AC3**: 点击"测试连接" → API Key 错误时显示"鉴权失败 (401)"
- [ ] **AC4**: API Key 在 UI 中显示为脱敏格式（如 `sk-****abc`）
- [ ] **AC5**: 在聊天区输入"你好" → 模型流式返回回复 → 逐字显示在聊天区
- [ ] **AC6**: 关闭并重启应用 → 之前配置的 Provider 仍然存在
- [ ] **AC7**: 关闭并重启应用 → 之前的聊天消息仍然存在
- [ ] **AC8**: PromptArea 底部显示当前选中的 Provider 和模型名（从配置读取，非硬编码）
- [ ] **AC9**: 模型请求失败时 → 聊天区显示"请求失败：xxx"，而非假回复
- [ ] **AC10**: 无 Provider 配置时 → PromptArea placeholder 提示"请先配置模型"

### 性能验收
- [ ] **P1**: 流式响应不导致 UI 卡顿
- [ ] **P2**: 会话保存 < 200ms

### 质量验收
- [ ] **Q1**: `npm run typecheck` 通过
- [ ] **Q2**: `npm run test` 通过（含新增 Provider Service 单元测试）
- [ ] **Q3**: `npm run build` 构建成功

---

## 相关资源

### 参考文档
- `docs/requirements/05-model-provider.md` — 模型 Provider 详细需求
- `docs/requirements/15-development-phases.md` — 阶段 2 范围定义
- `docs/requirements/14-security-privacy.md` — API Key 安全存储规范
- OpenAI API 文档：`https://platform.openai.com/docs/api-reference/chat`

### 依赖服务
- OpenAI-compatible API 端点（用户提供）
- 或 Ollama 本地服务（`http://localhost:11434/v1`）

---

## 需求澄清记录

| 问题 | 回答 | 确认时间 |
|------|------|----------|
| 是否只做 OpenAI-compatible？ | 是，第一版只做 OpenAI-compatible Provider，后续扩展其他格式 | 2026-06-25 |
| 聊天消息存在哪里？ | `app.getPath('userData')/sessions/` 下 JSON 文件 | 2026-06-25 |
| API Key 安全方案？ | 优先 Electron safeStorage，降级用 base64 + JSON 文件存储 | 2026-06-25 |
