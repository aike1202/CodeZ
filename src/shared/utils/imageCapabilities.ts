import type { ApiFormat, ModelConfig } from '../types/provider'
import type { ProviderImagePolicy } from '../types/attachment'

const MIB = 1024 * 1024

export type ImageInputSupportSource = 'manual' | 'model-default' | 'unknown'

export interface ImageInputCapability {
  supported: boolean
  source: ImageInputSupportSource
}

type ImageCapabilityModel = Pick<ModelConfig, 'name' | 'supportsVision'>

const KNOWN_NON_VISION_MODELS = [
  /^(?:text-)?embedding(?:[-_.]|$)/,
  /(?:^|[-_.])(?:embed|rerank|moderation|whisper|tts|transcribe|audio|imagen|veo|dall-e)(?:[-_.]|$)/,
  /^gpt-3\.5(?:[-_.]|$)/,
  /^gpt-4(?:$|-(?:\d|32k|base)(?:[-_.]|$))/,
  /^o(?:1|3)-mini(?:[-_.]|$)/,
  /^claude-(?:instant|2)(?:[-_.]|$)/,
  /^gemini-(?:1\.0-)?pro(?:$|-(?!vision(?:[-_.]|$)))/,
  /^deepseek-(?:chat|reasoner)(?:[-_.]|$)/,
  /^qwen-(?:max|plus|turbo|coder)(?:[-_.]|$)/,
  /^qwen\d(?:\.\d+)?-coder(?:[-_.]|$)/,
  /^glm-(?:4(?:\.5|-plus|-air|-flash)|5)(?:[-_.]|$)/,
  /^minimax-m2\.5(?:[-_.]|$)/,
  /^mimo-v2\.5-pro(?:[-_.]|$)/,
  /^moonshot-v1(?:[-_.]|$)/,
  /^kimi-k2(?:$|-(?:thinking|turbo)(?:[-_.]|$))/
]

const KNOWN_VISION_MODELS = [
  /^gpt-5(?:[-_.]|$)/,
  /^gpt-4(?:o|\.1|\.5)(?:[-_.]|$)/,
  /^gpt-4-(?:turbo|vision)(?:[-_.]|$)/,
  /^chatgpt-4o(?:[-_.]|$)/,
  /^o1(?:[-_.]|$)/,
  /^o3(?:[-_.]|$)/,
  /^o4-mini(?:[-_.]|$)/,
  /^claude-(?:3|[4-9])(?:[-_.]|$)/,
  /^claude-(?:opus|sonnet|haiku)-[4-9](?:[-_.]|$)/,
  /^gemini-(?:1\.5|[2-9])(?:[-_.]|$)/,
  /^gemini-(?:1\.0-)?pro-vision(?:[-_.]|$)/,
  /^qwen3\.6-plus(?:[-_.]|$)/,
  /^qvq(?:[-_.]|$)/,
  /^qwen(?:3(?:\.5)?-)?-?omni(?:[-_.]|$)/,
  /^glm-(?:4v|4\.1v|4\.6v|5v)(?:[-_.]|$)/,
  /^kimi-k2\.(?:5|7)(?:[-_.]|$)/,
  /^minimax-m3(?:[-_.]|$)/,
  /^mimo-v2\.5(?:[-_.]|$)/,
  /^step-(?:1v|1\.5v|2v|omni)(?:[-_.]|$)/,
  /^baichuan-omni(?:[-_.]|$)/,
  /^(?:deepseek-vl|internvl|yi-vl|minicpm-v|cogvlm|janus-pro)(?:[-_.\d]|$)/,
  /(?:^|[-_.])(?:vision|vl\d*|multimodal|pixtral)(?:[-_.]|$)/
]

const POLICIES: Record<ApiFormat, ProviderImagePolicy> = {
  openai: {
    apiFormat: 'openai',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxImages: 500,
    maxImageBytes: 50 * MIB,
    maxTotalBytes: 50 * MIB
  },
  anthropic: {
    apiFormat: 'anthropic',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxImages: 100,
    maxImageBytes: 5 * MIB,
    maxTotalBytes: 32 * MIB
  },
  gemini: {
    apiFormat: 'gemini',
    acceptedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxImageBytes: 20 * MIB,
    maxTotalBytes: 20 * MIB
  }
}

function normalizeModelName(modelName: string): string {
  const resourceName = modelName.trim().toLowerCase().split('/').pop() || ''
  return resourceName.replace(/^(?:anthropic|google|openai)[.:]/, '')
}

export function inferImageInputSupport(
  modelName: string
): boolean | undefined {
  const normalizedName = normalizeModelName(modelName)
  if (!normalizedName) return undefined
  if (KNOWN_NON_VISION_MODELS.some((pattern) => pattern.test(normalizedName))) return false
  if (KNOWN_VISION_MODELS.some((pattern) => pattern.test(normalizedName))) return true

  return undefined
}

export function getImageInputCapability(
  model: ImageCapabilityModel | undefined
): ImageInputCapability {
  if (typeof model?.supportsVision === 'boolean') {
    return { supported: model.supportsVision, source: 'manual' }
  }

  const inferred = inferImageInputSupport(model?.name || '')
  return inferred === undefined
    ? { supported: false, source: 'unknown' }
    : { supported: inferred, source: 'model-default' }
}

export function supportsImageInput(
  model: ImageCapabilityModel | undefined
): boolean {
  return getImageInputCapability(model).supported
}

export function getProviderImagePolicy(apiFormat: ApiFormat | undefined): ProviderImagePolicy {
  return POLICIES[apiFormat || 'openai']
}
