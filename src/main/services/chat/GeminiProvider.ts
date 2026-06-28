import { IChatProvider, ChatRequestConfig, StreamCallbacks } from './types'
import { buildThinkingPayload } from './utils'

export class GeminiProvider implements IChatProvider {
  async streamChat(config: ChatRequestConfig, callbacks: StreamCallbacks, signal: AbortSignal): Promise<void> {
    const { baseUrl, apiKey, model, messages, tools, thinking } = config
    let url = baseUrl
    if (!url.includes('/models')) {
      let cleanBase = url
        .replace(/\/v1\/chat\/completions\/?$/, '')
        .replace(/\/v1\/?$/, '')
        .replace(/\/v1beta\/?$/, '')
        .replace(/\/$/, '')
      url = `${cleanBase}/v1beta/models/${model}:streamGenerateContent?key=${apiKey}`
    } else {
      url = url.replace(/\/$/, '')
      if (!url.includes(':streamGenerateContent')) {
        url = `${url}:streamGenerateContent`
      }
      url = `${url}?key=${apiKey}`
    }

    let fullContent = ''

    // 构建 Gemini native payload
    const systemInstructionParts: any[] = []
    const contents: any[] = []

    const pushOrMergeContent = (role: 'user' | 'model' | 'function', parts: any[]) => {
      if (parts.length === 0) return
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts.push(...parts)
      } else {
        contents.push({ role, parts })
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'system') {
        systemInstructionParts.push({ text: msg.content })
      } else if (msg.role === 'user') {
        pushOrMergeContent('user', [{ text: msg.content }])
      } else if (msg.role === 'assistant') {
        const parts: any[] = []
        if (msg.content) parts.push({ text: msg.content })
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments
              }
            })
          }
        }
        pushOrMergeContent('model', parts)
      } else if (msg.role === 'tool') {
        const parts: any[] = []
        let j = i
        while (j < messages.length && messages[j].role === 'tool') {
          parts.push({
            functionResponse: {
              name: messages[j].name,
              response: { result: messages[j].content }
            }
          })
          j++
        }
        
        // functionResponse must use 'user' role
        contents.push({ role: 'user', parts })
        
        // If the next message is ALSO a user message (e.g. user typed "继续"),
        // Gemini strictly forbids mixing functionResponse and text in the same 'user' turn,
        // and also strictly forbids consecutive 'user' turns.
        // So we MUST inject a dummy 'model' turn to separate them.
        if (j < messages.length && messages[j].role === 'user') {
          contents.push({ role: 'model', parts: [{ text: 'OK' }] })
        }
        
        i = j - 1
      }
    }

    const geminiTools = tools && tools.length > 0 ? [{
      functionDeclarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }] : undefined

    const thinkingConfig = buildThinkingPayload(thinking, model, baseUrl, !!(tools && tools.length > 0))

    const requestPayload: any = { contents }
    if (systemInstructionParts.length > 0) {
      requestPayload.systemInstruction = { parts: systemInstructionParts }
    }
    if (geminiTools) {
      requestPayload.tools = geminiTools
    }
    if (thinkingConfig && Object.keys(thinkingConfig).length > 0) {
      if (thinkingConfig.google) {
        requestPayload.generationConfig = thinkingConfig.google
      } else if (thinkingConfig.thinking_config) {
        requestPayload.generationConfig = { thinkingConfig: thinkingConfig.thinking_config }
      }
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
        signal
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        callbacks.onError(`请求失败 (${response.status}): ${body.slice(0, 300)}`)
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        callbacks.onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''
      let toolCallIndex = 0
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
            
            const finishReason = json?.candidates?.[0]?.finishReason
            if (finishReason) {
              if (finishReason === 'STOP') finalStopReason = 'stop'
              else if (finishReason === 'MAX_TOKENS') finalStopReason = 'length'
              else if (finishReason === 'SAFETY') finalStopReason = 'content_filter'
            }

            const parts = json?.candidates?.[0]?.content?.parts
            if (!parts) continue

            for (const part of parts) {
              if (part.text) {
                if (part.thought) {
                  callbacks.onChunk('', part.text)
                } else {
                  fullContent += part.text
                  callbacks.onChunk(part.text, '')
                }
              }
              if (part.functionCall) {
                const id = 'call_' + Math.random().toString(36).slice(2)
                const name = part.functionCall.name
                const args = JSON.stringify(part.functionCall.args || {})
                
                const toolCalls = [{
                  index: toolCallIndex++,
                  id,
                  type: 'function',
                  function: { name, arguments: args }
                }]
                const sig = part.thoughtSignature || part.thought_signature || 'skip_thought_signature_validator'
                callbacks.onChunk('', '', toolCalls, sig)
              }
            }
          } catch {
            // ignore
          }
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
