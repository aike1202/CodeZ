import { IChatProvider, ChatRequestConfig, StreamCallbacks } from './types'
import type { AgentStopReason, ChatMessage } from '../../../shared/types/provider'
import type { ResolveImageAttachment } from '../../../shared/types/attachment'
import log from '../../logger'
import { logPrompt } from '../PromptLogger'
import type { ProviderTokenUsage } from '../../../shared/types/provider'
import { classifyProviderError } from './errors'

export function extractAnthropicUsage(value: any): ProviderTokenUsage {
  const inputTokens = Number(value?.input_tokens || 0)
  const outputTokens = Number(value?.output_tokens || 0)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

export interface AnthropicDeltaParts {
  textDelta: string
  reasoningDelta: string
  toolInputDelta: string
}

export function mapAnthropicStopReason(stopReason: string): AgentStopReason {
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    return 'stop'
  }
  if (stopReason === 'max_tokens') {
    return 'length'
  }
  if (stopReason === 'tool_use' || stopReason === 'pause_turn') {
    return 'tool_calls'
  }
  if (stopReason === 'refusal' || stopReason === 'safety') {
    return 'content_filter'
  }
  return 'unknown'
}

export function extractAnthropicDelta(delta: any): AnthropicDeltaParts {
  if (delta?.type === 'text_delta') {
    return {
      textDelta: delta.text || '',
      reasoningDelta: '',
      toolInputDelta: ''
    }
  }
  if (delta?.type === 'thinking_delta') {
    return {
      textDelta: '',
      reasoningDelta: delta.thinking || '',
      toolInputDelta: ''
    }
  }
  if (delta?.type === 'tool_use_input_delta' || delta?.type === 'input_json_delta') {
    return {
      textDelta: '',
      reasoningDelta: '',
      toolInputDelta: delta.partial_json || ''
    }
  }
  return {
    textDelta: '',
    reasoningDelta: '',
    toolInputDelta: ''
  }
}

export async function buildAnthropicMessages(
  messages: ChatMessage[],
  resolveImage?: ResolveImageAttachment
): Promise<any[]> {
  const anthropicMessages: any[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    if (msg.role === 'user') {
      if (!msg.attachments?.length) {
        anthropicMessages.push({ role: 'user', content: msg.content })
        continue
      }
      if (!resolveImage) throw new Error('Image resolver is unavailable')
      const images = await Promise.all(msg.attachments.map(resolveImage))
      anthropicMessages.push({
        role: 'user',
        content: [
          ...(msg.content?.trim() ? [{ type: 'text', text: msg.content }] : []),
          ...images.map((image) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mimeType,
              data: image.dataBase64
            }
          }))
        ]
      })
      continue
    }
    if (msg.role === 'assistant') {
      const content: any[] = []
      if (msg.content) content.push({ type: 'text', text: msg.content })
      for (const tc of msg.tool_calls || []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments
        })
      }
      anthropicMessages.push({ role: 'assistant', content })
      continue
    }
    anthropicMessages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content
      }]
    })
  }
  return anthropicMessages
}

export class AnthropicProvider implements IChatProvider {
  async streamChat(config: ChatRequestConfig, callbacks: StreamCallbacks, signal: AbortSignal): Promise<void> {
    const { baseUrl, apiKey, model, messages, tools, thinking, resolveImage } = config
    
    // Anthropic API URL
    let url = baseUrl
    if (!url.endsWith('/v1/messages') && !url.includes('messages')) {
      url = `${baseUrl.replace(/\/$/, '')}/v1/messages`
    }

    let fullContent = ''
    const systemPrompt = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content || '')
      .join('\n')
    const anthropicMessages = await buildAnthropicMessages(messages, resolveImage)

    const anthropicTools = tools?.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }))

    const thinkingPayload = await import('./utils').then(m => m.buildThinkingPayload(thinking, model, baseUrl, !!(tools && tools.length > 0), 'anthropic'))
    const requestPayload: any = {
      model,
      messages: anthropicMessages,
      max_tokens: 8192,
      stream: true,
      ...thinkingPayload
    }
    
    if ((thinkingPayload as any).thinking?.budget_tokens) {
      requestPayload.max_tokens = Math.max(8192, (thinkingPayload as any).thinking.budget_tokens + 4096)
    }
    
    if (systemPrompt) {
      requestPayload.system = systemPrompt.trim()
    }
    if (anthropicTools && anthropicTools.length > 0) {
      requestPayload.tools = anthropicTools
    }

    log.info(`[AnthropicProvider] Invoking model: ${model}`);
    log.debug(`[AnthropicProvider] Request Payload:`, JSON.stringify({ ...requestPayload, messages: `[Array of ${anthropicMessages.length} messages]` }));
    logPrompt(`[AnthropicProvider] system prompt`, 1, systemPrompt || '(none)');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(requestPayload),
        signal
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        callbacks.onError(
          `请求失败 (${response.status}): ${body.slice(0, 300)}`,
          classifyProviderError(response.status, body)
        )
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        callbacks.onError('无法读取响应流')
        return
      }

      log.info('[AnthropicProvider] response ok, streaming started')

      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''
      
      let toolCallIndex = 0
      let currentToolCallId = ''
      let currentToolCallName = ''
      let currentToolCallArgs = ''
      let finalStopReason: AgentStopReason = 'unknown'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim()
            continue
          }

          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim()
            if (dataStr === '[DONE]') continue

            try {
              const json = JSON.parse(dataStr)

              if (currentEvent === 'message_start' && json.message?.usage) {
                callbacks.onUsage?.(extractAnthropicUsage(json.message.usage))
              } else if (currentEvent === 'message_delta' && json.usage) {
                callbacks.onUsage?.(extractAnthropicUsage(json.usage))
              }

              if (currentEvent === 'content_block_start') {
                if (json.content_block?.type === 'tool_use') {
                  currentToolCallId = json.content_block.id
                  currentToolCallName = json.content_block.name
                  currentToolCallArgs = ''
                }
              } else if (currentEvent === 'message_delta') {
                const stopReason = json.delta?.stop_reason
                if (stopReason) {
                  finalStopReason = mapAnthropicStopReason(stopReason)
                }
              } else if (currentEvent === 'content_block_delta') {
                const deltaParts = extractAnthropicDelta(json.delta)
                if (deltaParts.textDelta) {
                  fullContent += deltaParts.textDelta
                  callbacks.onChunk(deltaParts.textDelta, '')
                }
                if (deltaParts.reasoningDelta) {
                  callbacks.onChunk('', deltaParts.reasoningDelta)
                }
                if (deltaParts.toolInputDelta) {
                  currentToolCallArgs += deltaParts.toolInputDelta
                }
              } else if (currentEvent === 'content_block_stop') {
                if (currentToolCallId) {
                  const toolCalls = [{
                    index: toolCallIndex++,
                    id: currentToolCallId,
                    type: 'function',
                    function: { name: currentToolCallName, arguments: currentToolCallArgs }
                  }]
                  callbacks.onChunk('', '', toolCalls, '')
                  currentToolCallId = ''
                  currentToolCallName = ''
                  currentToolCallArgs = ''
                }
              }
            } catch {
              // ignore json parse error
            }
          }
        }
      }

      log.info('[AnthropicProvider] stream done', { contentLen: fullContent.length })
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
