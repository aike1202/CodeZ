import * as fs from 'fs/promises'
import * as path from 'path'

function temporaryPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  )
}

export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const tempPath = temporaryPath(targetPath)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })

  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tempPath, 'w')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, targetPath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await atomicWriteFile(targetPath, JSON.stringify(value, null, 2))
}

interface FileIdentity {
  dev: number
  ino: number
  mode: number
}

async function regularFileIdentity(filePath: string): Promise<FileIdentity | undefined> {
  try {
    const stat = await fs.lstat(filePath)
    if (stat.isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${filePath}`)
    if (!stat.isFile()) throw new Error(`Atomic write target is not a regular file: ${filePath}`)
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Writes security-sensitive state without following a target symlink and
 * verifies that an existing target did not change before the rename.
 */
export async function atomicWriteSecureFile(targetPath: string, content: string): Promise<void> {
  const tempPath = temporaryPath(targetPath)
  const directory = path.dirname(targetPath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const before = await regularFileIdentity(targetPath)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tempPath, 'wx', before ? before.mode & 0o777 : 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined

    const current = await regularFileIdentity(targetPath)
    if (Boolean(before) !== Boolean(current) ||
        (before && current && (before.dev !== current.dev || before.ino !== current.ino))) {
      throw new Error(`Atomic write target changed while writing: ${targetPath}`)
    }
    await fs.rename(tempPath, targetPath)
    await regularFileIdentity(targetPath)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function atomicWriteSecureJson(targetPath: string, value: unknown): Promise<void> {
  await atomicWriteSecureFile(targetPath, JSON.stringify(value, null, 2))
}
