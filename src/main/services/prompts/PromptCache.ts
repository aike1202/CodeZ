export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '<!-- codez:prompt-dynamic-boundary -->'

export interface SystemPromptSections {
  staticContent: string
  dynamicContent: string
}

export function splitSystemPromptSections(prompt: string): SystemPromptSections {
  const index = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (index < 0) {
    return { staticContent: prompt.trim(), dynamicContent: '' }
  }
  return {
    staticContent: prompt.slice(0, index).trim(),
    dynamicContent: prompt.slice(index + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trim()
  }
}

export function stripSystemPromptMarkers(prompt: string): string {
  const { staticContent, dynamicContent } = splitSystemPromptSections(prompt)
  return [staticContent, dynamicContent].filter(Boolean).join('\n\n')
}
