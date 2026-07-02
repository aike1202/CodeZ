import { useState, useRef, useEffect } from 'react'
import { EditorView } from '@codemirror/view'
import { useChatStore } from '../../../stores/chatStore'
import { useProviderStore } from '../../../stores/providerStore'
import { builtinCommands } from '../../../commands/SlashCommandParser'
import type { WorkspaceInfo } from '@shared/types/workspace'

export function usePromptEditor(
  onSend: (message: string, modelName: string) => void,
  workspace?: WorkspaceInfo | null
) {
  const [text, setText] = useState('')
  const [selectedModelName, setSelectedModelName] = useState<string>('')
  const [dynamicSkills, setDynamicSkills] = useState<any[]>([])
  const [flattenedFiles, setFlattenedFiles] = useState<{ name: string; path: string; isDir: boolean }[]>([])
  const [activeToken, setActiveToken] = useState<{ type: 'slash' | 'mention'; text: string; startIndex: number } | null>(null)
  const [popupSelectedIndex, setPopupSelectedIndex] = useState(0)

  const viewRef = useRef<EditorView | null>(null)

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const models = activeProvider?.models || []

  const pendingPrompt = useChatStore((s) => s.pendingPrompt)
  const setPendingPrompt = useChatStore((s) => s.setPendingPrompt)

  useEffect(() => {
    if (pendingPrompt) {
      setText(pendingPrompt)
      setPendingPrompt(null)
      setTimeout(() => {
        if (viewRef.current) {
          viewRef.current.focus()
          viewRef.current.dispatch({
            selection: { anchor: pendingPrompt.length, head: pendingPrompt.length }
          })
        }
      }, 50)
    }
  }, [pendingPrompt, setPendingPrompt])

  useEffect(() => {
    if (models.length > 0 && !models.find((m) => m.name === selectedModelName)) {
      setSelectedModelName(models[0].name)
    }
  }, [activeProviderId, models, selectedModelName])

  useEffect(() => {
    if (workspace) {
      window.api.skill.getAll(workspace.rootPath).then(setDynamicSkills).catch(() => {})
      ;(window as any).api.workspace.getAllPaths(workspace.rootPath).then((paths: any) => {
        if (Array.isArray(paths)) {
          setFlattenedFiles(paths)
        }
      }).catch(() => {})
    } else {
      setDynamicSkills([])
      setFlattenedFiles([])
    }
  }, [workspace])

  const updateActiveToken = (currentText: string, cursor: number) => {
    const textBeforeCursor = currentText.slice(0, cursor)

    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/)
    if (slashMatch) {
      setActiveToken({
        type: 'slash',
        text: slashMatch[1],
        startIndex: slashMatch.index! + (slashMatch[0].startsWith(' ') ? 1 : 0)
      })
      return
    }

    const mentionMatch = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/)
    if (mentionMatch) {
      setActiveToken({
        type: 'mention',
        text: mentionMatch[1],
        startIndex: mentionMatch.index! + (mentionMatch[0].startsWith(' ') ? 1 : 0)
      })
      return
    }

    setActiveToken(null)
  }

  const handleChange = (value: string, viewUpdate: any) => {
    setText(value)
    const cursor = viewUpdate.state.selection.main.head
    updateActiveToken(value, cursor)
  }

  const getMentionScore = (f: { name: string; path: string }, query: string) => {
    if (!query) return 1
    const lowerName = f.name.toLowerCase()
    const lowerPath = f.path.toLowerCase()
    const lowerQuery = query.toLowerCase()

    if (lowerName === lowerQuery) return 100
    if (lowerName.startsWith(lowerQuery)) return 80 - lowerName.length * 0.01
    if (lowerName.includes(lowerQuery)) return 60 - lowerName.length * 0.01
    if (lowerPath.includes(lowerQuery)) return 40 - lowerPath.length * 0.01
    return 0
  }

  const filteredMentions = activeToken?.type === 'mention'
    ? flattenedFiles
        .map((f) => ({ ...f, _score: activeToken.text ? getMentionScore(f, activeToken.text) : 1 }))
        .filter((f) => f._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 50)
    : []

  const filteredCommands = activeToken?.type === 'slash'
    ? builtinCommands.filter(
        (c) =>
          c.name.toLowerCase().includes(activeToken.text.toLowerCase()) ||
          c.aliases?.some((a: string) => a.toLowerCase().includes(activeToken.text.toLowerCase()))
      )
    : []

  const filteredSkills = activeToken?.type === 'slash'
    ? dynamicSkills
        .map((s) => ({ ...s, name: s.id.replace(/^(global|workspace)-/, ''), displayName: s.name }))
        .filter(
          (c) =>
            c.name.toLowerCase().includes(activeToken.text.toLowerCase()) ||
            c.triggers?.some((a: string) => a.toLowerCase().includes(activeToken.text.toLowerCase()))
        )
    : []

  const popupItems = activeToken?.type === 'mention'
    ? filteredMentions.map((f) => ({ ...f, type: 'file' as const }))
    : activeToken?.type === 'slash'
      ? [
          ...filteredCommands.map((c) => ({ ...c, type: 'command' as const })),
          ...filteredSkills.map((s) => ({ ...s, type: 'skill' as const }))
        ]
      : []

  useEffect(() => {
    setPopupSelectedIndex(0)
  }, [activeToken?.text])

  const handleSelectPopupItem = (selected: any) => {
    if (!activeToken || !viewRef.current) return
    let markdownPath = selected.path || selected.id || selected.name
    if (selected.type === 'file' && workspace) {
      markdownPath = `${workspace.rootPath}/${selected.path}`.replace(/\\/g, '/').replace(/\/\//g, '/')
    } else if (selected.type === 'skill' && selected.path) {
      markdownPath = selected.path.replace(/\\/g, '\\\\')
    }
    const replacement =
      selected.type === 'file' ? `[${selected.name}](${markdownPath}) ` : `[$${selected.name}](${markdownPath}) `

    const view = viewRef.current
    view.dispatch({
      changes: {
        from: activeToken.startIndex,
        to: view.state.selection.main.head,
        insert: replacement
      }
    })
    view.focus()
  }

  const handleSend = () => {
    if (!text.trim()) return
    onSend(text.trim(), selectedModelName || models[0]?.name || '')
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeToken && popupItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPopupSelectedIndex((prev) => (prev + 1) % popupItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPopupSelectedIndex((prev) => (prev - 1 + popupItems.length) % popupItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = popupItems[popupSelectedIndex]
        if (selected) {
          handleSelectPopupItem(selected)
        }
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const displayLabel = activeProvider
    ? `${activeProvider.name} / ${selectedModelName || models[0]?.name || '?'}`
    : '未配置模型'

  const maxContextTokens = models.find((m) => m.name === selectedModelName)?.maxContextTokens || 32000

  return {
    text,
    setText,
    viewRef,
    selectedModelName,
    setSelectedModelName,
    activeToken,
    popupSelectedIndex,
    setPopupSelectedIndex,
    handleChange,
    handleKeyDown,
    handleSend,
    handleSelectPopupItem,
    updateActiveToken,
    filteredMentions,
    filteredCommands,
    filteredSkills,
    popupItems,
    displayLabel,
    maxContextTokens,
    dynamicSkills
  }
}
