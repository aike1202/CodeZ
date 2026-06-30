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
    expect(store.isUnchanged(SESSION, ABS.toUpperCase(), 'sha-aaa')).toBe(true)
  })

  it('getReadFingerprintStore 返回同一单例', () => {
    expect(getReadFingerprintStore()).toBe(getReadFingerprintStore())
  })
})
