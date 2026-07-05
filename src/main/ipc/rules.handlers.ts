import { ipcMain } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import type { RuleFile, RuleScope } from '../../shared/types/rules'

export function registerRulesIpc(): void {
  ipcMain.handle(IPC_CHANNELS.RULES_GET_LIST, async (_, workspaces: { id: string, rootPath: string }[]): Promise<RuleFile[]> => {
    const rules: RuleFile[] = []

    // Global
    const homeDir = os.homedir()
    await loadRulesFromPath(path.join(homeDir, '.codez', 'AGENTS.md'), 'global', rules)
    await loadRulesFromDir(path.join(homeDir, '.codez', 'rules'), 'global', rules)

    // Workspace
    if (workspaces && workspaces.length > 0) {
      for (const ws of workspaces) {
        if (!ws.rootPath) continue
        await loadRulesFromPath(path.join(ws.rootPath, 'AGENTS.md'), 'workspace', rules, ws.id)
        await loadRulesFromPath(path.join(ws.rootPath, '.agents', 'AGENTS.md'), 'workspace', rules, ws.id)
        await loadRulesFromPath(path.join(ws.rootPath, '.clinerules'), 'workspace', rules, ws.id)
        await loadRulesFromPath(path.join(ws.rootPath, '.cursorrules'), 'workspace', rules, ws.id)
        await loadRulesFromDir(path.join(ws.rootPath, '.codez', 'rules'), 'workspace', rules, ws.id)
      }
    }

    return rules
  })

  ipcMain.handle(IPC_CHANNELS.RULES_SAVE, async (_, rule: RuleFile, workspaceRoot: string): Promise<boolean> => {
    try {
      let targetPath = rule.path
      
      // If path is empty, it's a new rule. We need to construct the path.
      if (!targetPath) {
        if (!rule.filename) throw new Error('Filename is required')
        
        const isRootFile = ['AGENTS.md', '.clinerules', '.cursorrules'].includes(rule.filename)
        
        if (rule.scope === 'global') {
          const homeDir = os.homedir()
          if (rule.filename === 'AGENTS.md') {
            targetPath = path.join(homeDir, '.codez', 'AGENTS.md')
          } else {
            targetPath = path.join(homeDir, '.codez', 'rules', rule.filename)
          }
        } else {
          if (!workspaceRoot) throw new Error('Workspace root is required for workspace rules')
          if (isRootFile) {
            targetPath = path.join(workspaceRoot, rule.filename)
          } else {
            targetPath = path.join(workspaceRoot, '.codez', 'rules', rule.filename)
          }
        }
      }

      await fs.mkdir(path.dirname(targetPath), { recursive: true })

      await fs.writeFile(targetPath, rule.content, 'utf-8')
      return true
    } catch (e) {
      console.error('Failed to save rule', e)
      throw e
    }
  })

  ipcMain.handle(IPC_CHANNELS.RULES_DELETE, async (_, rulePath: string): Promise<boolean> => {
    try {
      await fs.unlink(rulePath)
      return true
    } catch (e) {
      console.error('Failed to delete rule', e)
      throw e
    }
  })

  ipcMain.handle(IPC_CHANNELS.RULES_RENAME, async (_, oldPath: string, newFilename: string, workspaceRoot: string, scope: RuleScope): Promise<boolean> => {
    try {
      if (!newFilename) throw new Error('Filename is required')
      let newPath = ''
      const isRootFile = ['AGENTS.md', '.clinerules', '.cursorrules'].includes(newFilename)
      
      if (scope === 'global') {
        const homeDir = os.homedir()
        if (newFilename === 'AGENTS.md') {
          newPath = path.join(homeDir, '.codez', 'AGENTS.md')
        } else {
          newPath = path.join(homeDir, '.codez', 'rules', newFilename)
        }
      } else {
        if (!workspaceRoot) throw new Error('Workspace root is required for workspace rules')
        if (isRootFile) {
          newPath = path.join(workspaceRoot, newFilename)
        } else {
          newPath = path.join(workspaceRoot, '.codez', 'rules', newFilename)
        }
      }

      await fs.mkdir(path.dirname(newPath), { recursive: true })
      await fs.rename(oldPath, newPath)
      return true
    } catch (e) {
      console.error('Failed to rename rule', e)
      throw e
    }
  })
}

async function loadRulesFromPath(filePath: string, scope: RuleScope, rules: RuleFile[], projectId?: string) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    rules.push(parseRuleFile(filePath, scope, raw, projectId))
  } catch {
    // ignore missing files
  }
}

async function loadRulesFromDir(dirPath: string, scope: RuleScope, rules: RuleFile[], projectId?: string) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        await loadRulesFromPath(path.join(dirPath, entry.name), scope, rules, projectId)
      }
    }
  } catch {
    // ignore missing dirs
  }
}

function parseRuleFile(filePath: string, scope: RuleScope, raw: string, projectId?: string): RuleFile {
  const filename = path.basename(filePath)
  // 去掉可能存在的 UTF-8 BOM，否则 ^--- frontmatter 匹配会失败
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  const rule: RuleFile = {
    filename,
    scope,
    path: filePath,
    content: raw,
    projectId
  }

  // Simple YAML frontmatter parser
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  const match = raw.match(frontmatterRegex)

  if (match) {
    const yamlStr = match[1]
    // keep rule.content as raw so the UI shows the entire file

    const lines = yamlStr.split(/\r?\n/)
    for (const line of lines) {
      const idx = line.indexOf(':')
      if (idx > -1) {
        const key = line.slice(0, idx).trim()
        const val = line.slice(idx + 1).trim()
        if (key === 'description') rule.description = val.replace(/^["']|["']$/g, '')
        if (key === 'globs') rule.globs = val.replace(/^["']|["']$/g, '')
        if (key === 'alwaysApply') rule.alwaysApply = val === 'true'
        if (key === 'enabled') rule.enabled = val === 'true'
      }
    }
  }

  // default enabled to true if not explicitly false
  if (rule.enabled === undefined) {
    rule.enabled = true
  }

  return rule
}
