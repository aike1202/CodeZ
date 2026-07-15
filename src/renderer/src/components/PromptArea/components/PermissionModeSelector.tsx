import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { PermissionMode } from '@shared/types/permission'
import { useWorkspaceStore } from '../../../stores/workspaceStore'

interface PermissionModeOption {
  value: PermissionMode
  label: string
  description: string
  icon: LucideIcon
}

const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = [
  {
    value: 'auto',
    label: '自动',
    description: '常规操作直接执行，风险操作按权限策略确认',
    icon: ShieldCheck
  },
  {
    value: 'full-access',
    label: '完全访问',
    description: '尽可能自动执行；模型可请求确认，绝对红线始终询问',
    icon: ShieldAlert
  }
]

export default function PermissionModeSelector(): React.ReactElement {
  const workspace = useWorkspaceStore((state) => state.workspace)
  const mode = useWorkspaceStore((state) => state.permissionMode)
  const setMode = useWorkspaceStore((state) => state.setPermissionMode)
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [isUpdating, setIsUpdating] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selectedIndex = PERMISSION_MODE_OPTIONS.findIndex((option) => option.value === mode)
  const selectedOption = PERMISSION_MODE_OPTIONS[selectedIndex] ?? PERMISSION_MODE_OPTIONS[0]

  useEffect(() => {
    if (!isOpen) return
    listboxRef.current?.focus()
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [isOpen])

  const openMenu = (nextActiveIndex = selectedIndex) => {
    if (!workspace || isUpdating) return
    setActiveIndex(nextActiveIndex < 0 ? 0 : nextActiveIndex)
    setIsOpen(true)
  }

  const closeMenu = (restoreFocus = false) => {
    setIsOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  const selectMode = async (nextMode: PermissionMode) => {
    if (isUpdating) return
    closeMenu(true)
    if (nextMode === mode) return
    setIsUpdating(true)
    try {
      await setMode(nextMode)
    } catch {
      // workspaceStore restores the previous mode when persistence fails.
    } finally {
      setIsUpdating(false)
    }
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openMenu(selectedIndex)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(selectedIndex < 0 ? 0 : selectedIndex)
    }
  }

  const handleListboxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % PERMISSION_MODE_OPTIONS.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + PERMISSION_MODE_OPTIONS.length) % PERMISSION_MODE_OPTIONS.length)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(PERMISSION_MODE_OPTIONS.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      void selectMode(PERMISSION_MODE_OPTIONS[activeIndex].value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(true)
    } else if (event.key === 'Tab') {
      setIsOpen(false)
    }
  }

  return (
    <div
      ref={rootRef}
      className="prompt-permission-selector"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="prompt-permission-trigger"
        disabled={!workspace || isUpdating}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-busy={isUpdating}
        title="当前工作区权限模式"
        onClick={() => isOpen ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedOption.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {isOpen ? (
        <div
          ref={listboxRef}
          id={listboxId}
          className="prompt-permission-menu"
          role="listbox"
          aria-label="选择权限模式"
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          tabIndex={-1}
          onKeyDown={handleListboxKeyDown}
        >
          {PERMISSION_MODE_OPTIONS.map((option, index) => {
            const Icon = option.icon
            const isSelected = option.value === mode
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                className={`prompt-permission-option${isSelected ? ' is-selected' : ''}${activeIndex === index ? ' is-active' : ''}`}
                role="option"
                aria-selected={isSelected}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => void selectMode(option.value)}
              >
                <Icon className="prompt-permission-option-icon" size={19} strokeWidth={1.8} aria-hidden="true" />
                <span className="prompt-permission-option-copy">
                  <span className="prompt-permission-option-title">{option.label}</span>
                  <span className="prompt-permission-option-description">{option.description}</span>
                </span>
                <span className="prompt-permission-option-check" aria-hidden="true">
                  {isSelected ? <Check size={18} strokeWidth={2} /> : null}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
