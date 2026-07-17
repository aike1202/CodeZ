import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import type { ModelConfig, ThinkingEffort } from '../../shared/desktop'
import { desktopApi } from '../../shared/desktop'
import {
  getReasoningCapabilities,
  mergeModelThinkingConfig,
  resolveReasoningBudgetTokens
} from '@shared/utils/reasoningCapabilities'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import IconGear from '../icons/IconGear'
import IconStop from '../icons/IconStop'
import IconSend from '../icons/IconSend'
import Select from '../ui/Select'
import ContextTracker from '../ContextTracker'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { pillDecoration } from '../chat/extensions/pillDecoration'
import './PromptArea.css'

import type { PromptAreaProps } from './types'
import { usePromptEditor } from './hooks/usePromptEditor'
import ModelSelector from './components/ModelSelector'
import PlusActionMenu from './components/PlusActionMenu'
import SlashMentionMenu from './components/SlashMentionMenu'
import QueuedPromptList from './components/QueuedPromptList'
import PermissionModeSelector from './components/PermissionModeSelector'
import { useImageAttachments } from './hooks/useImageAttachments'
import ImageAttachmentGrid from '../chat/ImageAttachmentGrid'
import ImagePreviewModal from '../chat/ImagePreviewModal'
import {
  cloneComposerDraft,
  getSessionComposerDraft
} from '../../stores/chatStore/composerDrafts'
import { mergeRejectedAttachments, restoreRejectedPromptText } from './promptSubmissionState'
import type { QueuedPrompt } from '@shared/types/queuedPrompt'
import { usePromptPrediction } from './hooks/usePromptPrediction'
import { promptPredictionExtension } from './extensions/promptPredictionExtension'

const EFFORT_LABELS: Partial<Record<ThinkingEffort, string>> = {
  none: '关闭',
  minimal: '极低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}
const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = []

function containsImageFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  ) || Array.from(dataTransfer.files).some((file) => file.type.startsWith('image/'))
}

