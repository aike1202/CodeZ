# 阶段8体验优化 - 计划与任务拆解

## 目标
实现《阶段 8：体验优化、打包发布与跨平台准备》的所有需求，完成应用打包、图标配置、深色模式适配和全局快捷键。

## 阶段与任务拆解

### ⏳ 阶段 1：UI 与深色模式适配
- ⏳ 任务 1.1：检查并完善全局深色模式机制
  - 详细设计：在 `tailwind.config.ts` 或 `styles.css` 中确认 `dark` 类的使用。在 `TopBar` 增加手动切换主题（Light/Dark/System）的按钮，利用 `electron.nativeTheme` (主进程) 和 localStorage (渲染进程) 保存设置。
- ⏳ 任务 1.2：微调组件视觉
  - 详细设计：确保所有图标、滚动条、文件链接等在深色模式下清晰可见。

### ⏳ 阶段 2：错误处理与全局快捷键
- ⏳ 任务 2.1：全局快捷键支持
  - 详细设计：在 `src/main/index.ts` 中注册 `globalShortcut`，例如 `CmdOrCtrl+Shift+Space` 用于隐藏/显示窗口。
- ⏳ 任务 2.2：全局错误捕获
  - 详细设计：在主进程增加 `process.on('uncaughtException')` 处理并写日志；渲染进程实现 React ErrorBoundary 捕获崩溃并显示友好提示。

### ⏳ 阶段 3：打包配置与图标
- ⏳ 任务 3.1：安装 electron-builder 并配置
  - 详细设计：`npm i -D electron-builder`。在 `package.json` 添加 `build` 字段配置（mac/win/linux）和 `scripts` (如 `"package": "electron-builder"` )。
- ⏳ 任务 3.2：生成与应用图标
  - 详细设计：使用资源文件生成 `icon.ico` 和 `icon.icns`，放到 `build` 或 `resources` 目录。在 `package.json` 配置图标路径。

### ⏳ 阶段 4：测试与编译验证
- ⏳ 任务 4.1：测试打包命令
  - 详细设计：运行 `npm run package` 并验证输出。

## 验收 & 测试
- [ ] 应用可正常切换深色模式且各页面颜色正常。
- [ ] 全局快捷键可以正常切换主窗口。
- [ ] `npm run package` 成功构建出 Windows exe 文件。
