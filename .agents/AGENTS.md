禁止TS代码里出现多个CSS样式，一个className里最多2个样式！

# 组件与文件规范
1. **文件行数限制**：单个 TSX/TS 文件代码建议控制在 150 行以内，硬性上限 200 行。超过 200 行必须拆分为目录结构。
2. **组件目录结构规范**：复杂组件使用 `[ComponentName]/` 目录，主入口为 `index.tsx`（或包含 `index.ts` 导出），包含 `[ComponentName].css`、`components/` 子组件、`hooks/` 与 `types.ts` / `constants.ts`。
