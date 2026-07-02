import React from 'react'
import { getFileIconComponent } from '../ExecutionLog/utils'
import { FolderIcon } from '@react-symbols/icons/utils'
import { parseArgs } from '../../../utils/parseArgs'
import type { ExecutionLogDetailProps } from './types'

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
      const lines = item.detail ? item.detail.split('\n') : []
      const hasTree = lines.some((l) => l.startsWith('[DIR]') || l.startsWith('[FILE]'))

      if (hasTree) {
        return (
          <div className="exe-log-detail-box-mono">
            {lines.map((line, idx) => {
              const isDir = line.startsWith('[DIR]')
              const isFile = line.startsWith('[FILE]')
              if (!isDir && !isFile) {
                if (!line.trim()) return null

                const dirMatch = line.match(/^={2,}\s*Directory:\s*(.+?)\s*={2,}$/)
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

              const name = line.replace(/^\[(DIR|FILE)\]\s*/u, '')
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

    if (item.toolName === 'get_project_snapshot') {
      try {
        const parsed = item.detail ? JSON.parse(item.detail) : null
        if (parsed && typeof parsed === 'object') {
          return (
            <div className="exe-log-snapshot-box">
              <div className="exe-log-snapshot-grid">
                <span className="exe-log-snapshot-label">项目名称</span>
                <span className="exe-log-snapshot-val">{parsed.rootName || '-'}</span>

                <span className="exe-log-snapshot-label">项目类型</span>
                <span className="exe-log-snapshot-val">{parsed.projectType || '-'}</span>

                <span className="exe-log-snapshot-label">包管理器</span>
                <span className="exe-log-snapshot-val">{parsed.packageManager || '-'}</span>

                {parsed.rootPath && (
                  <>
                    <span className="exe-log-snapshot-label">根目录</span>
                    <span className="exe-log-snapshot-val">{parsed.rootPath}</span>
                  </>
                )}
              </div>
              {parsed.scripts && typeof parsed.scripts === 'object' && Object.keys(parsed.scripts).length > 0 && (
                <div className="exe-log-divider">
                  <div className="exe-log-snapshot-sub-title">项目内置脚本</div>
                  <div className="exe-log-snapshot-scripts">
                    {Object.entries(parsed.scripts).map(([key, cmd]) => (
                      <div key={key} className="exe-log-script-item" title={String(cmd)}>
                        <span className="exe-log-script-key">{key}:</span>
                        <span className="exe-log-script-val">{String(cmd)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        }
      } catch {}
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
