// src/tests/read-fingerprint-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ReadFingerprintStore, getReadFingerprintStore } from '../main/tools/ReadFingerprintStore'

describe('ReadFingerprintStore', () => {
  let store: ReadFingerprintStore
  const SESSION = 'sess-1'
  const ABS = process.platform === 'win32' ? 'C:/proj/src/a.ts' : '/proj/src/a.ts'

  beforeEach(() => {
    store = new ReadFingerprintStore()
    store.clear(SESSION)
  })

  it('record 后同 sha 的 isUnchanged 返回 true', () => {
    store.record(SESSION, ABS, 'sha-aaa')
    expect(store.isUnchanged(SESSION, ABS, 'sha-aaa')).toBe(true)
  })

  it('不同 sha 的 isUnchanged 返回 false（内容已变）', () => {
    store.record(SESSION, ABS, 'sha-aaa')
    expect(store.isUnchanged(SESSION, ABS, 'sha-bbb')).toBe(false)
  })

  it('isUnchangedKnown：record 前为 false，record 后为 true', () => {
    expect(store.isUnchangedKnown(SESSION, ABS)).toBe(false)
    store.record(SESSION, ABS, 'sha-aaa')
    expect(store.isUnchangedKnown(SESSION, ABS)).toBe(true)
  })

  it('clear 清除该会话所有指纹', () => {
    store.record(SESSION, ABS, 'sha-aaa')
    store.clear(SESSION)
    expect(store.isUnchangedKnown(SESSION, ABS)).toBe(false)
    expect(store.isUnchanged(SESSION, ABS, 'sha-aaa')).toBe(false)
  })

  it('不同 sessionId 互不干扰', () => {
    store.record('sess-1', ABS, 'sha-aaa')
    expect(store.isUnchanged('sess-2', ABS, 'sha-aaa')).toBe(false)
    expect(store.isUnchangedKnown('sess-2', ABS)).toBe(false)
  })

  it('路径归一化：反斜杠/大小写等价', () => {
    const backslash = ABS.replace(/\//g, '\\')
    store.record(SESSION, backslash, 'sha-aaa')
    expect(store.isUnchanged(SESSION, ABS.toUpperCase(), 'sha-aaa'))
      .toBe(process.platform === 'win32')
  })

  it('getReadFingerprintStore 返回同一单例', () => {
    expect(getReadFingerprintStore()).toBe(getReadFingerprintStore())
  })

  it('合并同一文件的并发快照加载', async () => {
    let loads = 0
    const loader = async () => {
      loads++
      await Promise.resolve()
      return {
        sha256: 'sha-aaa',
        buffer: Buffer.from('content'),
        statSignature: '7:1:1'
      }
    }

    const [first, second] = await Promise.all([
      store.getOrLoadSnapshot(SESSION, ABS, '7:1:1', loader),
      store.getOrLoadSnapshot(SESSION, ABS, '7:1:1', loader)
    ])

    expect(loads).toBe(1)
    expect(first.source).toBe('filesystem')
    expect(second.source).toBe('shared-cache')
    expect(second.snapshot.buffer.toString()).toBe('content')
  })

  it('按 Agent scope 记录当前文件版本的交付', () => {
    store.recordDelivery(SESSION, 'subagent:a', ABS, 'sha-aaa')

    expect(store.hasDelivery(SESSION, 'subagent:a', ABS, 'sha-aaa')).toBe(true)
    expect(store.hasDelivery(SESSION, 'subagent:b', ABS, 'sha-aaa')).toBe(false)
    expect(store.hasDelivery(SESSION, 'subagent:a', ABS, 'sha-bbb')).toBe(false)
  })

  it('replaces stale scope authorization from the actual model projection', () => {
    store.recordDelivery(SESSION, 'main', ABS, 'old')
    store.replaceScopeDeliveries(SESSION, 'main', [{
      fileReferences: [{
        path: ABS,
        sha256: 'visible',
        operation: 'read',
        contentIncluded: true
      }]
    }])
    expect(store.hasDelivery(SESSION, 'main', ABS, 'old')).toBe(false)
    expect(store.hasDelivery(SESSION, 'main', ABS, 'visible')).toBe(true)

    store.replaceScopeDeliveries(SESSION, 'main', [{
      fileReferences: [{
        path: ABS,
        sha256: 'pruned',
        operation: 'read',
        contentIncluded: false
      }]
    }])
    expect(store.hasDelivery(SESSION, 'main', ABS, 'visible')).toBe(false)
    expect(store.hasDelivery(SESSION, 'main', ABS, 'pruned')).toBe(false)
  })

  it('orders restored context and retained tail references by ledger sequence', () => {
    store.replaceScopeDeliveries(SESSION, 'main', [
      {
        sourceSequence: 10,
        fileReferences: [{
          path: ABS, sha256: 'restored-current', operation: 'read', contentIncluded: true
        }]
      },
      {
        sourceSequence: 5,
        fileReferences: [{
          path: ABS, sha256: 'retained-old', operation: 'read', contentIncluded: true
        }]
      }
    ])

    expect(store.hasDelivery(SESSION, 'main', ABS, 'restored-current')).toBe(true)
    expect(store.hasDelivery(SESSION, 'main', ABS, 'retained-old')).toBe(false)
  })

  it('evicts snapshot buffers by LRU entry and byte limits', () => {
    const limited = new ReadFingerprintStore(2, 8)
    const signature = (value: string) => `${value.length}:1:1`
    const record = (filePath: string, value: string) => limited.recordSnapshot(SESSION, filePath, {
      sha256: value,
      buffer: Buffer.from(value),
      statSignature: signature(value)
    })
    const b = ABS.replace('a.ts', 'b.ts')
    const c = ABS.replace('a.ts', 'c.ts')

    record(ABS, 'aaaa')
    record(b, 'bbbb')
    expect(limited.getSnapshot(SESSION, ABS, signature('aaaa'))).toBeTruthy()
    record(c, 'cccc')

    expect(limited.getSnapshot(SESSION, ABS, signature('aaaa'))).toBeTruthy()
    expect(limited.getSnapshot(SESSION, b, signature('bbbb'))).toBeUndefined()
    expect(limited.getSnapshot(SESSION, c, signature('cccc'))).toBeTruthy()
  })
})
