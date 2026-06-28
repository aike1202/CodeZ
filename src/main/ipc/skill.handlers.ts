import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { SkillManager } from '../services/SkillManager'
import { getWorkspaceService } from './workspace.handlers'

export function registerSkillIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SKILL_GET_ALL, async () => {
    const workspaceSvc = getWorkspaceService()
    const currentWorkspace = workspaceSvc ? workspaceSvc.getCurrentWorkspace() : null
    const sm = SkillManager.getInstance()
    return await sm.getSkills(currentWorkspace)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_TOGGLE, async (_event, id: string, enabled: boolean) => {
    const workspaceSvc = getWorkspaceService()
    const currentWorkspace = workspaceSvc ? workspaceSvc.getCurrentWorkspace() : null
    const sm = SkillManager.getInstance()
    await sm.toggleSkill(currentWorkspace, id, enabled)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_CHECK_EXTERNAL, async () => {
    const sm = SkillManager.getInstance()
    return await sm.checkExternalSkills()
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_IMPORT_EXTERNAL, async (_event, sourceName?: string, customPath?: string, forceOverwrite?: boolean) => {
    const sm = SkillManager.getInstance()
    return await sm.importExternalSkills(sourceName, customPath, forceOverwrite)
  })
}
