import Ajv, { type ValidateFunction } from 'ajv'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ToolContext } from '../../tools/Tool'
import { getMcpContentStore, type McpContentStore, type McpStoredContent } from './McpContentStore'

type CallToolResult = Awaited<ReturnType<Client['callTool']>>

export interface McpResourceLink {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpCanonicalResult {
  modelText: string
  structuredData?: Record<string, unknown>
  mcpMeta?: Record<string, unknown>
  linkedResources: McpResourceLink[]
  storedContent: McpStoredContent[]
  isError: boolean
}

export function escapeMcpAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 36 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('MCP binary block contains invalid base64 data.')
  }
  return Buffer.from(value, 'base64')
}

export class McpContentNormalizer {
  private readonly outputValidator?: ValidateFunction

  constructor(
    private readonly serverName: string,
    private readonly toolName: string,
    outputSchema?: Record<string, unknown>,
    private readonly store: McpContentStore = getMcpContentStore()
  ) {
    if (outputSchema) this.outputValidator = new Ajv({ strict: false, allErrors: true }).compile(outputSchema)
  }

  async normalize(result: CallToolResult, context: ToolContext): Promise<McpCanonicalResult> {
    const structuredData = result.structuredContent as Record<string, unknown> | undefined
    if (this.outputValidator && (!structuredData || !this.outputValidator(structuredData))) {
      throw Object.assign(new Error('MCP structuredContent does not match the declared output schema.'), {
        code: 'MCP_OUTPUT_INVALID'
      })
    }
    const text: string[] = []
    const linkedResources: McpResourceLink[] = []
    const storedContent: McpStoredContent[] = []
    let totalText = 0
    let totalBinary = 0
    const addText = (value: string) => {
      totalText += Buffer.byteLength(value, 'utf8')
      if (totalText > 400_000) throw new Error('MCP text content exceeds the 400 KiB hard limit.')
      text.push(value)
    }
    const persist = async (data: unknown, mimeType: unknown, label: string) => {
      const bytes = decodeBase64(data)
      totalBinary += bytes.byteLength
      if (totalBinary > 25 * 1024 * 1024) throw new Error('MCP binary content exceeds the 25 MiB aggregate limit.')
      const mime = typeof mimeType === 'string' ? mimeType : 'application/octet-stream'
      if (!context.sessionId) {
        addText(`[MCP ${label}: ${mime}, ${bytes.byteLength} bytes; omitted because no session store is available]`)
        return
      }
      const stored = await this.store.persist({
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        serverName: this.serverName,
        toolName: this.toolName,
        mimeType: mime,
        bytes
      })
      storedContent.push(stored)
      addText(`[MCP ${label}: ${mime}, ${bytes.byteLength} bytes, ${stored.handle}]`)
    }

    for (const block of 'content' in result && Array.isArray(result.content) ? result.content : []) {
      if (block.type === 'text') addText(block.text)
      else if (block.type === 'image') await persist(block.data, block.mimeType, 'image')
      else if (block.type === 'audio') await persist(block.data, block.mimeType, 'audio')
      else if (block.type === 'resource_link') {
        linkedResources.push({
          uri: block.uri.slice(0, 8192),
          name: block.name.slice(0, 1024),
          description: block.description?.slice(0, 4096),
          mimeType: block.mimeType?.slice(0, 256)
        })
        addText(`[MCP resource link: ${block.name}] ${block.uri}`)
      } else if (block.type === 'resource') {
        const resource = block.resource
        if ('text' in resource) addText(`[MCP embedded resource ${resource.uri}]\n${resource.text}`)
        else await persist(resource.blob, resource.mimeType, `embedded resource ${resource.uri}`)
      }
    }
    if (structuredData) addText(`[MCP structured content]\n${JSON.stringify(structuredData)}`)
    return {
      modelText: `<mcp-result server="${escapeMcpAttribute(this.serverName)}" tool="${escapeMcpAttribute(this.toolName)}" trust="external-data">\n${text.join('\n')}\n</mcp-result>`,
      structuredData,
      mcpMeta: '_meta' in result ? result._meta as Record<string, unknown> | undefined : undefined,
      linkedResources,
      storedContent,
      isError: 'isError' in result && result.isError === true
    }
  }
}

