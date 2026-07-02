import * as path from 'path'
import { app } from 'electron'
import * as fs from 'fs/promises'

export class PermissionRuleStore {
  private globalRules: string[] = []
  private sessionRules: string[] = []
  
  private globalPathRules: string[] = []
  private sessionPathRules: string[] = []

  private globalConfigPath: string

  private static instance: PermissionRuleStore
  public static getInstance(): PermissionRuleStore {
    if (!PermissionRuleStore.instance) {
      PermissionRuleStore.instance = new PermissionRuleStore()
    }
    return PermissionRuleStore.instance
  }

  private constructor() {
    this.globalConfigPath = path.join(app.getPath('userData'), 'global-permissions.json')
    this.load()
  }

  private async load() {
    try {
      const data = await fs.readFile(this.globalConfigPath, 'utf8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed.globalRules)) {
        this.globalRules = parsed.globalRules
      }
      if (Array.isArray(parsed.globalPathRules)) {
        this.globalPathRules = parsed.globalPathRules
      }
    } catch (e) {
      this.globalRules = []
      this.globalPathRules = []
    }
  }

  private async save() {
    await fs.writeFile(this.globalConfigPath, JSON.stringify({ 
      globalRules: this.globalRules,
      globalPathRules: this.globalPathRules
    }, null, 2))
  }

  async addRule(rule: string, scope: 'session' | 'global') {
    if (scope === 'session') {
      if (!this.sessionRules.includes(rule)) this.sessionRules.push(rule)
    } else {
      if (!this.globalRules.includes(rule)) {
        this.globalRules.push(rule)
        await this.save()
      }
    }
  }

  async addPathRule(rulePath: string, scope: 'session' | 'global') {
    // Normalize path rule to posix
    const normalized = rulePath.replace(/\\/g, '/')
    if (scope === 'session') {
      if (!this.sessionPathRules.includes(normalized)) this.sessionPathRules.push(normalized)
    } else {
      if (!this.globalPathRules.includes(normalized)) {
        this.globalPathRules.push(normalized)
        await this.save()
      }
    }
  }

  isCommandWhitelisted(command: string): boolean {
    const check = (rules: string[]) => {
      return rules.some(rule => {
        if (rule.endsWith('*')) {
          const prefix = rule.slice(0, -1).trim()
          return command.startsWith(prefix) || command === prefix
        }
        return command === rule
      })
    }
    return check(this.sessionRules) || check(this.globalRules)
  }

  isPathWhitelisted(targetPath: string): boolean {
    const normalizedTarget = targetPath.replace(/\\/g, '/')
    const check = (rules: string[]) => {
      return rules.some(rule => {
        if (rule.endsWith('*')) {
          const prefix = rule.slice(0, -1)
          return normalizedTarget.startsWith(prefix)
        }
        return normalizedTarget === rule
      })
    }
    return check(this.sessionPathRules) || check(this.globalPathRules)
  }
}
