import React, { useEffect, useMemo, useState } from 'react'
import { IconAdd, IconServer, IconTrash } from '../Icons'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Select from '../ui/Select'
import './SettingsMcpTab.css'

type Transport = 'stdio' | 'http' | 'sse'
interface ServerConfig {
  type: Transport
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  alwaysLoadTools?: string[]
  samplingPolicy?: 'deny' | 'ask' | 'allow'
  elicitationPolicy?: 'deny' | 'ask' | 'allow'
  samplingMaxTokens?: number
  instructionsPolicy?: 'ignore' | 'tool-hints' | 'approved'
  resourceSubscriptions?: boolean
}
interface ScopedConfig {
  name: string
  scope: 'managed' | 'user' | 'project' | 'local' | 'dynamic'
  config: ServerConfig
  fingerprint: string
  trusted: boolean
  effective: boolean
  shadowedBy?: ScopedConfig['scope']
  policyDisabled?: boolean
}
interface ServerStatus {
  name: string
  state: string
  transport: Transport
  toolCount: number
  resourceCount: number
  promptCount: number
  capabilities?: Record<string, unknown>
  serverInfo?: { name: string; version: string; title?: string }
  error?: { code: string; message: string }
  logs: Array<{ timestamp: string; level: string; message: string }>
}

const emptyConfig = (): ServerConfig => ({ type: 'stdio', enabled: true, command: '', args: [] })

