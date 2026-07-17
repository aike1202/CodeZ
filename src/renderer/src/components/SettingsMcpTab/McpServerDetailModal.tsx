import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Braces,
  Bell,
  BellOff,
  Database,
  Eye,
  FileText,
  KeyRound,
  MessageSquareText,
  Play,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import Button from '../ui/Button'
import Switch from '../ui/Switch'
import { desktopApi } from '../../shared/desktop'
import type {
  McpPromptCatalogItem,
  McpPromptGetResult,
  McpResourceReadResult,
  McpServerCatalog,
  McpServerStatus,
  McpToolCatalogItem,
  ScopedMcpConfig
} from './types'
import { configEndpoint, MCP_SCOPE_LABELS, serverDescription, stateLabel } from './utils'

type DetailTab = 'tools' | 'resources' | 'prompts' | 'connection' | 'logs'
type ServerAction = 'reconnect' | 'trust' | 'authorize' | 'logout'

interface Props {
  config: ScopedMcpConfig
  status?: McpServerStatus
  busy: boolean
  busyAction?: ServerAction
  actionError: string
  workspaceRoot: string | null
  onClose: () => void
  onToggle: (enabled: boolean) => void
  onReconnect: () => void
  onTrust: () => void
  onAuthorize: () => void
  onLogout: () => void
}

interface SchemaParameter {
  name: string
  type: string
  required: boolean
  description?: string
  detail?: string
}

const EMPTY_CATALOG: McpServerCatalog = {
  server: '',
  tools: [],
  resources: [],
  prompts: [],
  stale: true
}

function schemaType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.enum)) return 'enum'
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((item) =>
    item && typeof item === 'object' ? schemaType(item as Record<string, unknown>) : 'unknown'
  ).join(' | ')
  return 'unknown'
}

function schemaParameters(tool?: McpToolCatalogItem): SchemaParameter[] {
  const properties = tool?.inputSchema?.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return []
  const required = new Set(Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.map(String) : [])
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const schema = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const details: string[] = []
    if (Array.isArray(schema.enum)) details.push(`可选值：${schema.enum.map(String).join(', ')}`)
    if (schema.default !== undefined) details.push(`默认值：${String(schema.default)}`)
    return {
      name,
      type: schemaType(schema),
      required: required.has(name),
      description: typeof schema.description === 'string' ? schema.description : undefined,
      detail: details.join(' · ') || undefined
    }
  })
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hasAttribute('hidden'))
}

interface PromptDetailProps {
  prompt: McpPromptCatalogItem
  arguments_: Record<string, string>
  busy: boolean
  onArgumentChange: (name: string, value: string) => void
  onResolve: () => void
}

function PromptDetail({
  prompt,
  arguments_,
  busy,
  onArgumentChange,
  onResolve
}: PromptDetailProps): React.ReactElement {
  return (
    <div className="mcp-catalog-detail">
      <h3>{prompt.name}</h3>
      <p>{prompt.description || '此 Prompt 未提供描述。'}</p>
      <h4>参数</h4>
      {prompt.arguments?.length ? (
        <div className="mcp-parameter-list">
          {prompt.arguments.map((argument) => (
            <div className="mcp-parameter-row" key={argument.name}>
              <code>{argument.name}</code>
              <span>{argument.required ? '必填' : '可选'}</span>
              <p>{argument.description || '未提供描述'}</p>
              <input
                value={arguments_[argument.name] || ''}
                onChange={(event) => onArgumentChange(argument.name, event.target.value)}
                aria-label={`${prompt.name} ${argument.name}`}
              />
            </div>
          ))}
        </div>
      ) : <div className="mcp-detail-empty">此 Prompt 不需要参数。</div>}
      <Button type="primary" icon={<Play size={15} />} onClick={onResolve} disabled={busy}>
        获取 Prompt
      </Button>
    </div>
  )
}

