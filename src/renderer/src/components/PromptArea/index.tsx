import React, { useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import type { ModelConfig, ThinkingEffort } from '@shared/types/provider'
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
import PermissionModeSelector from './components/PermissionModeSelector'
import { useImageAttachments } from './hooks/useImageAttachments'
import ImageAttachmentGrid from '../chat/ImageAttachmentGrid'
import ImagePreviewModal from '../chat/ImagePreviewModal'

const EFFORT_LABELS: Partial<Record<ThinkingEffort, string>> = {
  none: '关闭',
  minimal: '极低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

function containsImageFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  ) || Array.from(dataTransfer.files).some((file) => file.type.startsWith('image/'))
}

export default function PromptArea({
  onSend,
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
    clearAcceptedDrafts
  } = useImageAttachments()

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamCleanups = useChatStore((s) => s.streamCleanups)
  const isStreaming = activeSessionId ? !!streamCleanups[activeSessionId] : false
  const stopStream = activeSessionId ? streamCleanups[activeSessionId] ?? null : null
  const contextSnapshot = useChatStore((s) => activeSessionId ? s.contextBudgets[activeSessionId] : undefined)
  const compactionState = useChatStore((s) => activeSessionId ? s.compactionStates[activeSessionId] : undefined)

  const {
    text,
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
    workspace,
    attachments,
    clearAcceptedDrafts,
    importing
  )

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
      thinkingBudgetTokens: effort === 'auto' ? undefined : null
    })
  }

  const handleBudgetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const isAuto = e.target.value === 'auto'
    updateActiveModel({
      thinkingEffort: isAuto ? 'auto' : 'custom',
      thinkingBudgetTokens: isAuto ? null : Number(e.target.value)
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

        <Card
          variant="default"
          rounded="lg"
          className={`prompt-card${isImageDragging ? ' is-image-dragging' : ''}`}
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
              <div className="prompt-scroll-container" onKeyDownCapture={handleKeyDown}>
                <CodeMirror
                  value={text}
                  onChange={handleChange}
                  placeholder={placeholder || '随心输入...'}
                  extensions={[pillDecoration, EditorView.lineWrapping]}
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
                  <Button
                    variant="danger"
                    size="none"
                    onClick={() => stopStream && stopStream()}
                    className="prompt-send-btn is-streaming"
                    title="停止生成"
                  >
                    <IconStop />
                  </Button>
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
