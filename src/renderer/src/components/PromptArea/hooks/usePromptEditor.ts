import { useState, useRef, useEffect } from 'react'
import { EditorView } from '@codemirror/view'
import { useChatStore } from '../../../stores/chatStore'
import { useProviderStore } from '../../../stores/providerStore'
import { builtinCommands } from '../../../commands/SlashCommandParser'
import type { WorkspaceInfo } from '@shared/types/workspace'
import type { ComposerImageAttachment } from '@shared/types/attachment'
import { supportsImageInput } from '@shared/utils/imageCapabilities'
import { evaluateImageSendState } from '../../chat/imageAttachmentState'
import { restoreRejectedPromptText } from '../promptSubmissionState'

export function usePromptEditor(
  onSend: (
    message: string,
    modelName: string,
    attachments: ComposerImageAttachment[]
  ) => Promise<boolean>,
  onQueue: (
    message: string,
    modelName: string,
    attachments: ComposerImageAttachment[]
  ) => Promise<boolean>,
  workspace: WorkspaceInfo | null | undefined,
  attachments: ComposerImageAttachment[],
  clearComposerAttachments: () => void,
  restoreRejectedDrafts: (attachments: ComposerImageAttachment[]) => void,
  importingAttachments: boolean,
  conversationBusy: boolean
) {
  const [text, setText] = useState('')
  const [selectedModelName, setSelectedModelNameState] = useState<string>('')
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setSelectedModelName = (name: string) => {
    setSelectedModelNameState(name)
    const activeId = useProviderStore.getState().activeProviderId
    if (activeId) {
      localStorage.setItem(`codez:activeModelName:${activeId}`, name)
      if (activeSessionId) {
        localStorage.setItem(`codez:session:${activeSessionId}:activeModelName`, name)
      }
    }
  }
  const [dynamicSkills, setDynamicSkills] = useState<any[]>([])
  const [flattenedFiles, setFlattenedFiles] = useState<{ name: string; path: string; isDir: boolean }[]>([])
  const [activeToken, setActiveToken] = useState<{ type: 'slash' | 'mention'; text: string; startIndex: number } | null>(null)
  const [popupSelectedIndex, setPopupSelectedIndex] = useState(0)

  const viewRef = useRef<EditorView | null>(null)
  const isSubmittingRef = useRef(false)

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const models = activeProvider?.models || []
  const selectedModel = models.find((model) => model.name === selectedModelName) || models[0]
  const sendState = evaluateImageSendState({
    text,
    attachmentCount: attachments.length,
    importing: importingAttachments,
    supportsVision: supportsImageInput(selectedModel)
  })

  useEffect(() => {
    if (!activeSessionId) return
    const sessionProviderId = localStorage.getItem(`codez:session:${activeSessionId}:activeProviderId`)
    const sessionModelName = localStorage.getItem(`codez:session:${activeSessionId}:activeModelName`)
    
    if (sessionProviderId && providers.some((p) => p.id === sessionProviderId)) {
      if (activeProviderId !== sessionProviderId) {
        useProviderStore.getState().setActiveProvider(sessionProviderId)
      }
    }
    
    if (sessionModelName) {
      setSelectedModelNameState(sessionModelName)
    }
  }, [activeSessionId, providers])

  useEffect(() => {
    if (activeSessionId && activeProviderId) {
      localStorage.setItem(`codez:session:${activeSessionId}:activeProviderId`, activeProviderId)
    }
  }, [activeSessionId, activeProviderId])

  useEffect(() => {
    if (!activeProviderId || models.length === 0) return
    
    if (!selectedModelName || !models.some((m) => m.name === selectedModelName)) {
      const sessionStored = activeSessionId ? localStorage.getItem(`codez:session:${activeSessionId}:activeModelName`) : null
      if (sessionStored && models.some((m) => m.name === sessionStored)) {
        setSelectedModelNameState(sessionStored)
      } else {
        const providerStored = localStorage.getItem(`codez:activeModelName:${activeProviderId}`)
        if (providerStored && models.some((m) => m.name === providerStored)) {
          setSelectedModelNameState(providerStored)
          if (activeSessionId) {
            localStorage.setItem(`codez:session:${activeSessionId}:activeModelName`, providerStored)
          }
        } else {
          setSelectedModelNameState(models[0].name)
          localStorage.setItem(`codez:activeModelName:${activeProviderId}`, models[0].name)
          if (activeSessionId) {
            localStorage.setItem(`codez:session:${activeSessionId}:activeModelName`, models[0].name)
          }
        }
      }
    }
  }, [activeProviderId, models, selectedModelName, activeSessionId])

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
        .map((s) => ({ ...s, name: s.id.replace(/^(global|workspace|builtin)-/, ''), displayName: s.name }))
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

  const processSkillsInText = (rawText: string) => {
    return rawText.replace(/(^|\s)\$([a-zA-Z0-9_-]+)/g, (match, prefix, skillName) => {
      const lowerName = skillName.toLowerCase()
      const skill = dynamicSkills.find((s) => {
        const sName = s.id.replace(/^(global|workspace|builtin)-/, '').toLowerCase()
        return sName === lowerName || s.triggers?.some((t: string) => t.toLowerCase() === lowerName)
      })
      if (skill && skill.path) {
        const markdownPath = skill.path.replace(/\\/g, '\\\\')
        return `${prefix}[$${skillName}](${markdownPath})`
      }
      return match
    })
  }

  const handleSend = async (): Promise<boolean> => {
    if (!sendState.canSend || isSubmittingRef.current) return false

    const submittedText = text
    const submittedAttachments = attachments
    const trimmed = submittedText.trim()
    const finalContent = trimmed ? processSkillsInText(trimmed) : ''

    isSubmittingRef.current = true
    setText('')
    setActiveToken(null)
    clearComposerAttachments()

    try {
      const submit = conversationBusy ? onQueue : onSend
      const accepted = await submit(
        finalContent,
        selectedModelName || models[0]?.name || '',
        submittedAttachments
      )
      if (!accepted) {
        setText((current) => restoreRejectedPromptText(current, submittedText))
        restoreRejectedDrafts(submittedAttachments)
      }
      return accepted
    } catch (error) {
      console.error('[PromptArea] Failed to submit prompt:', error)
      setText((current) => restoreRejectedPromptText(current, submittedText))
      restoreRejectedDrafts(submittedAttachments)
      return false
    } finally {
      isSubmittingRef.current = false
    }
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
      void handleSend()
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
    dynamicSkills,
    sendState
  }
}
