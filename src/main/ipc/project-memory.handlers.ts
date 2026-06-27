import { ipcMain } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { IPC_CHANNELS } from '../../shared/ipc/channels'

const AGENT_DIR_NAME = '.agent'
const RULES_DIR_NAME = 'rules'

const DEFAULT_RULE_CONTENT = `# 🧠 全局规则 (Global Rules)

> **AI 助手的项目级上下文约束**
> 助手在处理您的需求时，会**自动加载并严格遵循**此目录下的所有约定。

## 🚫 核心规则
<!-- 写下开发中的绝对红线或强烈偏好 -->
- [例如 严格遵守 ESLint 规则，禁止出现 any]
- [例如 所有文件路径统一使用绝对别名引入]
- [例如 回答时请直接提供可运行代码，不要写省略号]
`

export function registerProjectMemoryIpc(): void {
  const getRulesDir = (rootPath: string) => path.join(rootPath, AGENT_DIR_NAME, RULES_DIR_NAME)

  // 确保目录存在
  const ensureRulesDir = async (rootPath: string) => {
    const dir = getRulesDir(rootPath)
    try {
      await fs.access(dir)
    } catch {
      await fs.mkdir(dir, { recursive: true })
    }
    return dir
  }

  // GET: 读取 rules 目录下所有 md 文件的内容并拼接（用于 System Prompt）
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_GET, async (_event, rootPath: string) => {
    try {
      const dir = await ensureRulesDir(rootPath)
      const files = await fs.readdir(dir)
      const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md'))
      
      let allContent = ''
      for (const file of mdFiles) {
        const filePath = path.join(dir, file)
        const content = await fs.readFile(filePath, 'utf-8')
        allContent += `\n\n--- 【来自规则文件：${file}】 ---\n${content}`
      }
      return { path: dir, content: allContent.trim() }
    } catch (error) {
      console.error('Failed to get project memory:', error)
      return null
    }
  })

  // LIST: 列出所有规则文件
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_LIST, async (_event, rootPath: string) => {
    try {
      const dir = await ensureRulesDir(rootPath)
      const files = await fs.readdir(dir)
      const mdFiles = files.filter(f => f.toLowerCase().endsWith('.md'))
      
      if (mdFiles.length === 0) {
        // 如果没有，初始化一个全局规则文件
        const defaultFile = path.join(dir, 'global.rule.md')
        await fs.writeFile(defaultFile, DEFAULT_RULE_CONTENT, 'utf-8')
        return [{ name: 'global.rule.md', path: defaultFile }]
      }

      return mdFiles.map(name => ({
        name,
        path: path.join(dir, name)
      }))
    } catch (error) {
      console.error('Failed to list project memory:', error)
      return []
    }
  })

  // CREATE: 创建一个新的规则文件
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_CREATE, async (_event, rootPath: string, filename: string) => {
    try {
      const dir = await ensureRulesDir(rootPath)
      if (!filename.toLowerCase().endsWith('.md')) {
        filename += '.md'
      }
      const filePath = path.join(dir, filename)
      
      let exists = true
      try {
        await fs.access(filePath)
      } catch {
        exists = false
      }
      
      if (!exists) {
        await fs.writeFile(filePath, `# ${filename.replace('.md', '')}\n\n- (在此填写您的规则)\n`, 'utf-8')
      }
      return filePath
    } catch (error) {
      console.error('Failed to create project memory file:', error)
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_SAVE, async (_event, rootPath: string, filePath: string, content: string) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8')
    } catch (error) {
      console.error('Failed to save project memory file:', error)
    }
  })
  
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_DELETE, async (_event, rootPath: string, filePath: string) => {
    try {
      await fs.unlink(filePath)
    } catch (error) {
      console.error('Failed to delete project memory file:', error)
    }
  })
}
