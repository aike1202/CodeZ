import { create } from 'zustand'
import type { RuleFile } from '@shared/types/rules'
import { useWorkspaceStore } from './workspaceStore'

interface RulesState {
  rules: RuleFile[]
  isLoading: boolean
  error: string | null
  loadRules: () => Promise<void>
  saveRule: (rule: RuleFile) => Promise<boolean>
  deleteRule: (rulePath: string) => Promise<boolean>
}

export const useRulesStore = create<RulesState>((set, get) => ({
  rules: [],
  isLoading: false,
  error: null,

  loadRules: async () => {
    set({ isLoading: true, error: null })
    try {
      const workspaceRoot = useWorkspaceStore.getState().workspace?.rootPath || ''
      const rules = await window.api.rules.getList(workspaceRoot)
      set({ rules, isLoading: false })
    } catch (err: any) {
      set({ error: err.message, isLoading: false })
    }
  },

  saveRule: async (rule: RuleFile) => {
    try {
      const workspaceRoot = useWorkspaceStore.getState().workspace?.rootPath || ''
      const success = await window.api.rules.save(rule, workspaceRoot)
      if (success) {
        await get().loadRules()
      }
      return success
    } catch (err: any) {
      set({ error: err.message })
      return false
    }
  },

  deleteRule: async (rulePath: string) => {
    try {
      const success = await window.api.rules.delete(rulePath)
      if (success) {
        await get().loadRules()
      }
      return success
    } catch (err: any) {
      set({ error: err.message })
      return false
    }
  }
}))
