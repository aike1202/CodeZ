# 未来规划笔记本 - 需求分析报告

> 版本: v0.2 | 日期: 2025-06-29 | 状态: 需求规划中
> 技术栈: Electron + React + TypeScript + Tailwind CSS

---

## 一、项目概述

### 1.1 产品定位
一款轻量级桌面 TodoList + 规划笔记应用，帮助用户规划、追踪和完成短期/长期目标。采用 Electron 桌面端方案，支持离线使用、数据本地存储，并提供**桌面悬浮窗**能力，让规划内容常驻视线。

### 1.2 目标用户
- 有自我管理需求的开发者/学生/职场人士
- 需要长期跟踪项目进度、学习计划、人生目标的用户
- 希望规划内容"随时可见"但又不想被打扰的用户（通过悬浮窗）

### 1.3 产品目标
- ✅ 简洁高效的任务管理（增删改查、分类、优先级、截止日期）
- ✅ 多维度视图（列表/看板/日历/甘特图渐进增强）
- ✅ 关联笔记系统（为每个目标/任务补充自由格式内容）
- ✅ 进度统计与激励（完成率、连续打卡、趋势）
- ✅ **桌面悬浮窗（核心亮点）**：半隐藏常驻桌面边缘，悬停展开，延时收起，位置用户自定义
- ✅ 本地优先、可导出备份，保障数据隐私

---

## 二、功能需求

### 2.1 功能架构

```
┌─────────────────────────────────────────────────────┐
│                   未来规划笔记本                      │
├────────────┬────────────┬───────────┬───────────────┤
│  任务管理   │  规划视图   │   笔记    │    悬浮窗     │
│ - 新增/编辑 │ - 列表视图 │ - Markdown│ - 贴边半隐藏  │
│ - 分类/标签 │ - 看板视图 │ - 富链接  │ - 悬停展开    │
│ - 优先级   │ - 日历视图 │ - 附件    │ - 延时自动隐藏│
│ - 截止日期 │ - 甘特视图 │           │ - 位置自定义  │
│ - 状态流转 │            │           │ - 透明度/大小 │
├────────────┴────────────┴───────────┴───────────────┤
│  统计复盘  │  数据管理  │  设置中心  │                │
│ - 完成率   │ - 本地存储 │ - 主题    │                │
│ - 连续天数 │ - 导入导出 │ - 快捷键  │                │
│ - 趋势图表 │ - 云同步预留│ - 通知    │                │
└─────────────────────────────────────────────────────┘
```

### 2.2 功能详情

#### 2.2.1 任务管理（核心）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| title | string | 任务标题（必填） |
| description | string | 详细描述（支持 Markdown） |
| status | enum | `todo` / `in-progress` / `done` / `archived` |
| priority | enum | `low` / `medium` / `high` / `urgent` |
| category | string | 分类（工作/学习/生活/自定义） |
| tags | string[] | 标签数组 |
| dueDate | Date | 截止日期（可选） |
| reminderAt | Date | 提醒时间（可选） |
| parentId | string | 父任务ID（支持子任务无限层级） |
| progress | number | 进度百分比 0-100（父任务根据子任务自动计算） |
| createdAt | Date | 创建时间 |
| updatedAt | Date | 更新时间 |
| completedAt | Date | 完成时间 |

**交互说明**：
- 快速添加：顶部输入框回车即可添加，默认优先级 medium、状态 todo
- 批量操作：多选后可批量改状态/分类/优先级/删除
- 拖拽排序：同分类内可拖拽调整顺序，跨分类拖拽可改变状态
- 子任务：任务详情中可添加子任务，子任务完成影响父任务进度

#### 2.2.2 规划视图（渐进增强）
- **v0.1 MVP**：列表视图，支持按状态/分类/日期/优先级筛选排序
- **v0.2**：看板视图（看板式列拖拽，列=状态）
- **v0.3**：日历视图（月视图展示任务截止日期分布）
- **v0.4**：甘特视图（长期规划时间线，展示任务依赖关系）

