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
