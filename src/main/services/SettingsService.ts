import * as fs from 'fs/promises'
import * as path from 'path'
import { app } from 'electron'
import type { GeneralSettings } from '../../shared/types/settings'
import { defaultSettings, defaultWebSearchSettings } from '../../shared/types/settings'

const SETTINGS_FILE = 'settings.json'

export class SettingsService {
  private filePath: string
  private cache: GeneralSettings

  constructor() {
    this.filePath = path.join(app.getPath('userData'), SETTINGS_FILE)
    this.cache = { ...defaultSettings }
  }

  public async init(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (parsed) {
        this.cache = { ...defaultSettings, ...parsed }
        // 嵌套对象需深合并，避免旧配置缺字段
        this.cache.webSearch = {
          ...defaultWebSearchSettings,
          ...(parsed.webSearch || {}),
          engines: {
            ...defaultWebSearchSettings.engines,
            ...(parsed.webSearch?.engines || {})
          }
        }
      }
    } catch {
      this.cache = { ...defaultSettings }
    }
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    } catch (error) {
      console.error('SettingsService save error:', error)
    }
  }

  public getSettings(): GeneralSettings {
    return { ...this.cache }
  }

  public async saveSettings(settings: Partial<GeneralSettings>): Promise<GeneralSettings> {
    this.cache = { ...this.cache, ...settings }
    await this.save()
    return { ...this.cache }
  }
}
