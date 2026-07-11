import { describe, expect, it } from 'vitest'
import { resolveOpenAIMessages } from '../main/services/chat/OpenAIProvider'
import { buildAnthropicMessages } from '../main/services/chat/AnthropicProvider'
import { buildGeminiContents } from '../main/services/chat/GeminiProvider'

const attachment = {
  id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
  width: 800, height: 600, sizeBytes: 4, storageKey: 'attachment:sessions/s1/img1',
  scope: 'session' as const, sessionId: 's1'
}
const resolveImage = async () => ({ mimeType: 'image/jpeg' as const, dataBase64: 'AQIDBA==' })

describe('multimodal provider payloads', () => {
  it('builds OpenAI Chat Completions image_url Data URLs', async () => {
    const result = await resolveOpenAIMessages([
      { role: 'user', content: 'inspect', attachments: [attachment] }
    ], resolveImage)
    expect(result[0].content).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQIDBA==' } }
    ])
  })

  it('builds Anthropic source blocks and preserves tool result order', async () => {
    const result = await buildAnthropicMessages([
      { role: 'user', content: '', attachments: [attachment] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }]
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1', name: 'Read' }
    ], resolveImage)
    expect(result[0].content).toEqual([{
      type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQIDBA==' }
    }])
    expect(result.at(-1)?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' })
  })

  it('builds Gemini inlineData parts', async () => {
    const result = await buildGeminiContents([
      { role: 'user', content: 'inspect', attachments: [attachment] }
    ], resolveImage)
    expect(result.contents).toEqual([{
      role: 'user', parts: [
        { text: 'inspect' },
        { inlineData: { mimeType: 'image/jpeg', data: 'AQIDBA==' } }
      ]
    }])
  })
})
