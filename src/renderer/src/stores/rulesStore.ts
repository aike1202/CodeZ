import { create } from 'zustand'
import type { RuleFile } from '@shared/types/rules'
import { desktopApi } from '../shared/desktop'
import { useWorkspaceStore } from './workspaceStore'

interface RulesState {
  rules: RuleFile[]
  isLoading: boolean
  error: string | null
  loadRules: () => Promise<void>
  saveRule: (rule: RuleFile) => Promise<boolean>
  deleteRule: (rulePath: string) => Promise<boolean>
  renameRule: (oldPath: string, newFilename: string, projectId: string | undefined, scope: 'global' | 'workspace') => Promise<boolean>
}

export const useRulesStore = create<RulesState>((set, get) => ({
  rules: [],
  isLoading: false,
  error: null,

  loadRules: async () => {
    set({ isLoading: true, error: null })
    try {
      const recentProjects = useWorkspaceStore.getState().recentProjects || []
      const workspaces = recentProjects.map(p => ({ id: p.id, rootPath: p.rootPath }))
      const rules = await desktopApi.rules.getList(workspaces)
      set({ rules, isLoading: false })
    } catch (err: any) {
      set({ error: err.message, isLoading: false })
    }
  },

  saveRule: async (rule: RuleFile) => {
    try {
      const workspaceRoot = useWorkspaceStore.getState().workspace?.rootPath || ''
      const success = await desktopApi.rules.save(rule, workspaceRoot)
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
      const success = await desktopApi.rules.delete(rulePath)
      if (success) {
        await get().loadRules()
      }
      return success
    } catch (err: any) {
      set({ error: err.message })
      return false
    }
  },

  renameRule: async (oldPath: string, newFilename: string, projectId: string | undefined, scope: 'global' | 'workspace') => {
    try {
      let workspaceRoot = ''
      if (scope === 'workspace') {
        const recentProjects = useWorkspaceStore.getState().recentProjects || []
        const proj = recentProjects.find(p => p.id === projectId)
        if (proj) workspaceRoot = proj.rootPath
      }
      const success = await desktopApi.rules.rename(oldPath, newFilename, workspaceRoot, scope)
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
