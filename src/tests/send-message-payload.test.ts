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
})
