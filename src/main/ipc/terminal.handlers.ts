import { ipcMain, BrowserWindow } from 'electron'
import { TerminalService } from '../services/TerminalService'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

export function registerTerminalIpc(): void {
  ipcMain.handle(IPC_CHANNELS.TERMINAL_START, (event, workspaceId: string, rootPath: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    TerminalService.start(workspaceId, rootPath, window)
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE, (_event, workspaceId: string, text: string) => {
    TerminalService.write(workspaceId, text)
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, (_event, workspaceId: string, cols: number, rows: number) => {
    TerminalService.resize(workspaceId, cols, rows)
  })

  ipcMain.handle(IPC_CHANNELS.TERMINAL_KILL, (_event, workspaceId: string) => {
    TerminalService.kill(workspaceId)
  })
}
