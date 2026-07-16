import { create } from 'zustand'
import type { ProviderFormData, ProviderInfo } from '../shared/desktop'

type ProviderBridgeInfo = Omit<ProviderInfo, 'apiKeyConfigured'> & {
  apiKeyConfigured?: boolean
  apiKey?: string
}

function normalizeProviderInfo(provider: ProviderBridgeInfo): ProviderInfo {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    apiKeyConfigured: provider.apiKeyConfigured ?? Boolean(provider.apiKey),
    models: provider.models,
    thinking: provider.thinking,
    enabled: provider.enabled,
    createdAt: provider.createdAt
  }
}

interface ProviderState {
  providers: ProviderInfo[]
  activeProviderId: string | null
  loading: boolean

  loadProviders: () => Promise<void>
  addProvider: (form: ProviderFormData) => Promise<ProviderInfo>
  updateProvider: (id: string, form: Partial<ProviderFormData>) => Promise<void>
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
      const providers = (data || []).map((provider) =>
        normalizeProviderInfo(provider as ProviderBridgeInfo)
      )
      set({ providers, loading: false })
      if (providers.length > 0 && !get().activeProviderId) {
        set({ activeProviderId: providers[0].id })
      }
    } catch {
      set({ loading: false })
    }
  },

  addProvider: async (form) => {
    const info = normalizeProviderInfo(
      await window.api.provider.add(form) as ProviderBridgeInfo
    )
    set((s) => ({
      providers: [...s.providers, info],
      activeProviderId: s.activeProviderId || info.id
    }))
    return info
  },

  updateProvider: async (id, form) => {
    const existing = get().providers.find((p) => p.id === id)
    if (!existing) return

    const formData: ProviderFormData = {
      name: existing.name,
      baseUrl: existing.baseUrl,
      apiFormat: existing.apiFormat,
      apiKey: '',
      models: existing.models,
      thinking: existing.thinking,
      ...form
    }

    const response = await window.api.provider.update(id, formData)
    const updated = response
      ? normalizeProviderInfo(response as ProviderBridgeInfo)
      : null
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
