# 📝 开发计划 - 重构项目记忆模块

> 关联需求：重构项目记忆模块-requirements.md
> 迭代：iteration-1
> 全局进度参阅：.continue/index.md

## 整体技术与架构总览
本次迭代旨在彻底替换原有的“基于应用全局 JSON 存储的项目记忆机制”，转而使用基于工作空间内 `.agent/project-memory.md` 文件的存储。
为实现这一点，需要对前后端进行调整：
1. **主进程 (Main)**：重构或新增 IPC API，用于获取/初始化该 Markdown 文件的绝对路径，并清理旧的 `ProjectMemoryStore.ts` 服务。
2. **渲染进程 (Renderer)**：
   - 调整 `PromptArea.tsx` 布局，加入快捷工具栏。
   - 移除原先的 `ProjectMemoryModal` 及 `TopBar` 里的入口。
   - 对话发送时，调用 IPC 读取该 Markdown 文件的文本内容，组装至 System Prompt。

## 阶段与任务大纲

**目标**：完成项目记忆从 JSON 模态框向本地 Markdown 文档与内嵌编辑器的重构。

⏳ 第一阶段 · 废弃旧架构与清理
  ✅ 1、[任务 T1] 移除旧 UI 组件
     - 极简说明：删除 `src/renderer/src/components/modals/ProjectMemoryModal.tsx` 及其 css，清理 `App.tsx` 和 `TopBar.tsx` 中的相关引用。
  ✅ 2、[任务 T2] 移除后端旧服务与 IPC 重构
     - 极简说明：删除 `ProjectMemoryStore.ts`，修改 `project-memory.handlers.ts`，将其变更为提供 `getFilePath(rootPath)` 和 `readMemory(rootPath)` 的基于文件操作的 IPC，而非内存缓存。

⏳ 第二阶段 · 前端重构与集成
  ✅ 1、[任务 T3] 改造 PromptArea 工具栏
     - 极简说明：在 `PromptArea.tsx` 的 `textarea` 正上方插入一个 `Flex` 容器，放入一个带 `IconGear` 或自定义 Icon 的“项目记忆”按钮。
  ✅ 2、[任务 T4] 绑定编辑器预览逻辑
     - 极简说明：点击“项目记忆”按钮时，调用 IPC 获取 `.agent/project-memory.md` 路径（不存在则由主进程创建骨架），然后调用 `setPreviewPath(path)` 打开内嵌编辑器。
  ✅ 3、[任务 T5] 修改 Prompt 发送前的组装逻辑
     - 极简说明：在 `App.tsx` 中 `startStreamingReply` 前，通过 IPC 读出 MD 文件内容，若不为空，则拼接到 `projectMemorySystemPrompt`。

### 验收&测试点
  ⏳ 1、[点击测试]：点击输入框上方“项目记忆”按钮，确认能在右侧打开文件且包含默认 Markdown 骨架。
  ⏳ 2、[对话验证]：在文件中输入约定（例如“回答请加上[Memory]”），发起测试聊天，验证 System Prompt 拼接是否生效且模型按约束回复。

## 变更记录
| 时间 | 变更内容 | 调整原因 |
|------|----------|----------|
| 2026-06-27 | 初始化计划 | 初次拆解 |
