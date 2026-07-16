import { create } from 'zustand'
import type { ThinkingConfig, ApiFormat, ModelConfig, ProviderInfo, ProviderFormData } from '../shared/desktop'
import { desktopApi } from '../shared/desktop'

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
      const data = await desktopApi.provider.getAll()
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
    const info = await desktopApi.provider.create(form)
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

    const updated = await desktopApi.provider.update(id, formData)
    if (updated) {
      set((s) => ({
        providers: s.providers.map((p) => (p.id === id ? updated : p))
      }))
    }
  },

  removeProvider: async (id) => {
    await desktopApi.provider.delete(id)
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      activeProviderId: s.activeProviderId === id
        ? (s.providers.find((p) => p.id !== id)?.id || null)
        : s.activeProviderId
    }))
  },

  testConnection: async (id) => {
    return desktopApi.provider.testConnection(id)
  },

  setActiveProvider: async (id) => {
    await desktopApi.provider.setActive(id)
    set({ activeProviderId: id })
  }
}))
