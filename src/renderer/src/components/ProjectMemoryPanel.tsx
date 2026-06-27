import React, { useState, useEffect } from 'react'
import Button from './ui/Button'
import Flex from './ui/Flex'
import IconClose from './icons/IconClose'
import IconPlus from './icons/IconPlus'
import IconCheck from './icons/IconCheck'
import IconTrash from './icons/IconTrash'

export interface ProjectMemoryPanelProps {
  workspace: any
  initialPath?: string
  panelWidth?: number
  onMouseDownResize?: (e: React.MouseEvent) => void
  onClose?: () => void
}

export default function ProjectMemoryPanel({
  workspace,
  initialPath,
  panelWidth = 480,
  onMouseDownResize = () => {},
  onClose = () => {}
}: ProjectMemoryPanelProps): React.ReactElement | null {
  const [files, setFiles] = useState<Array<{ name: string; path: string }>>([])
  const [activePath, setActivePath] = useState<string | null>(initialPath || null)
  const [content, setContent] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  // Fetch list of memory files
  const fetchFiles = async (newActivePath?: string) => {
    if (!workspace) return
    try {
      const list = await window.api.projectMemory.list(workspace.rootPath)
      setFiles(list || [])
      
      if (newActivePath) {
        setActivePath(newActivePath)
      } else if (!activePath && list && list.length > 0) {
        setActivePath(list[0].path)
      }
    } catch (e) {
      console.error(e)
    }
  }

  useEffect(() => {
    fetchFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  // Fetch content when activePath changes
  useEffect(() => {
    const loadContent = async () => {
      if (!workspace || !activePath) {
        setContent('')
        return
      }
      setLoading(true)
      try {
        const res = await window.api.workspace.readFile(activePath, workspace.rootPath)
        if (res && res.content !== undefined) {
          setContent(res.content)
          setIsDirty(false)
        }
      } catch (e) {
        console.error('Failed to read memory file:', e)
      } finally {
        setLoading(false)
      }
    }
    loadContent()
  }, [activePath, workspace])

  const handleSave = async () => {
    if (!workspace || !activePath) return
    setSaving(true)
    try {
      await window.api.projectMemory.save(workspace.rootPath, activePath, content)
      setIsDirty(false)
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async () => {
    if (!workspace) return
    const filename = prompt('请输入新规则文件的名称（无需带.md）：')
    if (filename && filename.trim()) {
      try {
        const path = await window.api.projectMemory.create(workspace.rootPath, filename.trim())
        if (path) {
          await fetchFiles(path)
        }
      } catch(e) {
        console.error(e)
      }
    }
  }

  const handleDelete = async (filePath: string) => {
    if (!workspace) return
    if (!confirm('确定要删除这个规则文件吗？')) return
    try {
      await window.api.projectMemory.delete(workspace.rootPath, filePath)
      const nextPath = activePath === filePath ? null : activePath
      setActivePath(nextPath)
      await fetchFiles()
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="h-full bg-white dark:bg-[#1e1e1e] border-l border-gray-200 dark:border-zinc-800 flex flex-col relative" style={{ width: panelWidth }}>
      <div 
        className="absolute top-0 bottom-0 left-0 w-1 cursor-col-resize hover:bg-blue-500/50 z-10" 
        onMouseDown={onMouseDownResize} 
      />
      
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-gray-200 dark:border-zinc-800 shrink-0">
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">项目记忆管理器</span>
        <Button variant="ghost" size="none" onClick={onClose} className="p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded">
          <IconClose />
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - File List */}
        <div className="w-40 border-r border-gray-200 dark:border-zinc-800 flex flex-col bg-gray-50/50 dark:bg-[#252526]/50">
          <div className="p-2 shrink-0 border-b border-gray-200 dark:border-zinc-800">
            <Button variant="ghost" size="sm" onClick={handleCreate} className="w-full flex items-center justify-center gap-1 text-xs text-blue-600 border border-blue-200 dark:border-blue-900">
              <IconPlus /> 新建规则
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {files.map(f => {
              const isActive = f.path === activePath
              return (
                <div 
                  key={f.path}
                  className={`group flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer mb-0.5 ${isActive ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200/50 dark:hover:bg-zinc-800'}`}
                  onClick={() => setActivePath(f.path)}
                >
                  <span className="truncate">{f.name}</span>
                  <div 
                    className={`p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-500`}
                    onClick={(e) => { e.stopPropagation(); handleDelete(f.path); }}
                    title="删除"
                  >
                    <IconTrash />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Right Area - Editor */}
        <div className="flex-1 flex flex-col min-w-0">
          {activePath ? (
            <>
              <div className="h-8 flex items-center justify-between px-3 border-b border-gray-100 dark:border-zinc-800 shrink-0 bg-gray-50/30 dark:bg-zinc-900/30">
                <span className="text-xs text-gray-500 truncate" title={activePath}>{activePath.split(/[\\/]/).pop()} {isDirty && '*'}</span>
                <Button 
                  variant="ghost" 
                  size="none" 
                  onClick={handleSave} 
                  disabled={!isDirty || saving}
                  className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${isDirty ? 'bg-blue-500 text-white hover:bg-blue-600' : 'text-gray-400'}`}
                >
                  {saving ? '保存中...' : <><IconCheck className="w-3 h-3" /> 保存</>}
                </Button>
              </div>
              <div className="flex-1 p-2">
                <textarea
                  className="w-full h-full resize-none outline-none bg-transparent text-sm text-gray-800 dark:text-gray-300"
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value)
                    setIsDirty(true)
                  }}
                  disabled={loading}
                  placeholder={loading ? "加载中..." : "在此输入规则内容 (Markdown格式)..."}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
              请在左侧选择或新建规则文件
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
