import React, { useEffect, useState } from 'react'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import IconClose from '../icons/IconClose'
import IconTrash from '../icons/IconTrash'
import { desktopApi, type ExecutionHistoryRecord } from '../../shared/desktop/api'
import './ExecutionHistoryModal.css'

interface ExecutionHistoryModalProps {
  workspaceId: string
  onClose: () => void
}

export default function ExecutionHistoryModal({ workspaceId, onClose }: ExecutionHistoryModalProps) {
  const [executions, setExecutions] = useState<ExecutionHistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void desktopApi.executionHistory.getByProject(workspaceId).then((data) => {
      if (active) setExecutions(data)
    }).catch((error) => {
      console.error(error)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [workspaceId])

  const handleDelete = async (executionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('确定要删除此执行记录吗？')) {
      await desktopApi.executionHistory.delete(executionId)
      setExecutions((current) => current.filter((execution) => execution.id !== executionId))
    }
  }

  return (
    <Flex className="execution-history-modal-overlay">
      <Card variant="default" className="execution-history-modal-card">
        <Stack className="h-full">
          <Flex align="center" justify="between" className="execution-history-modal-header">
            <h2 className="execution-history-modal-title">执行历史</h2>
            <Button variant="ghost" size="none" onClick={onClose} className="execution-history-close-btn">
              <IconClose />
            </Button>
          </Flex>
          
          <Stack className="execution-history-modal-content">
            {loading ? (
              <div className="execution-history-empty">加载中...</div>
            ) : executions.length === 0 ? (
              <div className="execution-history-empty">暂无执行记录</div>
            ) : (
              <Stack gap={3}>
                {executions.map((execution) => {
                  const isExpanded = expandedExecutionId === execution.id
                  return (
                    <Card key={execution.id} variant="default" className="execution-card-item">
                      <Flex 
                        align="center"
                        justify="between"
                        className="execution-item-header"
                        onClick={() => setExpandedExecutionId(isExpanded ? null : execution.id)}
                      >
                        <Stack className="min-w-0">
                          <span className="execution-title">{execution.title || '未命名执行'}</span>
                          <span className="execution-time">{new Date(execution.timestamp ?? 0).toLocaleString()}</span>
                        </Stack>
                        <Flex align="center" gap={3}>
                          <span className={`execution-badge ${
                            execution.status === 'completed' ? 'execution-badge-completed' : 
                            execution.status === 'failed' ? 'execution-badge-failed' : 'execution-badge-running'
                          }`}>
                            {execution.status === 'completed' ? '已完成' : execution.status === 'failed' ? '失败' : '进行中'}
                          </span>
                          <Button 
                            variant="ghost"
                            size="none"
                            className="execution-delete-btn"
                            onClick={(e) => handleDelete(execution.id, e)}
                            title="删除执行"
                          >
                            <IconTrash width="14" height="14" />
                          </Button>
                        </Flex>
                      </Flex>
                      
                      {isExpanded && (
                        <div className="execution-details-box">
                          {execution.description && (
                            <div className="mb-4">
                              <h4 className="execution-detail-section-title">描述</h4>
                              <p className="whitespace-pre-wrap">{execution.description}</p>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-4">
                            {execution.filesModified && execution.filesModified.length > 0 && (
                              <div>
                                <h4 className="execution-detail-section-title">修改的文件</h4>
                                <ul className="execution-file-list">
                                  {execution.filesModified.map((f: string, i: number) => (
                                    <li key={i} className="truncate" title={f}>{f}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {execution.commandsRun && execution.commandsRun.length > 0 && (
                              <div>
                                <h4 className="execution-detail-section-title">执行的命令</h4>
                                <ul className="execution-cmd-list">
                                  {execution.commandsRun.map((cmd: string, i: number) => (
                                    <li key={i} className="truncate" title={cmd}>{cmd}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </Card>
                  )
                })}
              </Stack>
            )}
          </Stack>
        </Stack>
      </Card>
    </Flex>
  )
}
