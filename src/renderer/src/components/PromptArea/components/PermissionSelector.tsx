import React from 'react'
import Button from '../../ui/Button'
import Card from '../../ui/Card'
import IconChevronDown from '../../icons/IconChevronDown'
import IconShieldAsk from '../../icons/IconShieldAsk'
import IconShieldApprove from '../../icons/IconShieldApprove'
import IconShieldAlert from '../../icons/IconShieldAlert'
import { PERMISSION_MODES, permissionLabels } from '../constants'
import { useWorkspaceStore } from '../../../stores/workspaceStore'

interface PermissionSelectorProps {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  onCloseOthers: () => void
}

const getPermissionIcon = (id: string) => {
  if (id === 'ask') {
    return <IconShieldAsk />
  }
  if (id === 'auto-approve-safe') {
    return <IconShieldApprove />
  }
  return <IconShieldAlert />
}

export default function PermissionSelector({
  isOpen,
  setIsOpen,
  onCloseOthers
}: PermissionSelectorProps): React.ReactElement {
  const currentWorkspace = useWorkspaceStore((s: any) => s.workspace)
  const setPermissionMode = useWorkspaceStore((s: any) => s.setPermissionMode)
  const mode = currentWorkspace?.permissionMode || 'auto-approve-safe'

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="none"
        className="prompt-approve-btn"
        onClick={() => {
          onCloseOthers()
          setIsOpen(!isOpen)
        }}
        style={{ color: mode === 'full-access' ? 'var(--error-color, #ef4444)' : 'inherit' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {getPermissionIcon(mode)}
        </span>
        <span style={{ marginLeft: '4px' }}>
          {PERMISSION_MODES.find((m) => m.id === mode)?.title || permissionLabels[mode]}
        </span>
        <IconChevronDown />
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-[40]" onClick={() => setIsOpen(false)}></div>
          <Card
            variant="default"
            className="prompt-dropdown-card"
            style={{ left: 0, bottom: '100%', marginBottom: '8px', minWidth: '240px', padding: '0' }}
          >
            <div
              className="prompt-dropdown-header"
              style={{
                padding: '12px 16px',
                fontSize: '12px',
                color: 'var(--text-muted)',
                borderBottom: '1px solid var(--border-color)'
              }}
            >
              权限级别
            </div>
            {PERMISSION_MODES.map((m) => (
              <div
                key={m.id}
                className={`prompt-dropdown-provider ${mode === m.id ? 'is-active' : ''}`}
                onClick={() => {
                  setPermissionMode(m.id)
                  setIsOpen(false)
                }}
                style={{
                  display: 'flex',
                  gap: '12px',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  alignItems: 'flex-start'
                }}
              >
                <div
                  style={{
                    color: mode === m.id ? 'var(--primary-color)' : 'var(--text-muted)',
                    marginTop: '2px',
                    flexShrink: 0,
                    display: 'flex',
                    width: '20px',
                    height: '20px',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  {getPermissionIcon(m.id)}
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 500,
                      color: mode === m.id ? 'var(--primary-color)' : 'var(--text-main)'
                    }}
                  >
                    {m.title}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    {m.subtitle}
                  </div>
                </div>
                {mode === m.id && (
                  <div
                    style={{
                      color: 'var(--primary-color)',
                      flexShrink: 0,
                      marginTop: '2px',
                      display: 'flex',
                      width: '20px',
                      height: '20px',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
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
          </Card>
        </>
      )}
    </div>
  )
}