export default function SettingsMcpTab(): React.ReactElement {
  const [configs, setConfigs] = useState<ScopedConfig[]>([])
  const [statuses, setStatuses] = useState<ServerStatus[]>([])
  const [selected, setSelected] = useState<string>('new')
  const [originalName, setOriginalName] = useState<string>()
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<ServerConfig>(emptyConfig())
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [secretKeys, setSecretKeys] = useState<string[]>([])
  const [secretKey, setSecretKey] = useState('')
  const [secretValue, setSecretValue] = useState('')

  const refresh = async () => {
    const payload = await window.api.mcp.list()
    setConfigs(payload.configs)
    setStatuses(payload.statuses)
    setSecretKeys(await window.api.mcp.listSecretKeys().catch(() => []))
  }

  useEffect(() => {
    void refresh()
    return window.api.mcp.onChanged(setStatuses)
  }, [])

  const selectedConfig = configs.find((config) => `${config.scope}:${config.name}` === selected)
  const selectedStatus = statuses.find((status) => status.name === selectedConfig?.name || status.name === name)
  const userConfigs = useMemo(() => configs.filter((config) => config.scope === 'user'), [configs])

  const selectConfig = (config?: ScopedConfig) => {
    if (!config) {
      setSelected('new'); setOriginalName(undefined); setName(''); setDraft(emptyConfig()); setArgsText(''); setEnvText(''); setError('')
      return
    }
    setSelected(`${config.scope}:${config.name}`)
    setOriginalName(config.name)
    setName(config.name)
    setDraft({ ...config.config })
    setArgsText((config.config.args || []).join('\n'))
    setEnvText(JSON.stringify(config.config.type === 'stdio' ? config.config.env || {} : config.config.headers || {}, null, 2))
    setError('')
  }

  const save = async () => {
    setError('')
    if (!name.trim()) { setError('请输入 server 名称。'); return }
    try {
      const keyValues = envText.trim() ? JSON.parse(envText) : {}
      const config: ServerConfig = draft.type === 'stdio'
        ? { ...draft, command: draft.command?.trim(), args: argsText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean), env: keyValues }
        : { ...draft, url: draft.url?.trim(), headers: keyValues }
      const servers = Object.fromEntries(userConfigs.map((item) => [item.name, item.config]))
      if (originalName && originalName !== name.trim()) delete servers[originalName]
      servers[name.trim()] = config
      setBusy(true)
      const payload = await window.api.mcp.saveUser(servers)
      setConfigs(payload.configs); setStatuses(payload.statuses)
      setOriginalName(name.trim()); setSelected(`user:${name.trim()}`)
    } catch (cause: any) {
      setError(cause?.message || String(cause))
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!originalName) return
    const servers = Object.fromEntries(userConfigs.filter((item) => item.name !== originalName).map((item) => [item.name, item.config]))
    setBusy(true)
    try { await window.api.mcp.saveUser(servers); selectConfig(); await refresh() } finally { setBusy(false) }
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refresh() } catch (cause: any) { setError(cause?.message || String(cause)) } finally { setBusy(false) }
  }

  const saveSecret = async () => {
    if (!secretKey.trim() || !secretValue) { setError('请输入 secret key 和值。'); return }
    await run(async () => {
      setSecretKeys(await window.api.mcp.setSecret(secretKey.trim(), secretValue))
      setSecretValue('')
    })
  }

  return (
    <div className="mcp-settings">
      <aside className="mcp-server-list">
        <div className="mcp-list-header">
          <div><h1>MCP</h1><p>管理外部工具、资源与 prompts。</p></div>
          <Button variant="icon" title="添加 MCP server" aria-label="添加 MCP server" icon={<IconAdd />} onClick={() => selectConfig()} />
        </div>
        <div className="mcp-list-body">
          {configs.map((config) => {
            const status = statuses.find((item) => item.name === config.name)
            return (
              <button key={`${config.scope}:${config.name}`} className={`mcp-server-row ${selected === `${config.scope}:${config.name}` ? 'active' : ''}`} onClick={() => selectConfig(config)}>
                <IconServer />
                <span className="mcp-server-copy"><strong>{config.name}</strong><small>{config.scope} · {config.config.type}{!config.effective ? ` · 被 ${config.shadowedBy} 覆盖` : ''}{config.policyDisabled ? ' · 策略禁用' : ''}</small></span>
                <span className={`mcp-state-dot is-${status?.state || 'stopped'}`} title={status?.state || 'stopped'} />
              </button>
            )
          })}
          {configs.length === 0 && <div className="mcp-empty-list">尚未配置 server</div>}
        </div>
      </aside>

      <main className="mcp-editor">
        <header className="mcp-editor-header">
          <div><h2>{selectedConfig?.scope === 'project' ? selectedConfig.name : originalName || '添加 MCP server'}</h2><p>{selectedStatus?.state || '尚未连接'}</p></div>
          <div className="mcp-header-actions">
            {selectedConfig?.scope === 'user' && <Button danger variant="icon" title="删除 server" aria-label="删除 server" icon={<IconTrash />} onClick={remove} disabled={busy} />}
            {selectedStatus && <Button onClick={() => run(() => window.api.mcp.reconnect(selectedStatus.name))} disabled={busy}>重连</Button>}
            {selectedStatus?.state === 'needs-auth' && <Button type="primary" onClick={() => run(() => window.api.mcp.authorize(selectedStatus.name))} disabled={busy}>认证</Button>}
            {selectedStatus?.state === 'connected' && selectedConfig?.config.type !== 'stdio' && <Button onClick={() => run(() => window.api.mcp.logout(selectedStatus.name))} disabled={busy}>退出认证</Button>}
          </div>
        </header>

        {selectedConfig && selectedConfig.scope !== 'user' ? (
          <section className="mcp-section">
            <h3>{selectedConfig.scope} 配置</h3>
            <p className="mcp-trust-copy">此配置由 {selectedConfig.scope} scope 提供，在此页面只读。{selectedConfig.shadowedBy ? `当前被 ${selectedConfig.shadowedBy} scope 覆盖。` : ''}</p>
            <pre className="mcp-readonly-config">{JSON.stringify(selectedConfig.config, null, 2)}</pre>
            <code className="mcp-fingerprint">{selectedConfig.fingerprint}</code>
            {selectedConfig.scope === 'project' && !selectedConfig.trusted && <Button type="primary" onClick={() => run(() => window.api.mcp.trustProject(selectedConfig.fingerprint))}>信任此配置</Button>}
          </section>
        ) : (
          <section className="mcp-section mcp-form">
            <div className="mcp-field"><label>名称</label><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="github" /></div>
            <div className="mcp-field"><label>Transport</label><Select value={draft.type} onChange={(event) => setDraft({ ...emptyConfig(), type: event.target.value as Transport })}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option><option value="sse">legacy SSE</option></Select></div>
            {draft.type === 'stdio' ? <>
              <div className="mcp-field"><label>命令</label><Input value={draft.command || ''} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></div>
              <div className="mcp-field"><label>参数（每行一个）</label><textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} /></div>
              <div className="mcp-field"><label>工作目录</label><Input value={draft.cwd || ''} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="留空使用当前工作区" /></div>
              <div className="mcp-field"><label>环境变量 JSON</label><textarea value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'{\n  "TOKEN": "${env:MCP_TOKEN}"\n}'} /></div>
            </> : <>
              <div className="mcp-field"><label>URL</label><Input value={draft.url || ''} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></div>
              <div className="mcp-field"><label>Headers JSON</label><textarea value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'{\n  "Authorization": "Bearer ${env:MCP_TOKEN}"\n}'} /></div>
            </>}
            <label className="mcp-check"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用 server</label>
            <div className="mcp-field"><label>Sampling</label><Select value={draft.samplingPolicy || 'deny'} onChange={(event) => setDraft({ ...draft, samplingPolicy: event.target.value as ServerConfig['samplingPolicy'] })}><option value="deny">拒绝</option><option value="ask">每次询问</option><option value="allow">允许</option></Select></div>
            <div className="mcp-field"><label>Sampling 最大 tokens</label><Input type="number" min={1} max={16384} value={String(draft.samplingMaxTokens || 4096)} onChange={(event) => setDraft({ ...draft, samplingMaxTokens: Number(event.target.value) || 4096 })} /></div>
            <div className="mcp-field"><label>Elicitation</label><Select value={draft.elicitationPolicy || 'deny'} onChange={(event) => setDraft({ ...draft, elicitationPolicy: event.target.value as ServerConfig['elicitationPolicy'] })}><option value="deny">拒绝</option><option value="ask">每次询问</option><option value="allow">允许 URL</option></Select></div>
            <div className="mcp-field"><label>Server instructions</label><Select value={draft.instructionsPolicy || 'ignore'} onChange={(event) => setDraft({ ...draft, instructionsPolicy: event.target.value as ServerConfig['instructionsPolicy'] })}><option value="ignore">忽略</option><option value="tool-hints">作为外部工具提示</option><option value="approved">已批准的外部说明</option></Select></div>
            <label className="mcp-check"><input type="checkbox" checked={draft.resourceSubscriptions === true} onChange={(event) => setDraft({ ...draft, resourceSubscriptions: event.target.checked })} />允许 resource subscription</label>
            {error && <div className="mcp-error">{error}</div>}
            <div><Button type="primary" onClick={save} loading={busy}>保存并连接</Button></div>
          </section>
        )}

        {selectedStatus && <section className="mcp-section">
          <h3>运行状态</h3>
          <div className="mcp-metrics"><span><strong>{selectedStatus.toolCount}</strong> 工具</span><span><strong>{selectedStatus.resourceCount}</strong> 资源</span><span><strong>{selectedStatus.promptCount}</strong> prompts</span></div>
          {selectedStatus.serverInfo && <p className="mcp-trust-copy">{selectedStatus.serverInfo.title || selectedStatus.serverInfo.name} · {selectedStatus.serverInfo.version} · capabilities: {Object.keys(selectedStatus.capabilities || {}).join(', ') || 'none'}</p>}
          {selectedStatus.error && <div className="mcp-error"><strong>{selectedStatus.error.code}</strong><br />{selectedStatus.error.message}</div>}
          <h3 className="mcp-log-title">诊断日志</h3>
          <div className="mcp-logs">{selectedStatus.logs.slice(-30).map((entry, index) => <div key={`${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><b>{entry.level}</b><span>{entry.message}</span></div>)}</div>
        </section>}

        <section className="mcp-section mcp-form">
          <h3>安全凭据</h3>
          <p className="mcp-trust-copy">配置中使用 <code>{'${secret:key}'}</code> 引用。值仅写入系统安全存储，不会返回 renderer。</p>
          <div className="mcp-field"><label>Secret key</label><Input value={secretKey} onChange={(event) => setSecretKey(event.target.value)} placeholder="github.token" /></div>
          <div className="mcp-field"><label>Secret value</label><Input type="password" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} /></div>
          <div><Button type="primary" onClick={saveSecret} disabled={busy}>写入安全存储</Button></div>
          <div className="mcp-secret-list">{secretKeys.map((key) => <div key={key}><code>{key}</code><Button danger onClick={() => run(async () => setSecretKeys(await window.api.mcp.deleteSecret(key)))} disabled={busy}>删除</Button></div>)}</div>
        </section>
      </main>
    </div>
  )
}
