import type { StateCreator } from 'zustand'
import type { ContextBudgetSnapshot } from '../../../../../shared/types/context'
import type { ChatState, CompactionUiState } from '../types'

export interface ContextSlice {
  contextBudgets: Record<string, ContextBudgetSnapshot | undefined>
  compactionStates: Record<string, CompactionUiState | undefined>
  setContextBudget: (sessionId: string, snapshot: ContextBudgetSnapshot) => void
  setCompactionState: (sessionId: string, state: CompactionUiState) => void
}

export const createContextSlice: StateCreator<ChatState, [], [], ContextSlice> = (set) => ({
  contextBudgets: {},
  compactionStates: {},
  setContextBudget: (sessionId, snapshot) => set((state) => ({
    contextBudgets: { ...state.contextBudgets, [sessionId]: snapshot }
  })),
  setCompactionState: (sessionId, compactionState) => set((state) => ({
    compactionStates: { ...state.compactionStates, [sessionId]: compactionState }
  }))
})