#### 2.2.3 笔记系统
- 每个任务/目标可关联多条笔记
- 支持 Markdown 编辑（标题/列表/代码块/引用/链接）
- 笔记可独立于任务存在（自由笔记）
- 支持内部链接：`[[任务ID]]` 语法引用其他任务

#### 2.2.4 统计复盘
- 今日/本周/本月完成数、完成率
- 连续完成天数（streak）
- 按分类/优先级维度统计
- 简单的趋势折线图（近30天完成数）
- 逾期任务汇总

#### 2.2.5 设置中心
- **主题**：浅色/深色/跟随系统，强调色自定义（Tailwind CSS 动态切换）
- **快捷键**：全局快捷键唤起主窗口/悬浮窗
- **通知**：系统通知开关、提醒时机
- **悬浮窗**：展开/收起延时、透明度、默认位置、显示内容模式
- **数据**：导入/导出 JSON、自动备份频率、打开数据目录

#### 2.2.6 数据管理
- 主存储：SQLite（通过 better-sqlite3 主进程操作）
- 自动备份：每日自动备份一次到应用数据目录，保留最近 N 份
- 导出：支持导出为 JSON / Markdown 全量备份
- 导入：支持从 JSON 备份文件恢复
- 预留云同步接口（v0.5+ 可能接入 WebDAV 或自建服务）

#### 2.2.7 桌面悬浮窗（核心亮点）

**设计理念**：让今日待办/正在进行的任务「一直看得见但不打扰」，用户自定义贴边位置，平时只露出一小条，鼠标悬停展开完整面板，离开后延时自动半隐藏。

**核心行为**：

| 行为 | 说明 |
|------|------|
| 贴边吸附 | 悬浮窗拖动到屏幕边缘（上/下/左/右）时自动吸附，进入半隐藏状态 |
| 半隐藏 | 窗体 80% 滑出屏幕外，仅露出 16-32px 的触发条（露出部分可自定义宽度） |
| 悬停展开 | 鼠标移动到露出的触发条上，窗体滑入屏幕完全展示，动画时长 200-300ms |
| 自动隐藏 | 鼠标离开窗体后，经过一段延时（默认 2s，可配置 1-10s）自动回到半隐藏位置 |
| 锁定模式 | 锁定位置后，鼠标拖动无效，防止误触；解锁后可重新拖动 |
| 置顶 | 悬浮窗始终置于其他窗口之上（`alwaysOnTop: true`），可临时取消 |
| 跨屏幕 | 支持多显示器，记录上次所在显示器和位置，重启后恢复 |

**位置模式**：
- `top`：贴屏幕顶部，露出底部一条
- `bottom`：贴屏幕底部，露出顶部一条
- `left`：贴屏幕左侧，露出右侧一条
- `right`：贴屏幕右侧（默认），露出左侧一条
- `floating`：不贴边，自由悬浮（不自动隐藏）

**外观配置**：
- 露出宽度（px）：默认 20px，范围 8-60px
- 窗体尺寸：默认 320×480，宽高均可调（240-600 / 320-900）
- 背景透明度：默认 95%，范围 70-100%
- 圆角、阴影、毛玻璃（vibrancy，macOS）
- 是否显示边框、窗口控制按钮（最小化/关闭）

**展示内容模式**：
- `today`（默认）：今日到期 + 进行中任务
- `inbox`：收件箱 / 快速捕获
- `focus`：当前聚焦的单一任务（番茄钟模式预留）
- `custom-list`：用户指定的某个分类/标签过滤结果
- `quick-add`：仅显示快速添加输入框，极简模式

**交互细节**：
- 展开状态下可直接勾选完成、快速编辑任务标题
- 点击任务跳转到主窗口并打开详情
- 快速添加输入框常驻悬浮窗顶部，回车即添加
- 右键悬浮窗触发条弹出菜单：展开/收起、位置选择、内容模式、锁定、设置、退出
- 全屏应用时自动隐藏（避免影响观看视频/演示），可配置是否启用
- 勿扰模式（开会/演示）：临时完全隐藏悬浮窗，到时自动恢复
- 开机自启时，悬浮窗直接以半隐藏状态启动