export async function normalizeMcpResourceResult(
  result: unknown,
  context: ToolContext,
  serverName: string,
  store: McpContentStore = getMcpContentStore()
): Promise<{ contents: Array<Record<string, unknown>> }> {
  const rawContents = (result as any)?.contents
  if (!Array.isArray(rawContents) || rawContents.length > 1000) throw new Error('MCP resource response is invalid or too large.')
  let totalTextBytes = 0
  let totalBinaryBytes = 0
  const contents: Array<Record<string, unknown>> = []
  for (const raw of rawContents) {
    if (!raw || typeof raw !== 'object' || typeof raw.uri !== 'string' || raw.uri.length > 8192) {
      throw new Error('MCP resource content entry is invalid.')
    }
    const base = {
      uri: raw.uri,
      mimeType: typeof raw.mimeType === 'string' ? raw.mimeType.slice(0, 256) : undefined
    }
    if (typeof raw.text === 'string') {
      totalTextBytes += Buffer.byteLength(raw.text, 'utf8')
      if (totalTextBytes > 400_000) throw new Error('MCP resource text exceeds the 400 KiB limit.')
      contents.push({ ...base, text: raw.text })
      continue
    }
    const bytes = decodeBase64(raw.blob)
    totalBinaryBytes += bytes.byteLength
    if (totalBinaryBytes > 25 * 1024 * 1024) throw new Error('MCP resource binary content exceeds the 25 MiB limit.')
    if (!context.sessionId) {
      contents.push({ ...base, binary: { sizeBytes: bytes.byteLength, persisted: false } })
      continue
    }
    const stored = await store.persist({
      workspaceRoot: context.workspaceRoot,
      sessionId: context.sessionId,
      serverName,
      toolName: 'ReadMcpResource',
      mimeType: base.mimeType || 'application/octet-stream',
      bytes
    })
    contents.push({ ...base, binary: stored })
  }
  return { contents }
}

export function normalizeMcpPromptResult(result: unknown): {
  description?: string
  messages: Array<{ role: 'user' | 'assistant'; content: Record<string, unknown> }>
} {
  const raw = result as any
  if (!raw || !Array.isArray(raw.messages) || raw.messages.length > 100) throw new Error('MCP prompt response is invalid or too large.')
  let totalTextBytes = 0
  const messages = raw.messages.map((message: any) => {
    const role: 'user' | 'assistant' = message?.role === 'assistant' ? 'assistant' : 'user'
    const content = message?.content
    if (!content || typeof content !== 'object') throw new Error('MCP prompt content is invalid.')
    if (content.type === 'text') {
      const text = typeof content.text === 'string' ? content.text : ''
      totalTextBytes += Buffer.byteLength(text, 'utf8')
      if (totalTextBytes > 256_000) throw new Error('MCP prompt text exceeds the 256 KiB limit.')
      return { role, content: { type: 'text', text } }
    }
    if (content.type === 'resource_link') {
      return { role, content: { type: 'resource_link', uri: String(content.uri).slice(0, 8192), name: String(content.name).slice(0, 1024) } }
    }
    if (content.type === 'resource' && typeof content.resource?.text === 'string') {
      const text = content.resource.text
      totalTextBytes += Buffer.byteLength(text, 'utf8')
      if (totalTextBytes > 256_000) throw new Error('MCP prompt text exceeds the 256 KiB limit.')
      return { role, content: { type: 'resource', uri: String(content.resource.uri).slice(0, 8192), text } }
    }
    return {
      role,
      content: {
        type: content.type === 'audio' ? 'audio' : 'image',
        mimeType: typeof content.mimeType === 'string' ? content.mimeType.slice(0, 256) : 'application/octet-stream',
        omitted: true
      }
    }
  })
  return {
    description: typeof raw.description === 'string' ? raw.description.slice(0, 32_000) : undefined,
    messages
  }
}
