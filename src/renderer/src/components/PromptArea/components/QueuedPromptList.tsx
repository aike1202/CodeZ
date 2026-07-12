import { useEffect, useRef, useState } from 'react'
import {
  CornerDownRight,
  Ellipsis,
  GripVertical,
  Image as ImageIcon,
  ListX,
  Pencil,
  Trash2
} from 'lucide-react'
import type { QueuedPrompt } from '@shared/types/queuedPrompt'

interface QueuedPromptListProps {
  prompts: QueuedPrompt[]
  onSteer: (prompt: QueuedPrompt) => void
  onEdit: (prompt: QueuedPrompt) => void
  onDelete: (prompt: QueuedPrompt) => void
  onClear: () => void
}

export default function QueuedPromptList({
  prompts,
  onSteer,
  onEdit,
  onDelete,
  onClear
}: QueuedPromptListProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuRootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openMenuId) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) setOpenMenuId(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [openMenuId])

  return (
    <div className="queued-prompt-panel" aria-label="待处理消息">
      {prompts.map((prompt, index) => (
        <div className="queued-prompt-row" key={prompt.id}>
          <GripVertical className="queued-prompt-grip" size={14} aria-hidden="true" />
          <span className="queued-prompt-branch" aria-hidden="true">
            <CornerDownRight size={14} />
          </span>
          <span className="queued-prompt-copy" title={prompt.text}>
            {prompt.text || `图片消息 ${index + 1}`}
          </span>
          {prompt.attachments.length > 0 ? (
            <span className="queued-prompt-attachments" title={`${prompt.attachments.length} 张图片`}>
              <ImageIcon size={13} />
              {prompt.attachments.length}
            </span>
          ) : null}
          <div className="queued-prompt-actions" ref={openMenuId === prompt.id ? menuRootRef : undefined}>
            <button
              type="button"
              className="queued-prompt-steer"
              onClick={() => onSteer(prompt)}
              disabled={prompt.status === 'steering'}
              title="在当前任务的下一个安全步骤引导 AI"
            >
              <CornerDownRight size={14} />
              <span>{prompt.status === 'steering' ? '引导中' : '引导'}</span>
            </button>
            <button
              type="button"
              className="queued-prompt-icon-btn"
              onClick={() => onDelete(prompt)}
              title="删除消息"
              aria-label="删除待处理消息"
            >
              <Trash2 size={15} />
            </button>
            <button
              type="button"
              className="queued-prompt-icon-btn queued-prompt-more"
              onClick={() => setOpenMenuId((current) => current === prompt.id ? null : prompt.id)}
              title="更多操作"
              aria-label="待处理消息更多操作"
              aria-expanded={openMenuId === prompt.id}
            >
              <Ellipsis size={16} />
            </button>
            {openMenuId === prompt.id ? (
              <div className="queued-prompt-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenuId(null)
                    onEdit(prompt)
                  }}
                >
                  <Pencil size={15} />
                  <span>编辑消息</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenuId(null)
                    onClear()
                  }}
                >
                  <ListX size={15} />
                  <span>关闭排队</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}
