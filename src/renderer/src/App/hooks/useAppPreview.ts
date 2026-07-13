import { useCallback, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import type { FileContent } from '@shared/types/workspace'

export interface PreviewDiff {
  filePath: string
  type: 'write' | 'replace'
  targetContent?: string
  replacementContent?: string
  codeContent?: string
}

export interface PreviewTab {
  id: string
  kind: 'file' | 'diff'
  title: string
  filePath: string
  previewPath: string | null
  content: FileContent | null
  loading: boolean
  diff: PreviewDiff | null
}

interface PreviewState {
  tabs: PreviewTab[]
  activeTabId: string | null
}

function normalizeFilePath(filePath: string): string {
  return filePath
    .replace(/(:\d+)$/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
}

export function getFilePreviewTabId(filePath: string): string {
  return `file:${normalizeFilePath(filePath)}`
}

export function getDiffPreviewTabId(filePath: string): string {
  return `diff:${normalizeFilePath(filePath)}`
}

function getFileName(filePath: string): string {
  const cleanPath = filePath.replace(/(:\d+)$/, '').replace(/\\/g, '/')
  return cleanPath.split('/').filter(Boolean).pop() || cleanPath
}

export function useAppPreview() {
  const [state, setState] = useState<PreviewState>({ tabs: [], activeTabId: null })
  const pendingReadsRef = useRef(new Map<string, symbol>())

  const handleFileClick = useCallback(async (filePath: string, virtualContent?: string) => {
    const ws = useWorkspaceStore.getState().workspace
    if (!ws) return

    const cleanPath = filePath.replace(/(:\d+)$/, '')
    const tabId = getFilePreviewTabId(filePath)
    const requestToken = Symbol(tabId)
    pendingReadsRef.current.set(tabId, requestToken)

    setState((current) => {
      const existingTab = current.tabs.find((tab) => tab.id === tabId)
      const nextTab: PreviewTab = {
        id: tabId,
        kind: 'file',
        title: getFileName(filePath),
        filePath: cleanPath,
        previewPath: filePath,
        content: existingTab?.content ?? null,
        loading: true,
        diff: null
      }

      return {
        tabs: existingTab
          ? current.tabs.map((tab) => (tab.id === tabId ? nextTab : tab))
          : [...current.tabs, nextTab],
        activeTabId: tabId
      }
    })

    if (virtualContent !== undefined) {
      const content: FileContent = {
        path: filePath,
        content: virtualContent,
        truncated: false,
        totalLines: virtualContent.split('\n').length
      }
      setState((current) => ({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, content, loading: false } : tab
        )
      }))
      pendingReadsRef.current.delete(tabId)
      return
    }

    let content: FileContent
    try {
      content = await window.api.workspace.readFile(cleanPath, ws.rootPath)
    } catch {
      content = {
        path: cleanPath,
        content: `无法读取文件：${cleanPath}`,
        truncated: false,
        totalLines: 0
      }
    }

    if (pendingReadsRef.current.get(tabId) !== requestToken) return
    pendingReadsRef.current.delete(tabId)
    setState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, content, loading: false } : tab
      )
    }))
  }, [])

  const handleDiffClick = useCallback((filePath: string, editInfo: Omit<PreviewDiff, 'filePath'>) => {
    const tabId = getDiffPreviewTabId(filePath)
    const diff: PreviewDiff = { filePath, ...editInfo }
    const nextTab: PreviewTab = {
      id: tabId,
      kind: 'diff',
      title: `Diff · ${getFileName(filePath)}`,
      filePath,
      previewPath: null,
      content: null,
      loading: false,
      diff
    }

    setState((current) => {
      const exists = current.tabs.some((tab) => tab.id === tabId)
      return {
        tabs: exists
          ? current.tabs.map((tab) => (tab.id === tabId ? nextTab : tab))
          : [...current.tabs, nextTab],
        activeTabId: tabId
      }
    })
  }, [])

  const closePreview = useCallback((tabId?: string) => {
    setState((current) => {
      const idToClose = tabId ?? current.activeTabId
      if (!idToClose) return current

      pendingReadsRef.current.delete(idToClose)
      const closedIndex = current.tabs.findIndex((tab) => tab.id === idToClose)
      if (closedIndex < 0) return current

      const tabs = current.tabs.filter((tab) => tab.id !== idToClose)
      if (current.activeTabId !== idToClose) return { ...current, tabs }

      const nextIndex = Math.min(closedIndex, tabs.length - 1)
      return { tabs, activeTabId: tabs[nextIndex]?.id ?? null }
    })
  }, [])

  const selectPreviewTab = useCallback((tabId: string) => {
    setState((current) =>
      current.tabs.some((tab) => tab.id === tabId)
        ? { ...current, activeTabId: tabId }
        : current
    )
  }, [])

  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs]
  )

  return {
    previewTabs: state.tabs,
    activePreviewTabId: state.activeTabId,
    activePreviewTab: activeTab,
    previewPath: activeTab?.previewPath ?? null,
    previewContent: activeTab?.content ?? null,
    previewLoading: activeTab?.loading ?? false,
    previewDiff: activeTab?.diff ?? null,
    panelOpen: state.tabs.length > 0,
    handleFileClick,
    handleDiffClick,
    closePreview,
    selectPreviewTab
  }
}