**异常与边界**：
- 拖动到远离边缘 → 恢复自由模式，不自动隐藏
- 分辨率改变/插拔显示器 → 重新计算位置，若上次位置越界则重置到右侧默认位置
- 展开时用户主动点击其他窗口 → 触发延时隐藏（不是立即隐藏，便于复制内容）
- 悬浮窗内有输入框获得焦点时 → 暂停自动隐藏，失焦后才计时

**IPC 接口规划**（主进程 ↔ 渲染进程）：
```ts
// 主进程 -> 渲染进程
float:state-change   // { mode: 'hidden' | 'shown', edge: Edge, bounds: Rectangle }
float:screen-change  // 显示器配置变化
// 渲染进程 -> 主进程
float:show           // 手动展开
float:hide           // 手动收起
float:set-position   // { edge: Edge, offset?: number }
float:set-bounds     // { width, height }
float:set-config     // { peekWidth, autoHideDelay, opacity, ... }
float:lock           // { locked: boolean }
float:open-quick-add // 聚焦快速输入框
```

**技术实现要点**：
- 使用独立 `BrowserWindow`（`frame: false`、`transparent: true`、`alwaysOnTop: true`、`resizable: true`、`skipTaskbar: true`）
- 主进程通过 `screen` 模块监听鼠标位置，判断是否需要展开/收起
- 拖动时使用 `-webkit-app-region: drag` + `setBounds` 实时更新
- 贴边检测：窗口拖动结束时判断与屏幕四边的距离，<20px 则吸附
- 自动隐藏使用 `setTimeout`，鼠标 `enter/leave` 事件重置计时器
- 半隐藏通过设置窗口坐标（`x` 或 `y` 为负值）实现，不是 CSS 动画，避免跨平台闪烁
- 毛玻璃效果使用 `vibrancy`（macOS）/ `Acrylic`（Windows 通过 `backgroundMaterial`）

---

## 三、非功能需求

1. **性能**：主窗口冷启动 < 2s；悬浮窗展开动画 ≥ 60fps、展开 < 300ms；悬浮窗空闲 CPU 接近 0%
2. **体积**：安装包 < 120MB
3. **稳定性**：崩溃率 < 0.1%；悬浮窗异常可自动重建；数据 WAL 预写防丢失
4. **跨平台**：macOS / Windows 优先（含悬浮窗），Linux 悬浮窗降级为普通置顶窗
5. **可访问性**：完整键盘操作；全局快捷键切主窗/悬浮窗
6. **隐私**：全本地存储，默认不上传
7. **可扩展性**：模块化，悬浮窗内容组件可插拔

---

## 四、技术架构

### 4.1 技术选型

| 层级 | 选型 | 理由 |
|------|------|------|
| 桌面框架 | Electron | 跨平台桌面端成熟方案 |
| 构建工具 | electron-vite | Electron + Vite 开箱即用，HMR 快 |
| UI 框架 | React 18 | 生态丰富、Hooks 友好 |
| 语言 | TypeScript 5 | 类型安全 |
| 样式 | Tailwind CSS 3 | 原子化 CSS，深色模式/主题切换方便 |
| 状态管理 | Zustand | 轻量、简单、无样板代码 |
| 路由 | React Router | 主窗口多页面导航 |
| 本地存储 | better-sqlite3 | 同步 API、性能好、事务支持 |
| 数据查询 | Kysely | 类型安全 SQL 查询构建器（可选） |
| Markdown | react-markdown + remark-gfm | 渲染，编辑用 textarea 简易增强 |
| 图表 | Recharts | React 生态，轻量统计图表 |
| 拖拽 | @dnd-kit | 现代、支持触摸、无障碍好 |
| 打包 | electron-builder | 跨平台打包/签名/自动更新 |
| 代码质量 | ESLint + Prettier | 统一风格 |
| 测试 | Vitest + React Testing Library | 单测 |

### 4.2 进程架构

