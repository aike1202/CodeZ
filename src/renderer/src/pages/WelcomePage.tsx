import React, { useEffect } from 'react'
import { APP_NAME, APP_SUBTITLE } from '@shared/constants/app'
import { useWorkspaceStore } from '../stores/workspaceStore'
import Button from '../components/ui/Button'
import Flex from '../components/ui/Flex'
import Stack from '../components/ui/Stack'
import Card from '../components/ui/Card'
import './WelcomePage.css'
import { desktopApi } from '../shared/desktop'

export default function WelcomePage(): React.ReactElement {
  const recentProjects = useWorkspaceStore((s) => s.recentProjects)
  const setRecentProjects = useWorkspaceStore((s) => s.setRecentProjects)
  const setView = useWorkspaceStore((s) => s.setView)
  const setWorkspace = useWorkspaceStore((s) => s.setWorkspace)
  const setFileTree = useWorkspaceStore((s) => s.setFileTree)
  const setProjectInfo = useWorkspaceStore((s) => s.setProjectInfo)
  const setLoading = useWorkspaceStore((s) => s.setLoading)

  useEffect(() => {
    loadRecentProjects()
  }, [])

  async function loadRecentProjects(): Promise<void> {
    try {
      const projects = await desktopApi.workspace.getRecentProjects()
      setRecentProjects(projects)
    } catch {
      setRecentProjects([])
    }
  }

  async function handleOpenProject(): Promise<void> {
    const dirPath = await desktopApi.workspace.openDirectory()
    if (!dirPath) return
    await openWorkspace(dirPath)
  }

  async function handleOpenRecent(rootPath: string): Promise<void> {
    await openWorkspace(rootPath)
  }

  async function openWorkspace(rootPath: string): Promise<void> {
    setLoading(true)
    try {
      const [fileTree, projectInfo] = await Promise.all([
        desktopApi.workspace.scanFileTree(rootPath),
        desktopApi.workspace.detectProject(rootPath)
      ])

      const name = rootPath.split(/[/\\]/).pop() || rootPath
      const ws = {
        id: Date.now().toString(),
        rootPath,
        name,
        projectType: projectInfo.type,
        openedAt: new Date().toISOString()
      }

      setWorkspace(ws)
      setFileTree(fileTree)
      setProjectInfo(projectInfo)
      setView('workspace')

      await desktopApi.workspace.addRecentProject(ws)
    } catch (error) {
      console.error('Failed to open workspace:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Flex className="welcome-container">
      <Card variant="default" className="welcome-card">
        <Stack gap={3}>
          <h1 className="welcome-title">{APP_NAME}</h1>
          <p className="welcome-subtitle">{APP_SUBTITLE}</p>

          <Button variant="primary" size="none" className="welcome-open-btn" onClick={handleOpenProject}>
            打开项目
          </Button>

          {recentProjects.length > 0 && (
            <Stack className="welcome-recent-section">
              <h2 className="welcome-recent-title">最近打开</h2>
              <ul className="welcome-recent-list">
                {recentProjects.map((p) => (
                  <li key={p.id} className="welcome-recent-item">
                    <Button 
                      variant="ghost" 
                      size="none" 
                      className="welcome-recent-btn" 
                      onClick={() => handleOpenRecent(p.rootPath)}
                    >
                      <span className="welcome-recent-name">{p.name}</span>
                      <span className="welcome-recent-path">{p.rootPath}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </Stack>
          )}

          <p className="welcome-footer-text">Tauri + Rust + React</p>
        </Stack>
      </Card>
    </Flex>
  )
}
