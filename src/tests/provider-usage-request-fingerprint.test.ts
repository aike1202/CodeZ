import { describe, expect, it } from 'vitest'
import { fingerprintProviderRequest } from '../main/services/context/ProviderUsageRequestFingerprint'

describe('Provider usage request fingerprint', () => {
  it('is stable across object key order but changes with request-shaping input', () => {
    const base = fingerprintProviderRequest({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      toolSchemas: [{ function: { description: 'read', name: 'Read' }, type: 'function' }],
      profile: { providerId: 'p1', model: 'm1', apiFormat: 'openai' }
    })
    const reordered = fingerprintProviderRequest({
      messages: [{ content: 'system', role: 'system' }, { content: 'hello', role: 'user' }],
      toolSchemas: [{ type: 'function', function: { name: 'Read', description: 'read' } }],
      profile: { apiFormat: 'openai', model: 'm1', providerId: 'p1' }
    })

    expect(reordered).toBe(base)
    expect(fingerprintProviderRequest({
      messages: [{ role: 'system', content: 'changed' }, { role: 'user', content: 'hello' }],
      toolSchemas: [{ function: { description: 'read', name: 'Read' }, type: 'function' }],
      profile: { providerId: 'p1', model: 'm1', apiFormat: 'openai' }
    })).not.toBe(base)
    expect(fingerprintProviderRequest({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      toolSchemas: [],
      profile: { providerId: 'p1', model: 'm1', apiFormat: 'openai' }
    })).not.toBe(base)
    expect(fingerprintProviderRequest({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      toolSchemas: [{ function: { description: 'read', name: 'Read' }, type: 'function' }],
      profile: { providerId: 'p1', model: 'm2', apiFormat: 'openai' }
    })).not.toBe(base)
  })
})
