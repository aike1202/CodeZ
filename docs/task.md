# P0 实现任务清单

- [x] **任务 1：新建 `editDiffUtils.ts`** — 提取公共 diff 计算/构建/点击逻辑
- [x] **任务 2：修改 `MessageParser.ts`** — 参数化 validFiles + 新增斜体/删除线/链接 + 修复命令正则
- [x] **任务 3：修改 `MessageBody.tsx`** — 传入 validFiles 参数
- [x] **任务 4：修复 `MessageBody.css`** — `min-w` → `min-width`
- [x] **任务 5：修改 `ChatArea.tsx`** — 提取 lastStreamingMsgId + 使用 editDiffUtils + 缓存 auditMessages
- [x] **任务 6：修改 `ExecutionLogUtils.ts`** — 使用 computeEditStats
- [x] **任务 7：修改 `ExecutionLog.tsx`** — 合并 diff 点击逻辑 + 使用 buildDiffEditInfo
- [x] **任务 8：修复 `ChatAreaLayout.tsx` + `App.css`** — className 规则 + position: relative
- [x] **任务 9：编译验证** — `npx tsc --noEmit`

# P1 优化任务清单（架构 + 可读性 + 用户体验）

- [ ] **任务 P1-1：`ChatArea.tsx` 拆分** — 提取 `useSendMessage` hook 和 `AgentMessageContent` 组件
- [ ] **任务 P1-2：`ExecutionLog.tsx` 逻辑清理** — 彻底消除重复的 diff 逻辑
- [ ] **任务 P1-3：`CodeBlock` 语法高亮** — 引入 `highlight.js` 并进行相关修改

# P2 优化任务清单（UX 细节 + 规范一致性）

- [ ] **任务 P2-1：用户消息气泡限高** — 增加最大高度限制和渐变滚动遮罩
- [ ] **任务 P2-2：Agent 头像替换** — 设计并替换为 `AgentAvatarIcon`
- [ ] **任务 P2-4：`ExecutionLogDetail` CSS 整理** — 将 Tailwind 内联类移出至 `ExecutionLog.css`
- [ ] **任务 P2-5：`ExecutionLog` 延迟折叠** — 任务完成后短暂保留展开状态

# P3 优化任务清单（清洁度 + 健壮性 + 微调）

- [ ] **任务 P3-1：清理弃用的 `ToolCallLog`** — 确认无引用后删除
- [ ] **任务 P3-2：清理弃用的 `ThinkingBlock`** — 确认无引用后删除
- [ ] **任务 P3-3：类型系统改进** — 消除组件中的 `any` 类型泛滥
