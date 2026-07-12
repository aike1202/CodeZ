import * as path from 'path'
import type { FileContextReference, NormalizedModelMessage } from '../../../shared/types/context'
import { ContextBudgetService } from './ContextBudgetService'

export interface FileContextProjection {
  messages: NormalizedModelMessage[]
  protectedMessageIds: Set<string>
  duplicateReadResults: number
  tokensSaved: number
}

function referenceKey(reference: FileContextReference): string {
  const normalized = path.normalize(reference.path)
  const filePath = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return [
    filePath,
    reference.sha256,
    reference.contentSha256 ?? ''
  ].join(':')
}

function isProjectableReference(reference: FileContextReference): boolean {
  return reference.operation === 'read' &&
    reference.contentIncluded &&
    Boolean(reference.contentSha256)
}

function hasValidBlockRange(reference: FileContextReference, content: string): boolean {
  const start = reference.resultBlockStart
  const end = reference.resultBlockEnd
  return Number.isInteger(start) && Number.isInteger(end) &&
    start! >= 0 && end! > start! && end! <= content.length &&
    content.startsWith('<file ', start) && content.slice(end! - 7, end) === '</file>'
}

interface ReadPayload {
  content: string
  serialize: (content: string) => string
}

function readPayload(message: NormalizedModelMessage): ReadPayload {
  try {
    const wrapper = JSON.parse(message.content)
    if (wrapper && typeof wrapper === 'object' && typeof wrapper.data === 'string') {
      return {
        content: wrapper.data,
        serialize: (content) => JSON.stringify({ ...wrapper, data: content })
      }
    }
  } catch {}
  return { content: message.content, serialize: (content) => content }
}

function legacyReadResultKey(message: NormalizedModelMessage): string | undefined {
  if (message.role !== 'tool' || message.name !== 'Read') return undefined
  const references = message.fileReferences || []
  const payload = readPayload(message).content
  const fileBlockCount = payload.match(/<file\b/g)?.length || 0
  if (
    references.length === 0 ||
    references.some((reference) => hasValidBlockRange(reference, payload)) ||
    fileBlockCount !== references.length ||
    references.some((reference) => !isProjectableReference(reference))
  ) return undefined
  return references.map(referenceKey).join('|')
}

function safeReferenceContent(reference: FileContextReference): string {
  return JSON.stringify({
    type: 'read_reference',
    path: reference.path,
    sha256: reference.sha256,
    offset: reference.offset,
    limit: reference.limit,
    characterOffset: reference.characterOffset,
    message: 'This unchanged file range is already present in an earlier Read block in this context.'
  })
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
}

/** Builds a cache-stable model view while leaving the durable ledger untouched. */
export class FileContextProjector {
  constructor(private readonly budget = new ContextBudgetService()) {}

  project(source: readonly NormalizedModelMessage[]): FileContextProjection {
    const messages = source.map((message) => ({
      ...message,
      toolCalls: message.toolCalls?.map((call) => ({ ...call })),
      fileReferences: message.fileReferences?.map((reference) => ({ ...reference }))
    }))
    const firstBlockDelivery = new Map<string, string>()
    const firstLegacyDelivery = new Map<string, string>()
    const protectedMessageIds = new Set<string>()
    let duplicateReadResults = 0
    let tokensSaved = 0

    for (const message of messages) {
      if (message.role !== 'tool' || message.name !== 'Read') continue
      const references = message.fileReferences || []
      const payload = readPayload(message)
      const ranged = references
        .map((reference, index) => ({ reference, index }))
        .filter(({ reference }) =>
          isProjectableReference(reference) && hasValidBlockRange(reference, payload.content)
        )

      if (ranged.length > 0) {
        const nonOverlapping: typeof ranged = []
        let previousEnd = -1
        for (const entry of [...ranged].sort(
          (left, right) => left.reference.resultBlockStart! - right.reference.resultBlockStart!
        )) {
          if (entry.reference.resultBlockStart! < previousEnd) continue
          nonOverlapping.push(entry)
          previousEnd = entry.reference.resultBlockEnd!
        }
        const replacements: Array<{
          index: number
          start: number
          end: number
          content: string
        }> = []

        for (const { reference, index } of nonOverlapping) {
          const key = referenceKey(reference)
          const canonicalId = firstBlockDelivery.get(key)
          if (!canonicalId) {
            firstBlockDelivery.set(key, message.id)
            continue
          }
          protectedMessageIds.add(canonicalId)
          replacements.push({
            index,
            start: reference.resultBlockStart!,
            end: reference.resultBlockEnd!,
            content: safeReferenceContent(reference)
          })
        }

        if (replacements.length > 0) {
          const tokensBefore = this.budget.estimateValueTokens(message)
          let projectedContent = payload.content
          for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
            projectedContent = `${projectedContent.slice(0, replacement.start)}${replacement.content}${projectedContent.slice(replacement.end)}`
            message.fileReferences![replacement.index] = {
              ...message.fileReferences![replacement.index],
              contentIncluded: false
            }
          }
          message.content = payload.serialize(projectedContent)
          duplicateReadResults += replacements.length
          tokensSaved += Math.max(0, tokensBefore - this.budget.estimateValueTokens(message))
        }
        continue
      }

      const legacyKey = legacyReadResultKey(message)
      if (!legacyKey) continue
      const canonicalId = firstLegacyDelivery.get(legacyKey)
      if (!canonicalId) {
        firstLegacyDelivery.set(legacyKey, message.id)
        continue
      }

      protectedMessageIds.add(canonicalId)
      const tokensBefore = this.budget.estimateValueTokens(message)
      message.content = JSON.stringify({
        ok: true,
        data: 'File version and requested range unchanged. The earlier Read tool result in this context is still current.'
      })
      message.fileReferences = message.fileReferences?.map((reference) => ({
        ...reference,
        contentIncluded: false
      }))
      tokensSaved += Math.max(0, tokensBefore - this.budget.estimateValueTokens(message))
      duplicateReadResults++
    }

    return { messages, protectedMessageIds, duplicateReadResults, tokensSaved }
  }
}
