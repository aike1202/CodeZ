import * as path from 'path'
import { app } from 'electron'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { CommandAnalyzer } from './CommandAnalyzer'
import {
  createStoredCommandRule,
  matchStoredCommandRule,
  normalizeStoredCommandRule
} from './permissionCommandRuleMatcher'
import {
  type PermissionRuleEffect,
  type PermissionRuleScope,
  type StoredCommandRule
} from './permissionRuleTypes'

export type { PermissionRuleEffect, PermissionRuleScope }

export class PermissionRuleStore {
  private globalRules: StoredCommandRule[] = []
  private workspaceRules = new Map<string, StoredCommandRule[]>()
  private sessionRules: StoredCommandRule[] = []
  
  private globalPathRules: string[] = []
  private workspacePathRules = new Map<string, string[]>()
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
        this.globalRules = parsed.globalRules.map((rule: StoredCommandRule) => normalizeStoredCommandRule(rule))
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

  private getWorkspaceConfigPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.codez', 'permissions.json')
  }

  private async loadWorkspaceRules(workspaceRoot: string): Promise<void> {
    if (this.workspaceRules.has(workspaceRoot)) return

    try {
      const data = await fs.readFile(this.getWorkspaceConfigPath(workspaceRoot), 'utf8')
      const parsed = JSON.parse(data)
      const rules = Array.isArray(parsed.workspaceRules) ? parsed.workspaceRules : []
      this.workspaceRules.set(workspaceRoot, rules.map((rule: StoredCommandRule) => normalizeStoredCommandRule(rule)))
      this.workspacePathRules.set(workspaceRoot, Array.isArray(parsed.workspacePathRules) ? parsed.workspacePathRules : [])
    } catch {
      this.workspaceRules.set(workspaceRoot, [])
      this.workspacePathRules.set(workspaceRoot, [])
    }
  }

  private loadWorkspaceRulesSync(workspaceRoot: string): void {
    if (this.workspaceRules.has(workspaceRoot)) return

    try {
      const data = fsSync.readFileSync(this.getWorkspaceConfigPath(workspaceRoot), 'utf8')
      const parsed = JSON.parse(data)
      const rules = Array.isArray(parsed.workspaceRules) ? parsed.workspaceRules : []
      this.workspaceRules.set(workspaceRoot, rules.map((rule: StoredCommandRule) => normalizeStoredCommandRule(rule)))
      this.workspacePathRules.set(workspaceRoot, Array.isArray(parsed.workspacePathRules) ? parsed.workspacePathRules : [])
    } catch {
      this.workspaceRules.set(workspaceRoot, [])
      this.workspacePathRules.set(workspaceRoot, [])
    }
  }

  private async saveWorkspaceRules(workspaceRoot: string): Promise<void> {
    const configPath = this.getWorkspaceConfigPath(workspaceRoot)
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      workspaceRules: this.workspaceRules.get(workspaceRoot) || [],
      workspacePathRules: this.workspacePathRules.get(workspaceRoot) || []
    }, null, 2))
  }

  async addRule(
    rule: string,
    scope: PermissionRuleScope,
    workspaceRoot?: string,
    effect: PermissionRuleEffect = 'allow'
  ) {
    if (scope === 'session') {
      if (!this.containsCommandRule(this.sessionRules, rule, effect)) this.sessionRules.push(createStoredCommandRule(rule, effect))
    } else if (scope === 'workspace') {
      if (!workspaceRoot) throw new Error('workspaceRoot is required for workspace permission rules')
      await this.loadWorkspaceRules(workspaceRoot)
      const rules = this.workspaceRules.get(workspaceRoot) || []
      if (!this.containsCommandRule(rules, rule, effect)) {
        rules.push(createStoredCommandRule(rule, effect))
        this.workspaceRules.set(workspaceRoot, rules)
        await this.saveWorkspaceRules(workspaceRoot)
      }
    } else {
      if (!this.containsCommandRule(this.globalRules, rule, effect)) {
        this.globalRules.push(createStoredCommandRule(rule, effect))
        await this.save()
      }
    }
  }

  async addPathRule(rulePath: string, scope: PermissionRuleScope, workspaceRoot?: string) {
    // Normalize path rule to posix
    const normalized = rulePath.replace(/\\/g, '/')
    if (scope === 'session') {
      if (!this.sessionPathRules.includes(normalized)) this.sessionPathRules.push(normalized)
    } else if (scope === 'workspace') {
      if (!workspaceRoot) throw new Error('workspaceRoot is required for workspace permission rules')
      await this.loadWorkspaceRules(workspaceRoot)
      const rules = this.workspacePathRules.get(workspaceRoot) || []
      if (!rules.includes(normalized)) {
        rules.push(normalized)
        this.workspacePathRules.set(workspaceRoot, rules)
        await this.saveWorkspaceRules(workspaceRoot)
      }
    } else {
      if (!this.globalPathRules.includes(normalized)) {
        this.globalPathRules.push(normalized)
        await this.save()
      }
    }
  }

  isCommandWhitelisted(command: string, workspaceRoot?: string): boolean {
    return this.getCommandRuleEffect(command, workspaceRoot) === 'allow'
  }

  getCommandRuleEffect(command: string, workspaceRoot?: string): PermissionRuleEffect | null {
    const commandRisk = CommandAnalyzer.analyze(command)
    if (workspaceRoot) this.loadWorkspaceRulesSync(workspaceRoot)
    const workspaceRules = workspaceRoot ? (this.workspaceRules.get(workspaceRoot) || []) : []
    const matches = [...this.globalRules, ...workspaceRules, ...this.sessionRules]
      .map((rule) => matchStoredCommandRule(rule, command, commandRisk))
      .filter((rule): rule is { effect: PermissionRuleEffect; specificity: number } => rule !== null)
      .sort((left, right) => right.specificity - left.specificity)
    const deny = matches.find((match) => match.effect === 'deny')
    if (deny) return 'deny'
    return matches[0]?.effect || null
  }

  private containsCommandRule(rules: StoredCommandRule[], rule: string, effect: PermissionRuleEffect): boolean {
    return rules.some((storedRule) => {
      const normalized = normalizeStoredCommandRule(storedRule)
      return normalized.rule === rule && normalized.effect === effect
    })
  }

  isPathWhitelisted(targetPath: string, workspaceRoot?: string): boolean {
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
    if (workspaceRoot) this.loadWorkspaceRulesSync(workspaceRoot)
    const workspaceRules = workspaceRoot ? (this.workspacePathRules.get(workspaceRoot) || []) : []
    return check(this.sessionPathRules) || check(workspaceRules) || check(this.globalPathRules)
  }
}
