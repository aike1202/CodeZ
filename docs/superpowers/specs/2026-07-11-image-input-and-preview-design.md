# 照片输入、预览与多模态发送设计

## 目标

为 CodeZ 增加真正的照片输入能力。用户可以通过文件选择、剪贴板粘贴或拖拽把照片加入输入框，在发送前直接看到缩略图并点击预览。发送后，照片继续显示在该条用户消息的聊天日志中，重新打开会话后仍可预览。

照片必须作为视觉内容进入规范化模型账本，并按当前 Provider 协议发送给支持多模态的模型，而不是退化为本地路径或纯界面附件。

## 已确认的产品行为

- 支持三种添加入口：点击“+”选择照片、从剪贴板粘贴、拖拽到输入框。
- 模型配置增加显式的“支持图片输入”开关；新增模型默认关闭。
- 当前模型未开启图片输入能力时，存在照片附件的消息不能发送，并提示用户切换或配置模型。
- 输入卡片内直接展示照片缩略图；每张照片可删除、可点击打开预览。
- 允许只发送照片，不强制输入文字。
- 支持多张照片，并按添加顺序发送和展示。
- 图片格式、尺寸、数量与请求体大小按实际 Provider 能力校验；可安全优化时自动转换，无法转换时阻止发送并给出具体原因。
- 发送后的用户消息按“照片网格 + 文本”展示；历史会话恢复后保持相同行为。
- 撤回到含照片的用户消息时，文字和照片一起恢复到输入框。
- 会话进入“最近删除”时保留托管照片，永久删除或超过恢复期清除会话时同步清理。

## 方案选择

采用应用托管附件文件方案。

照片导入后由 Main 进程托管。会话 UI 数据和规范化模型账本只保存附件元数据及稳定引用，不保存 Base64，也不依赖原照片路径。发送请求时，Main 进程在内存中读取托管文件并转换成对应 Provider 的图片内容块。

不采用以下方案：

- Base64 直接持久化：会显著放大会话 JSON、模型账本和内存占用。
- 只保存原文件路径：原文件移动、重命名或删除后，历史日志会失去图片。

## 数据模型

共享类型增加只描述托管资源、不暴露绝对路径的 `ImageAttachment`：

```ts
interface ImageAttachment {
  id: string
  kind: 'image'
  name: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  width: number
  height: number
  sizeBytes: number
  storageKey: string
}
```

这里的 MIME 是应用托管后的规范格式，不是对用户原始输入格式的固定限制。原图只要能被应用安全解码且能转换到当前 Provider 接受的格式即可导入。

`storageKey` 是 AttachmentService 可解析的受控引用，不是 Renderer 可直接读取的文件系统路径。草稿附件使用独立的 draft scope；发送时提升为 session scope，并生成最终 `ImageAttachment`。

以下类型增加可选的 `attachments?: ImageAttachment[]`：

- Renderer `ChatMessage`
- `SessionData.messages` 的共享持久化类型
- `NormalizedModelMessage`
- `StreamRequestV2.input`

旧会话缺少 `attachments` 时按空数组处理，不执行数据迁移。

`ModelConfig` 增加 `supportsVision?: boolean`，缺省值等同于 `false`。协议层维护按 `apiFormat` 区分的图片能力策略，包括可接受 MIME、图片数量、单图和整次请求大小等约束。模型配置的显式开关决定是否允许使用视觉输入，协议策略决定如何校验与转换。

## 附件存储与生命周期

新增 Main 进程 `AttachmentService`，负责：

- 导入 Renderer 提交的图片字节。
- 使用真实解码结果校验文件，不只信任扩展名或客户端 MIME。
- 读取宽高、MIME 和大小，生成缩略图。
- 在请求发送前根据目标 Provider 能力执行必要的缩放或格式转换。
- 管理 draft 和 session 两类附件作用域。
- 提供受控的缩略图与原图读取 IPC。
- 删除会话附件并清理无引用草稿。

托管目录位于 CodeZ 的应用数据目录，结构由 AttachmentService 私有管理。建议逻辑布局为：

```text
attachments/
  drafts/<draft-id>/
  sessions/<session-id>/<attachment-id>/
```

