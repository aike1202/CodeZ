import React, { useState } from 'react'
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

const EFFORT_LABELS: Partial<Record<ThinkingEffort, string>> = {
  none: '关闭',
  minimal: '极低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

export default function PromptArea({
  onSend,
  placeholder,
  onOpenSettings,
  workspace
}: PromptAreaProps): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [plusDropdownOpen, setPlusDropdownOpen] = useState(false)

  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const streamCleanups = useChatStore((s) => s.streamCleanups)
  const isStreaming = activeSessionId ? !!streamCleanups[activeSessionId] : false
  const stopStream = activeSessionId ? streamCleanups[activeSessionId] ?? null : null
  const messages = useChatStore((s) => s.messages)

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
    maxContextTokens,
    dynamicSkills
  } = usePromptEditor(onSend, workspace)

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

        <Card variant="default" rounded="lg" className="prompt-card">
          <Stack gap={2}>
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
                />
                <PermissionModeSelector />
              </Flex>

              <Flex align="center" gap={3} className="prompt-actions-right">


                <ContextTracker
                  messages={messages}
                  maxContextTokens={maxContextTokens}
                  skillsCount={dynamicSkills.length}
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
                    variant={text.trim() ? 'dark' : 'secondary'}
                    size="none"
                    onClick={handleSend}
                    disabled={!text.trim()}
                    className="prompt-send-btn"
                  >
                    <IconSend />
                  </Button>
                )}
              </Flex>
            </Flex>
          </Stack>
        </Card>
      </div>
    </div>
  )
}

export type { PromptAreaProps } from './types'
