import { describe, expect, it } from 'vitest'
import { FileMutationCoordinator } from '../main/tools/FileMutationCoordinator'

describe('FileMutationCoordinator', () => {
  it('serializes the same path in FIFO order and continues after failures', async () => {
    const coordinator = new FileMutationCoordinator()
    const events: string[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })

    const first = coordinator.run('C:\\repo\\a.ts', async () => {
      events.push('first:start')
      markFirstStarted()
      await gate
      events.push('first:end')
      throw new Error('expected')
    })
    const second = coordinator.run('C:\\repo\\a.ts', async () => {
      events.push('second')
      return 'ok'
    })

    await firstStarted
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await expect(first).rejects.toThrow('expected')
    await expect(second).resolves.toBe('ok')
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('allows unrelated paths to run concurrently', async () => {
    const coordinator = new FileMutationCoordinator()
    const started = new Set<string>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markBothStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve })
    const run = (filePath: string) => coordinator.run(filePath, async () => {
      started.add(filePath)
      if (started.size === 2) markBothStarted()
      await gate
    })

    const pending = Promise.all([run('C:\\repo\\a.ts'), run('C:\\repo\\b.ts')])
    await bothStarted
    expect(started.size).toBe(2)
    release()
    await pending
  })

  it('does not run an operation aborted while waiting for the file lock', async () => {
    const coordinator = new FileMutationCoordinator()
    const controller = new AbortController()
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    let secondRan = false

    const first = coordinator.run('C:\\repo\\abort.ts', async () => {
      markFirstStarted()
      await gate
    })
    await firstStarted
    const second = coordinator.run('C:\\repo\\abort.ts', async () => {
      secondRan = true
    }, controller.signal)

    controller.abort('executor stopped')
    await expect(second).rejects.toThrow('executor stopped')
    expect(secondRan).toBe(false)
    let thirdRan = false
    const third = coordinator.run('C:\\repo\\abort.ts', async () => {
      thirdRan = true
    })
    await Promise.resolve()
    expect(thirdRan).toBe(false)
    releaseFirst()
    await Promise.all([first, third])
    expect(thirdRan).toBe(true)
  })
})
