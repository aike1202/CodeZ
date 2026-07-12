import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import { atomicWriteSecureJson } from '../context/atomicFile'

export interface McpStoredContent {
  handle: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function defaultRoot(): string {
  try {
    if (app?.getPath) return path.join(app.getPath('userData'), 'mcp-content-v2')
  } catch {}
  return path.join(os.tmpdir(), 'codez-userdata', 'mcp-content-v2')
}

export class McpContentStore {
  constructor(private readonly root = defaultRoot()) {}

  private sessionDir(workspaceRoot: string, sessionId: string): string {
    return path.join(this.root, 'projects', hash(path.resolve(workspaceRoot)), 'sessions', hash(sessionId))
  }

  async persist(input: {
    workspaceRoot: string
    sessionId: string
    serverName: string
    toolName: string
    mimeType: string
    bytes: Buffer
  }): Promise<McpStoredContent> {
    if (input.bytes.byteLength > 25 * 1024 * 1024) throw new Error('MCP binary content exceeds the 25 MiB limit.')
    const id = `${hash(`${input.serverName}\0${input.toolName}`).slice(0, 12)}_${randomUUID().replace(/-/g, '')}`
    const dir = this.sessionDir(input.workspaceRoot, input.sessionId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const stored: McpStoredContent = {
      handle: `mcp-content://${id}`,
      mimeType: input.mimeType.slice(0, 256) || 'application/octet-stream',
      sizeBytes: input.bytes.byteLength,
      sha256: hash(input.bytes)
    }
    const contentPath = path.join(dir, `${id}.bin`)
    const handle = await fs.open(contentPath, 'wx', 0o600)
    try {
      await handle.writeFile(input.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await atomicWriteSecureJson(path.join(dir, `${id}.json`), {
      ...stored,
      serverName: input.serverName,
      toolName: input.toolName,
      createdAt: new Date().toISOString()
    })
    return stored
  }

  async removeSession(workspaceRoot: string, sessionId: string): Promise<void> {
    await fs.rm(this.sessionDir(workspaceRoot, sessionId), { recursive: true, force: true })
  }
}

let singleton: McpContentStore | undefined
export function getMcpContentStore(): McpContentStore {
  singleton ||= new McpContentStore()
  return singleton
}
