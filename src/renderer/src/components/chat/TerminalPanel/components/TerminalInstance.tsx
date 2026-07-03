import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalInstanceProps {
  terminalId: string
  rootPath: string
  visible: boolean
  sidebarWidth?: number
  previewPanelWidth?: number
  height: number
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
  clearTrigger,
  resetTrigger
}: TerminalInstanceProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!visible) return
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
  }, [visible, sidebarWidth, previewPanelWidth, height])

  useEffect(() => {
    if (visible && termRef.current) {
      termRef.current.focus()
    }
  }, [visible])

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
    if (termRef.current) {
      termRef.current.write('\r\n\x1b[33m[正在重置终端进程...]\x1b[0m\r\n')
      await window.api.terminal.kill(terminalId)
      await window.api.terminal.start(terminalId, rootPath)
      if (termRef.current && fitAddonRef.current) {
        const { cols, rows } = termRef.current
        await window.api.terminal.resize(terminalId, cols, rows)
      }
      termRef.current.write('\x1b[32m[终端进程已重启]\x1b[0m\r\n')
      termRef.current.focus()
    }
  }

  useEffect(() => {
    if (!containerRef.current) return

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

    window.api.terminal
      .start(terminalId, rootPath)
      .then(() => {
        const { cols, rows } = term
        window.api.terminal.resize(terminalId, cols, rows).catch(() => {})
      })
      .catch((err: any) => {
        term.write(`\r\n\x1b[31m[无法启动终端]: ${err}\x1b[0m\r\n`)
      })

    const termDataDisposable = term.onData((data) => {
      window.api.terminal.write(terminalId, data).catch(() => {})
    })

    const termResizeDisposable = term.onResize((size) => {
      window.api.terminal.resize(terminalId, size.cols, size.rows).catch(() => {})
    })

    const unsubscribeOutput = window.api.terminal.onOutput((tId: string, data: string) => {
      if (tId === terminalId) {
        term.write(data)
      }
    })

    const unsubscribeExit = window.api.terminal.onExit((tId: string) => {
      if (tId === terminalId) {
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

    if (visible) {
      term.focus()
    }

    return () => {
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
