import React, { useEffect, useState } from 'react'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import IconClose from '../icons/IconClose'
import IconTrash from '../icons/IconTrash'
import { desktopApi, type TaskHistoryRecord } from '../../shared/desktop/api'
import './TaskHistoryModal.css'

interface TaskHistoryModalProps {
  workspaceId: string
  onClose: () => void
}

export default function TaskHistoryModal({ workspaceId, onClose }: TaskHistoryModalProps) {
  const [tasks, setTasks] = useState<TaskHistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void desktopApi.task.getByProject(workspaceId).then((data) => {
      if (active) setTasks(data)
    }).catch((error) => {
      console.error(error)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [workspaceId])

  const handleDelete = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('确定要删除此任务记录吗？')) {
      await desktopApi.task.delete(taskId)
      setTasks((current) => current.filter((task) => task.id !== taskId))
    }
  }

  return (
    <Flex className="task-history-modal-overlay">
      <Card variant="default" className="task-history-modal-card">
        <Stack className="h-full">
          <Flex align="center" justify="between" className="task-history-modal-header">
            <h2 className="task-history-modal-title">任务历史</h2>
            <Button variant="ghost" size="none" onClick={onClose} className="task-history-close-btn">
              <IconClose />
            </Button>
          </Flex>
          
          <Stack className="task-history-modal-content">
            {loading ? (
              <div className="task-history-empty">加载中...</div>
            ) : tasks.length === 0 ? (
              <div className="task-history-empty">暂无任务记录</div>
            ) : (
              <Stack gap={3}>
                {tasks.map((task) => {
                  const isExpanded = expandedTaskId === task.id
                  return (
                    <Card key={task.id} variant="default" className="task-card-item">
                      <Flex 
                        align="center"
                        justify="between"
                        className="task-item-header"
                        onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                      >
                        <Stack className="min-w-0">
                          <span className="task-title">{task.title || '未命名任务'}</span>
                          <span className="task-time">{new Date(task.timestamp ?? 0).toLocaleString()}</span>
                        </Stack>
                        <Flex align="center" gap={3}>
                          <span className={`task-badge ${
                            task.status === 'completed' ? 'task-badge-completed' : 
                            task.status === 'failed' ? 'task-badge-failed' : 'task-badge-running'
                          }`}>
                            {task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '进行中'}
                          </span>
                          <Button 
                            variant="ghost"
                            size="none"
                            className="task-delete-btn"
                            onClick={(e) => handleDelete(task.id, e)}
                            title="删除任务"
                          >
                            <IconTrash width="14" height="14" />
                          </Button>
                        </Flex>
                      </Flex>
                      
                      {isExpanded && (
                        <div className="task-details-box">
                          {task.description && (
                            <div className="mb-4">
                              <h4 className="task-detail-section-title">描述</h4>
                              <p className="whitespace-pre-wrap">{task.description}</p>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-4">
                            {task.filesModified && task.filesModified.length > 0 && (
                              <div>
                                <h4 className="task-detail-section-title">修改的文件</h4>
                                <ul className="task-file-list">
                                  {task.filesModified.map((f: string, i: number) => (
                                    <li key={i} className="truncate" title={f}>{f}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {task.commandsRun && task.commandsRun.length > 0 && (
                              <div>
                                <h4 className="task-detail-section-title">执行的命令</h4>
                                <ul className="task-cmd-list">
                                  {task.commandsRun.map((cmd: string, i: number) => (
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
