import Ajv from 'ajv'
import type {
  Prompt,
  Resource,
  ResourceTemplate,
  Tool as McpSdkTool
} from '@modelcontextprotocol/sdk/types.js'
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import { mcpToolName } from './normalization'

export interface McpDiscoveryLimits {
  maxPages: number
  maxItems: number
  maxSchemaBytes: number
  maxDescriptionChars: number
}

export const MCP_DISCOVERY_LIMITS: Readonly<McpDiscoveryLimits> = Object.freeze({
  maxPages: 100,
  maxItems: 10_000,
  maxSchemaBytes: 256 * 1024,
  maxDescriptionChars: 32_000
})

export async function collectMcpPages<T>(
  load: (cursor?: string) => Promise<Record<string, unknown> & { nextCursor?: string }>,
  key: string,
  limits: Readonly<McpDiscoveryLimits> = MCP_DISCOVERY_LIMITS
): Promise<T[]> {
  const values: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    if (++pages > limits.maxPages) throw new Error(`MCP ${key} discovery exceeded the page limit.`)
    if (cursor) {
      if (cursors.has(cursor)) throw new Error(`MCP ${key} discovery returned a cursor loop.`)
      cursors.add(cursor)
    }
    const page = await load(cursor)
    const items = page[key]
    if (!Array.isArray(items)) throw new Error(`MCP ${key} discovery returned an invalid page.`)
    if (values.length + items.length > limits.maxItems) throw new Error(`MCP ${key} discovery exceeded the item limit.`)
    values.push(...items as T[])
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
  } while (cursor)
  return values
}

const ajv = new Ajv({ strict: false, allowUnionTypes: true })

function validSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  try {
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MCP_DISCOVERY_LIMITS.maxSchemaBytes) return false
    if (!ajv.validateSchema(schema)) return false
    ajv.compile(schema)
    return true
  } catch {
    return false
  }
}

export interface McpToolRejection {
  toolName: string
  reason: 'invalid-name' | 'invalid-input-schema' | 'invalid-output-schema' | 'normalized-name-conflict'
}

export function isolateMcpTools(
  serverName: string,
  tools: readonly McpSdkTool[]
): { tools: McpSdkTool[]; rejected: McpToolRejection[] } {
  const accepted: McpSdkTool[] = []
  const rejected: McpToolRejection[] = []
  const canonicalNames = new Set<string>()
  for (const tool of tools) {
    if (!tool.name || tool.name.length > 256 || /[\u0000-\u001f]/.test(tool.name)) {
      rejected.push({ toolName: tool.name || '<unnamed>', reason: 'invalid-name' })
      continue
    }
    if (!validSchema(tool.inputSchema)) {
      rejected.push({ toolName: tool.name, reason: 'invalid-input-schema' })
      continue
    }
    if (tool.outputSchema !== undefined && !validSchema(tool.outputSchema)) {
      rejected.push({ toolName: tool.name, reason: 'invalid-output-schema' })
      continue
    }
    const canonicalName = mcpToolName(serverName, tool.name)
    if (canonicalNames.has(canonicalName)) {
      rejected.push({ toolName: tool.name, reason: 'normalized-name-conflict' })
      continue
    }
    canonicalNames.add(canonicalName)
    accepted.push({
      ...tool,
      description: tool.description?.slice(0, MCP_DISCOVERY_LIMITS.maxDescriptionChars)
    })
  }
  return { tools: accepted, rejected }
}

export interface McpResourceRejection {
  identity: string
  reason: 'invalid-resource' | 'invalid-template' | 'duplicate-uri'
}

function validExternalString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value)
}

export function isolateMcpResources(
  resources: readonly Resource[],
  templates: readonly ResourceTemplate[]
): { resources: Resource[]; templates: ResourceTemplate[]; rejected: McpResourceRejection[] } {
  const acceptedResources: Resource[] = []
  const acceptedTemplates: ResourceTemplate[] = []
  const rejected: McpResourceRejection[] = []
  const uris = new Set<string>()
  for (const resource of resources) {
    const identity = typeof resource?.uri === 'string' ? resource.uri : '<invalid-resource>'
    if (!validExternalString(resource?.uri, 8192) || !validExternalString(resource?.name, 1024)) {
      rejected.push({ identity, reason: 'invalid-resource' })
      continue
    }
    if (uris.has(resource.uri)) {
      rejected.push({ identity, reason: 'duplicate-uri' })
      continue
    }
    uris.add(resource.uri)
    acceptedResources.push({
      ...resource,
      description: resource.description?.slice(0, MCP_DISCOVERY_LIMITS.maxDescriptionChars),
      mimeType: resource.mimeType?.slice(0, 256)
    })
  }
  for (const template of templates) {
    const identity = typeof template?.uriTemplate === 'string' ? template.uriTemplate : '<invalid-template>'
    let validTemplate = validExternalString(template?.uriTemplate, 8192) && validExternalString(template?.name, 1024)
    if (validTemplate) {
      try { new UriTemplate(template.uriTemplate) } catch { validTemplate = false }
    }
    if (!validTemplate) {
      rejected.push({ identity, reason: 'invalid-template' })
      continue
    }
    if (uris.has(template.uriTemplate)) {
      rejected.push({ identity, reason: 'duplicate-uri' })
      continue
    }
    uris.add(template.uriTemplate)
    acceptedTemplates.push({
      ...template,
      description: template.description?.slice(0, MCP_DISCOVERY_LIMITS.maxDescriptionChars),
      mimeType: template.mimeType?.slice(0, 256)
    })
  }
  return { resources: acceptedResources, templates: acceptedTemplates, rejected }
}

export interface McpPromptRejection {
  name: string
  reason: 'invalid-prompt' | 'duplicate-name'
}

export function isolateMcpPrompts(
  prompts: readonly Prompt[]
): { prompts: Prompt[]; rejected: McpPromptRejection[] } {
  const accepted: Prompt[] = []
  const rejected: McpPromptRejection[] = []
  const names = new Set<string>()
  for (const prompt of prompts) {
    const name = typeof prompt?.name === 'string' ? prompt.name : '<invalid-prompt>'
    if (!validExternalString(prompt?.name, 256)) {
      rejected.push({ name, reason: 'invalid-prompt' })
      continue
    }
    if (names.has(prompt.name)) {
      rejected.push({ name, reason: 'duplicate-name' })
      continue
    }
    names.add(prompt.name)
    accepted.push({
      ...prompt,
      description: prompt.description?.slice(0, MCP_DISCOVERY_LIMITS.maxDescriptionChars),
      arguments: prompt.arguments?.slice(0, 100).map((argument) => ({
        ...argument,
        name: argument.name.slice(0, 256),
        description: argument.description?.slice(0, 4096)
      }))
    })
  }
  return { prompts: accepted, rejected }
}
