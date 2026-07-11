import { describe, expect, it } from 'vitest'
import { buildChatStreamInput } from '../renderer/src/components/chat/hooks/useSendMessage'

describe('renderer chat stream payload', () => {
  it('contains only the processed current input and metadata', () => {
    const input = buildChatStreamInput('inspect [file](src/a.ts)', [], 'ui-1')
    expect(input.text).toContain('src/a.ts')
    expect(input.commandMetadata).toEqual({
      uiMessageId: 'ui-1', commandName: undefined, referencedFiles: ['src/a.ts']
    })
    expect(input).not.toHaveProperty('messages')
    expect(input).not.toHaveProperty('systemPrompt')
  })

  it('passes attachment references separately from text metadata', () => {
    const attachment = {
      id: 'img1', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg' as const,
      width: 800, height: 600, sizeBytes: 4, storageKey: 'attachment:sessions/s1/img1',
      scope: 'session' as const, sessionId: 's1'
    }
    const input = buildChatStreamInput('inspect', [], 'ui-1', false, [attachment])
    expect(input).toMatchObject({ text: 'inspect', attachments: [attachment] })
    expect(JSON.stringify(input)).not.toContain('base64')
  })
})
