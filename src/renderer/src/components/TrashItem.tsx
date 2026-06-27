import React from 'react'
import Button from './ui/Button'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import './TrashItem.css'

interface Props {
  id: string
  summary: string
  deletedAt?: number
  remainTimeStr: string
  onRestore: (id: string) => void
  onForceDelete: (id: string) => void
}

export default function TrashItem({ 
  id, 
  summary, 
  deletedAt, 
  remainTimeStr, 
  onRestore, 
  onForceDelete 
}: Props): React.ReactElement {
  return (
    <Flex align="center" justify="between" className="trash-item-row">
      <Stack gap={1}>
        <Flex align="center" gap={2}>
          <span className="trash-item-summary">{summary}</span>
          <span className="trash-item-time-badge">
            {remainTimeStr}
          </span>
        </Flex>
        <span className="trash-item-deleted-at">
          删除于 {deletedAt ? new Date(deletedAt).toLocaleString() : '未知时间'}
        </span>
      </Stack>
      <Flex align="center" gap={2}>
        <Button 
          variant="secondary"
          size="none"
          className="trash-item-restore-btn"
          onClick={() => onRestore(id)}
        >
          恢复
        </Button>
        <Button 
          variant="danger"
          size="none"
          className="trash-item-delete-btn"
          onClick={() => onForceDelete(id)}
        >
          彻底删除
        </Button>
      </Flex>
    </Flex>
  )
}
