import React from 'react'
import Button from '../../ui/Button'
import Card from '../../ui/Card'
import IconPlus from '../../icons/IconPlus'
import { useChatStore } from '../../../stores/chatStore'
import { ImagePlus } from 'lucide-react'

interface PlusActionMenuProps {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  onCloseOthers: () => void
  onAddPhotos: () => void
}

export default function PlusActionMenu({
  isOpen,
  setIsOpen,
  onCloseOthers,
  onAddPhotos
}: PlusActionMenuProps): React.ReactElement {
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="none"
        className="prompt-plus-btn"
        onClick={() => {
          onCloseOthers()
          setIsOpen(!isOpen)
        }}
      >
        <IconPlus />
      </Button>
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[40]" onClick={() => setIsOpen(false)}></div>
          <Card
            variant="default"
            className="prompt-dropdown-card"
            style={{ left: 0, bottom: '100%', marginBottom: '8px', minWidth: '180px' }}
          >
            <button
              type="button"
              className="prompt-dropdown-provider prompt-action-menu-item"
              onClick={() => {
                setIsOpen(false)
                onAddPhotos()
              }}
            >
              <ImagePlus size={17} aria-hidden="true" />
              <span>添加照片</span>
            </button>
            <div
              className="prompt-dropdown-provider"
              onClick={() => {
                setIsOpen(false)
                useChatStore.getState().setPlanListModalOpen(true)
              }}
              style={{ cursor: 'pointer', padding: '10px 14px' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span style={{ fontSize: '1.1em' }}>📋</span> 绑定开发计划
              </span>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
