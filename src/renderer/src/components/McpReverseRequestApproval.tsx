import React, { useEffect, useMemo, useState } from 'react'
import { Bot, CircleAlert, ExternalLink, ListChecks, ShieldAlert } from 'lucide-react'
import Button from './ui/Button'
import { desktopApi, type McpReverseRequestEvent, type McpReverseRequestResponse } from '../shared/desktop'
import './McpReverseRequestApproval.css'

type PrimitiveFieldType = 'string' | 'number' | 'integer' | 'boolean'

interface PrimitiveField {
  name: string
  label: string
  description?: string
  type: PrimitiveFieldType
  required: boolean
  enumValues?: Array<string | number | boolean>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isPrimitiveValue(value: unknown, type: PrimitiveFieldType): value is string | number | boolean {
  return (type === 'string' && typeof value === 'string')
    || ((type === 'number' || type === 'integer') && typeof value === 'number')
    || (type === 'boolean' && typeof value === 'boolean')
}

function safeFormFields(value: unknown): PrimitiveField[] | null {
  const schema = record(value)
  if (!schema || schema.type !== 'object' || schema.additionalProperties === true) return null
  if (['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'patternProperties'].some((key) => key in schema)) return null

  const properties = record(schema.properties)
  if (!properties || Object.keys(properties).length > 24) return null
  const requiredNames = (
    Array.isArray(schema.required) && schema.required.every((name) => typeof name === 'string')
      ? schema.required as string[]
      : []
  )
  const required = new Set<string>(requiredNames)
  if ([...required].some((name) => !(name in properties))) return null

  const fields: PrimitiveField[] = []
  for (const [name, rawField] of Object.entries(properties)) {
    if (!name || name.length > 160) return null
    const field = record(rawField)
    const type = field?.type
    if (!field || (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean')) return null
    if (['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'const'].some((key) => key in field)) return null

    let enumValues: Array<string | number | boolean> | undefined
    if (field.enum !== undefined) {
      if (!Array.isArray(field.enum) || field.enum.length === 0 || field.enum.length > 24) return null
      if (!field.enum.every((item) => isPrimitiveValue(item, type))) return null
      enumValues = field.enum as Array<string | number | boolean>
    }
    fields.push({
      name,
      label: typeof field.title === 'string' && field.title.trim() ? field.title.slice(0, 240) : name,
      description: typeof field.description === 'string' ? field.description.slice(0, 1_024) : undefined,
      type,
      required: required.has(name),
      enumValues
    })
  }
  return fields
}

function parseFormContent(
  fields: PrimitiveField[],
  values: Record<string, string>
): Record<string, string | number | boolean> | null {
  const content: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    const raw = values[field.name] ?? ''
    if (!raw) {
      if (field.required) return null
      continue
    }

    let value: string | number | boolean
    if (field.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') return null
      value = raw === 'true'
    } else if (field.type === 'number' || field.type === 'integer') {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))) return null
      value = parsed
    } else {
      value = raw
    }

    if (field.enumValues && !field.enumValues.some((allowed) => Object.is(allowed, value))) return null
    content[field.name] = value
  }
  return content
}

function declineResponse(event: McpReverseRequestEvent): McpReverseRequestResponse {
  if (event.request.kind === 'sampling') return { kind: 'sampling', approved: false }
  if (event.request.kind === 'elicitationUrl') return { kind: 'elicitationUrl', action: 'decline' }
  return { kind: 'elicitationForm', action: 'decline' }
}

interface ModalProps {
  event: McpReverseRequestEvent
  submitting: boolean
  error: string
  onRespond: (response: McpReverseRequestResponse) => Promise<void>
}

function McpReverseRequestModal({ event, submitting, error, onRespond }: ModalProps): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>({})
  const [validationError, setValidationError] = useState('')
  const fields = useMemo(
    () => event.request.kind === 'elicitationForm' ? safeFormFields(event.request.requestedSchema) : null,
    [event.request]
  )

  useEffect(() => {
    setValues({})
    setValidationError('')
  }, [event.requestId])

  const decline = (): void => {
    void onRespond(declineResponse(event))
  }
  const accept = (): void => {
    if (event.request.kind === 'sampling') {
      void onRespond({ kind: 'sampling', approved: true })
      return
    }
    if (event.request.kind === 'elicitationUrl') {
      void onRespond({ kind: 'elicitationUrl', action: 'accept' })
      return
    }
    if (!fields) return
    const content = parseFormContent(fields, values)
    if (!content) {
      setValidationError('请完成所有必填字段，并填写符合字段类型的值。')
      return
    }
    void onRespond({ kind: 'elicitationForm', action: 'accept', content })
  }

  const requestTitle = event.request.kind === 'sampling'
    ? 'MCP 请求模型采样'
    : event.request.kind === 'elicitationUrl'
      ? 'MCP 请求打开外部页面'
      : 'MCP 请求填写表单'
  const canAcceptForm = event.request.kind !== 'elicitationForm' || fields !== null

  return (
    <div
      className="mcp-reverse-overlay"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget && !submitting) decline()
      }}
    >
      <section
        className="mcp-reverse-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-reverse-title"
        aria-describedby="mcp-reverse-description"
        onKeyDown={(keyboardEvent) => {
          if (keyboardEvent.key === 'Escape' && !submitting) {
            keyboardEvent.preventDefault()
            decline()
          }
        }}
      >
        <header className="mcp-reverse-header">
          <span className="mcp-reverse-icon" aria-hidden="true"><ShieldAlert size={22} /></span>
          <div>
            <h2 id="mcp-reverse-title">{requestTitle}</h2>
            <p id="mcp-reverse-description">{event.serverName} 正在等待你的明确决定。</p>
          </div>
        </header>

