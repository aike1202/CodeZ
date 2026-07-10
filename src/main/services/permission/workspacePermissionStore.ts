import { app } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PermissionMode } from '../../../shared/types/permission'
import { DEFAULT_PERMISSION_MODE } from '../../../shared/types/permission'

interface PersistedWorkspacePermissions {
  workspaces: Record<string, PermissionMode>
}

export function normalizeWorkspaceKey(rootPath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(rootPath).replace(/\\/g, '/')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

export class WorkspacePermissionStore {
  constructor(
    private readonly filePath = app?.getPath ? path.join(app.getPath('userData'), 'workspace-permissions.json') : ':memory:',
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private async read(): Promise<PersistedWorkspacePermissions> {
    if (this.filePath === ':memory:') return { workspaces: {} }
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as PersistedWorkspacePermissions
      return {
        workspaces: parsed?.workspaces && typeof parsed.workspaces === 'object'
          ? parsed.workspaces
          : {}
      }
    } catch {
      return { workspaces: {} }
    }
  }

  async getMode(rootPath: string): Promise<PermissionMode> {
    const mode = (await this.read()).workspaces[normalizeWorkspaceKey(rootPath, this.platform)]
    return mode === 'full-access' || mode === 'auto' ? mode : DEFAULT_PERMISSION_MODE
  }

  async setMode(rootPath: string, mode: PermissionMode): Promise<void> {
    if (this.filePath === ':memory:') return
    const data = await this.read()
    data.workspaces[normalizeWorkspaceKey(rootPath, this.platform)] = mode
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}

let instance: WorkspacePermissionStore | null = null

export function getWorkspacePermissionStore(): WorkspacePermissionStore {
  if (!instance) instance = new WorkspacePermissionStore()
  return instance
}