```
┌──────────────────────── Main Process ────────────────────────┐
│  BrowserWindow: main      BrowserWindow: float (悬浮窗)       │
│  - 主界面                  - 置顶无框透明窗                    │
│  - 任务/笔记/统计/设置     - 贴边/半隐藏/悬停展开               │
│         │                           │                        │
│         │    IPC (contextBridge)    │                        │
│         ▼                           ▼                        │
│  ┌──────────── 主进程核心服务 ─────────────┐                  │
│  │ - WindowManager（双窗口创建/通信/位置）   │                  │
│  │ - FloatWindowController（悬浮窗状态机）   │                  │
│  │ - DatabaseService（SQLite CRUD）         │                  │
│  │ - BackupService（自动备份/导入导出）      │                  │
│  │ - NotificationService（系统提醒）         │                  │
│  │ - GlobalShortcut（全局快捷键）            │                  │
│  │ - Tray（托盘图标与菜单）                  │                  │
│  │ - AutoLaunch（开机自启）                  │                  │
│  └──────────────────────────────────────────┘                  │
└───────────────────────────────────────────────────────────────┘
```

### 4.3 目录结构（规划）

```
future-planner/
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── src/
│   ├── main/                    # 主进程
│   │   ├── index.ts             # 入口
│   │   ├── windows/
│   │   │   ├── MainWindow.ts
│   │   │   └── FloatWindow.ts   # 悬浮窗独立控制器
│   │   ├── services/
│   │   │   ├── db.ts
│   │   │   ├── backup.ts
│   │   │   ├── tray.ts
│   │   │   └── shortcuts.ts
│   │   ├── ipc/
│   │   │   ├── task.ts
│   │   │   ├── note.ts
│   │   │   ├── settings.ts
│   │   │   └── float.ts         # 悬浮窗 IPC
│   │   └── shared/types.ts
│   ├── preload/                 # 预加载脚本
│   │   ├── index.ts             # 通用 API
│   │   └── floatPreload.ts      # 悬浮窗专用 API
│   ├── renderer/                # 渲染进程（主窗口）
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── routes/
│   │   │   ├── Today.tsx
│   │   │   ├── Tasks.tsx
│   │   │   ├── Planner.tsx
│   │   │   ├── Stats.tsx
│   │   │   └── Settings.tsx
│   │   ├── components/
│   │   │   ├── TaskItem.tsx
│   │   │   ├── TaskDetail.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── ...
│   │   ├── stores/              # Zustand
│   │   │   ├── taskStore.ts
│   │   │   └── settingsStore.ts
│   │   └── styles/globals.css
│   └── float/                   # 悬浮窗渲染（独立 HTML/入口）
│       ├── index.html
│       ├── FloatApp.tsx
│       ├── float-main.tsx
│       ├── components/
│       │   ├── PeekBar.tsx      # 露出触发条
│       │   ├── FloatPanel.tsx   # 展开面板
│       │   ├── TodayList.tsx
│       │   ├── QuickAdd.tsx
│       │   └── FocusView.tsx
│       └── hooks/
│           └── useFloatAutoHide.ts
├── resources/                   # 图标等静态资源
└── docs/
    └── requirements.md
```

> 说明：悬浮窗使用独立的 HTML 入口（electron-vite 多入口配置），与主窗口复用组件/stores/样式，避免重复代码。

---

## 五、页面与交互（主窗口）

### 5.1 整体布局
```
┌─────────────────────────────────────────────┐
│ Sidebar   │  主内容区          │  详情面板    │
│ - Logo    │  ┌─────────────┐  │  (可折叠)    │
│ - 今日    │  │ 视图切换栏   │  │              │
│ - 收件箱  │  ├─────────────┤  │ 任务详情     │
│ - 分类树  │  │ 任务列表/看板 │  │ - 标题编辑   │
│ - 标签    │  │             │  │ - 描述MD     │
│ - 统计    │  │             │  │ - 子任务     │
│ - 设置    │  │             │  │ - 笔记       │
│           │  │             │  │ - 属性设置   │
│           │  └─────────────┘  │              │
└─────────────────────────────────────────────┘
```

