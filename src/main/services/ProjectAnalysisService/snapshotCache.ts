import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import type { SnapshotCacheFile } from './types'

export const SNAPSHOT_CACHE_FILE = 'project-snapshots.json'

export async function hashOptionalFile(
  validatePath: (p: string) => string,
  relativePath: string
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(validatePath(relativePath))
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return undefined
  }
}

export async function hashFirstExisting(
  validatePath: (p: string) => string,
  filePaths: string[]
): Promise<string | undefined> {
  for (const filePath of filePaths) {
    const hash = await hashOptionalFile(validatePath, filePath)
    if (hash) return hash
  }
  return undefined
}

export async function readCache(cacheFilePath: string): Promise<SnapshotCacheFile> {
  try {
    const content = await fs.readFile(cacheFilePath, 'utf-8')
    const parsed = JSON.parse(content) as SnapshotCacheFile
    return { entries: parsed.entries || {} }
  } catch {
    return { entries: {} }
  }
}

export async function writeCache(cacheFilePath: string, cache: SnapshotCacheFile): Promise<void> {
  const dir = path.dirname(cacheFilePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(cacheFilePath, JSON.stringify(cache, null, 2), 'utf-8')
}
