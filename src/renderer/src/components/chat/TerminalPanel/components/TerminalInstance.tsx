import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { desktopApi } from '../../../../shared/desktop'

interface TerminalInstanceProps {
  terminalId: string
  rootPath: string
  visible: boolean
  sidebarWidth?: number
  previewPanelWidth?: number
  height: number
  panelVisible?: boolean
  clearTrigger: number
  resetTrigger: number
}

export function TerminalInstance({
  terminalId,
  rootPath,
  visible,
  sidebarWidth,
  previewPanelWidth,
  height,
  panelVisible = true,
  clearTrigger,
  resetTrigger
}: TerminalInstanceProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const lifecycleRef = useRef(0)
  const resetInFlightRef = useRef(false)

  useEffect(() => {
    if (!visible || !panelVisible) return
    const handleResize = () => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch (err) {
          console.error('Fit error:', err)
        }
      }
    }

    const timer = setTimeout(handleResize, 50)
    window.addEventListener('resize', handleResize)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', handleResize)
    }
  }, [visible, panelVisible, sidebarWidth, previewPanelWidth, height])

  useEffect(() => {
    if (visible && panelVisible && termRef.current) {
      termRef.current.focus()
    }
  }, [visible, panelVisible])

  useEffect(() => {
    if (clearTrigger > 0 && termRef.current) {
      termRef.current.clear()
      termRef.current.focus()
    }
  }, [clearTrigger])

  useEffect(() => {
    if (resetTrigger > 0) {
      handleResetInternal()
    }
  }, [resetTrigger])

  const handleResetInternal = async () => {
    const term = termRef.current
    if (!term || resetInFlightRef.current) return

    const lifecycle = lifecycleRef.current
    resetInFlightRef.current = true
    term.write('\r\n\x1b[33m[正在重置终端进程...]\x1b[0m\r\n')
    try {
      await desktopApi.terminal.kill(terminalId)
      if (lifecycle !== lifecycleRef.current) return

      await desktopApi.terminal.start(terminalId, rootPath)
      if (lifecycle !== lifecycleRef.current) {
        await desktopApi.terminal.kill(terminalId).catch(() => undefined)
        return
      }
      const { cols, rows } = term
      await desktopApi.terminal.resize(terminalId, cols, rows)
      term.write('\x1b[32m[终端进程已重启]\x1b[0m\r\n')
      term.focus()
    } catch (error) {
      if (lifecycle === lifecycleRef.current) {
        termRef.current?.write(`\r\n\x1b[31m[重置终端失败]: ${String(error)}\x1b[0m\r\n`)
      }
    } finally {
      if (lifecycle === lifecycleRef.current) resetInFlightRef.current = false
    }
  }

  useEffect(() => {
    if (!containerRef.current) return

    const lifecycle = lifecycleRef.current + 1
    lifecycleRef.current = lifecycle
    let disposed = false

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono') || 'Cascadia Code, Consolas, monospace',
      theme: {
        background: '#f8f9fa',
        foreground: '#24292f',
        cursor: '#24292f',
        cursorAccent: '#f8f9fa',
        selectionBackground: '#add6ff',
        black: '#24292f',
        red: '#cf222e',
        green: '#116329',
        yellow: '#4d3800',
        blue: '#0969da',
        magenta: '#8250df',
        cyan: '#0594fa',
        white: '#24292f',
        brightBlack: '#57606a',
        brightRed: '#a0111f',
        brightGreen: '#1a7f37',
        brightYellow: '#6e5600',
        brightBlue: '#218bff',
        brightMagenta: '#a475f9',
        brightCyan: '#0969da',
        brightWhite: '#24292f'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    try {
      fitAddon.fit()
    } catch (err) {
      console.error(err)
    }

    termRef.current = term
    fitAddonRef.current = fitAddon

    void desktopApi.terminal
      .start(terminalId, rootPath)
      .then(async () => {
        if (disposed || lifecycle !== lifecycleRef.current) {
          await desktopApi.terminal.kill(terminalId).catch(() => undefined)
          return
        }
        const { cols, rows } = term
        desktopApi.terminal.resize(terminalId, cols, rows).catch(() => {})
      })
      .catch((error: unknown) => {
        if (disposed || lifecycle !== lifecycleRef.current) return
        const err = String(error)
        term.write(`\r\n\x1b[31m[无法启动终端]: ${err}\x1b[0m\r\n`)
      })

    const termDataDisposable = term.onData((data) => {
      desktopApi.terminal.write(terminalId, data).catch(() => {})
    })

    const termResizeDisposable = term.onResize((size) => {
      desktopApi.terminal.resize(terminalId, size.cols, size.rows).catch(() => {})
    })

    const unsubscribeOutput = desktopApi.terminal.onOutput(({ workspaceId, data }) => {
      if (workspaceId === terminalId) {
        term.write(data)
      }
    })

    const unsubscribeExit = desktopApi.terminal.onExit(({ workspaceId }) => {
      if (workspaceId === terminalId) {
        term.write('\r\n\x1b[31m[系统进程：当前终端 Shell 已退出]\x1b[0m\r\n')
      }
    })

    const timer = setTimeout(() => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch (err) {
          console.error(err)
        }
      }
    }, 150)

    if (visible && panelVisible) {
      term.focus()
    }

    return () => {
      disposed = true
      lifecycleRef.current += 1
      resetInFlightRef.current = false
      clearTimeout(timer)
      termDataDisposable.dispose()
      termResizeDisposable.dispose()
      unsubscribeOutput()
      unsubscribeExit()
      term.dispose()
    }
  }, [terminalId, rootPath])

  return (
    <div
      ref={containerRef}
      className={`terminal-instance-mount ${visible ? 'block' : 'hidden'}`}
    />
  )
}
