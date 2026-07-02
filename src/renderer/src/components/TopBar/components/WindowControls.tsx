import React from 'react'
import Button from '../../ui/Button'
import IconMinimize from '../../icons/IconMinimize'
import IconMaximize from '../../icons/IconMaximize'
import IconRestore from '../../icons/IconRestore'
import IconClose from '../../icons/IconClose'

interface WindowControlsProps {
  isMaximized: boolean
  setIsMaximized: React.Dispatch<React.SetStateAction<boolean>>
}

function sendWindowControl(action: 'minimize' | 'maximize' | 'close') {
  try {
    const win = window as any
    if (win.electron?.ipcRenderer) {
      win.electron.ipcRenderer.send('window-control', action)
    }
  } catch {}
}

export default function WindowControls({
  isMaximized,
  setIsMaximized
}: WindowControlsProps): React.ReactElement {
  return (
    <div className="topbar-window-controls">
      <Button
        variant="ghost"
        size="none"
        className="window-control-btn btn-minimize"
        title="最小化"
        onClick={() => sendWindowControl('minimize')}
      >
        <IconMinimize />
      </Button>
      <Button
        variant="ghost"
        size="none"
        className="window-control-btn btn-maximize"
        title={isMaximized ? '还原' : '最大化'}
        onClick={() => {
          setIsMaximized(!isMaximized)
          sendWindowControl('maximize')
        }}
      >
        {isMaximized ? <IconRestore /> : <IconMaximize />}
      </Button>
      <Button
        variant="ghost"
        size="none"
        className="window-control-btn btn-close"
        title="关闭"
        onClick={() => sendWindowControl('close')}
      >
        <IconClose />
      </Button>
    </div>
  )
}
