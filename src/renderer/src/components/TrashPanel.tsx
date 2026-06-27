import React from 'react'
import { useChatStore } from '../stores/chatStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { IconTrash, IconFolder } from './Icons'
import TrashItem from './TrashItem'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import './TrashPanel.css'

export default function TrashPanel(): React.ReactElement {
  const sessions = useChatStore((s) => s.sessions)
  const deletedSessions = sessions.filter(sess => sess.isDeleted)
  const restoreSession = useChatStore((s) => s.restoreSession)
  const forceDeleteSession = useChatStore((s) => s.deleteSession)
  const recentProjects = useWorkspaceStore((s) => s.recentProjects)

  const now = Date.now()
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000
  
  const getRemainTimeStr = (deletedAt?: number) => {
    if (!deletedAt) return '未知'
    const diff = THREE_DAYS - (now - deletedAt)
    if (diff <= 0) return '即将清除'
    const totalHours = Math.floor(diff / (60 * 60 * 1000))
    const days = Math.floor(totalHours / 24)
    const hours = totalHours % 24
    
    if (days > 0 && hours > 0) return `剩余 ${days} 天 ${hours} 小时`
    if (days > 0) return `剩余 ${days} 天`
    return `剩余 ${Math.max(1, totalHours)} 小时`
  }

  const groupedSessions = deletedSessions.reduce((acc, session) => {
    const pid = session.projectId || 'unknown'
    if (!acc[pid]) acc[pid] = []
    acc[pid].push(session)
    return acc
  }, {} as Record<string, typeof deletedSessions>)

  const projectGroups = Object.keys(groupedSessions).map(pid => {
    const proj = recentProjects.find(p => p.id === pid)
    return {
      projectId: pid,
      projectName: proj ? proj.name : (pid === 'unknown' ? '未知项目' : '已移除项目'),
      sessions: groupedSessions[pid].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    }
  })

  return (
    <Stack className="trash-panel-container">
      <div className="trash-panel-header">
        <h1 className="text-xl font-bold text-text-main mb-2">最近删除</h1>
        <p className="trash-panel-desc">
          最近删除的会话将在这里保留 3 天。过期后将被彻底清除。您可以选择手动恢复或彻底删除。
        </p>
      </div>
      
      <Stack className="trash-panel-list-area">
        {deletedSessions.length === 0 ? (
          <Stack align="center" justify="center" className="trash-panel-empty-state">
            <IconTrash className="trash-panel-empty-icon" />
            <p>回收站是空的</p>
          </Stack>
        ) : (
          <Stack gap={6}>
            {projectGroups.map(group => (
              <Stack key={group.projectId} gap={3}>
                <Flex align="center" gap={2} className="trash-panel-project-header">
                  <IconFolder className="trash-panel-folder-icon" />
                  {group.projectName}
                  <span className="trash-panel-count-badge">({group.sessions.length})</span>
                </Flex>
                <Stack gap={2}>
                  {group.sessions.map(session => (
                    <TrashItem
                      key={session.id}
                      id={session.id}
                      summary={session.summary}
                      deletedAt={session.deletedAt}
                      remainTimeStr={getRemainTimeStr(session.deletedAt)}
                      onRestore={restoreSession}
                      onForceDelete={forceDeleteSession}
                    />
                  ))}
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  )
}
