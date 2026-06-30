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
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'
import { ThoughtIcon, SearchIcon, CmdIcon } from './svg-icons'
import ContextTracker from './ContextTracker'
import { builtinCommands } from '../commands/SlashCommandParser'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { pillDecoration } from './chat/extensions/pillDecoration'
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
  const [flattenedFiles, setFlattenedFiles] = useState<{name: string, path: string, isDir: boolean}[]>([])

  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)

  const isStreaming = useChatStore((s) => s.streamCleanup !== null)
  const stopStream = useChatStore((s) => s.streamCleanup)

  const viewRef = useRef<EditorView | null>(null)

  const activeProvider = providers.find((p) => p.id === activeProviderId)
  const [selectedModelName, setSelectedModelName] = useState<string>('')

  const models = activeProvider?.models || []
  useEffect(() => {
    if (models.length > 0 && !models.find((m) => m.name === selectedModelName)) {
      setSelectedModelName(models[0].name)
    }
  }, [activeProviderId])

  const messages = useChatStore((s) => s.messages)
  const maxContextTokens = models.find(m => m.name === selectedModelName)?.maxContextTokens || 32000

  // Fetch skills and files
  useEffect(() => {
    if (workspace) {
      window.api.skill.getAll(workspace.rootPath).then(setDynamicSkills).catch(() => {})
      window.api.workspace.getAllPaths(workspace.rootPath).then((paths: any) => {
        if (Array.isArray(paths)) {
          setFlattenedFiles(paths)
        }
      }).catch(() => {})
    } else {
      setDynamicSkills([])
      setFlattenedFiles([])
    }
  }, [workspace])

  // Contexts for mention/slash dropdown
  const [activeToken, setActiveToken] = useState<{type: 'slash' | 'mention', text: string, startIndex: number} | null>(null)
  const [popupSelectedIndex, setPopupSelectedIndex] = useState(0)

  const updateActiveToken = (currentText: string, cursor: number) => {
    const textBeforeCursor = currentText.slice(0, cursor)
    
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/)
    if (slashMatch) {
      setActiveToken({ type: 'slash', text: slashMatch[1], startIndex: slashMatch.index! + (slashMatch[0].startsWith(' ') ? 1 : 0) })
      return
    }

    const mentionMatch = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/)
    if (mentionMatch) {
      setActiveToken({ type: 'mention', text: mentionMatch[1], startIndex: mentionMatch.index! + (mentionMatch[0].startsWith(' ') ? 1 : 0) })
      return
    }

    setActiveToken(null)
  }

  const handleChange = (value: string, viewUpdate: any) => {
    setText(value)
    const cursor = viewUpdate.state.selection.main.head
    updateActiveToken(value, cursor)
  }



  const getMentionScore = (f: { name: string, path: string }, query: string) => {
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

  const getFileIcon = (isDir: boolean, name: string) => {
    if (isDir) return <FolderIcon folderName={name} className="shrink-0" width={14} height={14} />
    return <FileIcon fileName={name} className="shrink-0" width={14} height={14} />
  }

  const filteredMentions = activeToken?.type === 'mention'
    ? flattenedFiles
        .map(f => ({ ...f, _score: activeToken.text ? getMentionScore(f, activeToken.text) : 1 }))
        .filter(f => f._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 50)
    : []

  const filteredCommands = activeToken?.type === 'slash'
    ? builtinCommands.filter(c => c.name.toLowerCase().includes(activeToken.text.toLowerCase()) || c.aliases?.some((a: string) => a.toLowerCase().includes(activeToken.text.toLowerCase())))
    : []

  const filteredSkills = activeToken?.type === 'slash'
    ? dynamicSkills.map(s => ({ ...s, name: s.id.replace(/^(global|workspace)-/, ''), displayName: s.name })).filter(c => c.name.toLowerCase().includes(activeToken.text.toLowerCase()) || c.triggers?.some((a: string) => a.toLowerCase().includes(activeToken.text.toLowerCase())))
    : []

  const popupItems = activeToken?.type === 'mention'
    ? filteredMentions.map(f => ({ ...f, type: 'file' as const }))
    : activeToken?.type === 'slash'
      ? [
          ...filteredCommands.map(c => ({ ...c, type: 'command' as const })),
          ...filteredSkills.map(s => ({ ...s, type: 'skill' as const }))
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
      // Escape backslashes for Windows absolute paths
      markdownPath = selected.path.replace(/\\/g, '\\\\')
    }
    const replacement = selected.type === 'file' ? `[${selected.name}](${markdownPath}) ` : `[$${selected.name}](${markdownPath}) `
    
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

  const handleSend = () => {
    if (!text.trim()) return
    onSend(text.trim(), selectedModelName || models[0]?.name || '')
    setText('')
  }



  const displayLabel = activeProvider
    ? `${activeProvider.name} / ${selectedModelName || models[0]?.name || '?'}`
    : '未配置模型'

  return (
    <div className="prompt-area-container">
      <div className="prompt-area-inner relative">
        {activeToken && popupItems.length > 0 && (
          <div className="prompt-slash-menu">
            {activeToken.type === 'mention' && filteredMentions.length > 0 && (
              <>
                <div className="prompt-slash-section-header">文件</div>
                {filteredMentions.map((file) => {
                  const globalIdx = popupItems.findIndex(item => item.type === 'file' && item.path === file.path)
                  return (
                    <div
                      key={file.path}
                      className={`prompt-slash-item ${globalIdx === popupSelectedIndex ? 'is-selected' : ''}`}
                      onClick={() => handleSelectPopupItem({ ...file, type: 'file' })}
                      onMouseEnter={() => setPopupSelectedIndex(globalIdx)}
                    >
                      <div className="prompt-slash-item-content">
                        <span className="prompt-slash-title">
                          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {getFileIcon(file.isDir, file.name)}
                          </span>
                          <span className="prompt-slash-title-text">@{file.name}</span>
                        </span>
                        <span className="prompt-slash-desc">{file.path}</span>
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {activeToken.type === 'slash' && filteredCommands.length > 0 && (
              <>
                <div className="prompt-slash-section-header">命令</div>
                {filteredCommands.map((cmd) => {
                  const globalIdx = popupItems.findIndex(item => item.type === 'command' && item.name === cmd.name)
                  return (
                    <div
                      key={cmd.name}
                      className={`prompt-slash-item ${globalIdx === popupSelectedIndex ? 'is-selected' : ''}`}
                      onClick={() => handleSelectPopupItem({ ...cmd, type: 'command' })}
                      onMouseEnter={() => setPopupSelectedIndex(globalIdx)}
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

            {activeToken.type === 'slash' && filteredSkills.length > 0 && (
              <>
                <div className="prompt-slash-section-header">技能</div>
                {filteredSkills.map((skill) => {
                  const globalIdx = popupItems.findIndex(item => item.type === 'skill' && item.id === skill.id)
                  return (
                    <div
                      key={skill.id}
                      className={`prompt-slash-item ${globalIdx === popupSelectedIndex ? 'is-selected' : ''}`}
                      onClick={() => handleSelectPopupItem({ ...skill, type: 'skill' })}
                      onMouseEnter={() => setPopupSelectedIndex(globalIdx)}
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
              <span>{activeToken.type === 'slash' ? '输入内容以搜索命令或者技能' : '输入内容以搜索文件'}</span>
            </div>
          </div>
        )}

        <Card variant="default" rounded="lg" className="prompt-card">
          <Stack gap={2}>
            {/* 输入框上方的功能扩展栏 */}
            <Flex align="center" gap={3} className="prompt-top-toolbar">
            </Flex>

            <Flex align="start" className="prompt-input-wrapper w-full">
              <div className="prompt-scroll-container" onKeyDownCapture={handleKeyDown}>
                <CodeMirror
                  value={text}
                  onChange={handleChange}
                  onUpdate={(viewUpdate) => {
                    if (viewUpdate.selectionSet) {
                      const cursor = viewUpdate.state.selection.main.head
                      updateActiveToken(viewUpdate.state.doc.toString(), cursor)
                    }
                  }}
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

                <ContextTracker 
                  messages={messages} 
                  maxContextTokens={maxContextTokens} 
                  skillsCount={dynamicSkills.length} 
                />

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
