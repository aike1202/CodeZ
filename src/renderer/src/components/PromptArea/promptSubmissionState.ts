import type { ComposerImageAttachment } from '@shared/types/attachment'

export function restoreRejectedPromptText(current: string, rejected: string): string {
  if (!rejected) return current
  if (!current) return rejected
  return `${rejected}\n\n${current}`
}

export function mergeRejectedAttachments(
  current: ComposerImageAttachment[],
  rejected: ComposerImageAttachment[]
): ComposerImageAttachment[] {
  const currentIds = new Set(current.map((attachment) => attachment.id))
  return [
    ...rejected.filter((attachment) => !currentIds.has(attachment.id)),
    ...current
  ]
}
