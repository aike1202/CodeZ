import React, { useState, useRef, useEffect } from 'react'
import { useProviderStore } from '../stores/providerStore'
import { useChatStore } from '../stores/chatStore'
import Button from './ui/Button'
import Flex from './ui/Flex'
import Stack from './ui/Stack'
import Card from './ui/Card'
import IconPlus from './icons/IconPlus'
import IconMore from './icons/IconMore'
import IconChevronDown from './icons/IconChevronDown'
import IconGear from './icons/IconGear'
import IconStop from './icons/IconStop'
import IconSend from './icons/IconSend'
import { builtinCommands } from '../commands/SlashCommandParser'
import './PromptArea.css'

import type { WorkspaceInfo } from '@shared/types/workspace'

interface PromptAreaProps {
  onSend: (message: string, modelName: string) => void
  placeholder?: string
  onOpenSettings?: () => void
  onOpenProjectMemory?: () => void
  workspace?: WorkspaceInfo | null
}

export default function PromptArea({ onSend, placeholder, onOpenSettings, onOpenProjectMemory, workspace }: PromptAreaProps): React.ReactElement {
  const [text, setText] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)

  const isStreaming = useChatStore((s) => s.streamCleanup !== null)
  const stopStream = useChatStore((s) => s.streamCleanup)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeProvider = providers.find((p) => p.id === activeProviderId)

  const [selectedModelName, setSelectedModelName] = useState<string>('')

  const models = activeProvider?.models || []
  useEffect(() => {
    if (models.length > 0 && !models.find((m) => m.name === selectedModelName)) {
      setSelectedModelName(models[0].name)
    }
  }, [activeProviderId])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [text])

  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)

  const showSlashMenu = text.startsWith('/') && !text.includes(' ')
  const filteredCommands = showSlashMenu
    ? builtinCommands.filter(c => {
        const search = text.substring(1).toLowerCase()
        return c.name.includes(search) || c.aliases?.some(a => a.includes(search))
      })
    : []

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [text])

  const handleSend = () => {
    if (!text.trim()) return
    onSend(text.trim(), selectedModelName || models[0]?.name || '')
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = filteredCommands[slashSelectedIndex]
        if (selected) {
          setText(`/${selected.name} `)
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

  return (
    <div className="prompt-area-container">
      <div className="prompt-area-inner relative">
        {showSlashMenu && filteredCommands.length > 0 && (
          <div className="absolute bottom-full mb-2 left-0 w-[450px] max-h-64 overflow-y-auto bg-white dark:bg-[#252526] border border-gray-200 dark:border-zinc-700 rounded-lg shadow-xl z-50 flex flex-col p-1.5">
            {filteredCommands.map((cmd, idx) => (
              <div
                key={cmd.name}
                className={`flex flex-col gap-0.5 px-3 py-2 rounded cursor-pointer ${idx === slashSelectedIndex ? 'bg-blue-50 dark:bg-blue-900/40' : 'hover:bg-gray-50 dark:hover:bg-zinc-800'}`}
                onClick={() => {
                  setText(`/${cmd.name} `)
                  textareaRef.current?.focus()
                }}
                onMouseEnter={() => setSlashSelectedIndex(idx)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-blue-600 dark:text-blue-400 font-mono text-sm font-semibold">/{cmd.name}</span>
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">{cmd.description}</span>
              </div>
            ))}
          </div>
        )}
        <Card variant="default" rounded="lg" className="prompt-card">
          <Stack gap={2}>
            {/* 输入框上方的功能扩展栏 */}
            <Flex align="center" gap={3} className="prompt-top-toolbar">
              {onOpenProjectMemory && (
                <Button variant="ghost" size="none" onClick={() => onOpenProjectMemory()} title="项目记忆" className="text-gray-500 hover:text-gray-800 flex items-center gap-1 text-xs px-2 py-1 rounded">
                  <IconGear /> <span>项目记忆</span>
                </Button>
              )}
            </Flex>

            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || '随心输入...'}
              className="prompt-textarea"
              style={{ maxHeight: '200px' }}
            />

            <Flex align="center" justify="between" className="pt-2">
              <Flex align="center" gap={3} className="prompt-actions-left">
                <Button variant="ghost" size="none" className="prompt-plus-btn">
                  <IconPlus />
                </Button>
                <Button variant="ghost" size="none" className="prompt-approve-btn">
                  <IconMore /> 请求批准 <IconChevronDown />
                </Button>
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

                <div className="relative">
                  <Button
                    variant="ghost"
                    size="none"
                    className="prompt-model-selector-btn"
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                  >
                    <span className="truncate">{displayLabel}</span>
                    <IconChevronDown />
                  </Button>

                  {dropdownOpen && (
                    <>
                      <div className="fixed inset-0 z-[40]" onClick={() => setDropdownOpen(false)}></div>
                      <Card variant="default" className="prompt-dropdown-card">
                        <div className="prompt-dropdown-header">Provider / 模型</div>

                        {providers.length === 0 ? (
                          <div className="prompt-dropdown-empty">暂无 Provider</div>
                        ) : (
                          providers.map((p) => (
                            <div key={p.id}>
                              <Flex
                                align="center"
                                justify="between"
                                className={`prompt-dropdown-provider ${
                                  p.id === activeProviderId ? 'is-active' : ''
                                }`}
                                onClick={() => {
                                  useProviderStore.getState().setActiveProvider(p.id)
                                }}
                              >
                                <span>{p.name}</span>
                                {p.id === activeProviderId && <span className="prompt-check-mark">✓</span>}
                              </Flex>
                              {p.id === activeProviderId && p.models.length > 0 && (
                                <div className="prompt-dropdown-model-list">
                                  {p.models.map((m) => (
                                    <Flex
                                      key={m.id}
                                      align="center"
                                      justify="between"
                                      className={`prompt-dropdown-model-item ${
                                        selectedModelName === m.name ? 'is-selected' : ''
                                      }`}
                                      onClick={() => {
                                        setSelectedModelName(m.name)
                                        setDropdownOpen(false)
                                      }}
                                    >
                                      <span>{m.name}</span>
                                      <span className="prompt-model-context-tokens">
                                        {m.maxContextTokens > 0 ? `${(m.maxContextTokens / 1024).toFixed(0)}K` : '-'}
                                      </span>
                                    </Flex>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))
                        )}

                        {onOpenSettings && (
                          <>
                            <div className="prompt-dropdown-divider"></div>
                            <Flex
                              align="center"
                              gap={2}
                              className="prompt-dropdown-settings-action"
                              onClick={() => { setDropdownOpen(false); onOpenSettings() }}
                            >
                              <IconGear /> 管理 Provider...
                            </Flex>
                          </>
                        )}
                      </Card>
                    </>
                  )}
                </div>

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
