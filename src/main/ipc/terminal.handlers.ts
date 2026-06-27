import { ipcMain, BrowserWindow } from 'electron'
import { TerminalService } from '../services/TerminalService'

export function registerTerminalIpc(): void {
  ipcMain.handle('terminal:start', (event, workspaceId: string, rootPath: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    TerminalService.start(workspaceId, rootPath, window)
  })

  ipcMain.handle('terminal:write', (_event, workspaceId: string, text: string) => {
    TerminalService.write(workspaceId, text)
  })

  ipcMain.handle('terminal:resize', (_event, workspaceId: string, cols: number, rows: number) => {
    TerminalService.resize(workspaceId, cols, rows)
  })

  ipcMain.handle('terminal:kill', (_event, workspaceId: string) => {
    TerminalService.kill(workspaceId)
  })
}
