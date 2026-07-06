import { IChatProvider, ChatRequestConfig, StreamCallbacks } from './types'
import { buildThinkingPayload } from './utils'
import log from '../../logger'

export interface ThinkParserState {
  inThinkTag: boolean
  streamBuffer: string
}

export function processDeltaWithThinkTags(
  delta: string,
  state: ThinkParserState,
  onChunk: (delta: string, reasoningDelta: string) => void
): void {
  state.streamBuffer += delta

  const thinkStartTag = '<think>'
  const thinkEndTag = '</think>'

  const checkPrefix = (str: string, tag: string): number => {
    for (let len = Math.min(str.length, tag.length - 1); len > 0; len--) {
      if (str.endsWith(tag.slice(0, len))) {
        return len
      }
    }
    return 0
  }

  const parse = (): void => {
    if (!state.inThinkTag) {
      const idx = state.streamBuffer.indexOf(thinkStartTag)
      if (idx !== -1) {
        const textPart = state.streamBuffer.slice(0, idx)
        if (textPart) {
          onChunk(textPart, '')
        }
        state.streamBuffer = state.streamBuffer.slice(idx + thinkStartTag.length)
        state.inThinkTag = true
        parse()
      } else {
        const prefixLen = checkPrefix(state.streamBuffer, thinkStartTag)
        if (prefixLen > 0) {
          const textPart = state.streamBuffer.slice(0, -prefixLen)
          if (textPart) {
            onChunk(textPart, '')
          }
          state.streamBuffer = state.streamBuffer.slice(-prefixLen)
        } else {
          if (state.streamBuffer) {
            onChunk(state.streamBuffer, '')
            state.streamBuffer = ''
          }
        }
      }
    } else {
      const idx = state.streamBuffer.indexOf(thinkEndTag)
      if (idx !== -1) {
        const reasoningPart = state.streamBuffer.slice(0, idx)
        if (reasoningPart) {
          onChunk('', reasoningPart)
        }
        state.streamBuffer = state.streamBuffer.slice(idx + thinkEndTag.length)
        state.inThinkTag = false
        parse()
      } else {
        const prefixLen = checkPrefix(state.streamBuffer, thinkEndTag)
        if (prefixLen > 0) {
          const reasoningPart = state.streamBuffer.slice(0, -prefixLen)
          if (reasoningPart) {
            onChunk('', reasoningPart)
          }
          state.streamBuffer = state.streamBuffer.slice(-prefixLen)
        } else {
          if (state.streamBuffer) {
            onChunk('', state.streamBuffer)
            state.streamBuffer = ''
          }
        }
      }
    }
  }

  parse()
}

export class OpenAIProvider implements IChatProvider {
  async streamChat(config: ChatRequestConfig, callbacks: StreamCallbacks, signal: AbortSignal): Promise<void> {
    const { baseUrl, apiKey, model, messages, tools, thinking } = config
    const url = `${baseUrl}/chat/completions`

    let fullContent = ''

    const requestPayload = {
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      stream: true,
      ...buildThinkingPayload(thinking, model, baseUrl, !!(tools && tools.length > 0))
    }

    log.info(`[OpenAIProvider] Invoking model: ${model}`);
    log.debug(`[OpenAIProvider] Request Payload:`, JSON.stringify({ ...requestPayload, messages: `[Array of ${messages.length} messages]` }));

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestPayload),
        signal
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        if (response.status === 401 || response.status === 403) {
          callbacks.onError(`鉴权失败 (${response.status}): 请检查 API Key`)
        } else if (response.status === 404) {
          callbacks.onError('模型或端点不存在 (404)')
        } else if (response.status === 429) {
          callbacks.onError('请求过于频繁 (429): 请稍后重试')
        } else {
          callbacks.onError(`请求失败 (${response.status}): ${body.slice(0, 300)}`)
        }
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        callbacks.onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''
      const thinkParserState: ThinkParserState = { inThinkTag: false, streamBuffer: '' }
      let finalStopReason: import('../../../shared/types/provider').AgentStopReason = 'unknown'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const dataStr = trimmed.slice(5).trim()
          if (dataStr === '[DONE]') continue



          try {
            const json = JSON.parse(dataStr)

            const finishReason = json?.choices?.[0]?.finish_reason
            if (finishReason) {
              if (finishReason === 'stop') finalStopReason = 'stop'
              else if (finishReason === 'length') finalStopReason = 'length'
              else if (finishReason === 'tool_calls' || finishReason === 'function_call') finalStopReason = 'tool_calls'
              else if (finishReason === 'content_filter') finalStopReason = 'content_filter'
            }

            const delta = json?.choices?.[0]?.delta?.content
            const reasoningDelta = json?.choices?.[0]?.delta?.reasoning_content
              || json?.choices?.[0]?.delta?.reasoning
              || json?.choices?.[0]?.delta?.thinking
              || json?.choices?.[0]?.delta?.thinking_content
            const toolCalls = json?.choices?.[0]?.delta?.tool_calls
            
            const extraContent = json?.choices?.[0]?.delta?.extra_content || json?.choices?.[0]?.message?.extra_content || json?.extra_content
            const providerSpecific = json?.choices?.[0]?.delta?.provider_specific_fields || json?.choices?.[0]?.message?.provider_specific_fields || json?.provider_specific_fields
            let thoughtSignature = extraContent?.google?.thought_signature || providerSpecific?.thought_signature || json?.choices?.[0]?.delta?.thought_signature || json?.google?.thought_signature || json?.thought_signature || json?.thoughtSignature

            if (!thoughtSignature && toolCalls?.length > 0) {
               thoughtSignature = toolCalls[0]?.thought_signature || toolCalls[0]?.function?.thought_signature
            }
            
            if (delta || reasoningDelta || toolCalls || thoughtSignature) {
              let parsedDelta = ''
              let parsedReasoning = reasoningDelta || ''

              if (delta) {
                if (reasoningDelta) {
                  parsedDelta = delta
                } else {
                  processDeltaWithThinkTags(delta, thinkParserState, (d, r) => {
                    parsedDelta += d
                    parsedReasoning += r
                  })
                }
              }

              if (parsedDelta) {
                fullContent += parsedDelta
              }

              if (parsedDelta || parsedReasoning || toolCalls || thoughtSignature) {
                callbacks.onChunk(parsedDelta, parsedReasoning, toolCalls, thoughtSignature)
              }
            }
          } catch {
            // ignore non-json
          }
        }
      }

      if (thinkParserState.streamBuffer) {
        if (thinkParserState.inThinkTag) {
          callbacks.onChunk('', thinkParserState.streamBuffer)
        } else {
          fullContent += thinkParserState.streamBuffer
          callbacks.onChunk(thinkParserState.streamBuffer, '')
        }
      }
      callbacks.onDone(fullContent, finalStopReason)
    } catch (error) {
      if (!signal.aborted) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('abort')) {
          callbacks.onDone(fullContent || '')
        } else {
          callbacks.onError(`网络错误: ${msg}`)
        }
      }
    }
  }
}