选择、粘贴和拖拽都把 `File` 字节通过受限 IPC 交给 Main 进程，统一走 draft 导入。Renderer 仅保留返回的附件描述和预览句柄。发送前，Main 进程原子地把草稿附件提升到目标会话；后续步骤失败时执行补偿回滚，避免产生半条用户日志。

Renderer 通过 IPC 读取缩略图或预览字节并创建临时 Blob URL，组件卸载或附件移除时立即 revoke。绝对路径和原始 Base64 不进入 Renderer 状态、会话日志或调试日志。

启动时清理过期草稿和未被任何会话（包括恢复期内的软删除会话）引用的 session 附件。会话进入“最近删除”时保留目录；永久删除或恢复期过期清除时才删除该会话目录。普通上下文压缩不会删除附件，因为聊天日志仍需展示它们。

## 输入区交互

`PlusActionMenu` 增加带图片图标的“添加照片”命令，调用支持多选的文件选择器。输入卡片同时监听：

- 剪贴板中的 image `File`
- 拖入输入区域的 image `File`
- 文件选择器返回的图片

三种入口共用一个导入控制器，统一处理加载、成功、部分失败和取消状态。

照片缩略图位于输入卡片顶部，文本编辑器位于其下方。缩略图使用固定尺寸，避免加载状态改变输入区布局。每张缩略图右上角使用图标按钮删除；点击图片主体打开预览弹窗。拖拽经过输入区时显示明确的放置状态，但不遮挡现有编辑内容。

发送按钮启用条件从“存在非空文本”改为“存在非空文本或至少一张已完成导入的照片”。导入仍在进行、存在校验错误或当前模型未开启 `supportsVision` 时，发送保持不可用并显示具体原因。

成功创建用户消息并启动请求后清空文字和附件。导入失败、前置校验失败或请求未成功启动时保留草稿，便于删除问题图片、切换模型或重试。

## 预览与聊天日志

新增可复用的照片展示组件：

- `ImageAttachmentGrid`：在输入区和用户消息中渲染缩略图网格。
- `ImagePreviewModal`：展示原图，支持关闭、上一张和下一张。
- `useAttachmentPreview`：按需获取预览字节并管理 Blob URL 生命周期。

输入区为网格提供删除行为；聊天日志使用只读模式。用户消息先显示照片网格，再显示现有 `MessageBody` 文本。没有文字时不渲染空文本容器。

预览弹窗复用现有 Modal 交互惯例，支持点击遮罩关闭和 Escape 关闭。多图时保留用户消息中的顺序。会话恢复只加载缩略图；用户点击后再读取原图，避免历史消息一次性占用大量内存。

撤回消息时，现有 `pendingPrompt` 扩展为同时携带文字和附件。已托管的 session 附件是会话内不可变资源，恢复到输入框和重新发送时可复用同一引用；附件不会因消息撤回或上下文裁剪而逐项删除，只在会话永久清除时删除。

## 模型账本与上下文

`SessionRuntimeCoordinator.beginTurn` 的非空条件改为“文字非空或附件非空”，并把附件引用写入 `NormalizedModelMessage`。用户继续消息的纯文本行为保持不变。

`ModelContextBuilder` 和 `ProviderMessageAdapter` 保留附件语义。附件只挂在产生它的用户消息上；Agent 的后续工具循环继续使用同一条账本消息，不复制图片到工具结果或 Assistant 消息。

上下文预算服务为图片加入保守的输入预算估算，避免继续按纯文本低估当前输入。Provider 返回的真实 usage 仍作为请求后的权威用量。上下文压缩可以从模型活动历史中移除旧图片消息，但不会改动 Renderer 会话日志或托管附件。

## Provider 请求转换

附件在进入 Provider 请求边界前才读取为 Base64，并且只存在于当前请求内存中。文本块在前，图片块按用户添加顺序跟随；纯图片消息省略空文本块。

### OpenAI Chat Completions

