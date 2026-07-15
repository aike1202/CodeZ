import React, { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { FileIcon } from '@react-symbols/icons/utils'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import Button from '../ui/Button'
import IconClose from '../icons/IconClose'
import IconCheck from '../icons/IconCheck'
import './EditApprovalWidget.css'

interface EditItem {
  filePath: string
  transactionPath?: string
  additions: string
  deletions: string
}

interface EditApprovalWidgetProps {
  msgId: string
  txId: string
  edits: EditItem[]
  editStatuses?: Record<string, 'accepted' | 'rejected'>
  onDiffClick?: (filePath: string) => void
  onFileClick?: (filePath: string) => void
}

export function acceptPendingEdits(
  edits: Array<{ filePath: string }>,
  editStatuses: Record<string, 'accepted' | 'rejected'>,
  accept: (filePath: string) => void
): void {
  const acceptedPaths = new Set<string>()
  edits.forEach((edit) => {
    if (!acceptedPaths.has(edit.filePath) && !editStatuses[edit.filePath]) {
      acceptedPaths.add(edit.filePath)
      accept(edit.filePath)
    }
  })
}

export default function EditApprovalWidget({ msgId, txId, edits, editStatuses = {}, onDiffClick, onFileClick }: EditApprovalWidgetProps) {
  const setEditStatus = useChatStore((s) => s.setEditStatus)
  const setEditStatuses = useChatStore((s) => s.setEditStatuses)
  const [loadingFile, setLoadingFile] = useState<string | null>(null)
  const [isExpanded, setIsExpanded] = useState(false)

  // 去重，因为同一个文件可能被编辑多次
  const uniqueEdits = edits.reduce((acc, edit) => {
    if (!acc.find(e => e.filePath === edit.filePath)) {
      acc.push(edit)
    }
    return acc
  }, [] as EditItem[])

  if (uniqueEdits.length === 0) return null

  // calculate total additions and deletions
  let totalAdd = 0;
  let totalDel = 0;
  uniqueEdits.forEach(edit => {
    totalAdd += parseInt(edit.additions.replace('+', '')) || 0;
    totalDel += parseInt(edit.deletions.replace('-', '')) || 0;
  });

  const handleAccept = (filePath: string) => {
    if (editStatuses[filePath]) return
    setEditStatus(msgId, filePath, 'accepted')
  }

  const handleReject = async (filePath: string) => {
    if (editStatuses[filePath]) return
    const edit = uniqueEdits.find((item) => item.filePath === filePath)
    if (!edit?.transactionPath) return
    setLoadingFile(filePath)
    try {
      const rejected = await window.api.chat.rejectFile(txId, edit.transactionPath)
      if (!rejected) {
        console.error('Reject refused because the file no longer matches the CodeZ mutation.')
        return
      }
      setEditStatus(msgId, filePath, 'rejected')
    } catch (err) {
      console.error('Reject error:', err)
    } finally {
      setLoadingFile(null)
    }
  }

  const handleAcceptAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    const accepted = Object.fromEntries(
      uniqueEdits
        .filter((edit) => !editStatuses[edit.filePath])
        .map((edit) => [edit.filePath, 'accepted' as const])
    )
    setEditStatuses(msgId, accepted)
  }

  const handleRejectAll = async (e: React.MouseEvent) => {
    e.stopPropagation()
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
        <Flex 
          align="center" 
          justify="between" 
          className="edit-approval-header"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <Flex align="center" gap={2}>
            <span className={`edit-approval-toggle-icon ${isExpanded ? 'expanded' : ''}`}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.5 3L10.5 8L5.5 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </span>
            <span className="edit-approval-title">
              {uniqueEdits.length} 个文件已更改
            </span>
            <Flex align="center" gap={1.5} className="edit-approval-total-diff">
              <span className="edit-approval-diff-add">+{totalAdd}</span>
              <span className="edit-approval-diff-del">-{totalDel}</span>
            </Flex>
          </Flex>

          {!allProcessed && (
            <Flex align="center" gap={2} onClick={e => e.stopPropagation()}>
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

        {isExpanded && (
          <Stack className="edit-approval-list-container">
            {uniqueEdits.map((edit, idx) => {
              const status = editStatuses[edit.filePath]
              const isAccepted = status === 'accepted'
              const isRejected = status === 'rejected'
              const isLoading = loadingFile === edit.filePath
              const hasTransactionPath = Boolean(edit.transactionPath)
              const fileName = edit.filePath.split(/[/\\]/).pop()

              return (
                <Flex 
                  key={idx} 
                  align="center"
                  justify="between"
                  className={`edit-approval-item ${
                    idx !== uniqueEdits.length - 1 ? 'edit-approval-item-border' : ''
                  } ${isRejected ? 'edit-approval-item-rejected' : ''}`}
                >
                  <Flex 
                    className="edit-approval-item-left" 
                    align="center" 
                    gap={2}
                    onClick={() => onFileClick?.(edit.filePath)}
                    title="点击预览整个文件"
                  >
                    <div className="flex items-center gap-1.5 min-w-0" style={{ color: 'var(--text-main)' }}>
                      <FileIcon fileName={edit.filePath} width={14} height={14} className="shrink-0" />
                      <span className="truncate text-xs font-medium" title={edit.filePath}>
                        {edit.filePath}
                      </span>
                    </div>
                    <Flex 
                      align="center" 
                      gap={1.5} 
                      className="edit-approval-item-diffs edit-approval-clickable-diff"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiffClick?.(edit.filePath);
                      }}
                      title="点击查看修改 Diff"
                    >
                      <span className="edit-approval-diff-add">{edit.additions}</span>
                      <span className="edit-approval-diff-del">{edit.deletions}</span>
                    </Flex>
                  </Flex>

                  <Flex align="center" gap={2} className="shrink-0 ml-3">
                    {isLoading && <span className="edit-approval-loading-dots">...</span>}
                    
                    {!allProcessed && !status && !isLoading && (
                      <Flex align="center" gap={1} className="edit-approval-item-actions">
                        <button className="edit-approval-btn-reject" disabled={!hasTransactionPath} onClick={(e) => { e.stopPropagation(); handleReject(edit.filePath); }} title={hasTransactionPath ? 'Reject' : '无法唯一定位事务文件'}>
                          <IconClose width={14} height={14} />
                        </button>
                        <button className="edit-approval-btn-accept" onClick={(e) => { e.stopPropagation(); handleAccept(edit.filePath); }} title="Accept">
                          <IconCheck width={14} height={14} />
                        </button>
                      </Flex>
                    )}

                    {isAccepted && <span className="edit-approval-status-text edit-approval-status-accepted">Accepted</span>}
                    {isRejected && <span className="edit-approval-status-text edit-approval-status-rejected">Rejected</span>}

                    <button 
                      className="edit-approval-btn-diff"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDiffClick?.(edit.filePath);
                      }}
                      title="点击查看修改 Diff"
                    >
                      打开 
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ marginLeft: 4 }}>
                        <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                      </svg>
                    </button>
                  </Flex>
                </Flex>
              )
            })}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}
