# 04 项目规则与 Memory

## 来源

Claude Code 从用户/项目配置中加载 `CLAUDE.md`、rules 和 memory。它们可进入 system 的动态 memory/session guidance，或作为带 `<system-reminder>` 的 conversation attachment 注入。

## 作用域

项目规则通常按目录作用域影响文件操作；更具体规则覆盖更宽泛规则，显式 system/user 指令优先。自动注入的裁剪规则可能被标记 `isPartialView`，这种局部视图不能直接作为 Edit 的先读证明，必须显式 Read。

## 模型可见性

规则正文一旦注入就计入模型上下文。私有路径、团队约定、构建命令和密钥提示可能出现在 transcript，因此仓库样例只保存存在性、hash/来源引用或脱敏文本。

## Compact/Resume

传统 compact summary 应保留关键规则，但不能依赖摘要完整复制所有目录约束。Resume 会重新加载当前项目配置，可能与原 session 开始时的规则版本不同。可靠日志需要保存规则文件路径、scope、hash、加载时间和 resolved order。
