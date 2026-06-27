import React from 'react'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { FileTree } from './FileTree'

export function FileTreePanel(): React.ReactElement {
  const fileTree = useWorkspaceStore((s) => s.fileTree)

  return (
    <aside className="file-tree-panel">
      <div className="file-tree-header">文件</div>
      <div className="file-tree-body">
        <FileTree nodes={fileTree} depth={0} />
      </div>
    </aside>
  )
}