        <div className="mcp-reverse-body">
          <dl className="mcp-reverse-metadata">
            <div><dt>Server</dt><dd>{event.serverName}</dd></div>
            <div><dt>策略</dt><dd>{event.policy === 'ask' ? '请求确认' : '允许但仍需确认'}</dd></div>
          </dl>

          {event.request.kind === 'sampling' ? (
            <div className="mcp-reverse-request-summary">
              <Bot size={18} aria-hidden="true" />
              <div>
                <strong>采样元数据</strong>
                <p>最多 {event.request.maxTokens} tokens，{event.request.messageCount} 条消息{event.request.hasSystemPrompt ? '，包含系统提示词' : ''}。</p>
              </div>
            </div>
          ) : null}

          {event.request.kind === 'elicitationUrl' ? (
            <div className="mcp-reverse-request-summary">
              <ExternalLink size={18} aria-hidden="true" />
              <div>
                <strong>目标来源</strong>
                <p>{event.request.origin}</p>
                <p>{event.request.message}</p>
              </div>
            </div>
          ) : null}

          {event.request.kind === 'elicitationForm' ? (
            <div className="mcp-reverse-form">
              <div className="mcp-reverse-request-summary">
                <ListChecks size={18} aria-hidden="true" />
                <div>
                  <strong>表单请求</strong>
                  <p>{event.request.message}</p>
                </div>
              </div>
              <p className="mcp-reverse-warning"><CircleAlert size={15} aria-hidden="true" />仅填写你确认可以交给此 MCP Server 的信息。</p>
              {fields === null ? (
                <p className="mcp-reverse-unsupported">此表单包含未支持的结构，无法安全填写，只能拒绝。</p>
              ) : fields.length === 0 ? (
                <p className="mcp-reverse-unsupported">此表单不要求提供字段；仍需明确确认后才会接受。</p>
              ) : (
                <div className="mcp-reverse-fields">
                  {fields.map((field) => (
                    <label key={field.name}>
                      <span>{field.label}{field.required ? <b>必填</b> : null}</span>
                      {field.description ? <small>{field.description}</small> : null}
                      {field.enumValues ? (
                        <select
                          value={values[field.name] ?? ''}
                          disabled={submitting}
                          onChange={(changeEvent) => setValues((current) => ({ ...current, [field.name]: changeEvent.target.value }))}
                        >
                          <option value="">请选择</option>
                          {field.enumValues.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
                        </select>
                      ) : field.type === 'boolean' ? (
                        <select
                          value={values[field.name] ?? ''}
                          disabled={submitting}
                          onChange={(changeEvent) => setValues((current) => ({ ...current, [field.name]: changeEvent.target.value }))}
                        >
                          <option value="">请选择</option>
                          <option value="true">是</option>
                          <option value="false">否</option>
                        </select>
                      ) : (
                        <input
                          type={field.type === 'string' ? 'text' : 'number'}
                          inputMode={field.type === 'string' ? 'text' : 'decimal'}
                          step={field.type === 'integer' ? '1' : 'any'}
                          value={values[field.name] ?? ''}
                          disabled={submitting}
                          onChange={(changeEvent) => setValues((current) => ({ ...current, [field.name]: changeEvent.target.value }))}
                        />
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {validationError ? <p className="mcp-reverse-error" role="alert">{validationError}</p> : null}
          {error ? <p className="mcp-reverse-error" role="alert">{error}</p> : null}
        </div>

        <footer className="mcp-reverse-actions">
          <Button autoFocus onClick={decline} disabled={submitting} danger>
            拒绝
          </Button>
          <Button type="primary" onClick={accept} disabled={submitting || !canAcceptForm} loading={submitting}>
            {event.request.kind === 'sampling' ? '允许采样' : '接受请求'}
          </Button>
        </footer>
      </section>
    </div>
  )
}

export default function McpReverseRequestApproval(): React.ReactElement | null {
  const [queue, setQueue] = useState<McpReverseRequestEvent[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const current = queue[0]

  useEffect(() => desktopApi.mcp.onReverseRequest((event) => {
    setQueue((requests) => requests.some((request) => request.requestId === event.requestId)
      ? requests
      : [...requests, event]
    )
  }), [])

  const respond = async (response: McpReverseRequestResponse): Promise<void> => {
    if (!current || submitting) return
    setSubmitting(true)
    setError('')
    try {
      await desktopApi.mcp.respondReverseRequest(current.requestId, response)
      setQueue((requests) => requests.filter((request) => request.requestId !== current.requestId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return current ? <McpReverseRequestModal event={current} submitting={submitting} error={error} onRespond={respond} /> : null
}
