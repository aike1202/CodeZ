import { create } from 'zustand'
import type { GeneralSettings } from '@shared/types/settings'
import { desktopApi } from '../shared/desktop'

interface SettingsState {
  settings: GeneralSettings | null
  loading: boolean
  loadSettings: () => Promise<void>
  updateSettings: (newSettings: Partial<GeneralSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: true,
  
  loadSettings: async () => {
    set({ loading: true })
    try {
      const data = await desktopApi.settings.get()
      set({ settings: data, loading: false })
    } catch (error) {
      console.error('Failed to load settings:', error)
      set({ loading: false })
    }
  },

  updateSettings: async (newSettings: Partial<GeneralSettings>) => {
    const current = get().settings
    if (!current) return
    
    // Optimistic update
    const updated = { ...current, ...newSettings }
    set({ settings: updated })
    
    try {
      await desktopApi.settings.save(updated)
    } catch (error) {
      console.error('Failed to save settings:', error)
      // Revert on failure
      set({ settings: current })
    }
  }
}))
