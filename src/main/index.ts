import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import { registerWorkspaceIpc } from './ipc/workspace.handlers'
import { registerProviderIpc } from './ipc/provider.handlers'
import { registerChatIpc } from './ipc/chat.handlers'
import { registerSessionIpc } from './ipc/session.handlers'
import { registerTerminalIpc } from './ipc/terminal.handlers'
import { registerProjectMemoryIpc } from './ipc/project-memory.handlers'
import { registerTaskIpc } from './ipc/task.handlers'
import { TerminalService } from './services/TerminalService'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    
    // 隐藏系统原生标题栏及边框
    frame: false,
    titleBarStyle: 'hidden',
    
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Windows 下干掉原生应用菜单栏 File Edit 等
  mainWindow.setMenu(null)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window-maximized-state', true)
  })
  
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window-maximized-state', false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 监听键盘按键开启开发者工具
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.myagent.desktop')

  registerWorkspaceIpc()
  registerProviderIpc()
  registerChatIpc()
  registerSessionIpc()
  registerTerminalIpc()
  registerProjectMemoryIpc()
  registerTaskIpc()

  // 监听来自前端渲染进程的自定义标题栏指令
  ipcMain.on('window-control', (_, action) => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
    if (action === 'close') mainWindow.close()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  TerminalService.killAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  TerminalService.killAll()
})
