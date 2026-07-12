import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'

export interface PersistedToolResult {
  handle: string
  originalChars: number
  originalBytes: number
  sha256: string
}

interface ToolResultMetadata extends PersistedToolResult {
  createdAt: string
  workspaceHash: string
  sessionHash: string
  callId: string
  toolName: string
  contentType: 'text/plain'
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function defaultRoot(): string {
  const userData = app?.getPath ? app.getPath('userData') : path.join(os.tmpdir(), 'codez-userdata')
  return path.join(userData, 'tool-results-v2')
}

export class LargeToolResultStore {
  constructor(private readonly root = defaultRoot()) {}

  private sessionDir(workspaceRoot: string, sessionId: string): string {
    return path.join(this.root, 'projects', hash(path.resolve(workspaceRoot)), 'sessions', hash(sessionId))
  }

  async persist(input: {
    workspaceRoot: string
    sessionId: string
    callId: string
    toolName: string
    content: string
  }): Promise<PersistedToolResult> {
    const id = `${hash(input.callId).slice(0, 16)}_${randomUUID().replace(/-/g, '')}`
    const handle = `tool-result://${id}`
    const dir = this.sessionDir(input.workspaceRoot, input.sessionId)
    await fs.mkdir(dir, { recursive: true })
    const contentPath = path.join(dir, `${id}.txt`)
    const metadataPath = path.join(dir, `${id}.json`)
    const body = Buffer.from(input.content, 'utf8')
    const persisted: PersistedToolResult = {
      handle,
      originalChars: input.content.length,
      originalBytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex')
    }
    const metadata: ToolResultMetadata = {
      ...persisted,
      createdAt: new Date().toISOString(),
      workspaceHash: hash(path.resolve(input.workspaceRoot)),
      sessionHash: hash(input.sessionId),
      callId: input.callId,
      toolName: input.toolName,
      contentType: 'text/plain'
    }
    const contentHandle = await fs.open(contentPath, 'wx')
    try {
      await contentHandle.writeFile(body)
    } finally {
      await contentHandle.close()
    }
    const metadataHandle = await fs.open(metadataPath, 'wx')
    try {
      await metadataHandle.writeFile(JSON.stringify(metadata), 'utf8')
    } finally {
      await metadataHandle.close()
    }
    return persisted
  }

  async read(input: {
    workspaceRoot: string
    sessionId: string
    handle: string
    offset?: number
    limit?: number
  }): Promise<{ content: string; offset: number; nextOffset?: number; totalChars: number }> {
    const match = /^tool-result:\/\/([A-Za-z0-9_-]+)$/.exec(input.handle)
    if (!match) throw new Error('Invalid tool-result handle.')
    const id = match[1]
    const dir = this.sessionDir(input.workspaceRoot, input.sessionId)
    const metadata = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8')) as ToolResultMetadata
    if (metadata.handle !== input.handle || metadata.sessionHash !== hash(input.sessionId)) {
      throw new Error('Tool-result handle does not belong to this session.')
    }
    const full = await fs.readFile(path.join(dir, `${id}.txt`), 'utf8')
    const offset = Math.max(0, Math.min(input.offset || 0, full.length))
    const limit = Math.max(1, Math.min(input.limit || 20_000, 50_000))
    const end = Math.min(full.length, offset + limit)
    return {
      content: full.slice(offset, end),
      offset,
      nextOffset: end < full.length ? end : undefined,
      totalChars: full.length
    }
  }

  async removeSession(workspaceRoot: string, sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(workspaceRoot, sessionId), { recursive: true, force: true })
  }
}

let sharedStore: LargeToolResultStore | undefined

export function getLargeToolResultStore(): LargeToolResultStore {
  if (!sharedStore) sharedStore = new LargeToolResultStore()
  return sharedStore
}
