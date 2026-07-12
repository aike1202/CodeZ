import type { PendingPromptDraft } from '@shared/types/attachment'

export type SessionComposerDrafts = Record<string, PendingPromptDraft | undefined>

export function cloneComposerDraft(draft?: PendingPromptDraft): PendingPromptDraft {
  return {
    text: draft?.text || '',
    attachments: draft?.attachments?.map((attachment) => ({ ...attachment })) || []
  }
}

export function getSessionComposerDraft(
  drafts: SessionComposerDrafts,
  sessionId: string | null
): PendingPromptDraft {
  return sessionId ? cloneComposerDraft(drafts[sessionId]) : cloneComposerDraft()
}

export function setSessionComposerDraft(
  drafts: SessionComposerDrafts,
  sessionId: string,
  draft: PendingPromptDraft
): SessionComposerDrafts {
  const next = { ...drafts }
  if (!draft.text && draft.attachments.length === 0) {
    delete next[sessionId]
  } else {
    next[sessionId] = cloneComposerDraft(draft)
  }
  return next
}
