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
  onFileClick?: (filePath: string) => void
}

export default function EditApprovalWidget({ msgId, txId, edits, editStatuses = {}, onDiffClick, onFileClick }: EditApprovalWidgetProps) {
  const setEditStatus = useChatStore((s) => s.setEditStatus)
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

  const handleAccept = async (filePath: string) => {
    if (editStatuses[filePath]) return
    setLoadingFile(filePath)
    try {
      await window.api.chat.acceptFile(txId, filePath)
      setEditStatus(msgId, filePath, 'accepted')
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
      await window.api.chat.rejectFile(txId, filePath)
      setEditStatus(msgId, filePath, 'rejected')
    } catch (err) {
      console.error('Reject error:', err)
      setEditStatus(msgId, filePath, 'rejected')
    } finally {
      setLoadingFile(null)
    }
  }

  const handleAcceptAll = async (e: React.MouseEvent) => {
    e.stopPropagation()
    for (const edit of uniqueEdits) {
      if (!editStatuses[edit.filePath]) {
        await handleAccept(edit.filePath)
      }
    }
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
                    <FileIcon />
                    <span className="edit-approval-file-name">{fileName}</span>
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
                        <button className="edit-approval-btn-reject" onClick={(e) => { e.stopPropagation(); handleReject(edit.filePath); }} title="Reject">
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
