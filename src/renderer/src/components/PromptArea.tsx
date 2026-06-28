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
import IconPackage from './icons/IconPackage'
import { builtinCommands } from '../commands/SlashCommandParser'
import './PromptArea.css'

import type { WorkspaceInfo } from '@shared/types/workspace'

interface PromptAreaProps {
  onSend: (message: string, modelName: string) => void
  placeholder?: string
  onOpenSettings?: () => void
  workspace?: WorkspaceInfo | null
}

export default function PromptArea({ onSend, placeholder, onOpenSettings, workspace }: PromptAreaProps): React.ReactElement {
  const [text, setText] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dynamicSkills, setDynamicSkills] = useState<any[]>([])

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
    if (workspace) {
      window.api.skill.getAll(workspace.rootPath).then(setDynamicSkills).catch(() => {})
    } else {
      setDynamicSkills([])
    }
  }, [workspace])

  const activeCommandMatch = text.match(/^\/([a-zA-Z0-9_-]+)\s*/)
  const activeCommandName = activeCommandMatch ? activeCommandMatch[1] : null
  const matchedSkill = activeCommandName
    ? dynamicSkills.find(s => s.id.replace(/^(global|workspace)-/, '').toLowerCase() === activeCommandName.toLowerCase())
    : null

  const textareaValue = matchedSkill ? text.replace(/^\/[a-zA-Z0-9_-]+\s*/, '') : text

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }, [textareaValue])

  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)

  useEffect(() => {
    const handleInsert = (e: Event) => {
      const cmd = (e as CustomEvent).detail
      setText(cmd)
      textareaRef.current?.focus()
    }
    window.addEventListener('insert-command', handleInsert)
    return () => window.removeEventListener('insert-command', handleInsert)
  }, [])

  const showSlashMenu = text.startsWith('/') && !text.includes(' ')

  const filteredCommands = showSlashMenu
    ? builtinCommands.filter(c => {
        const search = text.substring(1).toLowerCase()
        return c.name.toLowerCase().includes(search) || c.aliases?.some((a: string) => a.toLowerCase().includes(search))
      })
    : []

  const filteredSkills = showSlashMenu
    ? dynamicSkills.map(s => ({
        id: s.id,
        name: s.id.replace(/^(global|workspace)-/, ''), // display name
        displayName: s.name,
        description: s.description,
        triggers: s.triggers
      })).filter(c => {
        const search = text.substring(1).toLowerCase()
        return c.name.toLowerCase().includes(search) || c.triggers?.some((a: string) => a.toLowerCase().includes(search))
      })
    : []

  const totalItems = [
    ...filteredCommands.map(c => ({ ...c, type: 'command' as const })),
    ...filteredSkills.map(s => ({ ...s, type: 'skill' as const }))
  ]

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [text])

  const handleSend = () => {
    if (!text.trim()) return
    onSend(text.trim(), selectedModelName || models[0]?.name || '')
    setText('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Backspace' && matchedSkill && text === `/${activeCommandName} `) {
      e.preventDefault()
      setText('')
      return
    }

    if (showSlashMenu && totalItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % totalItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + totalItems.length) % totalItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = totalItems[slashSelectedIndex]
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
        {showSlashMenu && totalItems.length > 0 && (
          <div className="prompt-slash-menu">
            {filteredCommands.length > 0 && (
              <>
                <div className="prompt-slash-section-header">命令</div>
                {filteredCommands.map((cmd) => {
                  const globalIdx = totalItems.findIndex(item => item.type === 'command' && item.name === cmd.name)
                  return (
                    <div
                      key={cmd.name}
                      className={`prompt-slash-item ${globalIdx === slashSelectedIndex ? 'is-selected' : ''}`}
                      onClick={() => {
                        setText(`/${cmd.name} `)
                        textareaRef.current?.focus()
                      }}
                      onMouseEnter={() => setSlashSelectedIndex(globalIdx)}
                    >
                      <div className="prompt-slash-item-content">
                        <span className="prompt-slash-title">/{cmd.name}</span>
                        <span className="prompt-slash-desc">{cmd.description}</span>
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {filteredSkills.length > 0 && (
              <>
                <div className="prompt-slash-section-header">技能</div>
                {filteredSkills.map((skill) => {
                  const globalIdx = totalItems.findIndex(item => item.type === 'skill' && item.id === skill.id)
                  return (
                    <div
                      key={skill.id}
                      className={`prompt-slash-item ${globalIdx === slashSelectedIndex ? 'is-selected' : ''}`}
                      onClick={() => {
                        setText(`/${skill.name} `)
                        textareaRef.current?.focus()
                      }}
                      onMouseEnter={() => setSlashSelectedIndex(globalIdx)}
                    >
                      <div className="prompt-slash-item-content">
                        <span className="prompt-slash-skill-title">{skill.name}</span>
                        <span className="prompt-slash-desc">{skill.description || skill.displayName}</span>
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            <div className="prompt-slash-menu-footer">
              <span className="prompt-slash-footer-icon">ⓘ</span>
              <span>输入内容以搜索命令或者技能</span>
            </div>
          </div>
        )}
        <Card variant="default" rounded="lg" className="prompt-card">
          <Stack gap={2}>
            {/* 输入框上方的功能扩展栏 */}
            <Flex align="center" gap={3} className="prompt-top-toolbar">
            </Flex>

            <Flex align="start" className="prompt-input-wrapper w-full">
              {matchedSkill && (
                <div 
                  className="prompt-skill-chip"
                  title="已激活技能工作流"
                >
                  <IconPackage className="prompt-skill-chip-icon" />
                  <span className="prompt-skill-chip-text">{activeCommandName}</span>
                  <button 
                    type="button" 
                    className="prompt-skill-chip-close"
                    onClick={() => {
                      const rest = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, '')
                      setText(rest)
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              <textarea
                ref={textareaRef}
                rows={1}
                value={matchedSkill ? text.replace(/^\/[a-zA-Z0-9_-]+\s*/, '') : text}
                onChange={(e) => {
                  if (matchedSkill) {
                    setText(`/${activeCommandName} ${e.target.value}`)
                  } else {
                    setText(e.target.value)
                  }
                }}
                onKeyDown={handleKeyDown}
                placeholder={placeholder || '随心输入...'}
                className="prompt-textarea"
                style={{ maxHeight: '200px' }}
              />
            </Flex>

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
