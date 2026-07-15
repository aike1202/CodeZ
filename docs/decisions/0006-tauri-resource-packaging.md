# ADR 0006: Tauri 资源与 ripgrep 打包路径

> 状态：Accepted（Windows x64）
>
> 日期：2026-07-16

## 背景

CodeZ 必须随安装包提供 builtin skills 和 `rg`，并在安装位置变化后通过 Tauri `resource_dir` 定位。Electron 还额外打包 3 个 tree-sitter WASM；Rust 权限 parser 改用编译期 grammar 后，Tauri 不应继续携带这些 WASM。

资源路径不能依赖当前工作目录、源码目录或前端任意路径参数，也不能向 WebView 授予通用文件/进程权限。

## 决策

- 主 `tauri.conf.json` 使用 source-to-target map，把 `resources/builtin-skills/` 安装到 `$RESOURCE/builtin-skills/`。
- Windows x64 平台配置把 `@vscode/ripgrep-win32-x64/bin/rg.exe` 安装到 `$RESOURCE/tools/rg.exe`。
- `codez-platform::ResourceLocator` 只接受 Tauri `resource_dir`，并提供固定的 builtin skills 和 ripgrep 路径；不接受用户控制的相对路径。
- Tauri setup 执行非阻断资源诊断；真正启动 Skill/Search 工具前再次执行强校验并返回 typed `ResourceError`。
- tree-sitter、Bash 和 PowerShell grammar 编译进 Rust binary，不进入 Tauri resources。Electron 的 WASM extraResources 在 Electron 冻结期继续保留。
- macOS/Linux 和非 x64 Windows 使用独立平台/架构资源映射，只有对应 `@vscode/ripgrep-*` optional package 与构建验证通过后才宣称支持。
- Tauri capability 不新增前端 Shell 或任意资源读取权限；`rg` 仅由 Rust platform adapter 作为受控子进程启动。

## 后果

- 安装目录可变时，Rust 仍通过系统提供的 `resource_dir` 解析固定相对路径。
- Windows x64 已验证 `rg 15.0.0` 可执行，bundle source 和安装目标有确定性 SHA-256 清单。
- Electron `process.resourcesPath` 与 Tauri `resource_dir` 在迁移期分别存在，但不共享运行时 resolver；最终切换后删除 Electron resolver 属于 Phase 10。
- `node_modules` 是构建输入，不是运行时依赖；Tauri 安装包只携带映射后的二进制与资源文件。
- 升级 `@vscode/ripgrep`、新增 builtin skill 或修改目标路径时必须重新生成资源清单并构建 Tauri。
- 真实 NSIS 安装/升级后的资源读取仍属于 Phase 9 安装包验收，本 ADR 不以无 bundle 编译替代发布验收。

验证证据见 `docs/migration/spikes/tauri-resource-packaging.md`。
