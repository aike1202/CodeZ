import React, { useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import Button from '../ui/Button'
import Flex from '../ui/Flex'
import Stack from '../ui/Stack'
import Card from '../ui/Card'
import IconGear from '../icons/IconGear'
import IconStop from '../icons/IconStop'
import IconSend from '../icons/IconSend'
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

  const isStreaming = useChatStore((s) => s.streamCleanup !== null)
  const stopStream = useChatStore((s) => s.streamCleanup)
  const messages = useChatStore((s) => s.messages)

  const {
    text,
    viewRef,
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
                {onOpenSettings && (
                  <Button
                    variant="ghost"
                    size="none"
                    className="prompt-gear-btn"
                    title="模型设置"
                    onClick={onOpenSettings}
                  >
                    <IconGear />
                  </Button>
                )}

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
                />

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
