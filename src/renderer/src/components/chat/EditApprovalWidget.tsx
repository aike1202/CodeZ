import React, { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { FileIcon } from '../svg-icons'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import Button from '../ui/Button'
import IconClose from '../icons/IconClose'
import IconCheck from '../icons/IconCheck'
import './EditApprovalWidget.css'

interface EditItem {
  filePath: string
  additions: string
  deletions: string
}

interface EditApprovalWidgetProps {
  msgId: string
  txId: string
  edits: EditItem[]
  editStatuses?: Record<string, 'accepted' | 'rejected'>
  onDiffClick?: (filePath: string) => void
}

export default function EditApprovalWidget({ msgId, txId, edits, editStatuses = {}, onDiffClick }: EditApprovalWidgetProps) {
  const setEditStatus = useChatStore((s) => s.setEditStatus)
  const [loadingFile, setLoadingFile] = useState<string | null>(null)

  // 去重，因为同一个文件可能被编辑多次
  const uniqueEdits = edits.reduce((acc, edit) => {
    if (!acc.find(e => e.filePath === edit.filePath)) {
      acc.push(edit)
    }
    return acc
  }, [] as EditItem[])

  if (uniqueEdits.length === 0) return null

  const handleAccept = async (filePath: string) => {
    if (editStatuses[filePath]) return
    setLoadingFile(filePath)
    try {
      const success = await window.api.chat.acceptFile(txId, filePath)
      if (success !== false) { // even if false, we might just mark it accepted
        setEditStatus(msgId, filePath, 'accepted')
      }
    } catch (err) {
      console.error('Accept error:', err)
      setEditStatus(msgId, filePath, 'accepted') // fallback to local update
    } finally {
      setLoadingFile(null)
    }
  }

  const handleReject = async (filePath: string) => {
    if (editStatuses[filePath]) return
    setLoadingFile(filePath)
    try {
      const success = await window.api.chat.rejectFile(txId, filePath)
      if (success !== false) {
        setEditStatus(msgId, filePath, 'rejected')
      }
    } catch (err) {
      console.error('Reject error:', err)
    } finally {
      setLoadingFile(null)
    }
  }

  const handleAcceptAll = async () => {
    for (const edit of uniqueEdits) {
      if (!editStatuses[edit.filePath]) {
        await handleAccept(edit.filePath)
      }
    }
  }

  const handleRejectAll = async () => {
    for (const edit of uniqueEdits) {
      if (!editStatuses[edit.filePath]) {
        await handleReject(edit.filePath)
      }
    }
  }

  const allProcessed = uniqueEdits.every(e => editStatuses[e.filePath])

  return (
    <Card variant="default" className="edit-approval-card">
      <Stack>
        <Flex align="center" justify="between" className="edit-approval-header">
          <span className="edit-approval-title">
            {uniqueEdits.length} File{uniqueEdits.length > 1 ? 's' : ''} With Changes
          </span>
          {!allProcessed && (
            <Flex align="center" gap={2}>
              <Button 
                variant="ghost"
                size="none"
                onClick={handleRejectAll}
                className="edit-approval-header-btn-reject"
              >
                Reject all
              </Button>
              <Button 
                variant="primary"
                size="none"
                onClick={handleAcceptAll}
                className="edit-approval-header-btn-accept"
              >
                Accept all
              </Button>
            </Flex>
          )}
        </Flex>

        <Stack className="edit-approval-list-container">
          {uniqueEdits.map((edit, idx) => {
            const status = editStatuses[edit.filePath]
            const isAccepted = status === 'accepted'
            const isRejected = status === 'rejected'
            const isLoading = loadingFile === edit.filePath

            return (
              <Flex 
                key={idx} 
                align="center"
                justify="between"
                className={`edit-approval-item ${
                  idx !== uniqueEdits.length - 1 ? 'edit-approval-item-border' : ''
                } ${isRejected ? 'edit-approval-item-rejected' : ''}`}
              >
                <Flex className="edit-approval-item-left">
                  <Flex align="center" gap={1.5} className="edit-approval-diff-nums">
                    <span className="edit-approval-diff-add">+{edit.additions}</span>
                    <span className="edit-approval-diff-del">-{edit.deletions}</span>
                  </Flex>
                  <Flex 
                    align="center"
                    gap={1.5}
                    className="edit-approval-file-link"
                    onClick={() => onDiffClick?.(edit.filePath)}
                    title="点击查看修改 Diff"
                  >
                    <FileIcon />
                    <span className="edit-approval-file-name">{edit.filePath.split(/[/\\]/).pop()}</span>
                    <span className="edit-approval-file-path">{edit.filePath}</span>
                  </Flex>
                </Flex>

                <Flex align="center" gap={1} className="shrink-0 ml-3">
                  {isLoading && <span className="edit-approval-loading-dots">...</span>}
                  {isAccepted && <span className="edit-approval-status-text edit-approval-status-accepted">Accepted</span>}
                  {isRejected && <span className="edit-approval-status-text edit-approval-status-rejected">Rejected</span>}
                  
                  {!status && !isLoading && (
                    <>
                      <Button 
                        variant="ghost"
                        size="none"
                        onClick={() => handleReject(edit.filePath)}
                        className="edit-approval-btn-reject"
                        title="Reject changes"
                      >
                        <IconClose width="14" height="14" />
                      </Button>
                      <Button 
                        variant="ghost"
                        size="none"
                        onClick={() => handleAccept(edit.filePath)}
                        className="edit-approval-btn-accept"
                        title="Accept changes"
                      >
                        <IconCheck width="14" height="14" />
                      </Button>
                    </>
                  )}
                </Flex>
              </Flex>
            )
          })}
        </Stack>
      </Stack>
    </Card>
  )
}
