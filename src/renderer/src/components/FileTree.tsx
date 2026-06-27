import React, { useState } from 'react'
import type { FileTreeNode } from '@shared/types/workspace'
import { useWorkspaceStore } from '../stores/workspaceStore'

interface FileTreeProps {
  nodes: FileTreeNode[]
  depth: number
}

export function FileTree({ nodes, depth }: FileTreeProps): React.ReactElement {
  return (
    <ul className="file-tree" style={{ paddingLeft: depth === 0 ? 0 : undefined }}>
      {nodes.map((node) => (
        <FileTreeNodeItem key={node.path} node={node} depth={depth} />
      ))}
    </ul>
  )
}

function FileTreeNodeItem({
  node,
  depth
}: {
  node: FileTreeNode
  depth: number
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const selectedFilePath = useWorkspaceStore((s) => s.selectedFilePath)
  const setSelectedFile = useWorkspaceStore((s) => s.setSelectedFile)
  const workspace = useWorkspaceStore((s) => s.workspace)

  const isSelected = selectedFilePath === node.path

  if (node.type === 'directory') {
    const hasChildren = node.children && node.children.length > 0
    return (
      <li>
        <div
          className={`file-tree-row directory ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 16 }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="file-tree-icon">{expanded ? '▾' : '▸'}</span>
          <span className="file-tree-name">{node.name}</span>
        </div>
        {expanded && hasChildren && <FileTree nodes={node.children!} depth={depth + 1} />}
      </li>
    )
  }

  async function handleClick(): Promise<void> {
    setSelectedFile(node.path)
    if (!workspace) return
    try {
      const content = await window.api.workspace.readFile(node.path, workspace.rootPath)
      useWorkspaceStore.getState().setFileContent(content)
    } catch {
      // ignore
    }
  }

  return (
    <li>
      <div
        className={`file-tree-row file ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 16 }}
        onClick={handleClick}
      >
        <span className="file-tree-icon">─</span>
        <span className="file-tree-name">{node.name}</span>
      </div>
    </li>
  )
}
