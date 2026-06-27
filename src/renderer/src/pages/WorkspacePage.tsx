import React from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { FileTreePanel } from '../components/FileTreePanel'
import FilePreviewPanel from '../components/FilePreviewPanel'
import Button from '../components/ui/Button'
import Flex from '../components/ui/Flex'

export default function WorkspacePage(): React.ReactElement {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const projectInfo = useWorkspaceStore((s) => s.projectInfo)
  const setView = useWorkspaceStore((s) => s.setView)

  function handleBack(): void {
    setView('home')
  }

  if (!workspace) {
    return <div className="workspace-empty">未打开项目</div>
  }

  return (
    <Flex className="workspace-layout">
      <header className="workspace-header">
        <Button variant="ghost" size="none" className="btn-back" onClick={handleBack}>
          ← 返回
        </Button>
        <span className="workspace-name">{workspace.name}</span>
        {projectInfo && projectInfo.type !== 'unknown' && (
          <span className="project-type-badge">{projectInfo.type}</span>
        )}
        {projectInfo?.framework && (
          <span className="project-type-badge">{projectInfo.framework}</span>
        )}
      </header>
      <Flex className="workspace-body">
        <FileTreePanel />
        <FilePreviewPanel />
      </Flex>
    </Flex>
  )
}