export default function PromptArea({
  onSend,
  onSteer,
  placeholder,
  onOpenSettings,
  workspace
}: PromptAreaProps): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [plusDropdownOpen, setPlusDropdownOpen] = useState(false)
  const [isImageDragging, setIsImageDragging] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)

  const {
    attachments,
    importing,
    errors,
    addFiles,
    removeAttachment,
    replaceAttachments,
    clearComposerAttachments,
    restoreRejectedDrafts
  } = useImageAttachments()

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const queuedPrompts = useChatStore((s) => {
    if (!s.activeSessionId) return EMPTY_QUEUED_PROMPTS
    return s.sessions.find((session) => session.id === s.activeSessionId)?.queuedPrompts || EMPTY_QUEUED_PROMPTS
  })
  const enqueueQueuedPrompt = useChatStore((s) => s.enqueueQueuedPrompt)
  const updateQueuedPrompt = useChatStore((s) => s.updateQueuedPrompt)
  const removeQueuedPrompt = useChatStore((s) => s.removeQueuedPrompt)
  const clearQueuedPrompts = useChatStore((s) => s.clearQueuedPrompts)
  const pendingPrompt = useChatStore((s) => s.pendingPrompt)
  const setPendingPrompt = useChatStore((s) => s.setPendingPrompt)
  const setComposerDraft = useChatStore((s) => s.setComposerDraft)
  const streamCleanups = useChatStore((s) => s.streamCleanups)
  const runtimeStatus = useChatStore((s) => activeSessionId
    ? s.runtimeStatuses[activeSessionId]?.status
    : undefined)
  const isStreaming = activeSessionId ? !!streamCleanups[activeSessionId] : false
  const conversationBusy = isStreaming || Boolean(
    runtimeStatus?.mainRunnerActive || runtimeStatus?.activeSubAgentIds.length
  )
  const stopStream = activeSessionId ? streamCleanups[activeSessionId] ?? null : null
  const contextSnapshot = useChatStore((s) => activeSessionId ? s.contextBudgets[activeSessionId] : undefined)
  const compactionState = useChatStore((s) => activeSessionId ? s.compactionStates[activeSessionId] : undefined)

  const {
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
    filteredMentions,
    filteredCommands,
    filteredSkills,
    popupItems,
    sendState
  } = usePromptEditor(
    onSend,
    async (message, modelName, queuedAttachments) => {
      if (!activeSessionId) return false
      enqueueQueuedPrompt(activeSessionId, {
        text: message,
        modelName,
        attachments: queuedAttachments
      })
      return true
    },
    workspace,
    attachments,
    clearComposerAttachments,
    restoreRejectedDrafts,
    importing,
    conversationBusy
  )

  const cleanupQueuedAttachments = async (prompts: QueuedPrompt[]) => {
    if (!activeSessionId || prompts.length === 0) return
    const draftIds = prompts.flatMap((prompt) => prompt.attachments)
      .filter((attachment) => attachment.scope === 'draft')
      .map((attachment) => attachment.draftId)
    const sessionIds = prompts.flatMap((prompt) => prompt.attachments)
      .filter((attachment) => attachment.scope === 'session')
      .map((attachment) => attachment.id)
    await Promise.all([
      draftIds.length > 0 ? desktopApi.attachment.discardDrafts(draftIds) : Promise.resolve(),
      sessionIds.length > 0
        ? desktopApi.attachment.rollbackPromotion(activeSessionId, sessionIds)
        : Promise.resolve()
    ])
  }

  const handleEditQueuedPrompt = (prompt: QueuedPrompt) => {
    if (!activeSessionId || prompt.status === 'steering') return
    const removed = removeQueuedPrompt(activeSessionId, prompt.id)
    if (!removed) return
    setText((current) => restoreRejectedPromptText(current, removed.text))
    replaceAttachments(mergeRejectedAttachments(attachments, removed.attachments))
    window.setTimeout(() => viewRef.current?.focus(), 0)
  }

  const handleDeleteQueuedPrompt = (prompt: QueuedPrompt) => {
    if (!activeSessionId) return
    const removed = removeQueuedPrompt(activeSessionId, prompt.id)
    if (removed) void cleanupQueuedAttachments([removed])
  }

  const handleClearQueuedPrompts = () => {
    if (!activeSessionId) return
    const removed = clearQueuedPrompts(activeSessionId)
    void cleanupQueuedAttachments(removed)
  }

  const handleSteerQueuedPrompt = async (prompt: QueuedPrompt) => {
    if (!activeSessionId || prompt.status === 'steering') return
    updateQueuedPrompt(activeSessionId, prompt.id, { status: 'steering' })
    try {
      const promoted = prompt.attachments.length > 0
        ? await desktopApi.attachment.promoteDrafts(activeSessionId, prompt.attachments)
        : []
      const accepted = await onSteer({ ...prompt, attachments: promoted, status: 'steering' })
      if (!accepted) {
        if (promoted.length > 0) {
          await desktopApi.attachment.rollbackPromotion(activeSessionId, promoted.map((item) => item.id))
        }
        updateQueuedPrompt(activeSessionId, prompt.id, { status: 'queued' })
        return
      }
      const draftIds = prompt.attachments
        .filter((attachment) => attachment.scope === 'draft')
        .map((attachment) => attachment.draftId)
      updateQueuedPrompt(activeSessionId, prompt.id, {
        attachments: promoted,
        status: 'steering'
      })
      if (draftIds.length > 0) await desktopApi.attachment.discardDrafts(draftIds)
    } catch (error) {
      console.warn('[PromptArea] Failed to steer queued prompt:', error)
      updateQueuedPrompt(activeSessionId, prompt.id, { status: 'failed' })
    }
  }

  const composerDraftInitializedRef = useRef(false)
  const composerDraftSessionRef = useRef<string | null>(activeSessionId)
  const liveComposerDraftRef = useRef(cloneComposerDraft())

  useLayoutEffect(() => {
    if (!composerDraftInitializedRef.current) {
      composerDraftInitializedRef.current = true
      composerDraftSessionRef.current = activeSessionId
      const stored = getSessionComposerDraft(
        useChatStore.getState().composerDrafts,
        activeSessionId
      )
      liveComposerDraftRef.current = stored
      if (stored.text !== text) setText(stored.text)
      if (stored.attachments.length > 0 || attachments.length > 0) {
        replaceAttachments(stored.attachments)
      }
      return
    }

    if (composerDraftSessionRef.current !== activeSessionId) {
      const previousSessionId = composerDraftSessionRef.current
      if (previousSessionId) {
        setComposerDraft(previousSessionId, liveComposerDraftRef.current)
      }

      const next = getSessionComposerDraft(
        useChatStore.getState().composerDrafts,
        activeSessionId
      )
      composerDraftSessionRef.current = activeSessionId
      liveComposerDraftRef.current = next
      setText(next.text)
      replaceAttachments(next.attachments)
      setPreviewIndex(null)
      return
    }

    liveComposerDraftRef.current = cloneComposerDraft({ text, attachments })
  }, [activeSessionId, attachments, replaceAttachments, setComposerDraft, setText, text])

  useEffect(() => () => {
    const sessionId = composerDraftSessionRef.current
    if (sessionId) {
      useChatStore.getState().setComposerDraft(sessionId, liveComposerDraftRef.current)
    }
  }, [])

  useEffect(() => {
    if (!pendingPrompt) return
    setText(pendingPrompt.text)
    replaceAttachments(pendingPrompt.attachments)

    const timer = window.setTimeout(() => {
      viewRef.current?.focus()
      viewRef.current?.dispatch({
        selection: {
          anchor: pendingPrompt.text.length,
          head: pendingPrompt.text.length
        }
      })
      setPendingPrompt(null)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [pendingPrompt, replaceAttachments, setPendingPrompt, setText, viewRef])

  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const providers = useProviderStore((s) => s.providers)
  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const updateProvider = useProviderStore((s) => s.updateProvider)
  const activeModel = activeProvider?.models.find((model) => model.name === selectedModelName)
  const activeThinking = activeProvider
    ? mergeModelThinkingConfig(activeProvider.thinking, activeModel)
    : null
  const activeEffort = activeThinking?.effort
  const activeBudget = activeThinking
    ? resolveReasoningBudgetTokens(activeThinking)
    : undefined
  const reasoningCapabilities = activeProvider && activeModel
    ? getReasoningCapabilities({
        model: activeModel.name,
        apiFormat: activeModel.apiFormat || activeProvider.apiFormat,
        baseUrl: activeProvider.baseUrl,
        mode: activeThinking?.mode
      })
    : null

  const promptPrediction = usePromptPrediction({
    activeSessionId,
    providerId: activeProviderId,
    model: selectedModelName,
    draft: text,
    conversationBusy,
    menuOpen: Boolean(activeToken && popupItems.length > 0)
  })
  const editorExtensions = useMemo(() => [
    pillDecoration,
    EditorView.lineWrapping,
    promptPredictionExtension(promptPrediction.suffix)
  ], [promptPrediction.suffix])

  const updateActiveModel = (patch: Partial<ModelConfig>) => {
    if (!activeProvider || !activeModel) return
    updateProvider(activeProvider.id, {
      models: activeProvider.models.map((model) =>
        model.id === activeModel.id ? { ...model, ...patch } : model
      )
    })
  }

  const handleEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const effort = e.target.value as ThinkingEffort
    updateActiveModel({
      thinkingEffort: effort,
      thinkingBudgetTokens: undefined
    })
  }

  const handleBudgetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const isAuto = e.target.value === 'auto'
    updateActiveModel({
      thinkingEffort: isAuto ? 'auto' : 'custom',
      thinkingBudgetTokens: isAuto ? undefined : Number(e.target.value)
    })
  }

  const closeAllDropdowns = () => {
    setDropdownOpen(false)
    setPlusDropdownOpen(false)
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageFiles = Array.from(event.clipboardData.files)
      .filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    event.preventDefault()
    void addFiles(imageFiles)
  }

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!containsImageFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setIsImageDragging(true)
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!containsImageFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isImageDragging) return
    if (containsImageFiles(event.dataTransfer)) event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsImageDragging(false)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const hasImages = containsImageFiles(event.dataTransfer)
    dragDepthRef.current = 0
    setIsImageDragging(false)
    if (!hasImages) return
    event.preventDefault()
    const imageFiles = Array.from(event.dataTransfer.files)
      .filter((file) => file.type.startsWith('image/'))
    void addFiles(imageFiles)
  }

  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const view = viewRef.current
    const selection = view?.state.selection.main
    const menuOpen = Boolean(activeToken && popupItems.length > 0)
    const canAcceptPrediction = (
      event.key === 'Tab'
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.nativeEvent.isComposing
      && !menuOpen
      && Boolean(promptPrediction.suffix)
      && Boolean(view && selection?.empty && selection.head === view.state.doc.length)
    )

    if (canAcceptPrediction && view) {
      event.preventDefault()
      const insertAt = view.state.doc.length
      const acceptedText = `${view.state.doc.toString()}${promptPrediction.suffix}`
      view.dispatch({
        changes: {
          from: insertAt,
          insert: promptPrediction.suffix
        },
        selection: { anchor: insertAt + promptPrediction.suffix.length }
      })
      promptPrediction.accept(acceptedText)
      return
    }

    handleKeyDown(event)
  }

  return (
    <div className="prompt-area-container">
      <div className="prompt-area-inner relative">
        <SlashMentionMenu
          activeToken={activeToken}
          popupItems={popupItems}
          popupSelectedIndex={popupSelectedIndex}
          setPopupSelectedIndex={setPopupSelectedIndex}
          handleSelectPopupItem={handleSelectPopupItem}
          filteredCommands={filteredCommands}
          filteredSkills={filteredSkills}
          filteredFiles={filteredMentions}
        />

        {queuedPrompts.length > 0 ? (
          <QueuedPromptList
            prompts={queuedPrompts}
            onSteer={(prompt) => { void handleSteerQueuedPrompt(prompt) }}
            onEdit={handleEditQueuedPrompt}
            onDelete={handleDeleteQueuedPrompt}
            onClear={handleClearQueuedPrompts}
          />
        ) : null}

        <Card
          variant="default"
          rounded="lg"
          className={`prompt-card${isImageDragging ? ' is-image-dragging' : ''}${queuedPrompts.length > 0 ? ' has-queue' : ''}`}
          onPaste={handlePaste}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            className="prompt-image-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || [])
              event.currentTarget.value = ''
              void addFiles(files)
            }}
          />
          <Stack gap={2}>
            <ImageAttachmentGrid
              attachments={attachments}
              mode="editable"
              onRemove={(attachment) => { void removeAttachment(attachment.id) }}
              onOpen={setPreviewIndex}
            />
            {importing ? <div className="prompt-image-status">照片正在导入...</div> : null}
            {errors.length > 0 ? (
              <div className="prompt-image-errors" role="status">
                {errors.map((error, index) => <div key={`${index}:${error}`}>{error}</div>)}
              </div>
            ) : null}
            <Flex align="start" className="prompt-input-wrapper w-full">
              <div className="prompt-scroll-container" onKeyDownCapture={handlePromptKeyDown}>
                <CodeMirror
                  value={text}
                  onChange={handleChange}
                  placeholder={promptPrediction.suffix ? undefined : placeholder || '随心输入...'}
                  extensions={editorExtensions}
                  onCreateEditor={(view) => {
                    viewRef.current = view
                  }}
                  basicSetup={{
                    lineNumbers: false,
                    foldGutter: false,
                    dropCursor: false,
                    allowMultipleSelections: false,
                    indentOnInput: false,
                    highlightActiveLine: false,
                    highlightActiveLineGutter: false,
                    highlightSpecialChars: false,
                    history: true,
                    drawSelection: true,
                    syntaxHighlighting: false,
                    bracketMatching: false,
                    closeBrackets: false,
                    autocompletion: false,
                    rectangularSelection: false,
                    crosshairCursor: false,
                    highlightSelectionMatches: false
                  }}
                />
              </div>
            </Flex>

            <Flex align="center" justify="between" className="pt-2">
              <Flex align="center" gap={3} className="prompt-actions-left">
                <PlusActionMenu
                  isOpen={plusDropdownOpen}
                  setIsOpen={setPlusDropdownOpen}
                  onCloseOthers={closeAllDropdowns}
                  onAddPhotos={() => fileInputRef.current?.click()}
                />
                <PermissionModeSelector />
              </Flex>

              <Flex align="center" gap={3} className="prompt-actions-right">


                <ContextTracker
                  snapshot={contextSnapshot}
                  compactionState={compactionState}
                />

                <ModelSelector
                  isOpen={dropdownOpen}
                  setIsOpen={setDropdownOpen}
                  onOpenSettings={onOpenSettings}
                  onCloseOthers={closeAllDropdowns}
                  selectedModelName={selectedModelName}
                  setSelectedModelName={setSelectedModelName}
                />

                {activeProvider?.thinking?.enabled && reasoningCapabilities?.control === 'effort' && (
                  <Select
                    className="prompt-effort-select"
                    value={activeEffort && reasoningCapabilities.efforts.includes(activeEffort)
                      ? activeEffort
                      : 'auto'}
                    onChange={handleEffortChange}
                  >
                    <optgroup label="推理">
                      <option value="auto">默认</option>
                      {reasoningCapabilities.efforts.map((effort) => (
                        <option key={effort} value={effort}>{EFFORT_LABELS[effort] || effort}</option>
                      ))}
                    </optgroup>
                  </Select>
                )}

                {activeProvider?.thinking?.enabled && reasoningCapabilities?.control === 'budget' && (
                  <Select
                    className="prompt-effort-select"
                    value={activeBudget || 'auto'}
                    onChange={handleBudgetChange}
                  >
                    <optgroup label="思考 Token">
                      <option value="auto">动态</option>
                      {reasoningCapabilities.budgetPresets?.map((tokens) => (
                        <option key={tokens} value={tokens}>{`${tokens / 1024}K`}</option>
                      ))}
                      {activeBudget
                        && !reasoningCapabilities.budgetPresets?.includes(activeBudget) && (
                          <option value={activeBudget}>
                            {`自定义 ${activeBudget}`}
                          </option>
                        )}
                    </optgroup>
                  </Select>
                )}

                {isStreaming ? (
                  <>
                    {sendState.canSend ? (
                      <Button
                        variant="dark"
                        size="none"
                        onClick={() => { void handleSend() }}
                        className="prompt-send-btn prompt-queue-send-btn"
                        title="加入排队"
                      >
                        <IconSend />
                      </Button>
                    ) : null}
                    <Button
                      variant="danger"
                      size="none"
                      onClick={() => stopStream && stopStream()}
                      className="prompt-send-btn is-streaming"
                      title="停止生成"
                    >
                      <IconStop />
                    </Button>
                  </>
                ) : (
                  <Button
                    variant={sendState.canSend ? 'dark' : 'secondary'}
                    size="none"
                    onClick={() => { void handleSend() }}
                    disabled={!sendState.canSend}
                    className="prompt-send-btn"
                    title={sendState.reason || '发送消息'}
                  >
                    <IconSend />
                  </Button>
                )}
              </Flex>
            </Flex>
          </Stack>
          {isImageDragging ? (
            <div className="prompt-image-drop-state" aria-hidden="true">
              <ImagePlus size={22} />
              <span>松开添加照片</span>
            </div>
          ) : null}
        </Card>
        {previewIndex !== null ? (
          <ImagePreviewModal
            attachments={attachments}
            initialIndex={previewIndex}
            onClose={() => setPreviewIndex(null)}
          />
        ) : null}
      </div>
    </div>
  )
}

export type { PromptAreaProps } from './types'
