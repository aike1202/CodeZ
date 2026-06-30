# General Settings UI Design

## 1. Overview
The General Settings feature introduces a new "常规" (General) tab within the application's global Settings Page. It follows a grouped, scrollable long-list design. The settings cover various application-wide behaviors, from appearance and themes to terminal and proxy configuration.

## 2. Architecture & State Management
- **State Store**: A new Zustand store (`settingsStore.ts`) will manage the frontend state for all general settings.
- **Persistence**: The store will interface with the Electron main process via IPC (e.g., `window.api.settings.load()` and `window.api.settings.save()`) to persist preferences in the application's `userData` or a dedicated local configuration file.
- **Initialization**: Settings will be loaded asynchronously when the app starts or when the settings page mounts.

## 3. UI Components
- **SettingsGeneralTab.tsx**: The main React component rendering the settings list.
- **Switch.tsx**: A new reusable UI toggle switch component to be created in `src/renderer/src/components/ui/` for boolean settings (e.g., enable/disable notifications).
- **Cards & Layout**: The page will use existing `Card`, `Stack`, and `Flex` components. Each functional grouping will be placed inside a visually distinct card.

## 4. Configuration Groupings (Sections)

### 4.1 Appearance & Display (外观与显示)
- **App Theme (界面主题)**: Select (System, Light, Dark). Controls the global CSS theme.
- **Language (界面语言)**: Select (zh-CN, en-US). 
- **Code Editor Theme (代码编辑器主题)**: Select (github, dracula, material, xcode, eclipse). Used by the `react-codemirror` component in the app.

### 4.2 Terminal & Network (终端与网络)
- **Inherit System Profile (继承系统终端 Profile)**: Switch. Controls whether the built-in terminal inherits shell environments and proxies.
- **Terminal Font (终端字体)**: Input. Blank defaults to system monospace.
- **Integrated Shell (集成终端 Shell)**: Select (Auto, Git Bash, cmd, PowerShell).
- **HTTP Proxy (HTTP 代理)**: Input. Blank means direct connection.

### 4.3 System & Notifications (系统与通知)
- **Task Notifications (任务通知)**: Switch. Desktop notifications for task events.
- **Notification Sounds (通知声音)**: Switch.
- **Hide to Tray on Close (关闭窗口时隐藏到托盘)**: Switch. Modifies window close behavior (Windows only).

### 4.4 Interaction & Preferences (交互与偏好)
- **Interaction Behavior (交互行为)**: Select (Queue, Immediate execution). 
- **Show Thinking Process (显示思考过程)**: Switch. Toggles the visibility of LLM reasoning blocks in the chat.
- **Show Todo Cards (显示待办)**: Switch. Toggles the visibility of task/todo cards in the message stream.

### 4.5 Storage & Management (存储与任务管理)
- **Auto-Archive Old Tasks (自动归档旧任务)**: Switch.
- **Archive Retention Period (归档保留时长)**: Select (3 Days, 7 Days, 14 Days, 30 Days).
- **Data Storage Path (数据存储路径)**: Path display + "Change Folder" (更改目录) button. Invokes a directory picker.
- **Experience Optimization (优化体验)**: Switch. Telemetry opt-in.

## 5. Security & Constraints
- Modifying the **Data Storage Path** might require moving files or a restart. A basic implementation will just update the path, but the UI should warn the user.
- **HTTP Proxy** updates might also require an application restart or dynamic axios/fetch configuration.
