import React from 'react'
import Button from '../../ui/Button'
import Card from '../../ui/Card'
import IconPlus from '../../icons/IconPlus'
import { useChatStore } from '../../../stores/chatStore'
import { ClipboardList, ImagePlus } from 'lucide-react'
import { desktopApi } from '../../../shared/desktop'

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
  const planAvailable = desktopApi.capabilities.plan

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
            {planAvailable ? (
              <button
                type="button"
                className="prompt-dropdown-provider prompt-action-menu-item"
                onClick={() => {
                  setIsOpen(false)
                  useChatStore.getState().setPlanListModalOpen(true)
                }}
              >
                <ClipboardList size={17} aria-hidden="true" />
                <span>绑定开发计划</span>
              </button>
            ) : null}
          </Card>
        </>
      )}
    </div>
  )
}