本项目使用 Chat Completions 协议。用户消息转换为：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "请分析这张照片" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/jpeg;base64,<BASE64_DATA>"
      }
    }
  ]
}
```

该结构与 OpenAI 官方 Images and vision 文档一致。多图追加多个 `image_url` 内容块。

### Anthropic Messages

用户消息转换为 Anthropic content blocks：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "请分析这张照片" },
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/jpeg",
        "data": "<BASE64_DATA>"
      }
    }
  ]
}
```

### Gemini streamGenerateContent

用户消息转换为 Gemini parts：

```json
{
  "role": "user",
  "parts": [
    { "text": "请分析这张照片" },
    {
      "inlineData": {
        "mimeType": "image/jpeg",
        "data": "<BASE64_DATA>"
      }
    }
  ]
}
```

Provider 转换必须只改变用户消息的多模态内容处理，不改变现有 system、assistant、tool、tool use/function call 和 tool result/function response 的协议顺序。

## 安全与错误处理

- Main 进程校验附件 ID、scope、会话归属、文件存在性和真实图片解码结果。
- Renderer 传入任意路径不能让 AttachmentService 读取托管目录之外的文件。
- `supportsVision` 在 Renderer 和 Main 两侧都校验，避免绕过界面。
- 不支持的格式、损坏文件或协议限制错误逐项返回，已成功导入的其他图片仍保留。
- 可安全缩放或转码时自动优化；仍不满足当前 Provider 限制时阻止发送，并指出具体附件和限制。
- 图片 Base64、原图字节和绝对路径不得写入应用日志、Prompt 日志、会话 JSON、模型账本错误或 Provider 调试输出。
- API 明确返回不支持图片时，保留已经持久化的用户消息和附件，提示切换或重新配置模型后重试。
- 缩略图或原图文件缺失时显示不可用占位，不让整个聊天消息渲染失败。

## 测试与验收

### 单元与集成测试

1. AttachmentService 正确导入可解码图片并拒绝伪 MIME、损坏文件和越权引用。
2. draft 提升、补偿回滚、过期清理和会话永久删除清理只影响正确作用域；软删除与恢复不会丢图。
3. 选择、粘贴和拖拽调用同一导入链路，并保持添加顺序。
4. 输入区支持删除、纯图片发送、导入中禁用发送和成功后清空。
5. 非视觉模型在 Renderer 和 Main 两侧都阻止照片发送。
6. 用户消息与会话持久化保留附件元数据；旧会话无 `attachments` 时正常加载。
7. 输入区和聊天日志缩略图可打开同一预览组件；会话切换会释放 Blob URL。
8. 撤回含照片的消息同时恢复文字和附件，并保持旧消息附件引用有效。
9. OpenAI 单图、多图、图文混合和纯图片请求生成正确的 `image_url.url` Data URL。
10. Anthropic 生成正确的 `image`/`source` 块，且不破坏 tool use/result 顺序。
11. Gemini 生成正确的 `inlineData` part，且不破坏 function call/response 顺序。
12. 上下文账本记录附件引用，预算估算包含图片，日志中不存在 Base64 或绝对路径。

### 手工验收

- 在 Electron 中分别通过选择、粘贴、拖拽添加一张和多张照片。
- 验证输入框缩略图、删除、全图预览、上一张/下一张及 Escape 关闭。
- 分别使用启用视觉能力的 OpenAI、Anthropic 和 Gemini Provider 发送图文及纯图片消息，确认模型实际识别图片。
- 关闭并重新启动应用，打开历史会话，确认日志照片仍显示且可预览。
- 切换到未启用视觉能力的模型，确认发送被阻止且提示明确。
- 把会话移入“最近删除”并恢复，确认照片仍可用；永久删除后确认该会话附件被清理，其他会话照片不受影响。

完成实现后运行相关 Vitest、`npm run typecheck`、完整测试套件和 `npm run build`。UI 交互需要在桌面与窄窗口尺寸下检查缩略图布局、弹窗边界和控件重叠。

## 非目标

- 视频、音频、PDF 或任意文件附件。
- 在一段文本中间插入并交错排列图片；本次采用“文本块 + 有序图片块”。
- 图片编辑、裁剪、标注或滤镜。
- 从远程 URL 导入图片。
- 自动猜测自定义模型是否支持视觉输入。
- 把图片 Base64 永久保存到会话或模型账本。
