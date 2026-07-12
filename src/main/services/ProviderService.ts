import * as fs from 'fs/promises'
import * as path from 'path'
import { app, safeStorage } from 'electron'
import type { ProviderConfig, ProviderInfo, ProviderFormData, ModelConfig, ConnectionTestResult, ModelInfo, ThinkingConfig } from '../../shared/types/provider'
import { resolveModelContextCapabilities } from './context/ModelCapabilities'

const PROVIDERS_FILE = 'providers.json'
const MAX_PROVIDERS = 20
const LEGACY_DEFAULT_CONTEXT_TOKENS = 8192

function genId(): string {
  return `pv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function genModelId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}



function normalizeThinkingConfig(value: unknown): ThinkingConfig {
  if (value && typeof value === 'object') {
    const config = value as Partial<ThinkingConfig>
    return {
      enabled: config.enabled !== false,
      mode: config.mode === 'openai' ? 'auto' : config.mode || 'auto',
      effort: config.effort,
      budgetTokens: config.budgetTokens
    }
  }

  return { enabled: true, mode: 'auto' }
}

export class ProviderService {
  private filePath: string
  private cache: ProviderConfig[] = []
  private activeProviderId: string | null = null

  constructor() {
    this.filePath = path.join(app.getPath('userData'), PROVIDERS_FILE)
  }

  /* ---------- 持久化 ---------- */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      let providersMigrated = false
      if (Array.isArray(parsed?.providers)) {
        const originalProviders = JSON.stringify(parsed.providers)
        this.cache = parsed.providers.map(this.migrateConfig)
        providersMigrated = JSON.stringify(this.cache) !== originalProviders
      }
      if (typeof parsed?.activeProviderId === 'string') {
        this.activeProviderId = parsed.activeProviderId
      }
      if (providersMigrated) {
        await this.save().catch((error) => {
          console.error('ProviderService migration save error:', error)
        })
      }
    } catch {
      this.cache = []
      this.activeProviderId = null
    }
  }

  /** 兼容旧版单模型字段 */
  private migrateConfig(c: any): ProviderConfig {
    if (!Array.isArray(c.models)) {
      c.models = c.defaultModel
        ? [{ id: genModelId(), name: c.defaultModel, maxContextTokens: 8192 }]
        : []
      delete c.defaultModel
    }
    c.models = c.models.map((model: any) => ({
      ...model,
      maxContextTokens: Number.isFinite(model?.maxContextTokens) && model.maxContextTokens > 0
        ? Math.floor(model.maxContextTokens)
        : LEGACY_DEFAULT_CONTEXT_TOKENS
    }))
    c.thinking = normalizeThinkingConfig(c.thinking)
    return c as ProviderConfig
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ providers: this.cache, activeProviderId: this.activeProviderId }, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('ProviderService save error:', error)
      throw error
    }
  }

  /* ---------- API Key 加解密 ---------- */
  private encryptApiKey(plainKey: string): { encrypted: string; method: 'safeStorage' | 'base64' } {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plainKey)
      return { encrypted: buf.toString('base64'), method: 'safeStorage' }
    }
    const b64 = Buffer.from(plainKey, 'utf-8').toString('base64')
    return { encrypted: b64, method: 'base64' }
  }

  private decryptApiKey(encrypted: string, method: 'safeStorage' | 'base64' | 'none'): string {
    if (method === 'safeStorage' && safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(encrypted, 'base64')
      return safeStorage.decryptString(buf)
    }
    if (method === 'base64') {
      return Buffer.from(encrypted, 'base64').toString('utf-8')
    }
    return encrypted
  }

  /* ---------- CRUD ---------- */
  getAll(): ProviderInfo[] {
    return this.cache.map((c) => ({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      apiFormat: c.apiFormat || 'openai',
      apiKey: this.decryptApiKey(c.apiKeyRef, c.encryption),
      models: c.models,
      thinking: normalizeThinkingConfig(c.thinking),
      enabled: c.enabled,
      createdAt: c.createdAt
    }))
  }

  getActiveId(): string | null {
    return this.activeProviderId
  }

  async add(form: ProviderFormData): Promise<ProviderConfig> {
    if (this.cache.length >= MAX_PROVIDERS) {
      throw new Error(`最多支持 ${MAX_PROVIDERS} 个 Provider`)
    }
    this.validateModels(form.models || [])

    const { encrypted, method } = this.encryptApiKey(form.apiKey)
    const now = new Date().toISOString()

    const config: ProviderConfig = {
      id: genId(),
      name: form.name.trim() || '未命名',
      baseUrl: form.baseUrl.trim().replace(/\/$/, ''),
      apiFormat: form.apiFormat || 'openai',
      apiKeyRef: encrypted,
      encryption: method,
      models: (form.models || []).map((m) => ({
        ...m,
        id: m.id || genModelId()
      })),
      thinking: normalizeThinkingConfig(form.thinking),
      enabled: true,
      createdAt: now,
      updatedAt: now
    }

    this.cache.push(config)

    if (this.cache.length === 1) {
      this.activeProviderId = config.id
    }

    await this.save()
    return config
  }

  async update(id: string, form: Partial<ProviderFormData>): Promise<ProviderConfig | null> {
    const idx = this.cache.findIndex((c) => c.id === id)
    if (idx === -1) return null
    if (form.models !== undefined) this.validateModels(form.models)

    const existing = this.cache[idx]

    if (form.name !== undefined) existing.name = form.name.trim() || existing.name
    if (form.baseUrl !== undefined) existing.baseUrl = form.baseUrl.trim().replace(/\/$/, '') || existing.baseUrl
    if (form.apiFormat !== undefined) existing.apiFormat = form.apiFormat
    if (form.models !== undefined) {
      existing.models = form.models.map((m) => ({
        ...m,
        id: m.id || genModelId()
      }))
    }
    if (form.thinking !== undefined) {
      existing.thinking = normalizeThinkingConfig(form.thinking)
    }
    if (form.apiKey !== undefined && form.apiKey) {
      const { encrypted, method } = this.encryptApiKey(form.apiKey)
      existing.apiKeyRef = encrypted
      existing.encryption = method
    }

    existing.updatedAt = new Date().toISOString()
    await this.save()
    return existing
  }

  private validateModels(models: ModelConfig[]): void {
    if (models.length === 0) throw new Error('At least one model configuration is required')
    for (const model of models) {
      if (!model.name?.trim()) throw new Error('Every model configuration requires a name')
      resolveModelContextCapabilities(model)
    }
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.cache.findIndex((c) => c.id === id)
    if (idx === -1) return false

    this.cache.splice(idx, 1)

    if (this.activeProviderId === id) {
      this.activeProviderId = this.cache.length > 0 ? this.cache[0].id : null
    }

    await this.save()
    return true
  }

  async setActive(id: string): Promise<void> {
    if (!this.cache.some((c) => c.id === id)) {
      throw new Error('Provider 不存在')
    }
    this.activeProviderId = id
    await this.save()
  }

  /* ---------- 连接测试 ---------- */
  async testConnection(id: string): Promise<ConnectionTestResult> {
    const config = this.cache.find((c) => c.id === id)
    if (!config) {
      return { success: false, message: 'Provider 不存在' }
    }

    const apiKey = this.decryptApiKey(config.apiKeyRef, config.encryption)

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)

      const resp = await fetch(`${config.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      })
      clearTimeout(timeout)

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, message: `鉴权失败 (${resp.status})` }
      }
      if (resp.status === 404) {
        return { success: false, message: '端点不存在 (404)' }
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        return { success: false, message: `请求失败 (${resp.status}): ${body.slice(0, 200)}` }
      }

      const json = await resp.json() as { data?: ModelInfo[] }
      const models = json?.data?.map((m) => m.id).slice(0, 30) || []

      return {
        success: true,
        message: `连接成功，发现 ${models.length} 个可用模型`,
        models
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('abort')) {
        return { success: false, message: '连接超时 (15s)' }
      }
      return { success: false, message: `网络错误: ${msg}` }
    }
  }

  /** 获取解密后的 API Key（仅 IPC 内部使用） */
  getApiKey(id: string): string | null {
    const config = this.cache.find((c) => c.id === id)
    if (!config) return null
    return this.decryptApiKey(config.apiKeyRef, config.encryption)
  }

  getConfig(id: string): ProviderConfig | null {
    return this.cache.find((c) => c.id === id) || null
  }
}
