import type { ApiFormat, ModelConfig } from '../types/provider'
import type { ProviderImagePolicy } from '../types/attachment'

const MIB = 1024 * 1024

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

export function supportsImageInput(
  model: Pick<ModelConfig, 'supportsVision'> | undefined
): boolean {
  return model?.supportsVision === true
}

export function getProviderImagePolicy(apiFormat: ApiFormat | undefined): ProviderImagePolicy {
  return POLICIES[apiFormat || 'openai']
}
