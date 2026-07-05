import React, { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useProviderStore } from '../../stores/providerStore'
import type { ThinkingEffort } from '@shared/types/provider'
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
import PermissionSelector from './components/PermissionSelector'
import PlusActionMenu from './components/PlusActionMenu'
import SlashMentionMenu from './components/SlashMentionMenu'

export default function PromptArea({
  onSend,
  placeholder,
  onOpenSettings,
  workspace
}: PromptAreaProps): React.ReactElement {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [permDropdownOpen, setPermDropdownOpen] = useState(false)
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

  const handleEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (activeProvider) {
      updateProvider(activeProvider.id, {
        thinking: {
          ...activeProvider.thinking,
          effort: e.target.value as ThinkingEffort
        }
      })
    }
  }

  const closeAllDropdowns = () => {
    setDropdownOpen(false)
    setPermDropdownOpen(false)
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
                <PermissionSelector
                  isOpen={permDropdownOpen}
                  setIsOpen={setPermDropdownOpen}
                  onCloseOthers={closeAllDropdowns}
                />
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

                {activeProvider?.thinking?.enabled && (
                  <Select
                    className="prompt-effort-select"
                    value={activeProvider.thinking.effort || 'custom'}
                    onChange={handleEffortChange}
                  >
                    <optgroup label="推理">
                      <option value="auto">自动</option>
                      <option value="low">低</option>
                      <option value="medium">中</option>
                      <option value="high">高</option>
                      <option value="custom">自定义</option>
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