### 5.2 主要页面
- **今日（Home）**：今日到期 + 逾期 + 进行中，顶部快速添加
- **任务列表**：全量任务，筛选/排序/批量操作
- **规划视图**：看板/日历/甘特（渐进）
- **笔记**：自由笔记列表
- **统计**：数据可视化
- **设置**：主题/快捷键/悬浮窗配置/数据管理

### 5.3 悬浮窗视觉示意
```
【半隐藏状态，贴右侧】
┊                                 ┊
┊                         ┌─16px─┐┊
┊                         │ ⋯⋯⋯⋯ │┊ ← 露出触发条（PeekBar）
┊                         │       │┊
┊                         │       │┊
┊                         └───────┘┊
┊                                 ┊
屏幕                                  屏幕外

【鼠标悬停后展开】
┊                                 ┊
┊                     ┌───────────┴┐
┊                     │ ── 今日 ──  │
┊                     │ ☐ 写需求文档│
┊                     │ ☐ 修bug    │
┊                     │ ☐ 回邮件   │
┊                     │ ┌───────┐  │
┊                     │ │+ 快速加│  │
┊                     └────────────┘
┊                                 ┊
```

---

## 六、数据模型（TypeScript 草案）

```ts
// 任务
interface Task {
  id: string;
  title: string;
  description: string; // Markdown
  status: 'todo' | 'in-progress' | 'done' | 'archived';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  category: string;
  tags: string[];
  dueDate: string | null;       // ISO
  reminderAt: string | null;
  parentId: string | null;
  order: number;                // 排序权重
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// 笔记
interface Note {
  id: string;
  taskId: string | null;        // 关联任务（null=自由笔记）
  title: string;
  content: string;              // Markdown
  createdAt: string;
  updatedAt: string;
}

// 应用设置
interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  // 悬浮窗相关
  float: {
    enabled: boolean;
    edge: 'top' | 'bottom' | 'left' | 'right' | 'floating';
    offset: number;             // 沿边偏移量
    peekWidth: number;          // 露出宽度
    width: number;
    height: number;
    opacity: number;            // 0-1
    autoHideDelay: number;      // ms
    contentMode: 'today' | 'inbox' | 'focus' | 'custom-list' | 'quick-add';
    customFilter: { category?: string; tag?: string } | null;
    locked: boolean;
    alwaysOnTop: boolean;
    hideOnFullscreen: boolean;
    showOnAllWorkspaces: boolean;
    vibrancy: boolean;
  };
  // 快捷键
  shortcuts: {
    toggleMain: string;
    toggleFloat: string;
    quickAdd: string;
  };
  // 通知
  notifications: {
    enabled: boolean;
    remindBeforeMinutes: number;
    sound: boolean;
  };
  // 数据
  data: {
    autoBackup: boolean;
    autoBackupIntervalDays: number;
    maxBackups: number;
    dataDir: string;
  };
  // 窗口位置
  windowState: {
    main: { x: number; y: number; width: number; height: number };
    float: { x: number; y: number };
    displayId: string;
  };
}
```

---

## 七、里程碑规划（建议）

### v0.1 MVP（约 1-2 周）
目标：**主窗口可用 + 任务 CRUD + 基础悬浮窗**

- [ ] 脚手架搭建：Electron + React + TS + Tailwind（electron-vite）
- [ ] 主进程基础：窗口创建、IPC 通信框架、SQLite 初始化
- [ ] 主窗口三栏布局、路由、Sidebar
- [ ] 任务 CRUD（列表 + 添加/编辑/删除/状态切换）
- [ ] 分类、优先级、截止日期
- [ ] 本地持久化（SQLite）
- [ ] 基础主题切换（亮/暗）
- [ ] **悬浮窗 v0.1**：独立 BrowserWindow、固定贴右、悬停展开、延时收起（硬编码配置）
- [ ] 导出/导入 JSON 备份
- [ ] 应用图标、打包配置（macOS/Windows）

### v0.2 可用版（约 1 周）
目标：**悬浮窗完善 + 体验打磨**

