import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../../../stores/chatStore'
import {
  buildPromptPredictionContext,
  canPredictNextPrompt,
  getPromptPredictionSuffix
} from '../promptPrediction'

interface UsePromptPredictionOptions {
  activeSessionId: string | null
  providerId: string | null
  model: string
  draft: string
  conversationBusy: boolean
  menuOpen: boolean
}

export function usePromptPrediction({
  activeSessionId,
  providerId,
  model,
  draft,
  conversationBusy,
  menuOpen
}: UsePromptPredictionOptions) {
  const messages = useChatStore((state) => state.messages)
  const [suffix, setSuffix] = useState('')
  const requestGenerationRef = useRef(0)
  const lastRequestedKeyRef = useRef<string | null>(null)
  const suppressedDraftRef = useRef<string | null>(null)

  const context = useMemo(() => buildPromptPredictionContext(messages), [messages])
  const contextKey = useMemo(() => JSON.stringify(context), [context])
  const eligible = canPredictNextPrompt(messages)
  const requestKey = `${activeSessionId || ''}\u0000${providerId || ''}\u0000${model}\u0000${contextKey}\u0000${draft}`

  useEffect(() => {
    const generation = ++requestGenerationRef.current

    if (
      !activeSessionId
      || !providerId
      || !model
      || conversationBusy
      || menuOpen
      || !eligible
      || suppressedDraftRef.current === draft
    ) {
      lastRequestedKeyRef.current = null
      setSuffix('')
      return
    }
    if (lastRequestedKeyRef.current === requestKey) return

    setSuffix('')

    const timer = window.setTimeout(() => {
      lastRequestedKeyRef.current = requestKey
      void window.api.chat.predictNextInput({
        providerId,
        model,
        context,
        draft
      }).then((response) => {
        if (requestGenerationRef.current !== generation) return
        setSuffix(getPromptPredictionSuffix(draft, response.suggestion))
      }).catch(() => {
        if (requestGenerationRef.current === generation) setSuffix('')
      })
    }, 650)

    return () => window.clearTimeout(timer)
  }, [
    activeSessionId,
    contextKey,
    conversationBusy,
    draft,
    eligible,
    menuOpen,
    model,
    providerId,
    requestKey
  ])

  const accept = (acceptedText: string) => {
    suppressedDraftRef.current = acceptedText
    requestGenerationRef.current += 1
    setSuffix('')
  }

  useEffect(() => {
    if (suppressedDraftRef.current !== null && suppressedDraftRef.current !== draft) {
      suppressedDraftRef.current = null
    }
  }, [draft])

  return { suffix, accept }
}
