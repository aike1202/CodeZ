import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { PlanStore } from '../services/PlanStore'
import { PlanService } from '../services/PlanService'

export function registerPlanIpc(): void {
  ipcMain.handle(IPC_CHANNELS.PLAN_LIST, async (_event, workspaceRoot: string) => {
    const store = new PlanStore()
    return await store.list(workspaceRoot)
  })

  ipcMain.handle(IPC_CHANNELS.PLAN_LOAD, async (_event, workspaceRoot: string, slug: string) => {
    const store = new PlanStore()
    const plan = await store.getBySlug(workspaceRoot, slug)
    if (!plan) throw new Error(`Plan not found: ${slug}`)
    return plan
  })

  ipcMain.handle(IPC_CHANNELS.PLAN_GET_ACTIVE, async (_event, workspaceRoot: string) => {
    const store = new PlanStore()
    return await store.getActive(workspaceRoot)
  })
}
