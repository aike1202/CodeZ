import React from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { IconFolder } from '../components/Icons'
import Flex from '../components/ui/Flex'
import Stack from '../components/ui/Stack'
import Card from '../components/ui/Card'
import './HomePage.css'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了，还在构建未来？'
  if (hour < 12) return '早上好，今天从哪个项目开始？'
  if (hour < 14) return '午安，继续推进你的代码宇宙。'
  if (hour < 18) return '下午好，代码正在等你。'
  return '晚间愉快，给今天的收尾加个速。'
}

export default function HomePage({
  onOpenRecentProject
}: {
  onOpenRecentProject?: (project: { id: string; name: string; sessions: any[] }) => void
}): React.ReactElement {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const recentProjects = useWorkspaceStore((s) => s.recentProjects)
  
  if (workspace) {
    return (
      <Flex className="homepage-container">
        <Stack className="homepage-center-wrapper">
          <h1 className="homepage-title">
            我们应该在 <span className="font-semibold">{workspace.name}</span> 中构建什么？
          </h1>
          <p className="homepage-subtitle">{getGreeting()}</p>
        </Stack>
      </Flex>
    )
  }

  return (
    <Flex className="homepage-container">
      <div className="homepage-center-wrapper">
        <h1 className="homepage-welcome-title">
          欢迎使用 Codez
        </h1>
        
        {recentProjects.length > 0 ? (
          <div className="homepage-recent-header">
            <h2 className="homepage-recent-title">最近打开的项目</h2>
            <Card variant="default" className="homepage-recent-card">
              {recentProjects.map((proj, idx) => (
                <Flex 
                  key={proj.id}
                  align="center"
                  gap={3}
                  className={`homepage-project-item ${idx !== recentProjects.length - 1 ? 'homepage-project-item-border' : ''}`}
                  onClick={() => onOpenRecentProject?.({ id: proj.id, name: proj.name, sessions: [] })}
                >
                  <span className="homepage-project-icon"><IconFolder /></span>
                  <Stack className="min-w-0">
                    <span className="homepage-project-name">{proj.name}</span>
                    <span className="homepage-project-path">{proj.rootPath}</span>
                  </Stack>
                </Flex>
              ))}
            </Card>
          </div>
        ) : (
          <p className="homepage-subtitle">{getGreeting()}</p>
        )}
      </div>
    </Flex>
  )
}