- [ ] 悬浮窗：位置可拖动 + 四边贴边吸附
- [ ] 悬浮窗：设置面板（露出宽度/延时/透明度/尺寸/内容模式）
- [ ] 悬浮窗：锁定、勿扰、全屏自动隐藏
- [ ] 悬浮窗：多显示器支持 + 位置记忆
- [ ] 悬浮窗：快速添加、勾选完成、点击跳转主窗
- [ ] 子任务支持
- [ ] 看板视图（@dnd-kit）
- [ ] 全局快捷键（唤起主窗/悬浮窗/快速添加）
- [ ] 托盘图标 + 菜单
- [ ] 开机自启

### v0.3 增强版（约 1-2 周）
- [ ] 笔记系统（Markdown 编辑/关联任务/内部链接）
- [ ] 统计页（完成率、连续天数、趋势图）
- [ ] 日历视图
- [ ] 提醒通知（系统通知）
- [ ] 自动备份
- [ ] 搜索（全局任务/笔记搜索）
- [ ] 悬浮窗内容模式：Focus（番茄钟）
- [ ] 标签筛选、高级搜索

### v0.4 进阶版（后续）
- [ ] 甘特视图/时间线
- [ ] 拖拽排序优化
- [ ] 附件/图片支持
- [ ] 多语言 i18n
- [ ] 云同步（WebDAV 优先）
- [ ] 自动更新（electron-updater）
- [ ] 命令面板（Cmd/Ctrl+K）

---

## 八、风险与应对

| 风险 | 影响 | 应对方案 |
|------|------|----------|
| Electron 打包体积大 | 安装包臃肿 | 启用打包优化，只保留必要模块，ASAR 打包 |
| better-sqlite3 原生模块跨平台编译 | 构建复杂 | 使用 electron-rebuild / prebuild-install，锁版本 |
| 悬浮窗在不同平台（尤其 Linux 窗口管理器）表现不一致 | 跨平台体验差 | Linux 降级；macOS/Windows 单独测试；通过 setBounds 而非 CSS 控制位置规避闪烁 |
| 透明无边框窗口拖拽/输入区域在 Windows 偶发穿透 | 交互 bug | 精确设置 `-webkit-app-region: drag/no-drag`，必要时分层解决 |
| 主窗口和悬浮窗状态同步 | 数据一致性 | 两窗口共享 SQLite，通过 IPC 广播变更事件；Zustand 持久化到 SQLite；避免双写 |
| 自动隐藏逻辑误触发（操作中被收起） | 体验差 | 输入框聚焦/菜单打开/拖拽中时暂停计时；提供"钉住"开关 |

---

## 九、下一步行动

1. **初始化项目**：使用 `electron-vite` 官方 React + TS 模板初始化
2. **集成 Tailwind CSS**：安装依赖、配置 `tailwind.config.js`、暗黑模式策略
3. **主窗口骨架**：Sidebar + 主内容 + 详情面板三栏布局，React Router
4. **数据层**：封装 better-sqlite3，建 Task/Note/Settings 表，IPC Handler 骨架
5. **任务 CRUD**：实现今日页，完成基础 Todo 闭环
6. **悬浮窗原型**：创建第二个 BrowserWindow，实现贴边 + 悬停展开 + 自动隐藏的最小可用版本，快速验证技术可行性
7. **打磨悬浮窗**：拖动/吸附/配置化/多屏
8. **打包配置**：electron-builder 跑通 macOS/Windows 打包

---

*附：悬浮窗状态机草图*

```
            启动 → [Hidden 半隐藏]
                      │  mouseenter peekBar
                      ▼
                [Showing 动画展开]
                      │  动画结束
                      ▼
                 [Shown 展开]
                    │    │
                    │    │ mouseleave (开始计时)
                    │    ▼
                    │ [HideCountdown 延时中]
                    │    │  mouseenter / 聚焦输入
                    │    └─── 取消计时 ──→ [Shown]
                    │    │
                    │    ▼ 计时到
                    ▼ [Hiding 动画收起]
                      │
                      ▼
                 [Hidden 半隐藏]

  附加：[Floating 自由模式] 不自动隐藏，可随时拖动；拖到边缘自动切换到 Hidden 模式
```

