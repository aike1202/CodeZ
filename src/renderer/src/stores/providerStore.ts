import { create } from 'zustand'
import type { ThinkingConfig, ApiFormat } from '@shared/types/provider'

export interface ModelConfig {
  id: string
  name: string
  maxContextTokens: number
}

interface ProviderInfo {
  id: string
  name: string
  baseUrl: string
  apiFormat?: ApiFormat
  apiKeyMasked: string
  models: ModelConfig[]
  thinking: ThinkingConfig
  enabled: boolean
  createdAt: string
}

interface ProviderState {
  providers: ProviderInfo[]
  activeProviderId: string | null
  loading: boolean

  loadProviders: () => Promise<void>
  addProvider: (form: { name: string; baseUrl: string; apiKey: string; models: ModelConfig[]; thinking: ThinkingConfig }) => Promise<ProviderInfo>
  updateProvider: (id: string, form: Partial<{ name: string; baseUrl: string; apiKey: string; models: ModelConfig[]; thinking: ThinkingConfig }>) => Promise<void>
  removeProvider: (id: string) => Promise<void>
  testConnection: (id: string) => Promise<{ success: boolean; message: string; models?: string[] }>
  setActiveProvider: (id: string) => Promise<void>
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  activeProviderId: null,
  loading: false,

  loadProviders: async () => {
    set({ loading: true })
    try {
      const data = await window.api.provider.list()
      const providers = data || []
      set({ providers, loading: false })
      if (providers.length > 0 && !get().activeProviderId) {
        set({ activeProviderId: providers[0].id })
      }
    } catch {
      set({ loading: false })
    }
  },

  addProvider: async (form) => {
    const info = await window.api.provider.add(form as any)
    set((s) => ({
      providers: [...s.providers, info],
      activeProviderId: s.activeProviderId || info.id
    }))
    return info
  },

  updateProvider: async (id, form) => {
    const updated = await window.api.provider.update(id, form as any)
    if (updated) {
      set((s) => ({
        providers: s.providers.map((p) => (p.id === id ? updated : p))
      }))
    }
  },

  removeProvider: async (id) => {
    await window.api.provider.remove(id)
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      activeProviderId: s.activeProviderId === id
        ? (s.providers.find((p) => p.id !== id)?.id || null)
        : s.activeProviderId
    }))
  },

  testConnection: async (id) => {
    return window.api.provider.testConnection(id)
  },

  setActiveProvider: async (id) => {
    await window.api.provider.setActive(id)
    set({ activeProviderId: id })
  }
}))
