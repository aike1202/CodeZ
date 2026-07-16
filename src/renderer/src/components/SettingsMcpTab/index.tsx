import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  Braces,
  ChevronRight,
  Database,
  LockKeyhole,
  MessageSquareText,
  PlugZap,
  Search,
  Server,
  Wrench
} from 'lucide-react'
import Button from '../ui/Button'
import Switch from '../ui/Switch'
import McpJsonEditor from './McpJsonEditor'
import McpServerDetailModal from './McpServerDetailModal'
import type { McpListPayload, McpServerStatus, ScopedMcpConfig } from './types'
import {
  MCP_SCOPE_LABELS,
  parseUserConfiguration,
  serializeUserConfiguration,
  serverDescription,
  stateLabel
} from './utils'
import './SettingsMcpTab.css'

function effectiveServerKey(config: ScopedMcpConfig): string {
  return `${config.scope}:${config.name}`
}

export default function SettingsMcpTab(): React.ReactElement {
  const [configs, setConfigs] = useState<ScopedMcpConfig[]>([])
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [jsonText, setJsonText] = useState('{\n  "mcpServers": {}\n}')
  const [savedJsonText, setSavedJsonText] = useState('{\n  "mcpServers": {}\n}')
  const [jsonOpen, setJsonOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string>()
  const [busyServer, setBusyServer] = useState<string>()
  const [editorBusy, setEditorBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const deferredQuery = useDeferredValue(query)

  const applyPayload = useCallback((payload: McpListPayload, resetJson: boolean) => {
    setConfigs(payload.configs)
    setStatuses(payload.statuses)
    if (resetJson) {
      const serialized = serializeUserConfiguration(payload.configs)
      setJsonText(serialized)
      setSavedJsonText(serialized)
    }
  }, [])

  useEffect(() => {
    let active = true
    window.api.mcp.list().then((payload: McpListPayload) => {
      if (!active) return
      applyPayload(payload, true)
      if (!payload.configs.some((config) => config.effective)) setJsonOpen(true)
    }).catch((cause: unknown) => {
      if (active) setActionError(cause instanceof Error ? cause.message : String(cause))
    })
    const dispose = window.api.mcp.onChanged((next: McpServerStatus[]) => {
      if (active) setStatuses(next)
    })
    return () => {
      active = false
      dispose()
    }
  }, [applyPayload])

  const parsedJson = useMemo(() => {
    try {
      return { servers: parseUserConfiguration(jsonText), error: '' }
    } catch (cause) {
      return { servers: {}, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }, [jsonText])

  const statusByName = useMemo(() => new Map(statuses.map((status) => [status.name, status])), [statuses])
  const effectiveConfigs = useMemo(() => configs.filter((config) => config.effective), [configs])
  const filteredConfigs = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    if (!normalized) return effectiveConfigs
    return effectiveConfigs.filter((config) => {
      const status = statusByName.get(config.name)
      return `${config.name} ${serverDescription(config, status)} ${config.config.type} ${stateLabel(status?.state)}`
        .toLowerCase()
        .includes(normalized)
    })
  }, [deferredQuery, effectiveConfigs, statusByName])

  const selectedConfig = selectedKey ? configs.find((config) => effectiveServerKey(config) === selectedKey) : undefined
  const selectedStatus = selectedConfig ? statusByName.get(selectedConfig.name) : undefined
  const dirty = jsonText !== savedJsonText
  const connectedCount = statuses.filter((status) => status.state === 'connected').length
  const enabledCount = effectiveConfigs.filter((config) => config.config.enabled !== false && !config.policyDisabled).length

  const handleCloseJson = () => {
    if (dirty && !window.confirm('放弃尚未保存的 MCP JSON 修改？')) return
    setJsonText(savedJsonText)
    setActionError('')
    setJsonOpen(false)
  }

  const handleCloseDetail = useCallback(() => setSelectedKey(undefined), [])

  const handleFormat = () => {
    try {
      const servers = parseUserConfiguration(jsonText)
      setJsonText(JSON.stringify({ mcpServers: servers }, null, 2))
      setActionError('')
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handlePaste = async () => {
    try {
      setJsonText(await navigator.clipboard.readText())
      setActionError('')
    } catch (cause) {
      setActionError(`无法读取剪贴板：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonText)
      setActionError('')
    } catch (cause) {
      setActionError(`复制失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const handleSaveJson = async () => {
    setActionError('')
    let servers
    try {
      servers = parseUserConfiguration(jsonText)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    setEditorBusy(true)
    try {
      const payload = await window.api.mcp.saveUser(servers) as McpListPayload
      applyPayload(payload, true)
      setJsonOpen(false)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setEditorBusy(false)
    }
  }

  const handleToggle = async (config: ScopedMcpConfig, enabled: boolean) => {
    if (config.scope !== 'user' || !config.effective || config.policyDisabled) return
    setBusyServer(config.name)
    setActionError('')
    try {
      const payload = await window.api.mcp.setEnabled(config.name, enabled) as McpListPayload
      applyPayload(payload, true)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyServer(undefined)
    }
  }

  const runServerAction = async (config: ScopedMcpConfig, action: () => Promise<void>) => {
    setBusyServer(config.name)
    setActionError('')
    try {
      await action()
      applyPayload(await window.api.mcp.list(), false)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyServer(undefined)
    }
  }

  if (jsonOpen) {
    return (
      <div className="mcp-settings mcp-settings-editor-mode">
        <McpJsonEditor
          value={jsonText}
          error={parsedJson.error || actionError}
          dirty={dirty}
          busy={editorBusy}
          serverCount={Object.keys(parsedJson.servers).length}
          onChange={(value) => { setJsonText(value); setActionError('') }}
          onClose={handleCloseJson}
          onFormat={handleFormat}
          onPaste={handlePaste}
          onCopy={handleCopy}
          onSave={handleSaveJson}
        />
      </div>
    )
  }

  return (
    <div className="mcp-settings">
      <header className="mcp-page-header">
        <div>
          <h1>MCP Servers</h1>
          <p>通过 JSON 管理配置，在这里控制连接并检查 Server 能力。</p>
        </div>
        <div className="mcp-page-header-actions">
          <span className="mcp-summary"><strong>{connectedCount}</strong> 已连接 <i /> <strong>{enabledCount}</strong> 已启用</span>
          <Button type="primary" icon={<Braces size={16} />} onClick={() => setJsonOpen(true)}>编辑 JSON</Button>
        </div>
      </header>

      <div className="mcp-list-toolbar">
        <label className="mcp-search-field">
          <Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、描述或状态" aria-label="搜索 MCP Servers" />
        </label>
        <span>{filteredConfigs.length} 个 Server</span>
      </div>

      {actionError ? <div className="mcp-page-error" role="alert">{actionError}</div> : null}

      <main className="mcp-server-table" aria-label="MCP Server 列表">
        {filteredConfigs.map((config) => {
          const status = statusByName.get(config.name)
          const enabled = config.config.enabled !== false && !config.policyDisabled
          const canToggle = config.scope === 'user' && config.effective && !config.policyDisabled
          const isBusy = busyServer === config.name
          return (
            <article className={`mcp-server-item ${enabled ? '' : 'is-disabled'}`} key={effectiveServerKey(config)}>
              <button className="mcp-server-open" onClick={() => setSelectedKey(effectiveServerKey(config))}>
                <span className="mcp-server-icon" aria-hidden="true"><Server size={19} /></span>
                <span className="mcp-server-primary">
                  <span className="mcp-server-name-line">
                    <strong>{config.name}</strong>
                    <span className={`mcp-status is-${status?.state || (enabled ? 'stopped' : 'disabled')}`}>
                      <span className="mcp-status-dot" />{stateLabel(status?.state || (enabled ? 'stopped' : 'disabled'))}
                    </span>
                  </span>
                  <small>{serverDescription(config, status)}</small>
                </span>
                <span className="mcp-server-source">
                  <b>{config.config.type}</b>
                  <small>{MCP_SCOPE_LABELS[config.scope]}</small>
                </span>
                <span className="mcp-server-capabilities">
                  <span title={`${status?.toolCount || 0} 个工具`}><Wrench size={14} />{status?.toolCount || 0}</span>
                  <span title={`${status?.resourceCount || 0} 个资源`}><Database size={14} />{status?.resourceCount || 0}</span>
                  <span title={`${status?.promptCount || 0} 个 Prompts`}><MessageSquareText size={14} />{status?.promptCount || 0}</span>
                </span>
                <ChevronRight className="mcp-server-chevron" size={17} aria-hidden="true" />
              </button>
              <div className="mcp-server-toggle" title={canToggle ? `${enabled ? '停用' : '启用'} ${config.name}` : '此配置来源只读，请编辑对应的 JSON 文件'}>
                {!canToggle ? <LockKeyhole size={14} aria-hidden="true" /> : <PlugZap size={14} aria-hidden="true" />}
                <Switch
                  checked={enabled}
                  onChange={(next) => void handleToggle(config, next)}
                  disabled={!canToggle || isBusy}
                  ariaLabel={`${enabled ? '停用' : '启用'} ${config.name}`}
                />
              </div>
            </article>
          )
        })}

        {!effectiveConfigs.length ? (
          <div className="mcp-list-empty">
            <Braces size={30} aria-hidden="true" />
            <h2>尚未配置 MCP Server</h2>
            <Button type="primary" icon={<Braces size={16} />} onClick={() => setJsonOpen(true)}>粘贴 MCP JSON</Button>
          </div>
        ) : !filteredConfigs.length ? (
          <div className="mcp-list-empty compact"><Search size={24} aria-hidden="true" /><p>没有匹配的 MCP Server。</p></div>
        ) : null}
      </main>

      {selectedConfig ? (
        <McpServerDetailModal
          config={selectedConfig}
          status={selectedStatus}
          busy={busyServer === selectedConfig.name}
          onClose={handleCloseDetail}
          onToggle={(enabled) => void handleToggle(selectedConfig, enabled)}
          onReconnect={() => void runServerAction(selectedConfig, () => window.api.mcp.reconnect(selectedConfig.name))}
          onAuthorize={() => void runServerAction(selectedConfig, () => window.api.mcp.authorize(selectedConfig.name))}
          onLogout={() => void runServerAction(selectedConfig, () => window.api.mcp.logout(selectedConfig.name))}
        />
      ) : null}
    </div>
  )
}
