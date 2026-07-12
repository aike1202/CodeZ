import * as path from 'path'
import * as fs from 'fs'

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(
    typeof reason === 'string' && reason.trim()
      ? reason
      : 'File mutation was aborted while waiting for its lock.'
  )
}

async function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous.catch(() => undefined)
    return
  }
  if (signal.aborted) throw abortError(signal)
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([previous.catch(() => undefined), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Resolves path aliases to the stable identity used by mutation and rollback locks. */
export function canonicalMutationPath(filePath: string): string {
  let resolved: string
  try {
    resolved = fs.realpathSync.native(filePath)
  } catch {
    try {
      resolved = path.join(
        fs.realpathSync.native(path.dirname(filePath)),
        path.basename(filePath)
      )
    } catch {
      resolved = path.resolve(filePath)
    }
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Serializes CodeZ mutations per file while allowing unrelated files to run in parallel. */
export class FileMutationCoordinator {
  private readonly queues = new Map<string, Promise<void>>()

  async run<T>(
    filePath: string,
    operation: () => Promise<T>,
    abortSignal?: AbortSignal
  ): Promise<T> {
    const key = this.normalize(filePath)
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => current)
    this.queues.set(key, queued)

    try {
      await waitForPrevious(previous, abortSignal)
      if (abortSignal?.aborted) {
        throw abortError(abortSignal)
      }
      return await operation()
    } finally {
      release()
      void queued.then(() => {
        if (this.queues.get(key) === queued) this.queues.delete(key)
      })
    }
  }

  private normalize(filePath: string): string {
    return canonicalMutationPath(filePath)
  }
}

let instance: FileMutationCoordinator | undefined

export function getFileMutationCoordinator(): FileMutationCoordinator {
  instance ??= new FileMutationCoordinator()
  return instance
}
