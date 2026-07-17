import React from 'react'
import Button from '../../ui/Button'
import IconMinimize from '../../icons/IconMinimize'
import IconMaximize from '../../icons/IconMaximize'
import IconWindowRestore from '../../icons/IconWindowRestore'
import IconClose from '../../icons/IconClose'
import { desktopApi } from '../../../shared/desktop'

interface WindowControlsProps {
  isMaximized: boolean
  setIsMaximized: React.Dispatch<React.SetStateAction<boolean>>
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
        onClick={() => void desktopApi.window.control('minimize').catch(() => undefined)}
      >
        <IconMinimize />
      </Button>
      <Button
        variant="ghost"
        size="none"
        className="window-control-btn btn-maximize"
        title={isMaximized ? '还原' : '最大化'}
        onClick={() => {
          void desktopApi.window.control('toggleMaximize')
            .then(() => setIsMaximized((value) => !value))
            .catch(() => undefined)
        }}
      >
        {isMaximized ? <IconWindowRestore /> : <IconMaximize />}
      </Button>
      <Button
        variant="ghost"
        size="none"
        className="window-control-btn btn-close"
        title="关闭"
        onClick={() => void desktopApi.window.control('close').catch(() => undefined)}
      >
        <IconClose />
      </Button>
    </div>
  )
}
