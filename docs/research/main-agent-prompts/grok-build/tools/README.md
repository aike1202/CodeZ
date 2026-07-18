# Grok Build 工具系统

## 源码与版本

核心实现位于：

```text
F:\MyProjectF\grok-build\crates\codegen\xai-grok-tools\src\implementations\grok_build\
```

源码 revision：`8adf9013a0929e5c7f1d4e849492d2387837a28d`。部分工具同时保留 `legacy-0.4.10` contract；文档默认描述 current 行为，存在显著差异时单独注明。

## 全量模块清单

| 模块 | 工具职责 |
|---|---|
| `read_file` | 文本、图片、PDF、PPTX、Notebook 读取 |
| `search_replace` | 精确字符串替换和文件创建 |
| `grep` | ripgrep 正则内容搜索 |
| `list_dir` | 目录树列表与摘要 |
| `bash` | 前台/后台 shell 命令 |
| `task` | 创建/恢复子智能体 |
| `task_output` | 查询 shell、monitor、subagent 输出 |
| `kill_task` | 终止后台命令、monitor 或 subagent |
| `todo` | 维护 session todo |
| `enter_plan_mode` / `exit_plan_mode` | 基于磁盘 plan file 的计划流程 |
| `ask_user_question` | 结构化用户询问 |
| `lsp` | 语言服务诊断/导航 |
| `monitor` | 事件流/轮询监控 |
| `scheduler` | 定时/延迟执行 |
| `update_goal` | 持久目标状态 |
| `web_fetch` / `web_search` | 网页抓取与搜索 |
| `image_gen` / `image_edit` / `video_gen` | 媒体生成和编辑 |

工具名与参数名可以被 `TemplateRenderer` 重映射，prompt 使用 `${{ tools.by_kind.* }}` 和 `${{ params.* }}`，不要把 canonical 名称当作所有客户端的固定 API。

## 深度文档

- `read.md`
- `edit.md`
- `grep.md`
- `list-dir.md`
- `shell.md`
- `agent-and-task.md`
- `planning-and-other-tools.md`

## 架构特征

Grok 工具把 schema、capability、requires expression、行为版本、资源依赖、通知、流式投影和 terminal output 放在同一 Rust Tool 体系中。许多边界是硬执行约束，例如 Grep 早停、Task 深度 1、ListDir 字符预算；但也有仅提示约束，例如 SearchReplace 的 read-before-edit 建议。
