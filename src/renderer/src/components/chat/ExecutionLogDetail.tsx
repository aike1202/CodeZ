import React from 'react'
import {
  type UnifiedTimelineItem,
  getFileIconComponent
} from './ExecutionLogUtils'
import { FolderIcon } from '../svg-icons'
import { parseArgs } from '../../utils/parseArgs'

interface ExecutionLogDetailProps {
  item: UnifiedTimelineItem
  onFileClick?: (filePath: string, virtualContent?: string) => void
}

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
                return <div key={idx} className="pl-2">{line}</div>
              }

              const name = line.replace(/^\[(DIR|FILE)\]\s*/u, '')
              return (
                <div key={idx} className="exe-log-dir-row">
                  {isDir ? <FolderIcon /> : getFileIconComponent(name)}
                  <span>{name}</span>
                </div>
              )
            })}
          </div>
        )
      }
    }

    if (item.toolName === 'read_files') {
      const argsObj = parseArgs(item.args || '')
      const filePaths = Array.isArray(argsObj.filePaths) ? argsObj.filePaths : []
      
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
                <div className="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-zinc-800/80">
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
              {parsed.tree && typeof parsed.tree === 'string' && (
                <div className="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-zinc-800/80">
                  <div className="exe-log-snapshot-sub-title">项目目录结构 (Depth: 3)</div>
                  <div className="exe-log-tree-box">
                    {parsed.tree.split('\n').map((line: string, idx: number) => {
                      const isDir = line.includes('[DIR]')
                      const isFile = line.includes('[FILE]')
                      if (!isDir && !isFile) {
                        return <div key={idx} className="exe-log-tree-line-indent">{line}</div>
                      }

                      const match = line.match(/^(\s*)\[(?:DIR|FILE)\]\s*(.*)/u)
                      if (!match) return <div key={idx} className="pl-1">{line}</div>

                      const indent = match[1].length
                      const name = match[2]
                      const pl = `${indent * 6 + 4}px`

                      return (
                        <div key={idx} style={{ paddingLeft: pl }} className="exe-log-tree-row">
                          {isDir ? <FolderIcon /> : getFileIconComponent(name)}
                          <span className="truncate">{name}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        }
      } catch {
        // fail safe to fallback
      }
    }

    if (item.toolName === 'run_command' || item.verb === 'Terminal') {
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
              <div className="exe-log-terminal-cwd">
                <FolderIcon />
                <span className="truncate">{cwd}</span>
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
    } catch {
      // fail safe
    }

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
