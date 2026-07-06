import React from 'react'
import { Check, X, MessageCircleQuestion } from 'lucide-react'
import { getFileIconComponent } from '../ExecutionLog/utils'
import { FolderIcon } from '@react-symbols/icons/utils'
import { parseArgs } from '../../../utils/parseArgs'
import type { ExecutionLogDetailProps } from './types'
import './ExecutionLogDetail.css'

export default function ExecutionLogDetail({
  item,
  onFileClick
}: ExecutionLogDetailProps): React.ReactElement | null {
  if (item.type === 'reasoning') {
    return (
      <div className="exe-log-reasoning-detail">
        {item.detail?.trim()}
        {item.status === 'running' && <span className="streaming-cursor">▊</span>}
      </div>
    )
  }

  if (item.type === 'tool') {
    if (item.verb === 'Explored') {
      let detailText = item.detail || ''
      try {
        if (detailText.trim().startsWith('{')) {
          const parsed = JSON.parse(detailText)
          if (parsed && typeof parsed.data === 'string') {
            detailText = parsed.data
          }
        }
      } catch (e) {
        // ignore
      }

      const lines = detailText.split('\n')
      const hasTree = lines.some((l) => l.trim().startsWith('[DIR]') || l.trim().startsWith('[FILE]'))

      if (hasTree) {
        return (
          <div className="exe-log-detail-box-mono">
            {lines.map((line, idx) => {
              const trimmed = line.trim()
              const isDir = trimmed.startsWith('[DIR]')
              const isFile = trimmed.startsWith('[FILE]')
              if (!isDir && !isFile) {
                if (!trimmed) return null

                const dirMatch = trimmed.match(/^={2,}\s*Directory:\s*(.+?)\s*={2,}$/)
                if (dirMatch) {
                  return (
                    <div key={idx} className="exe-log-dir-header">
                      <FolderIcon folderName={dirMatch[1]} />
                      <span>{dirMatch[1]}</span>
                    </div>
                  )
                }

                return <div key={idx} className="pl-2">{line}</div>
              }

              const name = trimmed.replace(/^\[(DIR|FILE)\]\s*/u, '')
              return (
                <div key={idx} className="exe-log-dir-row">
                  {isDir ? <FolderIcon folderName={name} /> : getFileIconComponent(name)}
                  <span>{name}</span>
                </div>
              )
            })}
          </div>
        )
      }
    }

    if (item.toolName === 'read_files' || item.toolName === 'Read') {
      const argsObj = parseArgs(item.args || '')
      const filePaths = Array.isArray(argsObj.filePaths)
        ? argsObj.filePaths
        : (argsObj.file_path ? [argsObj.file_path] : [])

      if (filePaths.length > 1) {
        return (
          <div className="exe-log-detail-box-mono">
            <div className="exe-log-files-title">Analyzed Files:</div>
            {filePaths.map((pathItem: string, idx: number) => {
              const name = pathItem.split(/[/\\]/).pop() || pathItem
              return (
                <div
                  key={idx}
                  className="exe-log-file-row group/file"
                  onClick={(e) => {
                    e.stopPropagation()
                    onFileClick?.(pathItem)
                  }}
                  title={`点击在右侧打开预览 ${pathItem}`}
                >
                  {getFileIconComponent(name)}
                  <span className="exe-log-file-path-text">{pathItem}</span>
                </div>
              )
            })}
          </div>
        )
      }
    }

    if (item.toolName === 'search' || item.toolName === 'Grep' || item.verb === 'Searched') {
      let parsedSearch: any = null
      try {
        if (item.detail) {
          const rawParsed = JSON.parse(item.detail)
          if (rawParsed.data) {
            parsedSearch = typeof rawParsed.data === 'string' ? JSON.parse(rawParsed.data) : rawParsed.data
          } else {
            parsedSearch = rawParsed
          }
        }
      } catch {}

      if (parsedSearch && Array.isArray(parsedSearch.matches) && parsedSearch.matches.length > 0) {
        return (
          <div className="exe-log-detail-box-mono exe-log-search-container">
            <div className="exe-log-search-title">Search Results ({parsedSearch.matches.length} matches)</div>
            {parsedSearch.matches.map((match: any, idx: number) => {
              const name = match.path?.split(/[/\\]/).pop() || match.path || 'unknown'
              return (
                <div key={idx} className="exe-log-search-item">
                  <div
                    className="exe-log-search-item-header group"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (match.path) onFileClick?.(match.path)
                    }}
                    title="Click to open file"
                  >
                    <span className="exe-log-search-item-icon">{getFileIconComponent(name)}</span>
                    <span className="exe-log-search-item-path">
                      {match.path}{match.line ? `:${match.line}` : ''}
                    </span>
                  </div>
                  {match.text && <div className="exe-log-search-item-text">{match.text.trim()}</div>}
                </div>
              )
            })}
          </div>
        )
      }
    }

    if (item.toolName === 'run_command' || item.toolName === 'Bash' || item.toolName === 'PowerShell' || item.verb === 'Terminal') {
      let cmd = ''
      let cwd = ''
      try {
        const parsed = JSON.parse(item.args || '{}')
        cmd = parsed.commandLine || parsed.command || item.args || ''
        cwd = parsed.cwd || parsed.dir || ''
      } catch {
        cmd = item.args || ''
      }

      return (
        <div className="exe-log-cmd-details-box">
          <div className="exe-log-terminal-screen">
            {cwd && (
              <div className="exe-log-dir-item">
                <FolderIcon folderName={cwd} width={14} height={14} className="exe-log-dir-icon" />
                <span className="exe-log-dir-name truncate">{cwd}</span>
              </div>
            )}
            <div className="exe-log-terminal-cmdline">
              <span className="exe-log-terminal-prompt-char">$</span>
              <span className="exe-log-terminal-command-text">{cmd}</span>
            </div>
          </div>
          {item.detail && (
            <div className="exe-log-terminal-output-container">
              <span className="exe-log-output-label">Output:</span>
              <pre className="exe-log-output-pre">
                {item.detail.length > 2000 ? `${item.detail.slice(0, 2000)}\n...[Output Truncated]` : item.detail}
              </pre>
            </div>
          )}
        </div>
      )
    }

    // AskUserQuestion：展示问题、选项与用户回答
    if (item.toolName === 'AskUserQuestion') {
      let questions: any[] = []
      let answers: Array<{ question: string; answer: string | string[] }> = []
      try {
        const parsedArgs = JSON.parse(item.args || '{}')
        if (Array.isArray(parsedArgs.questions)) questions = parsedArgs.questions
      } catch {}
      try {
        if (item.detail) {
          const parsed = JSON.parse(item.detail)
          if (Array.isArray(parsed)) answers = parsed
        }
      } catch {}

      return (
        <div className="exe-log-ask-detail">
          {questions.map((q: any, qi: number) => {
            const ans = answers.find((a) => a.question === q.question)
            const isIgnored = ans && (ans.answer === '__IGNORED__' || (Array.isArray(ans.answer) && ans.answer.includes('__IGNORED__')))
            const answerArr = ans && !isIgnored
              ? (Array.isArray(ans.answer) ? ans.answer : [ans.answer])
              : []
            return (
              <div key={qi} className="exe-log-ask-item">
                {q.header && <div className="exe-log-ask-header">{q.header}</div>}
                <div className="exe-log-ask-question">{q.question}</div>
                {Array.isArray(q.options) && q.options.length > 0 && (
                  <div className="exe-log-ask-options">
                    {q.options.map((opt: any, oi: number) => {
                      const chosen = answerArr.includes(opt.label)
                      return (
                        <div
                          key={oi}
                          className={`exe-log-ask-option${chosen ? ' chosen' : ''}`}
                        >
                          <span className="exe-log-ask-option-mark" aria-hidden="true">
                            {chosen ? <Check size={12} /> : null}
                          </span>
                          <span className="exe-log-ask-option-label">{opt.label}</span>
                          {opt.description && <span className="exe-log-ask-option-desc">{opt.description}</span>}
                        </div>
                      )
                    })}
                  </div>
                )}
                {/* 回答区 */}
                {ans ? (
                  isIgnored ? (
                    <div className="exe-log-ask-answer is-ignored">
                      <X size={12} />
                      <span>用户忽略了此问题</span>
                    </div>
                  ) : (
                    <div className="exe-log-ask-answer">
                      <MessageCircleQuestion size={12} />
                      <span>用户回答：</span>
                      <span className="exe-log-ask-answer-val">{answerArr.join('、')}</span>
                    </div>
                  )
                ) : item.status === 'running' ? (
                  <div className="exe-log-ask-answer is-pending">
                    <span className="exe-log-ask-pending-dot" />
                    <span>等待用户回答…</span>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )
    }

    // TaskCreate / TaskUpdate
    if (item.toolName === 'TaskCreate' || item.toolName === 'TaskUpdate') {
      let parsedArgs: any = null
      try {
        if (item.args) parsedArgs = JSON.parse(item.args)
      } catch {}

      let parsedResult: any = null
      try {
        if (item.detail) parsedResult = JSON.parse(item.detail)
      } catch {}

      return (
        <div className="exe-log-cmd-details-box">
          {item.toolName === 'TaskCreate' && parsedResult?.data?.created && (
            <div className="exe-log-params-section">
              <span className="exe-log-params-label">Created Tasks:</span>
              <div className="exe-log-params-box">
                {parsedResult.data.created.map((t: any, i: number) => (
                  <div key={i} className="exe-log-param-row">
                    <span className="exe-log-param-key">{t.id}:</span>
                    <span className="exe-log-param-val">{t.subject}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {item.toolName === 'TaskUpdate' && parsedArgs && (
            <div className="exe-log-params-section">
              <span className="exe-log-params-label">Update Request:</span>
              <div className="exe-log-params-box">
                {Object.entries(parsedArgs).map(([k, v]) => (
                  <div key={k} className="exe-log-param-row">
                    <span className="exe-log-param-key">{k}:</span>
                    <span className="exe-log-param-val">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {parsedResult?.data?.summary && (
            <div className="exe-log-params-output-container">
              <span className="exe-log-output-label">Current Progress:</span>
              <pre className="exe-log-output-pre" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {parsedResult.data.summary}
              </pre>
            </div>
          )}
        </div>
      )
    }

    let parsedArgs: any = null
    try {
      if (item.args) {
        parsedArgs = JSON.parse(item.args)
      }
    } catch {}

    return (
      <div className="exe-log-cmd-details-box">
        {item.args && (
          <div className="exe-log-params-section">
            <span className="exe-log-params-label">Parameters:</span>
            {parsedArgs && typeof parsedArgs === 'object' ? (
              <div className="exe-log-params-box">
                {Object.entries(parsedArgs).map(([k, v]) => (
                  <div key={k} className="exe-log-param-row">
                    <span className="exe-log-param-key">{k}:</span>
                    <span className="exe-log-param-val">
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span className="exe-log-param-args">{item.args}</span>
            )}
          </div>
        )}
        {item.detail && (
          <div className="exe-log-params-output-container">
            <span className="exe-log-output-label">Output:</span>
            <pre className="exe-log-output-pre">
              {item.detail.length > 1500 ? `${item.detail.slice(0, 1500)}\n...内容已截断` : item.detail}
            </pre>
          </div>
        )}
      </div>
    )
  }

  if (item.type === 'command') {
    return (
      <div className="exe-log-cmd-raw-output">
        <pre className="whitespace-pre-wrap break-all leading-relaxed">
          {item.detail && item.detail.length > 2000 ? `${item.detail.slice(0, 2000)}\n...[Output Truncated]` : item.detail}
        </pre>
      </div>
    )
  }

  return null
}