export default function McpServerDetailModal({
  config,
  status,
  busy,
  busyAction,
  actionError,
  workspaceRoot,
  onClose,
  onToggle,
  onReconnect,
  onTrust,
  onAuthorize,
  onLogout
}: Props): React.ReactElement {
  const [tab, setTab] = useState<DetailTab>('tools')
  const [catalog, setCatalog] = useState<McpServerCatalog>(EMPTY_CATALOG)
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedTool, setSelectedTool] = useState('')
  const [selectedPrompt, setSelectedPrompt] = useState('')
  const [promptArguments, setPromptArguments] = useState<Record<string, string>>({})
  const [templateUris, setTemplateUris] = useState<Record<string, string>>({})
  const [resourceResult, setResourceResult] = useState<McpResourceReadResult | null>(null)
  const [promptResult, setPromptResult] = useState<McpPromptGetResult | null>(null)
  const [interactionError, setInteractionError] = useState('')
  const [subscriptionError, setSubscriptionError] = useState('')
  const [readingResource, setReadingResource] = useState(false)
  const [resolvingPrompt, setResolvingPrompt] = useState(false)
  const [subscribedUris, setSubscribedUris] = useState<string[]>([])
  const [subscriptionBusyUri, setSubscriptionBusyUri] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const subscriptionsRef = useRef(new Set<string>())
  const subscriptionScopeRef = useRef('')

  useEffect(() => {
    let active = true
    setCatalogError('')
    setInteractionError('')
    setSubscriptionError('')
    setResourceResult(null)
    setPromptResult(null)
    setPromptArguments({})
    setTemplateUris({})
    desktopApi.mcp.getCatalog(config.name, workspaceRoot).then((next: McpServerCatalog) => {
      if (!active) return
      setCatalog(next)
      setSelectedTool((current) => current || next.tools[0]?.name || '')
      setSelectedPrompt((current) => current || next.prompts[0]?.name || '')
    }).catch((cause: unknown) => {
      if (active) setCatalogError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [config.name, status?.updatedAt, workspaceRoot])

  useEffect(() => {
    const scope = `${config.name}\u0000${workspaceRoot || ''}`
    subscriptionScopeRef.current = scope
    setSubscribedUris([])
    subscriptionsRef.current.clear()
    return () => {
      if (subscriptionScopeRef.current === scope) subscriptionScopeRef.current = ''
      const uris = [...subscriptionsRef.current]
      subscriptionsRef.current.clear()
      if (!uris.length) return
      void Promise.allSettled(
        uris.map((uri) => desktopApi.mcp.unsubscribeResource(config.name, uri, workspaceRoot))
      )
    }
  }, [config.name, workspaceRoot])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = focusableElements(dialogRef.current)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previous?.focus()
    }
  }, [onClose])

  const filteredTools = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase()
    if (!normalized) return catalog.tools
    return catalog.tools.filter((tool) => `${tool.name} ${tool.title || ''} ${tool.description || ''}`.toLowerCase().includes(normalized))
  }, [catalog.tools, deferredQuery])

  const currentTool = filteredTools.find((tool) => tool.name === selectedTool) || filteredTools[0]
  const currentPrompt = catalog.prompts.find((prompt) => prompt.name === selectedPrompt) || catalog.prompts[0]
  const parameters = useMemo(() => schemaParameters(currentTool), [currentTool])
  const enabled = config.config.enabled !== false && !config.policyDisabled
  const canToggle = config.scope === 'user' && config.effective && !config.policyDisabled
  const description = serverDescription(config, status)
  const canReadResources = status?.state === 'connected'
  const supportsOAuth = config.config.type !== 'stdio' && Boolean(config.config.oauth)
  const missingProjectWorkspace = config.scope === 'project' && !workspaceRoot
  const authorizing = busyAction === 'authorize'
  const loggingOut = busyAction === 'logout'
  const canManageSubscriptions = config.config.resourceSubscriptions === true
    && canReadResources
    && !missingProjectWorkspace

  const readResource = async (uri: string) => {
    setReadingResource(true)
    setInteractionError('')
    try {
      setResourceResult(await desktopApi.mcp.readResource(config.name, uri, workspaceRoot))
    } catch (cause) {
      setInteractionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReadingResource(false)
    }
  }

  const resolvePrompt = async () => {
    if (!currentPrompt) return
    const arguments_ = Object.fromEntries(
      Object.entries(promptArguments).filter(([, value]) => value.trim().length > 0)
    )
    setResolvingPrompt(true)
    setInteractionError('')
    try {
      setPromptResult(await desktopApi.mcp.getPrompt(config.name, currentPrompt.name, arguments_, workspaceRoot))
    } catch (cause) {
      setInteractionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setResolvingPrompt(false)
    }
  }

  const toggleResourceSubscription = async (uri: string) => {
    if (!canManageSubscriptions || subscriptionBusyUri || !uri) return
    const subscribed = subscriptionsRef.current.has(uri)
    const scope = subscriptionScopeRef.current
    const serverName = config.name
    const root = workspaceRoot
    setSubscriptionBusyUri(uri)
    setSubscriptionError('')
    try {
      if (subscribed) {
        await desktopApi.mcp.unsubscribeResource(serverName, uri, root)
        if (subscriptionScopeRef.current !== scope) return
        subscriptionsRef.current.delete(uri)
      } else {
        await desktopApi.mcp.subscribeResource(serverName, uri, root)
        if (subscriptionScopeRef.current !== scope) {
          void desktopApi.mcp.unsubscribeResource(serverName, uri, root).catch(() => undefined)
          return
        }
        subscriptionsRef.current.add(uri)
      }
      setSubscribedUris([...subscriptionsRef.current])
    } catch (cause) {
      if (subscriptionScopeRef.current === scope) {
        setSubscriptionError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (subscriptionScopeRef.current === scope) setSubscriptionBusyUri(null)
    }
  }

  return (
    <div className="mcp-modal-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={dialogRef}
        className="mcp-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-detail-title"
        aria-describedby="mcp-detail-description"
      >
        <header className="mcp-detail-header">
          <div className="mcp-detail-identity">
            <span className="mcp-detail-server-icon" aria-hidden="true"><Server size={20} /></span>
            <div>
              <div className="mcp-detail-title-line">
                <h2 id="mcp-detail-title">{config.name}</h2>
                <span className={`mcp-status is-${status?.state || 'stopped'}`}>
                  <span className="mcp-status-dot" />{stateLabel(status?.state)}
                </span>
              </div>
              <p id="mcp-detail-description">{description}</p>
            </div>
          </div>
          <div className="mcp-detail-actions">
            <span className="mcp-toggle-label">{enabled ? '已启用' : '已停用'}</span>
            <span title={canToggle ? undefined : '仅用户作用域的有效配置可在此启停'}>
              <Switch checked={enabled} onChange={onToggle} disabled={!canToggle || busy} />
            </span>
            {status?.state === 'trust-required' ? (
              <Button type="primary" icon={<ShieldCheck size={15} />} onClick={onTrust} disabled={busy || !workspaceRoot}>信任项目配置</Button>
            ) : status?.state === 'needs-auth' ? (
              <span title={!supportsOAuth ? '此 MCP 配置未启用 OAuth。' : missingProjectWorkspace ? '项目 MCP 认证需要打开对应工作区。' : undefined}>
                <Button
                  type="primary"
                  icon={<KeyRound size={15} />}
                  loading={authorizing}
                  onClick={onAuthorize}
                  disabled={busy || !supportsOAuth || missingProjectWorkspace}
                >
                  {authorizing ? '正在认证' : '认证'}
                </Button>
              </span>
            ) : (
              <Button icon={<RefreshCw size={15} />} onClick={onReconnect} disabled={busy || !enabled}>重连</Button>
            )}
            {status?.state === 'connected' && supportsOAuth ? (
              <span title={missingProjectWorkspace ? '项目 MCP 退出认证需要打开对应工作区。' : undefined}>
                <Button loading={loggingOut} onClick={onLogout} disabled={busy || missingProjectWorkspace}>
                  {loggingOut ? '正在退出认证' : '退出认证'}
                </Button>
              </span>
            ) : null}
            <button ref={closeRef} className="mcp-modal-close" onClick={onClose} aria-label="关闭 MCP 详情">
              <X size={19} />
            </button>
          </div>
        </header>

        <nav className="mcp-detail-tabs" aria-label="MCP 详情视图" role="tablist">
          {([
            ['tools', Wrench, `工具 ${catalog.tools.length}`],
            ['resources', Database, `资源 ${catalog.resources.length}`],
            ['prompts', MessageSquareText, `Prompts ${catalog.prompts.length}`],
            ['connection', Terminal, '连接信息'],
            ['logs', FileText, '日志']
          ] as const).map(([id, Icon, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} role="tab" aria-selected={tab === id}>
              <Icon size={15} />{label}
            </button>
          ))}
        </nav>

        {catalog.stale && catalog.updatedAt ? (
          <div className="mcp-catalog-notice">显示上次发现的能力 · {new Date(catalog.updatedAt).toLocaleString()}</div>
        ) : null}
        {catalogError ? <div className="mcp-dialog-error" role="alert">{catalogError}</div> : null}
        {actionError ? <div className="mcp-dialog-error" role="alert">{actionError}</div> : null}
        {interactionError ? <div className="mcp-dialog-error" role="alert">{interactionError}</div> : null}
        {subscriptionError ? <div className="mcp-dialog-error" role="alert">{subscriptionError}</div> : null}

        <div className="mcp-detail-body">
          {tab === 'tools' ? (
            catalog.tools.length ? (
              <div className="mcp-catalog-layout">
                <aside className="mcp-catalog-sidebar">
                  <label className="mcp-catalog-search">
                    <Search size={15} aria-hidden="true" />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工具" aria-label="搜索 MCP 工具" />
                  </label>
                  <div className="mcp-catalog-items">
                    {filteredTools.map((tool) => (
                      <button key={tool.name} className={currentTool?.name === tool.name ? 'active' : ''} onClick={() => setSelectedTool(tool.name)}>
                        <Wrench size={14} /><span><strong>{tool.title || tool.name}</strong><small>{tool.name}</small></span>
                      </button>
                    ))}
                    {!filteredTools.length ? <div className="mcp-detail-empty">没有匹配的工具。</div> : null}
                  </div>
                </aside>
                {currentTool ? (
                  <div className="mcp-catalog-detail">
                    <h3>{currentTool.title || currentTool.name}</h3>
                    <code className="mcp-tool-name">{currentTool.name}</code>
                    <p>{currentTool.description || '此工具未提供描述。'}</p>
                    <h4>输入参数</h4>
                    {parameters.length ? (
                      <div className="mcp-parameter-list">
                        {parameters.map((parameter) => (
                          <div className="mcp-parameter-row" key={parameter.name}>
                            <code>{parameter.name}</code>
                            <span>{parameter.type}{parameter.required ? ' · 必填' : ' · 可选'}</span>
                            <p>{parameter.description || '未提供描述'}</p>
                            {parameter.detail ? <small>{parameter.detail}</small> : null}
                          </div>
                        ))}
                      </div>
                    ) : <div className="mcp-detail-empty">此工具不需要输入参数。</div>}
                    <details className="mcp-schema-details">
                      <summary><Braces size={14} />查看原始 inputSchema</summary>
                      <pre>{JSON.stringify(currentTool.inputSchema, null, 2)}</pre>
                    </details>
                  </div>
                ) : null}
              </div>
            ) : <div className="mcp-detail-empty large">{enabled ? '此 MCP 没有公开工具，或尚未完成连接。' : '启用并连接后可读取工具详情。'}</div>
          ) : null}

          {tab === 'resources' ? (
            catalog.resources.length ? (
              <div className="mcp-resource-list">
                {catalog.resources.map((resource) => {
                  const uri = resource.template ? templateUris[resource.uri]?.trim() || '' : resource.uri
                  const subscribed = subscribedUris.includes(uri)
                  const subscriptionLoading = subscriptionBusyUri === uri
                  const missingTemplateUri = resource.template && !uri
                  const subscriptionDisabled = !canManageSubscriptions || subscriptionBusyUri !== null || missingTemplateUri
                  const subscriptionTitle = !config.config.resourceSubscriptions
                    ? '此 MCP 配置未启用资源订阅。'
                    : missingProjectWorkspace
                      ? '项目 MCP 资源订阅需要打开对应工作区。'
                      : missingTemplateUri
                        ? '请输入资源模板的完整 URI。'
                        : undefined
                  return (
                    <div key={`${resource.template ? 'template' : 'resource'}:${resource.uri}`}>
                      <Database size={16} />
                      <div><strong>{resource.name}</strong><code>{resource.uri}</code><p>{resource.description || '未提供描述'}</p></div>
                      {resource.template ? (
                        <input
                          className="mcp-resource-template-input"
                          value={templateUris[resource.uri] || ''}
                          onChange={(event) => setTemplateUris((current) => ({ ...current, [resource.uri]: event.target.value }))}
                          placeholder={resource.uri}
                          aria-label={`资源模板 ${resource.name}`}
                        />
                      ) : <span>{resource.mimeType || '资源'}</span>}
                      <div className="mcp-resource-actions">
                        {config.config.resourceSubscriptions ? (
                          <span title={subscriptionTitle}>
                            <Button
                              size="small"
                              icon={subscribed ? <BellOff size={14} /> : <Bell size={14} />}
                              loading={subscriptionLoading}
                              onClick={() => void toggleResourceSubscription(uri)}
                              disabled={subscriptionDisabled}
                            >
                              {subscribed ? '取消订阅' : '订阅'}
                            </Button>
                          </span>
                        ) : null}
                        <button
                          className="mcp-resource-read-button"
                          title="读取资源"
                          aria-label={`读取资源 ${resource.name}`}
                          onClick={() => void readResource(uri)}
                          disabled={!canReadResources || readingResource || missingTemplateUri}
                        >
                          <Eye size={15} />
                        </button>
                      </div>
                    </div>
                  )
                })}
                {resourceResult ? <pre className="mcp-content-result">{JSON.stringify(resourceResult.contents, null, 2)}</pre> : null}
              </div>
            ) : <div className="mcp-detail-empty large">此 MCP 没有公开资源。</div>
          ) : null}

          {tab === 'prompts' ? (
            catalog.prompts.length ? (
              <div className="mcp-catalog-layout">
                <aside className="mcp-catalog-sidebar compact">
                  <div className="mcp-catalog-items">
                    {catalog.prompts.map((prompt) => (
                      <button key={prompt.name} className={currentPrompt?.name === prompt.name ? 'active' : ''} onClick={() => setSelectedPrompt(prompt.name)}>
                        <MessageSquareText size={14} /><span><strong>{prompt.name}</strong><small>{prompt.description || '无描述'}</small></span>
                      </button>
                    ))}
                  </div>
                </aside>
                {currentPrompt ? (
                  <PromptDetail
                    prompt={currentPrompt}
                    arguments_={promptArguments}
                    busy={resolvingPrompt || !canReadResources}
                    onArgumentChange={(name, value) => setPromptArguments((current) => ({ ...current, [name]: value }))}
                    onResolve={() => void resolvePrompt()}
                  />
                ) : null}
              </div>
            ) : <div className="mcp-detail-empty large">此 MCP 没有公开 Prompts。</div>
          ) : null}

          {tab === 'prompts' && promptResult ? (
            <pre className="mcp-content-result">{JSON.stringify(promptResult, null, 2)}</pre>
          ) : null}

          {tab === 'connection' ? (
            <div className="mcp-connection-details">
              <dl>
                <div><dt>配置来源</dt><dd>{MCP_SCOPE_LABELS[config.scope]}</dd></div>
                <div><dt>Transport</dt><dd>{config.config.type}</dd></div>
                <div><dt>{config.config.type === 'stdio' ? '命令' : 'URL'}</dt><dd><code>{configEndpoint(config.config)}</code></dd></div>
                <div><dt>Server 版本</dt><dd>{status?.serverInfo ? `${status.serverInfo.name} ${status.serverInfo.version}` : '尚未获取'}</dd></div>
                <div><dt>最后更新</dt><dd>{status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : '未知'}</dd></div>
              </dl>
              {config.config.env ? <p className="mcp-secret-summary">环境变量：{Object.keys(config.config.env).join(', ') || '无'}（值已隐藏）</p> : null}
              {config.config.headers ? <p className="mcp-secret-summary">Headers：{Object.keys(config.config.headers).join(', ') || '无'}（值已隐藏）</p> : null}
              {status?.error ? <div className="mcp-dialog-error"><strong>{status.error.code}</strong><br />{status.error.message}</div> : null}
            </div>
          ) : null}

          {tab === 'logs' ? (
            status?.logs?.length ? (
              <div className="mcp-detail-logs">
                {status.logs.slice(-100).map((entry, index) => (
                  <div key={`${entry.timestamp}-${index}`}>
                    <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                    <b>{entry.level}</b>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
            ) : <div className="mcp-detail-empty large">暂无诊断日志。</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
