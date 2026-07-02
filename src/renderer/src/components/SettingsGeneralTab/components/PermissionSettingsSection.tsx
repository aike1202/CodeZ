import React, { useState, useRef, useEffect } from 'react'
import IconShieldAsk from '../../icons/IconShieldAsk'
import IconShieldApprove from '../../icons/IconShieldApprove'
import IconShieldAlert from '../../icons/IconShieldAlert'

interface PermissionSettingsSectionProps {
  workspaceMode: string
  onUpdate: (key: any, value: any) => void
}

const PERMISSION_MODES = [
  {
    id: 'ask',
    title: '请求批准',
    subtitle: '每次执行系统命令或写入文件时都会询问。推荐新手使用。'
  },
  {
    id: 'auto-approve-safe',
    title: '替我审批',
    subtitle: '自动放行安全操作，仅拦截修改与风险命令。'
  },
  {
    id: 'full-access',
    title: '完全访问',
    subtitle: '减少确认次数。赋予极高权限，仅拦截极端危险命令。'
  }
]

const getPermissionIcon = (id: string) => {
  if (id === 'ask') {
    return <IconShieldAsk size={20} />
  }
  if (id === 'auto-approve-safe') {
    return <IconShieldApprove size={20} />
  }
  return <IconShieldAlert size={20} />
}

export function PermissionSettingsSection({
  workspaceMode,
  onUpdate
}: PermissionSettingsSectionProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const currentMode = PERMISSION_MODES.find((m) => m.id === workspaceMode) || PERMISSION_MODES[1]

  return (
    <div className="settings-general-card">
      <div
        className="settings-general-row"
        style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '16px' }}
      >
        <div>
          <div className="settings-general-label">自动执行权限模式</div>
          <div className="settings-general-desc">控制 Agent 在执行可能存在风险的操作时是否需要询问。</div>
        </div>
        <div className="permission-dropdown-container" ref={dropdownRef}>
          <div className="permission-dropdown-trigger" onClick={() => setIsOpen(!isOpen)}>
            <div className="permission-dropdown-trigger-icon">{getPermissionIcon(currentMode.id)}</div>
            <div className="permission-dropdown-trigger-text">
              <div className="permission-dropdown-trigger-title">{currentMode.title}</div>
              <div className="permission-dropdown-trigger-subtitle">{currentMode.subtitle}</div>
            </div>
            <div className="permission-dropdown-trigger-arrow">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          {isOpen && (
            <div className="permission-dropdown-menu">
              <div className="permission-dropdown-header">权限级别</div>
              {PERMISSION_MODES.map((item) => (
                <div
                  key={item.id}
                  className={`permission-dropdown-item ${workspaceMode === item.id ? 'selected' : ''}`}
                  onClick={() => {
                    onUpdate('workspaceMode', item.id)
                    setIsOpen(false)
                  }}
                >
                  <div className="permission-dropdown-item-icon">{getPermissionIcon(item.id)}</div>
                  <div className="permission-dropdown-item-text">
                    <div className="permission-dropdown-item-title">{item.title}</div>
                    <div className="permission-dropdown-item-subtitle">{item.subtitle}</div>
                  </div>
                  {workspaceMode === item.id && (
                    <div className="permission-dropdown-item-check">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
