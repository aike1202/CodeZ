# ADR 0007: CodeZ 应用数据根固定为 `~/.codez`

> 状态：Accepted
>
> 日期：2026-07-16

## 背景

Tauri 默认按应用标识解析平台 app-data、cache、log 和 temp 目录。该布局会让同一份 CodeZ 状态分散到多个平台目录，也会把“保留 `com.codez.desktop`”错误地等同于“旧数据天然连续”。Electron 的 `userData` 与 Tauri 默认 app-data 并不是可直接互换的权威仓库。

用户已明确要求新 Rust/Tauri 应用的完整应用数据根为当前用户主目录下的 `~/.codez`。旧 Electron `userData` 及升级前已存在于 `~/.codez` 的 Rules、Memory、Plans、Skills 等内容仍需安全迁移和保留。

## 决策

1. Rust/Tauri 运行时的唯一应用数据根固定为 `~/.codez`，不使用 Tauri `app_data_dir()` 作为日常 repository 根。
2. 缓存、日志、临时文件和迁移状态分别位于 `~/.codez/cache`、`~/.codez/logs`、`~/.codez/temp`、`~/.codez/migrations`。
3. Tauri resource 目录仍由打包宿主解析；它是只读安装资源，不属于用户数据根。
4. 所有模块只能从注入的 `AppPaths` 派生路径，不自行读取 home、`%APPDATA%`、XDG 目录、当前工作目录或 Tauri path resolver。
5. 保留产品名和应用 ID 只用于安装升级身份、协议与系统权限连续性，不决定 CodeZ 数据根。
6. Electron `userData` 是只读迁移源，不是新运行时的回退读取路径。迁移提交前，新 repository 不得成为权威，也不得覆盖或删除任何旧源。
7. 迁移发现必须同时覆盖 Electron `userData` 和已有的 `~/.codez` 用户内容。备份、转换、凭据处理、引用验证和原子 commit marker 全部通过后，repository 才可切换到新数据。
8. Electron 旧数据至少保留一个 Tauri 稳定版本；源码和 Electron 发布基线仍受 Phase 10 删除门禁约束。

## 路径布局

```text
~/.codez/
  providers.json
  settings.json
  sessions/
  attachments/
  session-runtime/
  config/
  cache/
  logs/
  temp/
  migrations/
```

该列表表示当前顶层约束，不冻结所有 repository 的最终内部格式。新增持久化目录必须位于此根下，并通过 repository 与 `AtomicFileStore` 管理；改变根目录或引入根外持久化需要新 ADR。

工作区内用户主动维护的 `.codez/` 和可丢弃的 `.codez-cache/` 属于项目状态，不是第二个全局应用数据根。它们只能从已验证的 workspace root 派生。

## 后果

- 首次启动不能依赖应用 ID 自动找到 Electron 数据，必须有显式 migration coordinator。
- 已有 `~/.codez` 同时可能是迁移源的一部分和新目标根；迁移实现必须使用互不覆盖的受控 staging/backup 路径，并按实际写入路径验证不相交，不能用目录整体复制覆盖。
- 卸载 Tauri 应用不得默认删除 `~/.codez`；清理由显式用户操作负责。
- Windows、macOS 和 Linux 的测试均需验证 home 解析、中文/Unicode 用户目录、权限、重复启动和迁移重试。

## 验证

- `AppPaths::for_user_home` 单元测试固定根目录和四个运行子目录。
- composition root 启动时创建所需目录，任一创建失败都阻止启动并保留具体错误来源。
- repository 集成测试断言不会在授权的 `~/.codez` 和 workspace 根之外写入。
- 安装/升级 smoke test 记录实际路径，并验证 Electron 源在失败、回退和重试后保持不变。
