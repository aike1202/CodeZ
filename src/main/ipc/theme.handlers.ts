import { ipcMain, nativeTheme, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

export function registerThemeIpc(): void {
  // Get current effective theme (dark or light)
  ipcMain.handle(IPC_CHANNELS.THEME_GET, () => {
    return {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      themeSource: nativeTheme.themeSource
    }
  })

  // Set theme source ('system', 'light', 'dark')
  ipcMain.handle(IPC_CHANNELS.THEME_SET, (_, source: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = source
    return {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      themeSource: nativeTheme.themeSource
    }
  })

  // Listen to OS theme changes
  nativeTheme.on('updated', () => {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(IPC_CHANNELS.THEME_UPDATED, {
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        themeSource: nativeTheme.themeSource
      })
    })
  })
}
