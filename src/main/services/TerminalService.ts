import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'

export class TerminalService {
  private static instances: Map<string, pty.IPty> = new Map()

  static start(terminalId: string, rootPath: string, window: BrowserWindow) {
    if (this.instances.has(terminalId)) {
      return
    }

    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : 'bash'
    const args = isWin ? ['-NoExit', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'] : []

    try {
      const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: rootPath,
        env: process.env as any
      })

      this.instances.set(terminalId, ptyProcess)

      ptyProcess.onData((data: string) => {
        if (!window.isDestroyed()) {
          window.webContents.send('terminal:output', terminalId, data)
        }
      })

      ptyProcess.onExit(() => {
        this.instances.delete(terminalId)
        if (!window.isDestroyed()) {
          window.webContents.send('terminal:exit', terminalId)
        }
      })
    } catch (err) {
      console.error('Failed to spawn pty process:', err)
      if (!window.isDestroyed()) {
        window.webContents.send('terminal:output', terminalId, `[Error spawning shell]: ${err instanceof Error ? err.message : String(err)}\r\n`)
      }
    }
  }

  static write(terminalId: string, text: string) {
    const proc = this.instances.get(terminalId)
    if (proc) {
      proc.write(text)
    }
  }

  static resize(terminalId: string, cols: number, rows: number) {
    const proc = this.instances.get(terminalId)
    if (proc) {
      try {
        proc.resize(cols, rows)
      } catch (err) {
        console.error('Failed to resize pty process:', err)
      }
    }
  }

  static kill(terminalId: string) {
    const proc = this.instances.get(terminalId)
    if (proc) {
      try {
        proc.kill()
      } catch (err) {
        console.error('Failed to kill pty process:', err)
      }
      this.instances.delete(terminalId)
    }
  }

  static killAll() {
    for (const [id, proc] of this.instances.entries()) {
      try {
        proc.kill()
      } catch (err) {
        console.error(`Failed to kill pty process ${id}:`, err)
      }
    }
    this.instances.clear()
  }
}
