import React from 'react'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import IconClose from '../icons/IconClose'
import './TaskHistoryModal.css' // Reusing the modal overlay and card styles

interface RevertPreviewModalProps {
  toDelete: string[]
  toRestore: string[]
  unknownStatus?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function RevertPreviewModal({
  toDelete,
  toRestore,
  unknownStatus,
  onConfirm,
  onCancel
}: RevertPreviewModalProps) {
  return (
    <Flex className="task-history-modal-overlay">
      <Card variant="default" className="task-history-modal-card" style={{ maxWidth: '500px', height: 'auto', maxHeight: '80vh' }}>
        <Stack className="h-full">
          <Flex align="center" justify="between" className="task-history-modal-header">
            <h2 className="task-history-modal-title">回退预览</h2>
            <Button variant="ghost" size="none" onClick={onCancel} className="task-history-close-btn">
              <IconClose />
            </Button>
          </Flex>
          
          <Stack className="task-history-modal-content" gap={4} style={{ padding: '16px' }}>
            <p style={{ fontSize: '13px', color: 'var(--text-normal)' }}>
              确定要回退到此消息吗？这将删除在此之后的所有对话，并强行撤销在此之后 AI 对工作区所做的所有文件修改。
            </p>
            
            {!unknownStatus && (toDelete.length > 0 || toRestore.length > 0) && (
              <div style={{ background: 'var(--bg-subtle)', padding: '12px', borderRadius: '6px' }}>
                {toDelete.length > 0 && (
                  <div className="mb-3">
                    <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--error-color, #ef4444)', marginBottom: '4px' }}>将删除以下新建的文件：</h4>
                    <ul style={{ listStyleType: 'disc', paddingLeft: '20px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {toDelete.map((f, i) => (
                        <li key={i} className="truncate" title={f}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {toRestore.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--warning-color, #f59e0b)', marginBottom: '4px' }}>将还原以下文件至修改前状态：</h4>
                    <ul style={{ listStyleType: 'disc', paddingLeft: '20px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {toRestore.map((f, i) => (
                        <li key={i} className="truncate" title={f}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {!unknownStatus && toDelete.length === 0 && toRestore.length === 0 && (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                (没有检测到受影响的文件修改，仅截断对话历史)
              </p>
            )}

            <Flex justify="end" gap={2} style={{ marginTop: '16px' }}>
              <Button variant="ghost" onClick={onCancel}>取消</Button>
              <Button variant="primary" onClick={onConfirm}>确认回退</Button>
            </Flex>
          </Stack>
        </Stack>
      </Card>
    </Flex>
  )
}
